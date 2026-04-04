import * as Sentry from "@sentry/node";
import { trackEvent } from "./analytics.js";
import { extractArticle } from "./extractor.js";
import { buildSpeechScript } from "./speech-script.js";
import { chunkSpeechScript } from "./text-chunker.js";
import {
  DEFAULT_SPEECH_OPTIONS,
  AVAILABLE_VOICES,
  VOICE_PREVIEW_TEXT,
  buildAudioFileKey,
  createSpeechProvider,
  measureMP3DurationSeconds,
  type SpeechProvider,
} from "./tts.js";
import type { AudioStore, JobStore } from "./storage.js";
import type {
  AudioJob,
  AudioJobStatus,
  CreateAudioJobInput,
  SpeechOptions,
} from "./types.js";

export class AudioJobService {
  private readonly jobStore: JobStore;
  private readonly audioStore: AudioStore;
  private readonly speechProvider: SpeechProvider;
  private initPromise: Promise<void> | null = null;

  constructor(options: {
    jobStore: JobStore;
    audioStore: AudioStore;
    speechProvider?: SpeechProvider;
  }) {
    this.jobStore = options.jobStore;
    this.audioStore = options.audioStore;
    this.speechProvider = options.speechProvider ?? createSpeechProvider();
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.jobStore.init();
    }
    await this.initPromise;
  }

  getProviderName(): string {
    return this.speechProvider.name;
  }

  async createJob(input: CreateAudioJobInput, userId?: string): Promise<AudioJob> {
    await this.init();
    const article = await extractArticle(input);
    const speechOptions = resolveSpeechOptions(input.speechOptions);
    const timestamp = new Date().toISOString();
    const jobId = await this.jobStore.nextId();
    const job: AudioJob = {
      id: jobId,
      status: "queued",
      article,
      speechOptions,
      provider: this.speechProvider.name,
      audioUrl: null,
      playlistUrl: null,
      audioSegments: [],
      durationSeconds: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      userId: userId ?? null,
    };

    await this.jobStore.save(job);

    const domain = safeHostname(article.url);
    trackEvent("narration_created", {
      url: article.url,
      domain,
      voice: speechOptions.voice,
      word_count: article.wordCount,
      estimated_minutes: article.estimatedMinutes,
    });

    return job;
  }

  async getJob(jobId: string, userId?: string): Promise<AudioJob | null> {
    await this.init();
    if (userId) return this.jobStore.getForUser(jobId, userId);
    return this.jobStore.get(jobId);
  }

  async listJobs(userId?: string): Promise<AudioJob[]> {
    await this.init();
    if (userId) return this.jobStore.getAllForUser(userId);
    return this.jobStore.getAll();
  }

  async deleteJob(jobId: string, userId?: string): Promise<boolean> {
    await this.init();
    const existingJob = userId
      ? await this.jobStore.getForUser(jobId, userId)
      : await this.jobStore.get(jobId);
    if (existingJob) {
      await this.deleteNarrationArtifacts(jobId);
    }
    if (userId) return this.jobStore.deleteForUser(jobId, userId);
    return this.jobStore.delete(jobId);
  }

  async processJob(jobId: string): Promise<void> {
    await this.init();
    const claimedJob = await this.jobStore.claimQueued(jobId);
    if (!claimedJob) {
      return;
    }

    const speechScript = buildSpeechScript({
      title: claimedJob.article.title,
      textContent: claimedJob.article.textContent,
    });
    const segmentTexts = chunkSpeechScript({
      script: speechScript.script,
      targetSecondsPerChunk: 20,
    }).map((chunk) => chunk.text);

    if (segmentTexts.length === 0) {
      await this.deleteNarrationArtifacts(jobId);
      await this.updateJob(jobId, {
        status: "failed",
        audioUrl: null,
        playlistUrl: null,
        audioSegments: [],
        durationSeconds: null,
        error: "No playable script content was generated.",
      });
      return;
    }

    let audioSegments: AudioJob["audioSegments"] = [...claimedJob.audioSegments];
    let combinedSegmentAudioData: Buffer[] = [];
    const canResumePersistedSegments =
      audioSegments.length > 0 && audioSegments.length <= segmentTexts.length;

    if (canResumePersistedSegments) {
      try {
        const restoredSegments = await this.restorePersistedSegments(jobId, audioSegments);
        audioSegments = restoredSegments.audioSegments;
        combinedSegmentAudioData = restoredSegments.combinedAudioData;
      } catch {
        audioSegments = [];
        combinedSegmentAudioData = [];
      }
    }

    if (audioSegments.length === 0) {
      await this.deleteNarrationArtifacts(jobId);
      await this.updateJob(jobId, {
        error: null,
        audioUrl: null,
        playlistUrl: null,
        audioSegments: [],
        durationSeconds: null,
      });
    }

    try {
      const playlistKey = buildNarrationPlaylistKey(jobId);
      let playlistUrl: string | null = audioSegments.length > 0 ? claimedJob.playlistUrl : null;
      const nextSegmentIndex = { value: audioSegments.length };
      const pendingSegments = new Map<number, AudioJob["audioSegments"][number]>();
      const pendingCombinedAudioData = new Map<number, Buffer>();
      let nextPlaylistIndex = audioSegments.length;
      let playlistWrite = Promise.resolve();
      let workerError: unknown = null;
      const queuePlaylistFlush = () => {
        playlistWrite = playlistWrite.then(async () => {
          let didAdvance = false;
          while (pendingSegments.has(nextPlaylistIndex)) {
            audioSegments.push(pendingSegments.get(nextPlaylistIndex)!);
            combinedSegmentAudioData.push(pendingCombinedAudioData.get(nextPlaylistIndex)!);
            pendingSegments.delete(nextPlaylistIndex);
            pendingCombinedAudioData.delete(nextPlaylistIndex);
            nextPlaylistIndex += 1;
            didAdvance = true;
          }

          if (!didAdvance) {
            return;
          }

          playlistUrl = await this.audioStore.put(
            playlistKey,
            Buffer.from(buildPlaylist(audioSegments, false), "utf8"),
            "application/vnd.apple.mpegurl",
            { overwrite: true },
          );

          await this.updateJob(jobId, {
            status: "processing",
            audioUrl: null,
            playlistUrl,
            audioSegments: [...audioSegments],
            durationSeconds: null,
          });
        });

        return playlistWrite;
      };
      const runWorker = async () => {
        while (workerError === null) {
          const index = nextSegmentIndex.value;
          nextSegmentIndex.value += 1;
          if (index >= segmentTexts.length) {
            return;
          }

          try {
            const textChunk = segmentTexts[index]!;
            const result = await synthesizeSegmentWithRetry(
              this.speechProvider,
              textChunk,
              claimedJob.speechOptions,
              {
                audioStore: this.audioStore,
                fileKey: buildNarrationSegmentKey(jobId, index),
              },
            );

            if (!result.audioUrl || !result.audioData) {
              throw new Error("Segment generation did not return playable audio.");
            }

            pendingSegments.set(index, {
              url: result.audioUrl,
              durationSeconds: result.durationSeconds,
            });
            pendingCombinedAudioData.set(index, stripLeadingID3Tag(result.audioData));
            await queuePlaylistFlush();
          } catch (error) {
            workerError ??= error;
            return;
          }
        }
      };
      const workerCount = Math.min(
        getTtsConcurrency(),
        Math.max(segmentTexts.length - audioSegments.length, 1),
      );

      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      await playlistWrite;

      if (workerError) {
        throw workerError;
      }

      playlistUrl = await this.audioStore.put(
        playlistKey,
        Buffer.from(buildPlaylist(audioSegments, true), "utf8"),
        "application/vnd.apple.mpegurl",
        { overwrite: true },
      );
      const finalAudioUrl = await this.audioStore.put(
        buildNarrationFinalAudioKey(jobId),
        Buffer.concat(combinedSegmentAudioData),
        "audio/mpeg",
        { overwrite: true },
      );
      const durationSeconds = audioSegments.reduce(
        (total, segment) => total + segment.durationSeconds,
        0,
      );

      await this.updateJob(jobId, {
        status: "completed",
        audioUrl: finalAudioUrl,
        playlistUrl,
        audioSegments,
        durationSeconds,
        error: null,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Speech generation failed.";
      await this.deleteNarrationArtifacts(jobId);
      Sentry.captureException(error, {
        tags: {
          jobId,
          voice: claimedJob.speechOptions.voice,
          provider: claimedJob.provider,
        },
        contexts: {
          job: {
            id: jobId,
            articleUrl: claimedJob.article.url,
            articleTitle: claimedJob.article.title,
            wordCount: claimedJob.article.wordCount,
            voice: claimedJob.speechOptions.voice,
            provider: claimedJob.provider,
          },
        },
      });
      trackEvent("tts_failed", {
        job_id: jobId,
        voice: claimedJob.speechOptions.voice,
        error: message,
      });
      await this.updateJob(jobId, {
        status: "failed",
        playlistUrl: null,
        audioSegments: [],
        durationSeconds: null,
        error: message,
      });
    }
  }

  getAvailableVoices(): string[] {
    return [...AVAILABLE_VOICES];
  }

  async getOrCreateVoicePreview(
    voice: string,
  ): Promise<{ voice: string; audioUrl: string }> {
    if (
      !AVAILABLE_VOICES.includes(voice as (typeof AVAILABLE_VOICES)[number])
    ) {
      throw new Error("Unsupported voice.");
    }

    const fileKey = `previews/${buildAudioFileKey("voice-preview", voice)}`;

    // Return cached preview if it exists
    const existingUrl = await this.audioStore.head(fileKey);
    if (existingUrl) {
      return { voice, audioUrl: existingUrl };
    }

    const result = await this.speechProvider.synthesizeText(
      VOICE_PREVIEW_TEXT,
      { voice },
      { audioStore: this.audioStore, fileKey },
    );

    if (!result.audioUrl) {
      throw new Error("Voice preview generation failed.");
    }

    return { voice, audioUrl: result.audioUrl };
  }

  async requeueInterruptedJobs(): Promise<void> {
    await this.init();
    const jobs = await this.jobStore.getAll();

    for (const job of jobs) {
      if (job.status === "processing") {
        // Reset interrupted mid-processing jobs back to queued before retrying.
        await this.updateJob(job.id, {
          status: "queued",
          error: "Job resumed after server restart.",
        });
        void this.processJob(job.id);
      } else if (job.status === "queued") {
        // Pick up jobs that were saved but never claimed before the server restarted.
        void this.processJob(job.id);
      }
    }
  }

  private async updateJob(jobId: string, patch: Partial<AudioJob>) {
    await this.jobStore.update(jobId, patch);
  }

  private async deleteNarrationArtifacts(
    jobId: string,
  ): Promise<void> {
    await this.audioStore.deletePrefix(buildNarrationJobDirectory(jobId));
  }

  private async restorePersistedSegments(
    jobId: string,
    persistedSegments: AudioJob["audioSegments"],
  ): Promise<{
    audioSegments: AudioJob["audioSegments"];
    combinedAudioData: Buffer[];
  }> {
    const combinedAudioData: Buffer[] = [];
    const restoredSegments: AudioJob["audioSegments"] = [];

    for (let index = 0; index < persistedSegments.length; index += 1) {
      const storedAudioData = await this.audioStore.get(buildNarrationSegmentKey(jobId, index));
      if (!storedAudioData) {
        throw new Error(`Missing audio data for persisted segment ${index}.`);
      }

      combinedAudioData.push(stripLeadingID3Tag(storedAudioData));
      restoredSegments.push({
        ...persistedSegments[index]!,
        durationSeconds:
          measureMP3DurationSeconds(storedAudioData) ?? persistedSegments[index]!.durationSeconds,
      });
    }

    return {
      audioSegments: restoredSegments,
      combinedAudioData,
    };
  }
}

function resolveSpeechOptions(input?: Partial<SpeechOptions>): SpeechOptions {
  return {
    voice: input?.voice?.trim() || DEFAULT_SPEECH_OPTIONS.voice,
  };
}

export function isTerminalStatus(status: AudioJobStatus): boolean {
  return status === "completed" || status === "failed";
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const MAX_SEGMENT_CHARS = 800;
const DEFAULT_TTS_CONCURRENCY = 5;
const DEFAULT_SEGMENT_RETRY_ATTEMPTS = 2;
const SEGMENT_RETRY_BASE_DELAY_MS = 500;

function getTtsConcurrency(): number {
  const parsed = Number(process.env.TTS_CONCURRENCY ?? DEFAULT_TTS_CONCURRENCY);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TTS_CONCURRENCY;
}

function getSegmentRetryAttempts(): number {
  const parsed = Number(
    process.env.TTS_SEGMENT_RETRY_ATTEMPTS ?? DEFAULT_SEGMENT_RETRY_ATTEMPTS,
  );
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SEGMENT_RETRY_ATTEMPTS;
}

async function synthesizeSegmentWithRetry(
  speechProvider: SpeechProvider,
  text: string,
  speechOptions: SpeechOptions,
  context: { audioStore: AudioStore; fileKey: string },
) {
  let attempt = 0;
  let lastError: unknown;
  const maxRetries = getSegmentRetryAttempts();

  while (attempt <= maxRetries) {
    try {
      return await speechProvider.synthesizeText(text, speechOptions, context);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableSegmentError(error)) {
        throw error;
      }

      await delay(SEGMENT_RETRY_BASE_DELAY_MS * (attempt + 1));
      attempt += 1;
    }
  }

  throw lastError;
}

function isRetryableSegmentError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      /(^|\s)bad gateway(\s|$)/i.test(error.message) ||
      /gateway timeout/i.test(message) ||
      /timed out/i.test(message) ||
      /timeout/i.test(message) ||
      /fetch failed/i.test(message) ||
      /econnreset/i.test(message) ||
      /eai_again/i.test(message) ||
      /temporarily unavailable/i.test(message) ||
      /openai speech generation failed: 5\d\d/i.test(message)
    );
  }

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildNarrationPlaylistKey(jobId: string): string {
  return `${buildNarrationJobDirectory(jobId)}/playlist.m3u8`;
}

function buildNarrationSegmentKey(jobId: string, index: number): string {
  return `${buildNarrationJobDirectory(jobId)}/segment-${index}.mp3`;
}

function buildNarrationFinalAudioKey(jobId: string): string {
  return `${buildNarrationJobDirectory(jobId)}/final.mp3`;
}

function buildNarrationJobDirectory(jobId: string): string {
  return `narrations/job-${jobId}`;
}

function buildPlaylist(
  audioSegments: AudioJob["audioSegments"],
  isComplete: boolean,
): string {
  const targetDuration = Math.max(
    1,
    ...audioSegments.map((segment) => Math.ceil(segment.durationSeconds)),
  );
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:" + targetDuration,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES",
  ];

  for (const segment of audioSegments) {
    lines.push(`#EXTINF:${segment.durationSeconds.toFixed(3)},`);
    lines.push(segment.url);
  }

  if (isComplete) {
    lines.push("#EXT-X-ENDLIST");
  }

  return lines.join("\n") + "\n";
}

function stripLeadingID3Tag(audioData: Buffer): Buffer {
  if (
    audioData.length < 10 ||
    audioData[0] !== 0x49 ||
    audioData[1] !== 0x44 ||
    audioData[2] !== 0x33
  ) {
    return audioData;
  }

  const flags = audioData[5] ?? 0;
  const footerLength = (flags & 0x10) !== 0 ? 10 : 0;
  const offset = Math.min(10 + synchsafeInteger(audioData.subarray(6, 10)) + footerLength, audioData.length);
  return audioData.subarray(offset);
}

function synchsafeInteger(bytes: Buffer): number {
  return (
    ((bytes[0] ?? 0) << 21) |
    ((bytes[1] ?? 0) << 14) |
    ((bytes[2] ?? 0) << 7) |
    (bytes[3] ?? 0)
  );
}
