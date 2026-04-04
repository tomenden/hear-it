import { describe, expect, it, vi } from "vitest";

import { buildFinalAudioKey, buildPlaylistKey } from "./media-packager.js";
import {
  FinalizationRepairer,
  HlsRetentionCleaner,
  JobReconciler,
  MaintenanceRunner,
} from "./maintenance.js";
import type { AudioStore, JobStore } from "./storage.js";
import type { AudioJob } from "./types.js";

class MemoryJobStore implements JobStore {
  readonly updates: Array<{ jobId: string; patch: Partial<AudioJob> }> = [];
  readonly leaseClaims: Array<{ leaseOwner: string; leaseExpiresAt: string }> = [];
  maintenanceLeaseAvailable = true;
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
    if (!this.maintenanceLeaseAvailable) {
      return false;
    }

    this.maintenanceLeaseAvailable = false;
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

    expect(jobStore.updates).toContainEqual({
      jobId: "job-123",
      patch: expect.objectContaining({
        status: "queued",
        internalState: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        runId: null,
        error: "Job re-queued after lease expiry.",
      }),
    });
  });

  it("cleans expired HLS assets after the retention window", async () => {
    const now = new Date("2026-04-05T18:00:01.000Z");
    const jobStore = new MemoryJobStore();
    const audioStore = new MemoryAudioStore();
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
    expect(audioStore.deletedKeys).toContain(buildPlaylistKey("job-123"));
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
        leaseExpiresAt: "2026-04-05T12:05:00.000Z",
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
