import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AudioJob } from "./types.js";
import type { AudioStore, JobStore } from "./storage.js";

// ---------------------------------------------------------------------------
// File-system JobStore  (same behaviour as before — JSON file on disk)
// ---------------------------------------------------------------------------

export class FileJobStore implements JobStore {
  private readonly jobs = new Map<string, AudioJob>();
  private _nextId = 1;
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = resolve(
      filePath ?? process.env.JOBS_FILE_PATH ?? "data/jobs.json",
    );
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { jobs?: AudioJob[] };
      const jobs = parsed.jobs ?? [];

      this.jobs.clear();
      for (const job of jobs) {
        this.jobs.set(job.id, job);
      }

      this._nextId = jobs.reduce((maxId, job) => {
        const numericId = Number(job.id);
        return Number.isFinite(numericId)
          ? Math.max(maxId, numericId + 1)
          : maxId;
      }, 1);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : null;
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }

  async getAll(): Promise<AudioJob[]> {
    return Array.from(this.jobs.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async get(jobId: string): Promise<AudioJob | null> {
    return this.jobs.get(jobId) ?? null;
  }

  async save(job: AudioJob): Promise<void> {
    this.jobs.set(job.id, job);
    await this.persist();
  }

  async update(jobId: string, patch: Partial<AudioJob>): Promise<boolean> {
    const existing = this.jobs.get(jobId);
    if (!existing) return false;
    this.jobs.set(jobId, { ...existing, ...patch, updatedAt: new Date().toISOString() });
    await this.persist();
    return true;
  }

  async nextId(): Promise<string> {
    return String(this._nextId++);
  }

  private async persist(): Promise<void> {
    const jobs = Array.from(this.jobs.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    await writeFile(
      this.filePath,
      JSON.stringify({ jobs }, null, 2),
      "utf8",
    );
  }
}

// ---------------------------------------------------------------------------
// File-system AudioStore  (writes MP3 files to a local directory)
// ---------------------------------------------------------------------------

export class FileAudioStore implements AudioStore {
  private readonly outputDir: string;
  private readonly publicBaseUrl: string;

  constructor(outputDir?: string, publicBaseUrl?: string) {
    this.outputDir = resolve(
      outputDir ?? process.env.AUDIO_OUTPUT_DIR ?? "data/audio",
    );
    this.publicBaseUrl =
      publicBaseUrl ?? process.env.AUDIO_PUBLIC_BASE_URL ?? "/audio";
  }

  async put(key: string, data: Buffer, _contentType?: string): Promise<string> {
    const filePath = join(this.outputDir, key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    return this.toPublicUrl(key);
  }

  async head(key: string): Promise<string | null> {
    const filePath = join(this.outputDir, key);
    try {
      await access(filePath);
      return this.toPublicUrl(key);
    } catch {
      return null;
    }
  }

  getOutputDir(): string {
    return this.outputDir;
  }

  private toPublicUrl(key: string): string {
    const base = this.publicBaseUrl.endsWith("/")
      ? this.publicBaseUrl.slice(0, -1)
      : this.publicBaseUrl;
    return `${base}/${key}`;
  }
}
