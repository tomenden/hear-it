import * as Sentry from "@sentry/node";
import { trackEvent } from "./analytics.js";
import { extractArticle } from "./extractor.js";
import {
  DEFAULT_SPEECH_OPTIONS,
  AVAILABLE_VOICES,
  VOICE_PREVIEW_TEXT,
  buildAudioFileKey,
  createSpeechProvider,
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
      await this.deleteNarrationArtifacts(jobId, existingJob.audioSegments.length);
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

    const hadPersistedSegments = claimedJob.audioSegments.length > 0;
    if (!hadPersistedSegments) {
      await this.deleteNarrationArtifacts(jobId, 0);
      await this.updateJob(jobId, {
        error: null,
        audioUrl: null,
        playlistUrl: null,
        audioSegments: [],
        durationSeconds: null,
      });
    }

    try {
      const segmentTexts = chunkNarrationText(
        claimedJob.article.textContent,
      );
      const audioSegments: AudioJob["audioSegments"] = [...claimedJob.audioSegments];
      const playlistKey = buildNarrationPlaylistKey(jobId);
      let playlistUrl: string | null = claimedJob.playlistUrl;
      const nextSegmentIndex = { value: audioSegments.length };
      const pendingSegments = new Map<number, AudioJob["audioSegments"][number]>();
      let nextPlaylistIndex = audioSegments.length;
      let playlistWrite = Promise.resolve();
      let workerError: unknown = null;
      const queuePlaylistFlush = () => {
        playlistWrite = playlistWrite.then(async () => {
          let didAdvance = false;
          while (pendingSegments.has(nextPlaylistIndex)) {
            audioSegments.push(pendingSegments.get(nextPlaylistIndex)!);
            pendingSegments.delete(nextPlaylistIndex);
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
            const result = await this.speechProvider.synthesizeText(
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
      const durationSeconds = audioSegments.reduce(
        (total, segment) => total + segment.durationSeconds,
        0,
      );

      await this.updateJob(jobId, {
        status: "completed",
        audioUrl: null,
        playlistUrl,
        audioSegments,
        durationSeconds,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Speech generation failed.";
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
        await this.updateJob(job.id, {
          status: "queued",
          error: "Job resumed after server restart.",
        });
        void this.processJob(job.id);
      }
    }
  }

  private async updateJob(jobId: string, patch: Partial<AudioJob>) {
    await this.jobStore.update(jobId, patch);
  }

  private async deleteNarrationArtifacts(
    jobId: string,
    segmentCount: number,
  ): Promise<void> {
    await this.audioStore.delete(buildNarrationPlaylistKey(jobId));

    for (let index = 0; index < segmentCount; index += 1) {
      await this.audioStore.delete(buildNarrationSegmentKey(jobId, index));
    }
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

function getTtsConcurrency(): number {
  const parsed = Number(process.env.TTS_CONCURRENCY ?? DEFAULT_TTS_CONCURRENCY);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TTS_CONCURRENCY;
}

export function chunkNarrationText(text: string, maxChars = MAX_SEGMENT_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const blocks = trimmed
    .split(/\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let currentChunk = "";

  const pushPiece = (piece: string) => {
    if (!piece) return;

    if (!currentChunk) {
      currentChunk = piece;
      return;
    }

    if (currentChunk.length + 2 + piece.length <= maxChars) {
      currentChunk = `${currentChunk}\n\n${piece}`;
      return;
    }

    chunks.push(currentChunk);
    currentChunk = piece;
  };

  const splitLongBlock = (block: string) =>
    block.split(/(?<=[.!?])\s+/).map((piece) => piece.trim()).filter(Boolean);

  for (const block of blocks.length > 0 ? blocks : [trimmed]) {
    if (block.length <= maxChars) {
      pushPiece(block);
      continue;
    }

    for (const sentence of splitLongBlock(block)) {
      if (sentence.length <= maxChars) {
        pushPiece(sentence);
        continue;
      }

      let startIndex = 0;
      while (startIndex < sentence.length) {
        pushPiece(sentence.slice(startIndex, startIndex + maxChars).trim());
        startIndex += maxChars;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length > 0 ? chunks : [trimmed];
}

function buildNarrationPlaylistKey(jobId: string): string {
  return `narrations/job-${jobId}/playlist.m3u8`;
}

function buildNarrationSegmentKey(jobId: string, index: number): string {
  return `narrations/job-${jobId}/segment-${index}.mp3`;
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
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:" + targetDuration,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
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
