import { buildFinalAudioKey, buildPlaylistKey } from "./media-packager.js";
import type { AudioStore, JobStore } from "./storage.js";
import type { AudioJob } from "./types.js";

const DEFAULT_HLS_RETENTION_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60_000;
const DEFAULT_MAINTENANCE_LEASE_MS = 55_000;
const DEFAULT_MAINTENANCE_LEASE_NAME = "maintenance";

export interface MaintenanceService {
  runOnce(now?: Date): Promise<void>;
}

export interface JobReconcilerOptions {
  jobStore: JobStore;
  audioStore: AudioStore;
}

export class JobReconciler implements MaintenanceService {
  private readonly jobStore: JobStore;
  private readonly audioStore: AudioStore;

  constructor(options: JobReconcilerOptions) {
    this.jobStore = options.jobStore;
    this.audioStore = options.audioStore;
  }

  async runOnce(now = new Date()): Promise<void> {
    const jobs = await this.jobStore.getAll();

    for (const job of jobs) {
      if (job.status !== "processing") {
        continue;
      }

      if (!job.leaseExpiresAt || job.leaseExpiresAt > now.toISOString()) {
        continue;
      }

      const repairedAudioUrl = await this.audioStore.head(buildFinalAudioKey(job.id));
      if (repairedAudioUrl) {
        continue;
      }

      await this.jobStore.requeueExpiredLease(job.id, {
        leaseOwner: job.leaseOwner ?? null,
        runId: job.runId ?? null,
        leaseExpiresAt: job.leaseExpiresAt,
        now: now.toISOString(),
      });
    }
  }
}

export interface HlsRetentionCleanerOptions {
  jobStore: JobStore;
  audioStore: AudioStore;
  retentionMs?: number;
}

export class HlsRetentionCleaner implements MaintenanceService {
  private readonly jobStore: JobStore;
  private readonly audioStore: AudioStore;
  private readonly retentionMs: number;

  constructor(options: HlsRetentionCleanerOptions) {
    this.jobStore = options.jobStore;
    this.audioStore = options.audioStore;
    this.retentionMs = options.retentionMs ?? DEFAULT_HLS_RETENTION_MS;
  }

  async runOnce(now = new Date()): Promise<void> {
    const jobs = await this.jobStore.getAll();

    for (const job of jobs) {
      if (job.status !== "completed" || !job.playlistUrl) {
        continue;
      }

      const hlsReferenceAt = job.liveEdgeUpdatedAt ?? job.updatedAt;
      if (!hlsReferenceAt) {
        continue;
      }

      const ageMs = now.getTime() - new Date(hlsReferenceAt).getTime();
      if (ageMs < this.retentionMs) {
        continue;
      }

      await this.audioStore.deletePrefix(buildHlsSegmentsPrefix(job.id));
      await this.audioStore.delete(buildPlaylistKey(job.id));
      await this.jobStore.update(job.id, {
        playlistUrl: null,
        liveEdgeUpdatedAt: null,
        audioSegments: [],
        updatedAt: now.toISOString(),
      });
    }
  }
}

export interface FinalizationRepairerOptions {
  jobStore: JobStore;
  audioStore: AudioStore;
}

export class FinalizationRepairer implements MaintenanceService {
  private readonly jobStore: JobStore;
  private readonly audioStore: AudioStore;

  constructor(options: FinalizationRepairerOptions) {
    this.jobStore = options.jobStore;
    this.audioStore = options.audioStore;
  }

  async runOnce(now = new Date()): Promise<void> {
    const jobs = await this.jobStore.getAll();
    const nowIso = now.toISOString();

    for (const job of jobs) {
      if (job.status === "completed") {
        continue;
      }

      if (hasLiveLease(job, nowIso)) {
        continue;
      }

      const finalAudioUrl = await this.audioStore.head(buildFinalAudioKey(job.id));
      if (!finalAudioUrl) {
        continue;
      }

      await this.jobStore.update(job.id, {
        status: "completed",
        internalState: "completed",
        audioUrl: finalAudioUrl,
        leaseOwner: null,
        leaseExpiresAt: null,
        runId: null,
        error: null,
        updatedAt: now.toISOString(),
      });
    }
  }
}

export interface MaintenanceRunnerOptions {
  jobStore: JobStore;
  leaseOwner: string;
  services: MaintenanceService[];
  leaseDurationMs?: number;
  leaseName?: string;
}

export class MaintenanceRunner {
  private readonly jobStore: JobStore;
  private readonly leaseOwner: string;
  private readonly services: MaintenanceService[];
  private readonly leaseDurationMs: number;
  private readonly leaseName: string;

  constructor(options: MaintenanceRunnerOptions) {
    this.jobStore = options.jobStore;
    this.leaseOwner = options.leaseOwner;
    this.services = options.services;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_MAINTENANCE_LEASE_MS;
    this.leaseName = options.leaseName ?? DEFAULT_MAINTENANCE_LEASE_NAME;
  }

  async runOnce(now = new Date()): Promise<boolean> {
    if (!this.jobStore.claimMaintenanceLease) {
      for (const service of this.services) {
        await service.runOnce(now);
      }
      return true;
    }

    const claimed = await this.jobStore.claimMaintenanceLease(
      this.leaseOwner,
      new Date(now.getTime() + this.leaseDurationMs).toISOString(),
      this.leaseName,
    );

    if (!claimed) {
      return false;
    }

    let renewalError: unknown = null;
    const renewalIntervalMs = Math.max(1, Math.floor(this.leaseDurationMs / 2));
    const renewLease = async () => {
      const renewed = await this.jobStore.claimMaintenanceLease?.(
        this.leaseOwner,
        new Date(Date.now() + this.leaseDurationMs).toISOString(),
        this.leaseName,
      );

      if (!renewed) {
        renewalError ??= new Error("Failed to renew maintenance lease.");
      }
    };
    const timer = setInterval(() => {
      void renewLease();
    }, renewalIntervalMs);
    timer.unref?.();

    try {
      for (const service of this.services) {
        if (renewalError) {
          throw renewalError;
        }
        await service.runOnce(now);
      }
      if (renewalError) {
        throw renewalError;
      }
    } finally {
      clearInterval(timer);
    }

    return true;
  }
}

export interface StartMaintenanceWorkerOptions {
  jobStore: JobStore;
  services: MaintenanceService[];
  leaseOwner: string;
  intervalMs?: number;
  leaseDurationMs?: number;
  leaseName?: string;
  onError?: (error: unknown) => void;
}

export function startMaintenanceWorker(options: StartMaintenanceWorkerOptions) {
  const runner = new MaintenanceRunner({
    jobStore: options.jobStore,
    leaseOwner: options.leaseOwner,
    services: options.services,
    leaseDurationMs: options.leaseDurationMs,
    leaseName: options.leaseName,
  });
  const intervalMs = options.intervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  let running = false;

  const tick = async () => {
    if (running) {
      return;
    }

    running = true;
    try {
      await runner.runOnce();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}

function buildHlsSegmentsPrefix(jobId: string): string {
  return `jobs/${jobId}/segments`;
}

function hasLiveLease(job: AudioJob, nowIso: string): boolean {
  return (
    Boolean(job.leaseOwner || job.runId) &&
    typeof job.leaseExpiresAt === "string" &&
    job.leaseExpiresAt > nowIso
  );
}
