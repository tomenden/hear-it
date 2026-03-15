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

  async createJob(input: CreateAudioJobInput): Promise<AudioJob> {
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
    };

    await this.jobStore.save(job);
    return job;
  }

  async getJob(jobId: string): Promise<AudioJob | null> {
    await this.init();
    return this.jobStore.get(jobId);
  }

  async listJobs(): Promise<AudioJob[]> {
    await this.init();
    return this.jobStore.getAll();
  }

  async processJob(jobId: string): Promise<void> {
    await this.init();
    const queuedJob = await this.jobStore.get(jobId);
    if (!queuedJob || queuedJob.status !== "queued") {
      return;
    }

    await this.updateJob(jobId, { status: "processing", error: null });

    try {
      const fileKey = buildAudioFileKey(
        queuedJob.article.title ?? queuedJob.article.url,
        queuedJob.speechOptions.voice,
        `job-${jobId}`,
      );

      const result = await this.speechProvider.synthesize(
        queuedJob.article,
        queuedJob.speechOptions,
        { audioStore: this.audioStore, fileKey },
      );

      await this.updateJob(jobId, {
        status: "completed",
        audioUrl: result.audioUrl,
        playlistUrl: result.playlistUrl,
        audioSegments: result.audioSegments,
        durationSeconds: result.durationSeconds,
      });
    } catch (error) {
      await this.updateJob(jobId, {
        status: "failed",
        error:
          error instanceof Error ? error.message : "Speech generation failed.",
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
}

function resolveSpeechOptions(input?: Partial<SpeechOptions>): SpeechOptions {
  return {
    voice: input?.voice?.trim() || DEFAULT_SPEECH_OPTIONS.voice,
  };
}

export function isTerminalStatus(status: AudioJobStatus): boolean {
  return status === "completed" || status === "failed";
}
