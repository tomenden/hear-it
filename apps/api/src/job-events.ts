export type JobEventType =
  | "job_created"
  | "job_claimed"
  | "job_heartbeat"
  | "chunk_ready"
  | "playback_ready"
  | "job_completed"
  | "job_failed"
  | (string & {});

export interface JobEventInput {
  type: JobEventType;
  sequenceNumber: number;
  payload?: Record<string, unknown> | null;
  occurredAt?: string;
}

export interface JobEventRecord extends JobEventInput {
  id: string;
  jobId: string;
  occurredAt: string;
}

export interface JobLeaseClaim {
  leaseOwner: string;
  leaseExpiresAt: string;
  runId?: string | null;
  attempt?: number | null;
}

export interface JobEventListOptions {
  limit?: number;
}
