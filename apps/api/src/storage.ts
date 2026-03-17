import type { AudioJob } from "./types.js";

export interface AudioStorePutOptions {
  overwrite?: boolean;
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
  claimQueued(jobId: string): Promise<AudioJob | null>;
  /**
   * Atomically claim a queued job, or a stalled processing job, for continued work.
   * `stalledBefore` should be an ISO timestamp; processing jobs older than it are resumable.
   */
  claimPending(jobId: string, stalledBefore: string): Promise<AudioJob | null>;
  /** Update specific fields on an existing job. Returns false if the job doesn't exist. */
  update(jobId: string, patch: Partial<AudioJob>): Promise<boolean>;
  /** Delete a job by ID. Returns false if the job doesn't exist. */
  delete(jobId: string): Promise<boolean>;
  nextId(): Promise<string>;
  getAllForUser(userId: string): Promise<AudioJob[]>;
  getForUser(jobId: string, userId: string): Promise<AudioJob | null>;
  deleteForUser(jobId: string, userId: string): Promise<boolean>;
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

  /** Delete a blob by key. No-op if it doesn't exist. */
  delete(key: string): Promise<void>;
}
