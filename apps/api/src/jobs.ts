import { randomUUID } from "node:crypto";

import { trackEvent } from "./analytics.js";
import { extractArticle } from "./extractor.js";
import type { FfmpegMediaPackager } from "./ffmpeg-media-packager.js";
import { createFfmpegMediaPackager } from "./ffmpeg-media-packager.js";
import { createJobPipeline, LostJobLeaseError } from "./job-pipeline.js";
import type { AudioStore, JobOwnership, JobStore } from "./storage.js";
import {
  AVAILABLE_VOICES,
  DEFAULT_SPEECH_OPTIONS,
  VOICE_PREVIEW_TEXT,
  buildAudioFileKey,
  createSpeechProvider,
  type SpeechProvider,
} from "./tts.js";
import type {
  AudioJob,
  AudioJobStatus,
  CreateAudioJobInput,
  SpeechOptions,
} from "./types.js";

const DEFAULT_JOB_LEASE_MS = 60_000;
const DEFAULT_JOB_HEARTBEAT_MS = 15_000;

export class AudioJobService {
  private readonly jobStore: JobStore;
  private readonly audioStore: AudioStore;
  private readonly speechProvider: SpeechProvider;
  private readonly mediaPackager: FfmpegMediaPackager;
  private readonly leaseOwner: string;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private initPromise: Promise<void> | null = null;

  constructor(options: {
    jobStore: JobStore;
    audioStore: AudioStore;
    speechProvider?: SpeechProvider;
    mediaPackager?: FfmpegMediaPackager;
    leaseOwner?: string;
    leaseDurationMs?: number;
    heartbeatIntervalMs?: number;
  }) {
    this.jobStore = options.jobStore;
    this.audioStore = options.audioStore;
    this.speechProvider = options.speechProvider ?? createSpeechProvider();
    this.mediaPackager = options.mediaPackager ?? createFfmpegMediaPackager();
    this.leaseOwner =
      options.leaseOwner?.trim() ||
      `job-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_JOB_LEASE_MS;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_JOB_HEARTBEAT_MS;
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.jobStore.init().catch((error) => {
        this.initPromise = null;
        throw error;
      });
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
    const runId = randomUUID();
    const claimedJob = await this.jobStore.claimQueued(jobId, {
      leaseOwner: this.leaseOwner,
      leaseExpiresAt: createLeaseExpiry(this.leaseDurationMs),
      runId,
    });
    if (!claimedJob) {
      return;
    }

    const ownership: JobOwnership = {
      leaseOwner: this.leaseOwner,
      runId,
    };
    const leaseState = { lost: false };
    const stopHeartbeat = this.startLeaseHeartbeat(jobId, ownership, leaseState);

    const shouldStartFresh =
      claimedJob.audioSegments.length === 0 &&
      !claimedJob.audioUrl &&
      !claimedJob.playlistUrl;

    try {
      if (shouldStartFresh) {
        await this.deleteNarrationArtifacts(jobId);
      }

      const pipeline = createJobPipeline({
        audioStore: this.audioStore,
        speechProvider: this.speechProvider,
        mediaPackager: this.mediaPackager,
        shouldAbort: () => leaseState.lost,
        onJobUpdate: async (patch) => {
          if (leaseState.lost) {
            throw new LostJobLeaseError();
          }

          const updated = await this.updateOwnedJob(jobId, patch, ownership);
          if (!updated) {
            leaseState.lost = true;
            throw new LostJobLeaseError();
          }
        },
      });

      const result = await pipeline.processClaimedJob(claimedJob);
      if (result.job.status === "failed" && result.job.error) {
        trackEvent("tts_failed", {
          job_id: jobId,
          voice: claimedJob.speechOptions.voice,
          error: result.job.error,
        });
      }
    } finally {
      stopHeartbeat();
      if (!leaseState.lost) {
        await this.updateOwnedJob(
          jobId,
          {
            leaseOwner: null,
            leaseExpiresAt: null,
            runId: null,
          },
          ownership,
        );
      }
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
      } else if (job.status === "queued") {
        void this.processJob(job.id);
      }
    }
  }

  private async updateJob(jobId: string, patch: Partial<AudioJob>) {
    await this.jobStore.update(jobId, patch);
  }

  private async updateOwnedJob(
    jobId: string,
    patch: Partial<AudioJob>,
    ownership: JobOwnership,
  ) {
    return this.jobStore.updateOwned(jobId, patch, ownership);
  }

  private async deleteNarrationArtifacts(jobId: string): Promise<void> {
    const pipeline = createJobPipeline({
      audioStore: this.audioStore,
      speechProvider: this.speechProvider,
      mediaPackager: this.mediaPackager,
    });
    await pipeline.deleteJobArtifacts(jobId);
  }

  private startLeaseHeartbeat(
    jobId: string,
    ownership: JobOwnership,
    leaseState: { lost: boolean },
  ): () => void {
    if (!this.jobStore.heartbeat || this.heartbeatIntervalMs <= 0) {
      return () => {};
    }

    const timer = setInterval(() => {
      void this.jobStore
        .heartbeat?.(
          jobId,
          ownership.leaseOwner,
          createLeaseExpiry(this.leaseDurationMs),
          ownership.runId,
        )
        .then((updated) => {
          if (!updated) {
            leaseState.lost = true;
          }
        })
        .catch(() => {
          leaseState.lost = true;
        });
    }, this.heartbeatIntervalMs);
    timer.unref?.();

    return () => clearInterval(timer);
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

function createLeaseExpiry(durationMs: number): string {
  return new Date(Date.now() + durationMs).toISOString();
}
