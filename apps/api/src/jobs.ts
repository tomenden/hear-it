import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { extractArticle } from "./extractor.js";
import {
  DEFAULT_SPEECH_OPTIONS,
  AVAILABLE_VOICES,
  VOICE_PREVIEW_TEXT,
  buildAudioFileStem,
  createSpeechProvider,
  type SpeechProvider,
} from "./tts.js";
import type {
  AudioJob,
  AudioJobStatus,
  CreateAudioJobInput,
  SpeechOptions,
} from "./types.js";

export class AudioJobService {
  private readonly jobs = new Map<string, AudioJob>();
  private readonly speechProvider: SpeechProvider;
  private readonly audioOutputDir: string;
  private readonly audioPublicBaseUrl: string;
  private readonly jobsFilePath: string;
  private nextId = 1;
  private initPromise: Promise<void> | null = null;

  constructor(options?: {
    speechProvider?: SpeechProvider;
    audioOutputDir?: string;
    audioPublicBaseUrl?: string;
    jobsFilePath?: string;
  }) {
    this.audioOutputDir = resolve(
      options?.audioOutputDir ?? process.env.AUDIO_OUTPUT_DIR ?? "data/audio",
    );
    this.jobsFilePath = resolve(options?.jobsFilePath ?? process.env.JOBS_FILE_PATH ?? "data/jobs.json");
    this.audioPublicBaseUrl =
      options?.audioPublicBaseUrl ?? process.env.AUDIO_PUBLIC_BASE_URL ?? "/audio";
    this.speechProvider = options?.speechProvider ?? createSpeechProvider();
  }

  async ensureStorage(): Promise<void> {
    await mkdir(this.audioOutputDir, { recursive: true });
    await mkdir(dirname(this.jobsFilePath), { recursive: true });
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.loadPersistedJobs();
    }

    await this.initPromise;
  }

  getAudioOutputDir(): string {
    return this.audioOutputDir;
  }

  getAudioPublicBaseUrl(): string {
    return this.audioPublicBaseUrl;
  }

  getProviderName(): string {
    return this.speechProvider.name;
  }

  async createJob(input: CreateAudioJobInput): Promise<AudioJob> {
    await this.init();
    await this.ensureStorage();
    const article = await extractArticle(input);
    const speechOptions = resolveSpeechOptions(input.speechOptions);
    const timestamp = new Date().toISOString();
    const jobId = String(this.nextId++);
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

    this.jobs.set(job.id, job);
    await this.persistJobs();
    void this.processJob(job.id);

    return job;
  }

  getJob(jobId: string): AudioJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  listJobs(): AudioJob[] {
    return Array.from(this.jobs.values()).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async processJob(jobId: string): Promise<void> {
    await this.init();
    const queuedJob = this.jobs.get(jobId);
    if (!queuedJob || queuedJob.status !== "queued") {
      return;
    }

    await this.updateJob(jobId, { status: "processing", error: null });

    try {
      const result = await this.speechProvider.synthesize(
        queuedJob.article,
        queuedJob.speechOptions,
        {
          outputDir: this.audioOutputDir,
          publicBaseUrl: this.audioPublicBaseUrl,
          fileStem: buildAudioFileStem(
            queuedJob.article.title ?? queuedJob.article.url,
            queuedJob.speechOptions.voice,
            `job-${jobId}`,
          ),
        },
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
        error: error instanceof Error ? error.message : "Speech generation failed.",
      });
    }
  }

  getAvailableVoices(): string[] {
    return [...AVAILABLE_VOICES];
  }

  async getOrCreateVoicePreview(voice: string): Promise<{ voice: string; audioUrl: string }> {
    if (!AVAILABLE_VOICES.includes(voice as (typeof AVAILABLE_VOICES)[number])) {
      throw new Error("Unsupported voice.");
    }

    await this.ensureStorage();
    const previewOutputDir = join(this.audioOutputDir, "previews");
    const previewPublicBaseUrl = `${this.audioPublicBaseUrl}/previews`;
    await mkdir(previewOutputDir, { recursive: true });
    const fileStem = buildAudioFileStem("voice-preview", voice);
    const fileName = `${fileStem}.mp3`;
    const filePath = join(previewOutputDir, fileName);

    try {
      await access(filePath);
      return {
        voice,
        audioUrl: `${previewPublicBaseUrl}/${fileName}`,
      };
    } catch {
      const result = await this.speechProvider.synthesizeText(
        VOICE_PREVIEW_TEXT,
        { voice },
        {
          outputDir: previewOutputDir,
          publicBaseUrl: previewPublicBaseUrl,
          fileStem,
        },
      );

      if (!result.audioUrl) {
        throw new Error("Voice preview generation failed.");
      }

      return {
        voice,
        audioUrl: result.audioUrl,
      };
    }
  }

  async requeueInterruptedJobs(): Promise<void> {
    await this.init();

    for (const job of this.jobs.values()) {
      if (job.status === "processing") {
        await this.updateJob(job.id, {
          status: "queued",
          error: "Job resumed after server restart.",
        });
        void this.processJob(job.id);
      }
    }
  }

  private async loadPersistedJobs(): Promise<void> {
    await this.ensureStorage();

    try {
      const raw = await readFile(this.jobsFilePath, "utf8");
      const parsed = JSON.parse(raw) as { jobs?: AudioJob[] };
      const jobs = parsed.jobs ?? [];

      this.jobs.clear();
      for (const job of jobs) {
        this.jobs.set(job.id, job);
      }

      this.nextId = jobs.reduce((maxId, job) => {
        const numericId = Number(job.id);
        return Number.isFinite(numericId) ? Math.max(maxId, numericId + 1) : maxId;
      }, 1);
    } catch (error) {
      const errorCode = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;
      if (errorCode !== "ENOENT") {
        throw error;
      }
    }
  }

  private async persistJobs(): Promise<void> {
    const jobs = Array.from(this.jobs.values()).sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );

    await writeFile(this.jobsFilePath, JSON.stringify({ jobs }, null, 2), "utf8");
  }

  private async updateJob(jobId: string, patch: Partial<AudioJob>) {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return;
    }

    this.jobs.set(jobId, {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    });

    await this.persistJobs();
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
