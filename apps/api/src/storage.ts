import type { AudioJob } from "./types.js";

// ---------------------------------------------------------------------------
// Job Store — persists AudioJob records
// ---------------------------------------------------------------------------

export interface JobStore {
  init(): Promise<void>;
  getAll(): Promise<AudioJob[]>;
  get(jobId: string): Promise<AudioJob | null>;
  save(job: AudioJob): Promise<void>;
  /** Update specific fields on an existing job. Returns false if the job doesn't exist. */
  update(jobId: string, patch: Partial<AudioJob>): Promise<boolean>;
  nextId(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Audio Store — persists audio blobs and returns public URLs
// ---------------------------------------------------------------------------

export interface AudioStore {
  /**
   * Write an audio buffer and return its public URL.
   * `key` is a path-like identifier, e.g. "previews/voice-preview--alloy.mp3"
   */
  put(key: string, data: Buffer, contentType?: string): Promise<string>;

  /** Check whether a key already exists and return its public URL, or null. */
  head(key: string): Promise<string | null>;
}
