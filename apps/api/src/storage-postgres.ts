import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import postgres, { type JSONValue } from "postgres";

import type { JobEventInput, JobEventListOptions, JobEventRecord, JobLeaseClaim } from "./job-events.js";
import type { AudioJob } from "./types.js";
import type { JobStore } from "./storage.js";

type SqlRow = Record<string, unknown>;

export interface SqlClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  json(value: JSONValue): unknown;
}

export interface PostgresJobStoreOptions {
  sql?: SqlClient;
}

function getSQL(): SqlClient {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("POSTGRES_URL environment variable is not set.");
  }

  return postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  }) as unknown as SqlClient;
}

export class PostgresJobStore implements JobStore {
  private _sql: SqlClient | null;

  constructor(options: PostgresJobStoreOptions = {}) {
    this._sql = options.sql ?? null;
  }

  private get sql(): SqlClient {
    if (!this._sql) {
      this._sql = getSQL();
    }
    return this._sql;
  }

  async check(): Promise<void> {
    try {
      await this.sql`SELECT 1`;
    } catch (error) {
      captureDatabaseFailure("db_check", error);
      throw error;
    }
  }

  async init(): Promise<void> {
    try {
      await this.sql`
        CREATE TABLE IF NOT EXISTS audio_jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          internal_state TEXT,
          display_title TEXT,
          speech_script TEXT,
          available_duration_seconds DOUBLE PRECISION,
          lease_owner TEXT,
          lease_expires_at TEXT,
          run_id TEXT,
          attempt INTEGER NOT NULL DEFAULT 0,
          article JSONB NOT NULL,
          speech_options JSONB NOT NULL,
          provider TEXT NOT NULL,
          audio_url TEXT,
          playlist_url TEXT,
          audio_segments JSONB NOT NULL DEFAULT '[]',
          duration_seconds DOUBLE PRECISION,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          user_id TEXT
        )
      `;

      await this.sql`
        CREATE TABLE IF NOT EXISTS job_events (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          sequence_number INTEGER NOT NULL,
          payload JSONB,
          occurred_at TEXT NOT NULL
        )
      `;

      await this.sql`
        CREATE SEQUENCE IF NOT EXISTS audio_jobs_id_seq
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS internal_state TEXT
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS display_title TEXT
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS speech_script TEXT
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS available_duration_seconds DOUBLE PRECISION
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS lease_owner TEXT
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TEXT
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS run_id TEXT
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS user_id TEXT
      `;

      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_audio_jobs_user_id ON audio_jobs(user_id)
      `;

      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_audio_jobs_internal_state ON audio_jobs(internal_state)
      `;

      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_audio_jobs_lease_owner ON audio_jobs(lease_owner)
      `;

      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_audio_jobs_lease_expires_at ON audio_jobs(lease_expires_at)
      `;

      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_audio_jobs_run_id ON audio_jobs(run_id)
      `;

      await this.sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_job_events_job_id_sequence
        ON job_events(job_id, sequence_number)
      `;

      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_job_events_job_id_created_at
        ON job_events(job_id, occurred_at DESC)
      `;
    } catch (error) {
      captureDatabaseFailure("db_init", error);
      throw error;
    }
  }

  async getAll(): Promise<AudioJob[]> {
    const rows = await this.sql`
      SELECT * FROM audio_jobs ORDER BY created_at DESC
    `;
    return rows.map(rowToJob);
  }

  async get(jobId: string): Promise<AudioJob | null> {
    const rows = await this.sql`
      SELECT * FROM audio_jobs WHERE id = ${jobId}
    `;
    return rows.length > 0 ? rowToJob(rows[0]) : null;
  }

  async save(job: AudioJob): Promise<void> {
    try {
      await this.sql`
        INSERT INTO audio_jobs (
          id, status, internal_state, display_title, speech_script,
          available_duration_seconds, lease_owner, lease_expires_at, run_id, attempt,
          article, speech_options, provider,
          audio_url, playlist_url, audio_segments, duration_seconds,
          error, created_at, updated_at, user_id
        ) VALUES (
          ${job.id},
          ${job.status},
          ${job.internalState ?? null},
          ${job.displayTitle ?? job.article.title},
          ${job.speechScript ?? null},
          ${job.availableDurationSeconds ?? null},
          ${job.leaseOwner ?? null},
          ${job.leaseExpiresAt ?? null},
          ${job.runId ?? null},
          ${job.attempt ?? 0},
          ${this.sql.json(job.article as unknown as JSONValue)},
          ${this.sql.json(job.speechOptions as unknown as JSONValue)},
          ${job.provider},
          ${job.audioUrl},
          ${job.playlistUrl},
          ${this.sql.json(job.audioSegments as unknown as JSONValue)},
          ${job.durationSeconds},
          ${job.error},
          ${job.createdAt},
          ${job.updatedAt},
          ${job.userId}
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          internal_state = EXCLUDED.internal_state,
          display_title = EXCLUDED.display_title,
          speech_script = EXCLUDED.speech_script,
          available_duration_seconds = EXCLUDED.available_duration_seconds,
          lease_owner = EXCLUDED.lease_owner,
          lease_expires_at = EXCLUDED.lease_expires_at,
          run_id = EXCLUDED.run_id,
          attempt = EXCLUDED.attempt,
          article = EXCLUDED.article,
          speech_options = EXCLUDED.speech_options,
          provider = EXCLUDED.provider,
          audio_url = EXCLUDED.audio_url,
          playlist_url = EXCLUDED.playlist_url,
          audio_segments = EXCLUDED.audio_segments,
          duration_seconds = EXCLUDED.duration_seconds,
          error = EXCLUDED.error,
          updated_at = EXCLUDED.updated_at,
          user_id = EXCLUDED.user_id
      `;
    } catch (error) {
      captureDatabaseFailure("db_save_job", error, { jobId: job.id, status: job.status });
      throw error;
    }
  }

  async claimQueued(jobId: string, lease?: JobLeaseClaim): Promise<AudioJob | null> {
    const now = new Date().toISOString();

    const rows = lease
      ? await this.sql`
        UPDATE audio_jobs
        SET
          status = 'processing',
          lease_owner = ${lease.leaseOwner},
          lease_expires_at = ${lease.leaseExpiresAt},
          run_id = ${lease.runId ?? null},
          attempt = ${lease.attempt ?? 1},
          updated_at = ${now}
        WHERE id = ${jobId}
          AND status = 'queued'
        RETURNING *
      `
      : await this.sql`
        UPDATE audio_jobs
        SET
          status = 'processing',
          updated_at = ${now}
        WHERE id = ${jobId}
          AND status = 'queued'
        RETURNING *
      `;

    return rows.length > 0 ? rowToJob(rows[0]) : null;
  }

  async update(jobId: string, patch: Partial<AudioJob>): Promise<boolean> {
    const now = new Date().toISOString();
    const hasStatus = patch.status !== undefined;
    const hasInternalState = patch.internalState !== undefined;
    const hasDisplayTitle = patch.displayTitle !== undefined;
    const hasSpeechScript = patch.speechScript !== undefined;
    const hasAvailableDurationSeconds = patch.availableDurationSeconds !== undefined;
    const hasLeaseOwner = patch.leaseOwner !== undefined;
    const hasLeaseExpiresAt = patch.leaseExpiresAt !== undefined;
    const hasRunId = patch.runId !== undefined;
    const hasAttempt = patch.attempt !== undefined;
    const hasAudioUrl = patch.audioUrl !== undefined;
    const hasPlaylistUrl = patch.playlistUrl !== undefined;
    const hasAudioSegments = patch.audioSegments !== undefined;
    const hasDurationSeconds = patch.durationSeconds !== undefined;
    const hasError = patch.error !== undefined;

    const rows = await this.sql`
      UPDATE audio_jobs SET
        status = CASE WHEN ${hasStatus} THEN ${patch.status ?? null} ELSE status END,
        internal_state = CASE WHEN ${hasInternalState} THEN ${patch.internalState ?? null} ELSE internal_state END,
        display_title = CASE WHEN ${hasDisplayTitle} THEN ${patch.displayTitle ?? null} ELSE display_title END,
        speech_script = CASE WHEN ${hasSpeechScript} THEN ${patch.speechScript ?? null} ELSE speech_script END,
        available_duration_seconds = CASE
          WHEN ${hasAvailableDurationSeconds} THEN ${patch.availableDurationSeconds ?? null}
          ELSE available_duration_seconds
        END,
        lease_owner = CASE WHEN ${hasLeaseOwner} THEN ${patch.leaseOwner ?? null} ELSE lease_owner END,
        lease_expires_at = CASE WHEN ${hasLeaseExpiresAt} THEN ${patch.leaseExpiresAt ?? null} ELSE lease_expires_at END,
        run_id = CASE WHEN ${hasRunId} THEN ${patch.runId ?? null} ELSE run_id END,
        attempt = CASE WHEN ${hasAttempt} THEN ${patch.attempt ?? 0} ELSE attempt END,
        audio_url = CASE WHEN ${hasAudioUrl} THEN ${patch.audioUrl ?? null} ELSE audio_url END,
        playlist_url = CASE WHEN ${hasPlaylistUrl} THEN ${patch.playlistUrl ?? null} ELSE playlist_url END,
        audio_segments = CASE
          WHEN ${hasAudioSegments} THEN ${this.sql.json((patch.audioSegments ?? []) as unknown as JSONValue)}
          ELSE audio_segments
        END,
        duration_seconds = CASE
          WHEN ${hasDurationSeconds} THEN ${patch.durationSeconds ?? null}
          ELSE duration_seconds
        END,
        error = CASE WHEN ${hasError} THEN ${patch.error ?? null} ELSE error END,
        updated_at = ${now}
      WHERE id = ${jobId}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async delete(jobId: string): Promise<boolean> {
    const rows = await this.sql`
      DELETE FROM audio_jobs WHERE id = ${jobId} RETURNING id
    `;
    return rows.length > 0;
  }

  async nextId(): Promise<string> {
    return randomUUID();
  }

  async getAllForUser(userId: string): Promise<AudioJob[]> {
    const rows = await this.sql`
      SELECT * FROM audio_jobs WHERE user_id = ${userId} ORDER BY created_at DESC
    `;
    return rows.map(rowToJob);
  }

  async getForUser(jobId: string, userId: string): Promise<AudioJob | null> {
    const rows = await this.sql`
      SELECT * FROM audio_jobs WHERE id = ${jobId} AND user_id = ${userId}
    `;
    return rows.length > 0 ? rowToJob(rows[0]) : null;
  }

  async deleteForUser(jobId: string, userId: string): Promise<boolean> {
    const rows = await this.sql`
      DELETE FROM audio_jobs WHERE id = ${jobId} AND user_id = ${userId} RETURNING id
    `;
    return rows.length > 0;
  }

  async appendEvent(jobId: string, event: JobEventInput): Promise<void> {
    await this.sql`
      INSERT INTO job_events (
        id,
        job_id,
        event_type,
        sequence_number,
        payload,
        occurred_at
      ) VALUES (
        ${randomUUID()},
        ${jobId},
        ${event.type},
        ${event.sequenceNumber},
        ${this.sql.json((event.payload ?? null) as unknown as JSONValue)},
        ${event.occurredAt ?? new Date().toISOString()}
      )
      ON CONFLICT (job_id, sequence_number) DO UPDATE SET
        event_type = EXCLUDED.event_type,
        payload = EXCLUDED.payload,
        occurred_at = EXCLUDED.occurred_at
    `;
  }

  async listEvents(jobId: string, options: JobEventListOptions = {}): Promise<JobEventRecord[]> {
    const rows =
      options.limit !== undefined
        ? await this.sql`
          SELECT * FROM job_events
          WHERE job_id = ${jobId}
          ORDER BY sequence_number ASC, occurred_at ASC
          LIMIT ${options.limit}
        `
        : await this.sql`
          SELECT * FROM job_events
          WHERE job_id = ${jobId}
          ORDER BY sequence_number ASC, occurred_at ASC
        `;

    return rows.map(rowToEvent);
  }

  async heartbeat(jobId: string, leaseOwner: string, leaseExpiresAt: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE audio_jobs
      SET lease_expires_at = ${leaseExpiresAt},
          updated_at = ${new Date().toISOString()}
      WHERE id = ${jobId}
        AND lease_owner = ${leaseOwner}
        AND status = 'processing'
      RETURNING id
    `;
    return rows.length > 0;
  }
}

function rowToJob(row: SqlRow): AudioJob {
  return {
    id: row.id as string,
    status: row.status as AudioJob["status"],
    internalState: (row.internal_state as AudioJob["internalState"]) ?? null,
    displayTitle: (row.display_title as string) ?? null,
    speechScript: (row.speech_script as string) ?? null,
    availableDurationSeconds:
      row.available_duration_seconds === undefined
        ? null
        : (row.available_duration_seconds as number | null),
    leaseOwner: (row.lease_owner as string) ?? null,
    leaseExpiresAt: (row.lease_expires_at as string) ?? null,
    runId: (row.run_id as string) ?? null,
    attempt: row.attempt === undefined ? null : (row.attempt as number | null),
    article: row.article as AudioJob["article"],
    speechOptions: row.speech_options as AudioJob["speechOptions"],
    provider: row.provider as string,
    audioUrl: (row.audio_url as string) ?? null,
    playlistUrl: (row.playlist_url as string) ?? null,
    audioSegments: (row.audio_segments as AudioJob["audioSegments"]) ?? [],
    durationSeconds:
      row.duration_seconds === undefined
        ? null
        : (row.duration_seconds as number | null),
    error: (row.error as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    userId: (row.user_id as string) ?? null,
  };
}

function rowToEvent(row: SqlRow): JobEventRecord {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    type: row.event_type as JobEventRecord["type"],
    sequenceNumber: row.sequence_number as number,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    occurredAt: row.occurred_at as string,
  };
}

function captureDatabaseFailure(
  operation: string,
  error: unknown,
  extra?: Record<string, unknown>,
) {
  Sentry.captureException(error, {
    tags: {
      operation,
      layer: "database",
    },
    extra,
  });
}
