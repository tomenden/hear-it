import { neon } from "@neondatabase/serverless";
import { put, head } from "@vercel/blob";

import type { AudioJob } from "./types.js";
import type { AudioStore, JobStore } from "./storage.js";

// ---------------------------------------------------------------------------
// Neon Postgres JobStore
// ---------------------------------------------------------------------------

function getSQL() {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("POSTGRES_URL environment variable is not set.");
  }
  return neon(url);
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
    await this.sql`SELECT 1`;
  }

  async init(): Promise<void> {
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
    await this.sql`
      INSERT INTO audio_jobs (
        id, status, article, speech_options, provider,
        audio_url, playlist_url, audio_segments, duration_seconds,
        error, created_at, updated_at
      ) VALUES (
        ${job.id},
        ${job.status},
        ${JSON.stringify(job.article)},
        ${JSON.stringify(job.speechOptions)},
        ${job.provider},
        ${job.audioUrl},
        ${job.playlistUrl},
        ${JSON.stringify(job.audioSegments)},
        ${job.durationSeconds},
        ${job.error},
        ${job.createdAt},
        ${job.updatedAt}
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
        updated_at = EXCLUDED.updated_at
    `;
  }

  async update(jobId: string, patch: Partial<AudioJob>): Promise<boolean> {
    const now = new Date().toISOString();
    const rows = await this.sql`
      UPDATE audio_jobs SET
        status = COALESCE(${patch.status ?? null}, status),
        audio_url = COALESCE(${patch.audioUrl ?? null}, audio_url),
        playlist_url = COALESCE(${patch.playlistUrl ?? null}, playlist_url),
        audio_segments = COALESCE(${patch.audioSegments ? JSON.stringify(patch.audioSegments) : null}, audio_segments),
        duration_seconds = COALESCE(${patch.durationSeconds ?? null}, duration_seconds),
        error = ${patch.error !== undefined ? patch.error : null},
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
    const rows = await this.sql`SELECT nextval('audio_jobs_id_seq') AS id`;
    return String(rows[0].id);
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
      const isBlobNotFound =
        error instanceof Error && error.name === "BlobNotFoundError";
      if (!isBlobNotFound) throw error;
    }
  }

  async put(key: string, data: Buffer, contentType = "audio/mpeg"): Promise<string> {
    const blob = await put(key, data, {
      access: "public",
      contentType,
      addRandomSuffix: false,
    });
    return blob.url;
  }

  async head(key: string): Promise<string | null> {
    try {
      const blob = await head(key);
      return blob.url;
    } catch {
      return null;
    }
  }
}
