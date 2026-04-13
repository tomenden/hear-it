import * as Sentry from "@sentry/node";
import { randomUUID } from "node:crypto";

import { trackEvent } from "./analytics.js";
import { extractArticle } from "./extractor.js";
import type { FfmpegMediaPackager } from "./ffmpeg-media-packager.js";
import { createFfmpegMediaPackager } from "./ffmpeg-media-packager.js";
import { createJobPipeline, LostJobLeaseError } from "./job-pipeline.js";
import { createJobEventRecorder } from "./job-observability.js";
import type { AudioStore, JobOwnership, JobStore } from "./storage.js";
import { chunkSpeechScript } from "./text-chunker.js";
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
      audioSegments: [],
      durationSeconds: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      userId: userId ?? null,
    };

    await this.jobStore.save(job);
    const eventRecorder = await createJobEventRecorder(this.jobStore, jobId);
    await eventRecorder?.record("job_created", {
      voice: speechOptions.voice,
      url: article.url,
      estimatedMinutes: article.estimatedMinutes,
      wordCount: article.wordCount,
      userId: userId ?? null,
    });

    const domain = safeHostname(article.url);
    trackEvent("audio_created", {
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
      await this.deleteJobArtifacts(jobId);
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
    const eventRecorder = await createJobEventRecorder(this.jobStore, jobId);
    await eventRecorder?.record("job_claimed", {
      leaseOwner: ownership.leaseOwner,
      leaseExpiresAt: claimedJob.leaseExpiresAt ?? null,
      runId,
      attempt: claimedJob.attempt ?? null,
    });
    const leaseState = { lost: false };
    const stopHeartbeat = this.startLeaseHeartbeat(jobId, ownership, leaseState);
    let chunksReadyObserved = claimedJob.audioSegments.length;
    let chunksTotalObserved = resolveChunksTotal(claimedJob);

    const shouldStartFresh =
      claimedJob.audioSegments.length === 0 &&
      !claimedJob.audioUrl;

    try {
      if (shouldStartFresh) {
        try {
          await this.deleteJobArtifacts(jobId);
        } catch (error) {
          const cleanupFailed = await this.updateOwnedJob(
            jobId,
            {
              status: "failed",
              internalState: "failed",
              audioUrl: null,
              audioSegments: [],
              durationSeconds: null,
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to clean up previous audio artifacts.",
            },
            ownership,
          );
          if (!cleanupFailed) {
            leaseState.lost = true;
          }
          return;
        }
      }

      const pipeline = createJobPipeline({
        audioStore: this.audioStore,
        speechProvider: this.speechProvider,
        mediaPackager: this.mediaPackager,
        shouldAbort: () => leaseState.lost,
        onPlaybackReady: async ({ finalAudioUrl, durationSeconds, audioSegmentsCount }) => {
          await eventRecorder?.record("playback_ready", {
            finalAudioUrl,
            durationSeconds,
            audioSegmentsCount,
            source: "pipeline_upload",
          });
        },
        onJobUpdate: async (patch, snapshot) => {
          if (leaseState.lost) {
            throw new LostJobLeaseError();
          }

          const updated = await this.updateOwnedJob(jobId, patch, ownership);
          if (!updated) {
            leaseState.lost = true;
            throw new LostJobLeaseError();
          }

          chunksTotalObserved ??= resolveChunksTotal(snapshot);
          if (snapshot.audioSegments.length > chunksReadyObserved) {
            chunksReadyObserved = snapshot.audioSegments.length;
            await eventRecorder?.record("chunk_ready", {
              chunksReady: chunksReadyObserved,
              chunksTotal: chunksTotalObserved,
              availableDurationSeconds: snapshot.audioSegments.reduce(
                (total, segment) => total + segment.durationSeconds,
                0,
              ),
              internalState: snapshot.internalState ?? null,
            });
          }

          if (patch.status === "completed" && snapshot.audioUrl) {
            await eventRecorder?.record("job_completed", {
              finalAudioUrl: snapshot.audioUrl,
              durationSeconds: snapshot.durationSeconds,
              chunksReady: snapshot.audioSegments.length,
              chunksTotal: chunksTotalObserved,
              source: "pipeline",
            });
          } else if (patch.status === "failed") {
            await eventRecorder?.record("job_failed", {
              error: snapshot.error ?? null,
              internalState: snapshot.internalState ?? null,
            });
          }
        },
      });

      const result = await pipeline.processClaimedJob(claimedJob);
      if (leaseState.lost && result.job.status === "completed" && result.job.audioUrl) {
        const persistedJob = await this.jobStore.get(jobId);
        if (!isPersistedPlaybackReady(persistedJob, result.job.audioUrl)) {
          Sentry.captureMessage("Audio finalization missed completion persistence.", {
            level: "warning",
            tags: {
              jobId,
              leaseOwner: ownership.leaseOwner,
              runId,
              provider: claimedJob.provider,
            },
            extra: {
              finalAudioUrl: result.job.audioUrl,
              durationSeconds: result.job.durationSeconds,
              chunksReady: result.job.audioSegments.length,
              chunksTotal: chunksTotalObserved,
              persistedStatus: persistedJob?.status ?? null,
              persistedAudioUrl: persistedJob?.audioUrl ?? null,
            },
          });
        }
      }
      if (result.job.status === "failed" && result.job.error) {
        trackEvent("audio_failed", {
          job_id: jobId,
          voice: claimedJob.speechOptions.voice,
          error: result.job.error,
        });
      }
    } finally {
      stopHeartbeat();
      const released = !leaseState.lost
        ? await this.updateOwnedJob(
            jobId,
            {
              leaseOwner: null,
              leaseExpiresAt: null,
              runId: null,
            },
            ownership,
          )
        : false;

      if (!released) {
        await this.releaseObservedTerminalLease(jobId, ownership);
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
    const resumedJobs: Promise<void>[] = [];

    for (const job of jobs) {
      if (job.status === "processing") {
        await this.updateJob(job.id, {
          status: "queued",
          internalState: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          runId: null,
          error: "Job resumed after server restart.",
        });
        resumedJobs.push(this.processJob(job.id));
      } else if (job.status === "queued") {
        resumedJobs.push(this.processJob(job.id));
      }
    }

    const results = await Promise.allSettled(resumedJobs);
    const failedResults = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (failedResults.length > 0) {
      if (failedResults.length === 1) {
        throw failedResults[0].reason;
      }

      throw new AggregateError(
        failedResults.map((result) => result.reason),
        "One or more interrupted jobs failed to resume.",
      );
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

  private async releaseObservedTerminalLease(
    jobId: string,
    ownership: JobOwnership,
  ): Promise<void> {
    const observedJob = await this.jobStore.get(jobId);
    if (
      !observedJob ||
      !isTerminalStatus(observedJob.status) ||
      observedJob.leaseOwner !== ownership.leaseOwner ||
      observedJob.runId !== ownership.runId
    ) {
      return;
    }

    await this.jobStore.updateIfLeaseSnapshotMatches(
      jobId,
      {
        leaseOwner: null,
        leaseExpiresAt: null,
        runId: null,
      },
      {
        status: observedJob.status,
        leaseOwner: observedJob.leaseOwner,
        leaseExpiresAt: observedJob.leaseExpiresAt ?? null,
        runId: observedJob.runId,
      },
    );
  }

  private async deleteJobArtifacts(jobId: string): Promise<void> {
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

function resolveChunksTotal(job: AudioJob): number | null {
  if (!job.speechScript) {
    return null;
  }

  return chunkSpeechScript({ script: job.speechScript }).length;
}

function isPersistedPlaybackReady(
  job: AudioJob | null,
  expectedAudioUrl: string,
): boolean {
  return job?.status === "completed" && job.audioUrl === expectedAudioUrl;
}
