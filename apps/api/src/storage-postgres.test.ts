import { describe, expect, it } from "vitest";

import { PostgresJobStore, type SqlClient } from "./storage-postgres.js";
import type { AudioJob } from "./types.js";

function createJob(overrides: Partial<AudioJob> = {}): AudioJob {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id: "job-1",
    status: "queued",
    internalState: "queued",
    displayTitle: "Example Article",
    speechScript: "Example Article\nThis is the body.",
    availableDurationSeconds: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    runId: null,
    attempt: 0,
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
    durationSeconds: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    userId: null,
    ...overrides,
  };
}

function createSqlHarness() {
  const jobs = new Map<string, SqlRow>();
  const events: SqlRow[] = [];
  const queries: string[] = [];

  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = normalizeSql(strings);
    queries.push(text);

    if (text.startsWith("select 1")) {
      return [];
    }

    if (text.includes("create table if not exists") || text.includes("create index if not exists") || text.includes("create sequence if not exists") || text.includes("alter table")) {
      return [];
    }

    if (text.startsWith("insert into audio_jobs")) {
      const job = rowFromInsert(values);
      jobs.set(job.id as string, job);
      return [];
    }

    if (text.startsWith("select * from audio_jobs where id =") && !text.includes("user_id")) {
      const jobId = values[0] as string;
      return jobs.has(jobId) ? [jobs.get(jobId)!] : [];
    }

    if (text.startsWith("select * from audio_jobs where id =") && text.includes("and user_id =")) {
      const [jobId, userId] = values as [string, string];
      const job = jobs.get(jobId);
      return job && job.user_id === userId ? [job] : [];
    }

    if (text.startsWith("select * from audio_jobs where user_id =")) {
      const userId = values[0] as string;
      return Array.from(jobs.values())
        .filter((job) => job.user_id === userId)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }

    if (text.startsWith("select * from audio_jobs order by created_at desc")) {
      return Array.from(jobs.values()).sort((a, b) =>
        String(b.created_at).localeCompare(String(a.created_at)),
      );
    }

    if (
      text.startsWith("update audio_jobs") &&
      text.includes("status = 'processing'") &&
      text.includes("lease_owner =") &&
      text.includes("run_id =") &&
      text.includes("attempt =")
    ) {
      const jobId = values[5] as string;
      const job = jobs.get(jobId);
      if (!job || job.status !== "queued") {
        return [];
      }

      const nextJob = {
        ...job,
        status: "processing",
        lease_owner: values[0] as string,
        lease_expires_at: values[1] as string,
        run_id: values[2] ?? null,
        attempt: values[3] ?? 1,
        updated_at: values[4] as string,
      };
      jobs.set(jobId, nextJob);
      return [nextJob];
    }

    if (text.startsWith("update audio_jobs") && text.includes("status = 'processing'") && !text.includes("lease_owner =")) {
      const updatedAt = values[0] as string;
      const jobId = values[1] as string;
      const job = jobs.get(jobId);
      if (!job || job.status !== "queued") {
        return [];
      }
      const nextJob = { ...job, status: "processing", updated_at: updatedAt };
      jobs.set(jobId, nextJob);
      return [nextJob];
    }

    if (
      text.startsWith("update audio_jobs") &&
      text.includes("set lease_expires_at =") &&
      text.includes("where id =") &&
      text.includes("and lease_owner =") &&
      text.includes("status = 'processing'")
    ) {
      const leaseExpiresAt = values[0] as string;
      const updatedAt = values[1] as string;
      const jobId = values[2] as string;
      const leaseOwner = values[3] as string;
      const job = jobs.get(jobId);
      if (!job || job.status !== "processing" || job.lease_owner !== leaseOwner) {
        return [];
      }
      const nextJob = {
        ...job,
        lease_expires_at: leaseExpiresAt,
        updated_at: updatedAt,
      };
      jobs.set(jobId, nextJob);
      return [nextJob];
    }

    if (text.startsWith("update audio_jobs set")) {
      const jobId = values[values.length - 1] as string;
      const job = jobs.get(jobId);
      if (!job) {
        return [];
      }
      const nextJob = patchJobFromUpdate(job, values, text);
      jobs.set(jobId, nextJob);
      return [nextJob];
    }

    if (text.startsWith("delete from audio_jobs where id =") && text.includes("and user_id =")) {
      const [jobId, userId] = values as [string, string];
      const job = jobs.get(jobId);
      if (!job || job.user_id !== userId) {
        return [];
      }
      jobs.delete(jobId);
      return [{ id: jobId }];
    }

    if (text.startsWith("delete from audio_jobs where id =")) {
      const jobId = values[0] as string;
      if (!jobs.has(jobId)) {
        return [];
      }
      jobs.delete(jobId);
      return [{ id: jobId }];
    }

    if (text.startsWith("insert into job_events")) {
      const event = rowFromEventInsert(values);
      const existingIndex = events.findIndex(
        (row) =>
          row.job_id === event.job_id &&
          row.sequence_number === event.sequence_number,
      );
      if (existingIndex >= 0) {
        events[existingIndex] = event;
      } else {
        events.push(event);
      }
      return [];
    }

    if (text.startsWith("select * from job_events")) {
      const jobId = values[0] as string;
      const limit = text.includes("limit") ? (values[1] as number) : undefined;
      const rows = events
        .filter((row) => row.job_id === jobId)
        .sort((a, b) =>
          Number(a.sequence_number) - Number(b.sequence_number) ||
          String(a.occurred_at).localeCompare(String(b.occurred_at)),
        );
      return typeof limit === "number" ? rows.slice(0, limit) : rows;
    }

    return [];
  }) as SqlClient;

  sql.json = (value) => value;

  return { sql, jobs, events, queries };
}

type SqlRow = Record<string, unknown>;

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

function rowFromInsert(values: unknown[]): SqlRow {
  return {
    id: values[0],
    status: values[1],
    internal_state: values[2],
    display_title: values[3],
    speech_script: values[4],
    available_duration_seconds: values[5],
    lease_owner: values[6],
    lease_expires_at: values[7],
    run_id: values[8],
    attempt: values[9],
    article: values[10],
    speech_options: values[11],
    provider: values[12],
    audio_url: values[13],
    playlist_url: values[14],
    audio_segments: values[15],
    duration_seconds: values[16],
    error: values[17],
    created_at: values[18],
    updated_at: values[19],
    user_id: values[20],
  };
}

function rowFromEventInsert(values: unknown[]): SqlRow {
  return {
    id: values[0],
    job_id: values[1],
    event_type: values[2],
    sequence_number: values[3],
    payload: values[4],
    occurred_at: values[5],
  };
}

function patchJobFromUpdate(job: SqlRow, values: unknown[], text: string): SqlRow {
  if (text.includes("audio_url = case when")) {
    return {
      ...job,
      status: values[0] !== undefined ? values[0] : job.status,
      internal_state: values[1] !== undefined ? values[1] : job.internal_state,
      display_title: values[2] !== undefined ? values[2] : job.display_title,
      speech_script: values[3] !== undefined ? values[3] : job.speech_script,
      available_duration_seconds:
        values[4] !== undefined ? values[4] : job.available_duration_seconds,
      lease_owner: values[5] !== undefined ? values[5] : job.lease_owner,
      lease_expires_at: values[6] !== undefined ? values[6] : job.lease_expires_at,
      run_id: values[7] !== undefined ? values[7] : job.run_id,
      attempt: values[8] !== undefined ? values[8] : job.attempt,
      audio_url: values[9] !== undefined ? values[9] : job.audio_url,
      playlist_url: values[10] !== undefined ? values[10] : job.playlist_url,
      audio_segments: values[11] !== undefined ? values[11] : job.audio_segments,
      duration_seconds: values[12] !== undefined ? values[12] : job.duration_seconds,
      error: values[13] !== undefined ? values[13] : job.error,
      updated_at: values[14],
    };
  }

  return job;
}

function makeJobStore() {
  const harness = createSqlHarness();
  const store = new PostgresJobStore({ sql: harness.sql });
  return { store, harness };
}

describe("PostgresJobStore events and leases", () => {
  it("records a job_created event", async () => {
    const { store } = makeJobStore();
    await store.init();

    await store.appendEvent?.("job-1", {
      type: "job_created",
      sequenceNumber: 1,
    });

    const events = await store.listEvents?.("job-1");
    expect(events?.map((event) => event.type)).toEqual(["job_created"]);
    expect(events?.[0]?.sequenceNumber).toBe(1);
  });

  it("claims a job with a lease", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(createJob());

    const claimed = await store.claimQueued("job-1", {
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-01-01T00:05:00.000Z",
      runId: "run-1",
      attempt: 1,
    });

    expect(claimed?.status).toBe("processing");
    expect(claimed?.leaseOwner).toBe("worker-1");
    expect(claimed?.leaseExpiresAt).toBe("2026-01-01T00:05:00.000Z");
    expect(claimed?.runId).toBe("run-1");
    expect(claimed?.attempt).toBe(1);
  });

  it("extends a heartbeat", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        status: "processing",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-01-01T00:05:00.000Z",
      }),
    );

    const updated = await store.heartbeat?.(
      "job-1",
      "worker-1",
      "2026-01-01T00:10:00.000Z",
    );

    expect(updated).toBe(true);
    expect((await store.get("job-1"))?.leaseExpiresAt).toBe("2026-01-01T00:10:00.000Z");
  });

  it("reads back recent events in order", async () => {
    const { store } = makeJobStore();
    await store.init();

    await store.appendEvent?.("job-1", { type: "job_created", sequenceNumber: 1 });
    await store.appendEvent?.("job-1", { type: "chunk_ready", sequenceNumber: 2 });
    await store.appendEvent?.("job-1", { type: "job_completed", sequenceNumber: 3 });

    const events = await store.listEvents?.("job-1");
    expect(events?.map((event) => event.type)).toEqual([
      "job_created",
      "chunk_ready",
      "job_completed",
    ]);
    expect(events?.map((event) => event.sequenceNumber)).toEqual([1, 2, 3]);
  });
});
