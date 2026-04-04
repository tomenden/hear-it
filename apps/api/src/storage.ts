import type { AudioJob } from "./types.js";
import type {
  JobEventInput,
  JobEventListOptions,
  JobEventRecord,
  JobLeaseClaim,
} from "./job-events.js";

export interface AudioStorePutOptions {
  overwrite?: boolean;
}

export interface JobOwnership {
  leaseOwner: string;
  runId: string;
}

export interface ExpiredLeaseSnapshot {
  leaseOwner: string | null;
  runId: string | null;
  leaseExpiresAt: string;
  now: string;
}

// ---------------------------------------------------------------------------
// Job Store — persists AudioJob records
// ---------------------------------------------------------------------------

export interface JobStore {
  init(): Promise<void>;
  /** Lightweight connectivity check (e.g. SELECT 1). */
  check(): Promise<void>;
  getAll(): Promise<AudioJob[]>;
  get(jobId: string): Promise<AudioJob | null>;
  save(job: AudioJob): Promise<void>;
  /** Atomically move a queued job into processing. Returns null if it was already claimed. */
  claimQueued(jobId: string, lease?: JobLeaseClaim): Promise<AudioJob | null>;
  /** Update specific fields on an existing job. Returns false if the job doesn't exist. */
  update(jobId: string, patch: Partial<AudioJob>): Promise<boolean>;
  /** Update a leased job only if the current owner/run still matches. */
  updateOwned(
    jobId: string,
    patch: Partial<AudioJob>,
    ownership: JobOwnership,
  ): Promise<boolean>;
  requeueExpiredLease(
    jobId: string,
    snapshot: ExpiredLeaseSnapshot,
  ): Promise<boolean>;
  /** Delete a job by ID. Returns false if the job doesn't exist. */
  delete(jobId: string): Promise<boolean>;
  nextId(): Promise<string>;
  getAllForUser(userId: string): Promise<AudioJob[]>;
  getForUser(jobId: string, userId: string): Promise<AudioJob | null>;
  deleteForUser(jobId: string, userId: string): Promise<boolean>;
  appendEvent?(jobId: string, event: JobEventInput): Promise<void>;
  listEvents?(
    jobId: string,
    options?: JobEventListOptions,
  ): Promise<JobEventRecord[]>;
  claimMaintenanceLease?(
    leaseOwner: string,
    leaseExpiresAt: string,
    leaseName?: string,
  ): Promise<boolean>;
  heartbeat?(
    jobId: string,
    leaseOwner: string,
    leaseExpiresAt: string,
    runId: string,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Audio Store — persists audio blobs and returns public URLs
// ---------------------------------------------------------------------------

export interface AudioStore {
  /** Lightweight reachability check. */
  check(): Promise<void>;

  /**
   * Write an audio buffer and return its public URL.
   * `key` is a path-like identifier, e.g. "previews/voice-preview--alloy.mp3"
   */
  put(
    key: string,
    data: Buffer,
    contentType?: string,
    options?: AudioStorePutOptions,
  ): Promise<string>;

  /** Check whether a key already exists and return its public URL, or null. */
  head(key: string): Promise<string | null>;

  /** Read a blob by key. Returns null when it does not exist. */
  get(key: string): Promise<Buffer | null>;

  /** Delete a blob by key. No-op if it doesn't exist. */
  delete(key: string): Promise<void>;

  /** Delete every blob stored under a path prefix. No-op if the prefix does not exist. */
  deletePrefix(prefix: string): Promise<void>;
}
