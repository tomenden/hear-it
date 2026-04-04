import { describe, expect, it, vi } from "vitest";

import {
  buildFinalAudioKey,
  buildInitSegmentKey,
  buildPlaylistKey,
} from "./media-packager.js";
import {
  FinalizationRepairer,
  HlsRetentionCleaner,
  JobReconciler,
  MaintenanceRunner,
  startMaintenanceWorker,
} from "./maintenance.js";
import type {
  AudioStore,
  ExpiredLeaseSnapshot,
  JobOwnership,
  JobStore,
} from "./storage.js";
import type { AudioJob } from "./types.js";

class MemoryJobStore implements JobStore {
  readonly updates: Array<{ jobId: string; patch: Partial<AudioJob> }> = [];
  readonly leaseClaims: Array<{ leaseOwner: string; leaseExpiresAt: string }> = [];
  readonly requeueAttempts: Array<{ jobId: string; expected: ExpiredLeaseSnapshot }> = [];
  maintenanceLeaseOwner: string | null = null;
  maintenanceLeaseExpiresAt: string | null = null;
  failMaintenanceLeaseClaimAt: number | null = null;
  maintenanceLeaseClaimError: Error = new Error("maintenance lease renewal failed");
  onRequeueAttempt?: (
    jobId: string,
    expected: ExpiredLeaseSnapshot,
  ) => Promise<void> | void;
  private readonly jobs = new Map<string, AudioJob>();

  async init(): Promise<void> {}

  async check(): Promise<void> {}

  async getAll(): Promise<AudioJob[]> {
    return Array.from(this.jobs.values());
  }

  async get(jobId: string): Promise<AudioJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async save(job: AudioJob): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async claimQueued(_jobId: string): Promise<AudioJob | null> {
    return null;
  }

  async update(jobId: string, patch: Partial<AudioJob>): Promise<boolean> {
    const existing = this.jobs.get(jobId);
    if (!existing) {
      return false;
    }

    this.updates.push({ jobId, patch });
    this.jobs.set(jobId, {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? existing.updatedAt,
    });
    return true;
  }

  async updateOwned(
    jobId: string,
    patch: Partial<AudioJob>,
    _ownership: JobOwnership,
  ): Promise<boolean> {
    return this.update(jobId, patch);
  }

  async delete(_jobId: string): Promise<boolean> {
    return false;
  }

  async nextId(): Promise<string> {
    return "next-job-id";
  }

  async getAllForUser(userId: string): Promise<AudioJob[]> {
    return Array.from(this.jobs.values()).filter((job) => job.userId === userId);
  }

  async getForUser(jobId: string, userId: string): Promise<AudioJob | null> {
    const job = this.jobs.get(jobId);
    return job?.userId === userId ? job : null;
  }

  async deleteForUser(_jobId: string, _userId: string): Promise<boolean> {
    return false;
  }

  async claimMaintenanceLease(
    leaseOwner: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    this.leaseClaims.push({ leaseOwner, leaseExpiresAt });
    if (
      this.failMaintenanceLeaseClaimAt !== null &&
      this.leaseClaims.length >= this.failMaintenanceLeaseClaimAt
    ) {
      throw this.maintenanceLeaseClaimError;
    }

    const now = new Date().toISOString();
    const leaseIsLive =
      this.maintenanceLeaseOwner !== null &&
      this.maintenanceLeaseExpiresAt !== null &&
      this.maintenanceLeaseExpiresAt > now;

    if (leaseIsLive && this.maintenanceLeaseOwner !== leaseOwner) {
      return false;
    }

    this.maintenanceLeaseOwner = leaseOwner;
    this.maintenanceLeaseExpiresAt = leaseExpiresAt;
    return true;
  }

  async heartbeat(
    _jobId: string,
    _leaseOwner: string,
    _leaseExpiresAt: string,
    _runId: string,
  ): Promise<boolean> {
    return true;
  }

  async requeueExpiredLease(
    jobId: string,
    expected: ExpiredLeaseSnapshot,
  ): Promise<boolean> {
    this.requeueAttempts.push({ jobId, expected });
    await this.onRequeueAttempt?.(jobId, expected);

    const existing = this.jobs.get(jobId);
    if (!existing || existing.status !== "processing") {
      return false;
    }

    if (
      existing.leaseOwner !== expected.leaseOwner ||
      existing.runId !== expected.runId ||
      existing.leaseExpiresAt !== expected.leaseExpiresAt ||
      !existing.leaseExpiresAt ||
      existing.leaseExpiresAt > expected.now
    ) {
      return false;
    }

    this.jobs.set(jobId, {
      ...existing,
      status: "queued",
      internalState: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      runId: null,
      error: "Job re-queued after lease expiry.",
      updatedAt: expected.now,
    });
    return true;
  }
}

class MemoryAudioStore implements AudioStore {
  readonly deletedKeys: string[] = [];
  readonly deletedPrefixes: string[] = [];
  private readonly blobs = new Map<string, string>();

  async check(): Promise<void> {}

  async put(key: string, _data: Buffer): Promise<string> {
    const url = `/audio/${key}`;
    this.blobs.set(key, url);
    return url;
  }

  async head(key: string): Promise<string | null> {
    return this.blobs.get(key) ?? null;
  }

  async get(_key: string): Promise<Buffer | null> {
    return null;
  }

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.blobs.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    this.deletedPrefixes.push(prefix);
    for (const key of this.blobs.keys()) {
      if (key.startsWith(`${prefix}/`)) {
        this.blobs.delete(key);
      }
    }
  }

  seed(key: string, url = `/audio/${key}`): void {
    this.blobs.set(key, url);
  }
}

describe("maintenance services", () => {
  it("re-queues a job after lease expiry", async () => {
    const now = new Date("2026-04-05T12:00:00.000Z");
    const jobStore = new MemoryJobStore();
    const audioStore = new MemoryAudioStore();
    await jobStore.save(
      createJob({
        status: "processing",
        internalState: "synthesizing",
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-04-05T11:59:00.000Z",
        runId: "run-a",
      }),
    );

    const reconciler = new JobReconciler({ jobStore, audioStore });
    await reconciler.runOnce(now);

    expect(jobStore.requeueAttempts).toContainEqual({
      jobId: "job-123",
      expected: {
        leaseOwner: "worker-a",
        runId: "run-a",
        leaseExpiresAt: "2026-04-05T11:59:00.000Z",
        now: "2026-04-05T12:00:00.000Z",
      },
    });
    expect(await jobStore.get("job-123")).toMatchObject({
      status: "queued",
      internalState: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      runId: null,
      error: "Job re-queued after lease expiry.",
    });
  });

  it("cleans expired HLS assets after the retention window", async () => {
    const now = new Date("2026-04-05T18:00:01.000Z");
    const jobStore = new MemoryJobStore();
    const audioStore = new MemoryAudioStore();
    audioStore.seed("jobs/job-123/tmp/chunk-0000.mp3");
    audioStore.seed(buildInitSegmentKey("job-123"));
    await jobStore.save(
      createJob({
        status: "completed",
        internalState: "completed",
        audioUrl: "/audio/jobs/job-123/final.mp3",
        playlistUrl: "/audio/jobs/job-123/playlist.m3u8",
        liveEdgeUpdatedAt: "2026-04-05T12:00:00.000Z",
      }),
    );

    const cleaner = new HlsRetentionCleaner({ jobStore, audioStore });
    await cleaner.runOnce(now);

    expect(audioStore.deletedPrefixes).toContain("jobs/job-123/segments");
    expect(audioStore.deletedPrefixes).toContain("jobs/job-123/tmp");
    expect(audioStore.deletedKeys).toContain(buildPlaylistKey("job-123"));
    expect(audioStore.deletedKeys).toContain(buildInitSegmentKey("job-123"));
  });

  it("repairs a job whose final MP3 exists but state was not finalized", async () => {
    const now = new Date("2026-04-05T12:00:00.000Z");
    const jobStore = new MemoryJobStore();
    const audioStore = new MemoryAudioStore();
    audioStore.seed(buildFinalAudioKey("job-123"));
    await jobStore.save(
      createJob({
        status: "processing",
        internalState: "finalizing",
        playlistUrl: `/audio/${buildPlaylistKey("job-123")}`,
        audioUrl: null,
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-04-05T11:55:00.000Z",
        error: "stuck finalizing",
      }),
    );

    const repairer = new FinalizationRepairer({ jobStore, audioStore });
    await repairer.runOnce(now);

    expect(jobStore.updates).toContainEqual({
      jobId: "job-123",
      patch: expect.objectContaining({
        status: "completed",
        internalState: "completed",
        audioUrl: `/audio/${buildFinalAudioKey("job-123")}`,
        leaseOwner: null,
        leaseExpiresAt: null,
        runId: null,
        error: null,
      }),
    });
  });

  it("does not repair a job whose final MP3 exists while the live lease is still active", async () => {
    const now = new Date("2026-04-05T12:00:00.000Z");
    const jobStore = new MemoryJobStore();
    const audioStore = new MemoryAudioStore();
    audioStore.seed(buildFinalAudioKey("job-123"));
    await jobStore.save(
      createJob({
        status: "processing",
        internalState: "finalizing",
        audioUrl: null,
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-04-05T12:05:00.000Z",
        runId: "run-a",
        error: "stuck finalizing",
      }),
    );

    const repairer = new FinalizationRepairer({ jobStore, audioStore });
    await repairer.runOnce(now);

    expect(jobStore.updates).toHaveLength(0);
    expect(await jobStore.get("job-123")).toMatchObject({
      status: "processing",
      internalState: "finalizing",
      audioUrl: null,
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-04-05T12:05:00.000Z",
      runId: "run-a",
      error: "stuck finalizing",
    });
  });

  it("ensures only one maintenance runner acts at a time via the maintenance lease", async () => {
    const now = new Date("2026-04-05T12:00:00.000Z");
    const jobStore = new MemoryJobStore();
    const firstService = { runOnce: vi.fn().mockResolvedValue(undefined) };
    const secondService = { runOnce: vi.fn().mockResolvedValue(undefined) };

    const firstRunner = new MaintenanceRunner({
      jobStore,
      leaseOwner: "worker-a",
      services: [firstService],
    });
    const secondRunner = new MaintenanceRunner({
      jobStore,
      leaseOwner: "worker-b",
      services: [secondService],
    });

    await firstRunner.runOnce(now);
    await secondRunner.runOnce(now);

    expect(firstService.runOnce).toHaveBeenCalledTimes(1);
    expect(secondService.runOnce).not.toHaveBeenCalled();
    expect(jobStore.leaseClaims).toHaveLength(2);
  });

  it("does not overlap maintenance passes within one process", async () => {
    vi.useFakeTimers();

    try {
      const jobStore = new MemoryJobStore();
      let resolveSlowRun: () => void = () => {};
      const slowRun = new Promise<void>((resolve) => {
        resolveSlowRun = () => resolve();
      });
      const slowService = {
        runOnce: vi.fn(() => slowRun),
      };

      const stop = startMaintenanceWorker({
        jobStore,
        leaseOwner: "worker-a",
        intervalMs: 10,
        services: [slowService],
      });

      await vi.advanceTimersByTimeAsync(35);
      expect(slowService.runOnce).toHaveBeenCalledTimes(1);

      resolveSlowRun();
      await Promise.resolve();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the maintenance lease during a long pass so another runner cannot overlap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));

    try {
      const jobStore = new MemoryJobStore();
      let resolveSlowRun: () => void = () => {};
      const slowRun = new Promise<void>((resolve) => {
        resolveSlowRun = resolve;
      });
      const firstService = {
        runOnce: vi.fn(() => slowRun),
      };
      const secondService = {
        runOnce: vi.fn().mockResolvedValue(undefined),
      };
      const firstRunner = new MaintenanceRunner({
        jobStore,
        leaseOwner: "worker-a",
        services: [firstService],
        leaseDurationMs: 50,
      });
      const secondRunner = new MaintenanceRunner({
        jobStore,
        leaseOwner: "worker-b",
        services: [secondService],
        leaseDurationMs: 50,
      });

      const firstPass = firstRunner.runOnce(new Date());
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(120);
      const secondPass = await secondRunner.runOnce(new Date());

      expect(firstService.runOnce).toHaveBeenCalledTimes(1);
      expect(secondPass).toBe(false);
      expect(secondService.runOnce).not.toHaveBeenCalled();
      expect(jobStore.maintenanceLeaseOwner).toBe("worker-a");
      expect(jobStore.leaseClaims.length).toBeGreaterThan(2);

      resolveSlowRun();
      await firstPass;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the pass when maintenance lease renewal throws during a long-running service", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));

    try {
      const jobStore = new MemoryJobStore();
      jobStore.failMaintenanceLeaseClaimAt = 2;
      let resolveSlowRun: () => void = () => {};
      const slowRun = new Promise<void>((resolve) => {
        resolveSlowRun = resolve;
      });
      const slowService = {
        runOnce: vi.fn(() => slowRun),
      };
      const skippedService = {
        runOnce: vi.fn().mockResolvedValue(undefined),
      };
      const runner = new MaintenanceRunner({
        jobStore,
        leaseOwner: "worker-a",
        services: [slowService, skippedService],
        leaseDurationMs: 50,
      });

      const pass = runner.runOnce(new Date());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
      resolveSlowRun();

      await expect(pass).rejects.toThrow("maintenance lease renewal failed");
      expect(slowService.runOnce).toHaveBeenCalledTimes(1);
      expect(skippedService.runOnce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overwrite a renewed lease when maintenance races with a live runner", async () => {
    const now = new Date("2026-04-05T12:00:00.000Z");
    const jobStore = new MemoryJobStore();
    const audioStore = new MemoryAudioStore();
    await jobStore.save(
      createJob({
        status: "processing",
        internalState: "synthesizing",
        leaseOwner: "worker-a",
        leaseExpiresAt: "2026-04-05T11:59:00.000Z",
        runId: "run-a",
      }),
    );
    jobStore.onRequeueAttempt = async () => {
      await jobStore.save(
        createJob({
          status: "processing",
          internalState: "synthesizing",
          leaseOwner: "worker-a",
          leaseExpiresAt: "2026-04-05T12:05:00.000Z",
          runId: "run-a",
          updatedAt: "2026-04-05T12:00:00.000Z",
        }),
      );
    };

    const reconciler = new JobReconciler({ jobStore, audioStore });
    await reconciler.runOnce(now);

    expect(jobStore.requeueAttempts).toHaveLength(1);
    expect(await jobStore.get("job-123")).toMatchObject({
      status: "processing",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-04-05T12:05:00.000Z",
      runId: "run-a",
    });
  });
});

function createJob(overrides: Partial<AudioJob> = {}): AudioJob {
  const timestamp = "2026-04-05T12:00:00.000Z";
  return {
    id: "job-123",
    status: "queued",
    internalState: "queued",
    displayTitle: "Example Article",
    speechScript: "Example Article\nThis is the body.",
    availableDurationSeconds: 42,
    liveEdgeUpdatedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    runId: null,
    attempt: 1,
    article: {
      url: "https://example.com/article",
      title: "Example Article",
      byline: null,
      siteName: null,
      excerpt: null,
      textContent: "This is the body.",
      wordCount: 4,
      estimatedMinutes: 1,
    },
    speechOptions: { voice: "alloy" },
    provider: "test-provider",
    audioUrl: null,
    playlistUrl: null,
    audioSegments: [],
    durationSeconds: 42,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    userId: null,
    ...overrides,
  };
}
