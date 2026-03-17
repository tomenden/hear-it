import postgres, { type JSONValue } from "postgres";
import { put, head, del } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";

import type { AudioJob } from "./types.js";
import type { AudioStore, AudioStorePutOptions, JobStore } from "./storage.js";

/** Cast a typed object to JSONValue for postgres.js JSONB parameters. */
const jsonb = (value: unknown) => value as JSONValue;

// ---------------------------------------------------------------------------
// Postgres JobStore
// ---------------------------------------------------------------------------

function getSQL() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("POSTGRES_URL environment variable is not set.");
  }
  // Serverless-safe options: keep pool to 1 connection to avoid exhausting
  // Neon's connection limit across concurrent Vercel function invocations.
  return postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export class VercelJobStore implements JobStore {
  private _sql: ReturnType<typeof getSQL> | null = null;

  private get sql(): ReturnType<typeof getSQL> {
    if (!this._sql) {
      this._sql = getSQL();
    }
    return this._sql;
  }

  async check(): Promise<void> {
    try {
      await this.sql`SELECT 1`;
    } catch (error) {
      captureStorageFailure("db_check", error);
      throw error;
    }
  }

  async init(): Promise<void> {
    try {
      await this.sql`
        CREATE TABLE IF NOT EXISTS audio_jobs (
          id            TEXT PRIMARY KEY,
          status        TEXT NOT NULL,
          article       JSONB NOT NULL,
          speech_options JSONB NOT NULL,
          provider      TEXT NOT NULL,
          audio_url     TEXT,
          playlist_url  TEXT,
          audio_segments JSONB NOT NULL DEFAULT '[]',
          duration_seconds DOUBLE PRECISION,
          error         TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        )
      `;

      await this.sql`
        CREATE SEQUENCE IF NOT EXISTS audio_jobs_id_seq
      `;

      await this.sql`
        ALTER TABLE audio_jobs ADD COLUMN IF NOT EXISTS user_id TEXT
      `;

      await this.sql`
        CREATE INDEX IF NOT EXISTS idx_audio_jobs_user_id ON audio_jobs(user_id)
      `;
    } catch (error) {
      captureStorageFailure("db_init", error);
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
          id, status, article, speech_options, provider,
          audio_url, playlist_url, audio_segments, duration_seconds,
          error, created_at, updated_at, user_id
        ) VALUES (
          ${job.id},
          ${job.status},
          ${this.sql.json(jsonb(job.article))},
          ${this.sql.json(jsonb(job.speechOptions))},
          ${job.provider},
          ${job.audioUrl},
          ${job.playlistUrl},
          ${this.sql.json(jsonb(job.audioSegments))},
          ${job.durationSeconds},
          ${job.error},
          ${job.createdAt},
          ${job.updatedAt},
          ${job.userId}
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
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
      captureStorageFailure("db_save_job", error, { jobId: job.id, status: job.status });
      throw error;
    }
  }

  async claimQueued(jobId: string): Promise<AudioJob | null> {
    return this.claimPending(jobId, new Date(0).toISOString());
  }

  async claimPending(jobId: string, stalledBefore: string): Promise<AudioJob | null> {
    const now = new Date().toISOString();
    const rows = await this.sql`
      UPDATE audio_jobs
      SET
        status = 'processing',
        updated_at = ${now}
      WHERE id = ${jobId}
        AND (
          status = 'queued'
          OR (status = 'processing' AND updated_at < ${stalledBefore})
        )
      RETURNING *
    `;
    return rows.length > 0 ? rowToJob(rows[0]) : null;
  }

  async update(jobId: string, patch: Partial<AudioJob>): Promise<boolean> {
    const now = new Date().toISOString();
    const hasStatus = patch.status !== undefined;
    const hasAudioUrl = patch.audioUrl !== undefined;
    const hasPlaylistUrl = patch.playlistUrl !== undefined;
    const hasAudioSegments = patch.audioSegments !== undefined;
    const hasDurationSeconds = patch.durationSeconds !== undefined;
    const hasError = patch.error !== undefined;
    const rows = await this.sql`
      UPDATE audio_jobs SET
        status = CASE WHEN ${hasStatus} THEN ${patch.status ?? null} ELSE status END,
        audio_url = CASE WHEN ${hasAudioUrl} THEN ${patch.audioUrl ?? null} ELSE audio_url END,
        playlist_url = CASE WHEN ${hasPlaylistUrl} THEN ${patch.playlistUrl ?? null} ELSE playlist_url END,
        audio_segments = CASE
          WHEN ${hasAudioSegments} THEN ${this.sql.json(jsonb(patch.audioSegments ?? []))}
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
}

function rowToJob(row: Record<string, unknown>): AudioJob {
  return {
    id: row.id as string,
    status: row.status as AudioJob["status"],
    article: row.article as AudioJob["article"],
    speechOptions: row.speech_options as AudioJob["speechOptions"],
    provider: row.provider as string,
    audioUrl: (row.audio_url as string) ?? null,
    playlistUrl: (row.playlist_url as string) ?? null,
    audioSegments: (row.audio_segments as AudioJob["audioSegments"]) ?? [],
    durationSeconds: (row.duration_seconds as number) ?? null,
    error: (row.error as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    userId: (row.user_id as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Vercel Blob AudioStore
// ---------------------------------------------------------------------------

export class VercelAudioStore implements AudioStore {
  async check(): Promise<void> {
    // Attempt a head request for a non-existent key. A "not found" error is
    // expected and means the store is reachable. Any other error propagates.
    try {
      await head("__health_check__");
    } catch (error: unknown) {
      const isBlobNotFound = isBlobMissingError(error);
      if (!isBlobNotFound) {
        captureStorageFailure("blob_check", error);
        throw error;
      }
    }
  }

  async put(
    key: string,
    data: Buffer,
    contentType = "audio/mpeg",
    options?: AudioStorePutOptions,
  ): Promise<string> {
    try {
      const blob = await put(key, data, {
        access: "public",
        contentType,
        addRandomSuffix: false,
        allowOverwrite: options?.overwrite ?? false,
      });
      return blob.url;
    } catch (error) {
      captureStorageFailure("blob_put", error, { key, contentType, overwrite: options?.overwrite ?? false });
      throw error;
    }
  }

  async head(key: string): Promise<string | null> {
    try {
      const blob = await head(key);
      return blob.url;
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await del(key);
    } catch {
      // Ignore — blob may already be gone.
    }
  }
}

export function isBlobMissingError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "BlobNotFoundError"
      || error.message.includes("does not exist"));
}

function captureStorageFailure(
  operation: string,
  error: unknown,
  extra?: Record<string, unknown>,
) {
  Sentry.captureException(error, {
    tags: {
      operation,
      layer: operation.startsWith("blob_") ? "blob" : "database",
    },
    extra,
  });
}
