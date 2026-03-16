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
    await this.audioStore.delete(`narrations/narration-${jobId}.mp3`);
    if (userId) return this.jobStore.deleteForUser(jobId, userId);
    return this.jobStore.delete(jobId);
  }

  async processJob(jobId: string): Promise<void> {
    await this.init();
    const queuedJob = await this.jobStore.get(jobId);
    if (!queuedJob || queuedJob.status !== "queued") {
      return;
    }

    await this.updateJob(jobId, { status: "processing", error: null });

    try {
      const result = await this.speechProvider.synthesize(
        queuedJob.article,
        queuedJob.speechOptions,
        {},
      );

      let audioUrl: string | null = null;
      if (result.audioData) {
        const key = `narrations/narration-${jobId}.mp3`;
        audioUrl = await this.audioStore.put(
          key,
          result.audioData,
          result.contentType ?? "audio/mpeg",
        );
      }

      await this.updateJob(jobId, {
        status: "completed",
        audioUrl,
        playlistUrl: result.playlistUrl,
        audioSegments: result.audioSegments,
        durationSeconds: result.durationSeconds,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Speech generation failed.";
      Sentry.captureException(error, {
        tags: {
          jobId,
          voice: queuedJob.speechOptions.voice,
          provider: queuedJob.provider,
        },
        contexts: {
          job: {
            id: jobId,
            articleUrl: queuedJob.article.url,
            articleTitle: queuedJob.article.title,
            wordCount: queuedJob.article.wordCount,
            voice: queuedJob.speechOptions.voice,
            provider: queuedJob.provider,
          },
        },
      });
      trackEvent("tts_failed", {
        job_id: jobId,
        voice: queuedJob.speechOptions.voice,
        error: message,
      });
      await this.updateJob(jobId, {
        status: "failed",
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

  /** Returns the blob URL for the narration audio, or null if not yet stored. */
  async getNarrationAudioUrl(jobId: string): Promise<string | null> {
    return this.audioStore.head(`narrations/narration-${jobId}.mp3`);
  }

  /** Delete the narration audio blob (cleanup after client download). */
  async deleteNarrationAudio(jobId: string): Promise<void> {
    await this.audioStore.delete(`narrations/narration-${jobId}.mp3`);
  }

  buildNarrationDownloadPath(jobId: string): string {
    return `/api/jobs/${jobId}/audio`;
  }

  private async updateJob(jobId: string, patch: Partial<AudioJob>) {
    await this.jobStore.update(jobId, patch);
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
