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
    publishedChunkCount: 0,
    liveEdgeUpdatedAt: null,
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
      text.includes("set lease_expires_at = case") &&
      text.includes("where id =") &&
      text.includes("and lease_owner =") &&
      text.includes("and run_id =") &&
      text.includes("and lease_expires_at >") &&
      text.includes("status = 'processing'")
    ) {
      const proposedLeaseExpiresAt = values[0] as string;
      const leaseExpiresAt = values[1] as string;
      const updatedAt = values[2] as string;
      const jobId = values[3] as string;
      const leaseOwner = values[4] as string;
      const runId = values[5] as string;
      const currentTime = values[6] as string;
      const job = jobs.get(jobId);
      if (
        !job ||
        job.status !== "processing" ||
        job.lease_owner !== leaseOwner ||
        job.run_id !== runId ||
        typeof job.lease_expires_at !== "string" ||
        job.lease_expires_at <= currentTime
      ) {
        return [];
      }
      const nextJob = {
        ...job,
        lease_expires_at:
          typeof job.lease_expires_at === "string" &&
          job.lease_expires_at > proposedLeaseExpiresAt
            ? job.lease_expires_at
            : leaseExpiresAt,
        updated_at: updatedAt,
      };
      jobs.set(jobId, nextJob);
      return [nextJob];
    }

    if (
      text.startsWith("update audio_jobs set") &&
      text.includes("status = 'queued'") &&
      text.includes("internal_state = 'queued'") &&
      text.includes("lease_owner = null") &&
      text.includes("lease_expires_at = null") &&
      text.includes("run_id = null") &&
      text.includes("where id =") &&
      text.includes("status = 'processing'") &&
      text.includes("lease_owner is not distinct from") &&
      text.includes("run_id is not distinct from") &&
      text.includes("lease_expires_at =") &&
      text.includes("lease_expires_at <=")
    ) {
      const errorMessage = values[0] as string;
      const updatedAt = values[1] as string;
      const jobId = values[2] as string;
      const leaseOwner = values[3] as string | null;
      const runId = values[4] as string | null;
      const expectedLeaseExpiresAt = values[5] as string;
      const currentTime = values[6] as string;
      const job = jobs.get(jobId);

      if (
        !job ||
        job.status !== "processing" ||
        job.lease_owner !== leaseOwner ||
        job.run_id !== runId ||
        job.lease_expires_at !== expectedLeaseExpiresAt ||
        typeof job.lease_expires_at !== "string" ||
        job.lease_expires_at > currentTime
      ) {
        return [];
      }

      const nextJob = {
        ...job,
        status: "queued",
        internal_state: "queued",
        lease_owner: null,
        lease_expires_at: null,
        run_id: null,
        error: errorMessage,
        updated_at: updatedAt,
      };
      jobs.set(jobId, nextJob);
      return [nextJob];
    }

    if (
      text.startsWith("update audio_jobs set") &&
      text.includes("where id =") &&
      text.includes("and status =") &&
      text.includes("and lease_owner is not distinct from") &&
      text.includes("and lease_expires_at is not distinct from") &&
      text.includes("and run_id is not distinct from")
    ) {
      const jobId = values[values.length - 5] as string;
      const status = values[values.length - 4] as string;
      const leaseOwner = values[values.length - 3] as string | null;
      const leaseExpiresAt = values[values.length - 2] as string | null;
      const runId = values[values.length - 1] as string | null;
      const job = jobs.get(jobId);

      if (
        !job ||
        job.status !== status ||
        job.lease_owner !== leaseOwner ||
        job.lease_expires_at !== leaseExpiresAt ||
        job.run_id !== runId
      ) {
        return [];
      }

      const nextJob = patchJobFromUpdate(job, values.slice(0, -5), text);
      jobs.set(jobId, nextJob);
      return [nextJob];
    }

    if (
      text.startsWith("update audio_jobs set") &&
      text.includes("where id =") &&
      text.includes("and lease_owner =") &&
      text.includes("and run_id =") &&
      text.includes("and lease_expires_at >") &&
      !text.includes("status = 'processing'")
    ) {
      const jobId = values[values.length - 4] as string;
      const leaseOwner = values[values.length - 3] as string;
      const runId = values[values.length - 2] as string;
      const currentTime = values[values.length - 1] as string;
      const job = jobs.get(jobId);
      if (
        !job ||
        job.lease_owner !== leaseOwner ||
        job.run_id !== runId ||
        typeof job.lease_expires_at !== "string" ||
        job.lease_expires_at <= currentTime
      ) {
        return [];
      }
      const nextJob = patchJobFromUpdate(job, values.slice(0, -4), text);
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

    if (text.startsWith("delete from job_events where not exists")) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const row = events[index];
        if (row && !jobs.has(String(row.job_id))) {
          events.splice(index, 1);
        }
      }
      return [];
    }

    if (text.startsWith("delete from job_events where job_id =") && !text.includes("exists")) {
      const jobId = values[0] as string;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.job_id === jobId) {
          events.splice(index, 1);
        }
      }
      return [];
    }

    if (text.startsWith("delete from job_events") && text.includes("exists")) {
      const jobId = values[0] as string;
      const userId = values[2] as string;
      const job = jobs.get(jobId);
      if (!job || job.user_id !== userId) {
        return [];
      }
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.job_id === jobId) {
          events.splice(index, 1);
        }
      }
      return [];
    }

    if (text.startsWith("delete from audio_jobs where id =") && text.includes("and user_id =")) {
      const [jobId, userId] = values as [string, string];
      const job = jobs.get(jobId);
      if (!job || job.user_id !== userId) {
        return [];
      }
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.job_id === jobId) {
          events.splice(index, 1);
        }
      }
      jobs.delete(jobId);
      return [{ id: jobId }];
    }

    if (text.startsWith("delete from audio_jobs where id =")) {
      const jobId = values[0] as string;
      if (!jobs.has(jobId)) {
        return [];
      }
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.job_id === jobId) {
          events.splice(index, 1);
        }
      }
      jobs.delete(jobId);
      return [{ id: jobId }];
    }

    if (text.startsWith("insert into job_events")) {
      const event = rowFromEventInsert(values);
      if (!jobs.has(String(event.job_id))) {
        throw new Error("insert or update on table \"job_events\" violates foreign key constraint");
      }
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
    published_chunk_count: values[6],
    live_edge_updated_at: values[7],
    lease_owner: values[8],
    lease_expires_at: values[9],
    run_id: values[10],
    attempt: values[11],
    article: values[12],
    speech_options: values[13],
    provider: values[14],
    audio_url: values[15],
    playlist_url: values[16],
    audio_segments: values[17],
    duration_seconds: values[18],
    error: values[19],
    created_at: values[20],
    updated_at: values[21],
    user_id: values[22],
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
    let cursor = 0;
    const read = <T>(current: T): T => {
      const hasValue = Boolean(values[cursor++]);
      const nextValue = values[cursor++];
      return hasValue ? (nextValue as T) : current;
    };

    return {
      ...job,
      status: read(job.status),
      internal_state: read(job.internal_state),
      display_title: read(job.display_title),
      speech_script: read(job.speech_script),
      available_duration_seconds: read(job.available_duration_seconds),
      published_chunk_count: read(job.published_chunk_count),
      live_edge_updated_at: read(job.live_edge_updated_at),
      lease_owner: read(job.lease_owner),
      lease_expires_at: read(job.lease_expires_at),
      run_id: read(job.run_id),
      attempt: read(job.attempt),
      audio_url: read(job.audio_url),
      playlist_url: read(job.playlist_url),
      audio_segments: read(job.audio_segments),
      duration_seconds: read(job.duration_seconds),
      error: read(job.error),
      updated_at: values[cursor],
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
    await store.save(createJob());

    await store.appendEvent("job-1", {
      type: "job_created",
      sequenceNumber: 1,
    });

    const events = await store.listEvents("job-1");
    expect(events.map((event) => event.type)).toEqual(["job_created"]);
    expect(events[0]?.sequenceNumber).toBe(1);
  });

  it("round-trips the added job columns", async () => {
    const { store } = makeJobStore();
    await store.init();

    await store.save(
      createJob({
        status: "processing",
        internalState: "synthesizing",
        displayTitle: "Readable Title",
        speechScript: "Readable Title\nBody text.",
        availableDurationSeconds: 42,
        publishedChunkCount: 3,
        liveEdgeUpdatedAt: "2026-01-01T00:06:00.000Z",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-01-01T00:10:00.000Z",
        runId: "run-1",
        attempt: 3,
      }),
    );

    const job = await store.get("job-1");
    expect(job).toMatchObject({
      status: "processing",
      internalState: "synthesizing",
      displayTitle: "Readable Title",
      speechScript: "Readable Title\nBody text.",
      availableDurationSeconds: 42,
      publishedChunkCount: 3,
      liveEdgeUpdatedAt: "2026-01-01T00:06:00.000Z",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-01-01T00:10:00.000Z",
      runId: "run-1",
      attempt: 3,
    });
  });

  it("deduplicates event sequences and honors limits", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(createJob());

    await store.appendEvent("job-1", {
      type: "job_created",
      sequenceNumber: 1,
      payload: { phase: "first" },
    });
    await store.appendEvent("job-1", {
      type: "job_created",
      sequenceNumber: 1,
      payload: { phase: "updated" },
    });
    await store.appendEvent("job-1", {
      type: "chunk_ready",
      sequenceNumber: 2,
    });

    const limited = await store.listEvents("job-1", { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({
      type: "job_created",
      sequenceNumber: 1,
      payload: { phase: "updated" },
    });

    const allEvents = await store.listEvents("job-1");
    expect(allEvents).toHaveLength(2);
    expect(allEvents.map((event) => event.sequenceNumber)).toEqual([1, 2]);
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
        leaseExpiresAt: "2099-01-01T00:05:00.000Z",
        runId: "run-1",
      }),
    );

    const updated = await store.heartbeat?.(
      "job-1",
      "worker-1",
      "2099-01-01T00:10:00.000Z",
      "run-1",
    );

    expect(updated).toBe(true);
    expect((await store.get("job-1"))?.leaseExpiresAt).toBe("2099-01-01T00:10:00.000Z");
  });

  it("does not let a delayed heartbeat shorten an active lease", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        status: "processing",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2099-01-01T00:10:00.000Z",
        runId: "run-1",
      }),
    );

    const updated = await store.heartbeat?.(
      "job-1",
      "worker-1",
      "2099-01-01T00:08:00.000Z",
      "run-1",
    );

    expect(updated).toBe(true);
    expect((await store.get("job-1"))?.leaseExpiresAt).toBe("2099-01-01T00:10:00.000Z");
  });

  it("rejects a late heartbeat after the lease already expired", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        status: "processing",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        runId: "run-1",
      }),
    );

    const updated = await store.heartbeat?.(
      "job-1",
      "worker-1",
      "2026-01-01T00:10:00.000Z",
      "run-1",
    );

    expect(updated).toBe(false);
    expect((await store.get("job-1"))?.leaseExpiresAt).toBe("2000-01-01T00:00:00.000Z");
  });

  it("rejects owned updates after the lease already expired", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        status: "processing",
        internalState: "synthesizing",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        runId: "run-1",
      }),
    );

    expect(
      await store.updateOwned(
        "job-1",
        { internalState: "finalizing" },
        { leaseOwner: "worker-1", runId: "run-1" },
      ),
    ).toBe(false);
    expect((await store.get("job-1"))?.internalState).toBe("synthesizing");
  });

  it("fences owned updates and heartbeats by run id", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        status: "processing",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2099-01-01T00:05:00.000Z",
        runId: "run-1",
      }),
    );

    expect(
      await store.updateOwned("job-1", { internalState: "finalizing" }, {
        leaseOwner: "worker-1",
        runId: "run-1",
      }),
    ).toBe(true);
    expect((await store.get("job-1"))?.internalState).toBe("finalizing");

    expect(
      await store.updateOwned("job-1", { status: "completed" }, {
        leaseOwner: "worker-1",
        runId: "run-2",
      }),
    ).toBe(false);
    expect((await store.get("job-1"))?.status).toBe("processing");

    expect(
      await store.heartbeat?.(
        "job-1",
        "worker-1",
        "2026-01-01T00:10:00.000Z",
        "run-2",
      ),
    ).toBe(false);
    expect((await store.get("job-1"))?.leaseExpiresAt).toBe("2099-01-01T00:05:00.000Z");
  });

  it("requeues expired jobs only when the observed lease snapshot still matches", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        status: "processing",
        internalState: "synthesizing",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        runId: "run-1",
      }),
    );

    expect(
      await store.requeueExpiredLease("job-1", {
        leaseOwner: "worker-1",
        runId: "run-2",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(false);

    expect(
      await store.requeueExpiredLease("job-1", {
        leaseOwner: "worker-1",
        runId: "run-1",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);

    expect(await store.get("job-1")).toMatchObject({
      status: "queued",
      internalState: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      runId: null,
      error: "Job re-queued after lease expiry.",
    });
  });

  it("updates only when the observed lease snapshot still matches", async () => {
    const { store } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        status: "processing",
        internalState: "finalizing",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2000-01-01T00:00:00.000Z",
        runId: "run-1",
        error: "stuck finalizing",
      }),
    );

    expect(
      await store.updateIfLeaseSnapshotMatches(
        "job-1",
        {
          status: "completed",
          internalState: "completed",
          audioUrl: "/audio/jobs/job-1/final.mp3",
          leaseOwner: null,
          leaseExpiresAt: null,
          runId: null,
          error: null,
        },
        {
          status: "processing",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2000-01-01T00:00:00.000Z",
          runId: "run-2",
        },
      ),
    ).toBe(false);

    expect(
      await store.updateIfLeaseSnapshotMatches(
        "job-1",
        {
          status: "completed",
          internalState: "completed",
          audioUrl: "/audio/jobs/job-1/final.mp3",
          leaseOwner: null,
          leaseExpiresAt: null,
          runId: null,
          error: null,
        },
        {
          status: "processing",
          leaseOwner: "worker-1",
          leaseExpiresAt: "2000-01-01T00:00:00.000Z",
          runId: "run-1",
        },
      ),
    ).toBe(true);

    expect(await store.get("job-1")).toMatchObject({
      status: "completed",
      internalState: "completed",
      audioUrl: "/audio/jobs/job-1/final.mp3",
      leaseOwner: null,
      leaseExpiresAt: null,
      runId: null,
      error: null,
    });
  });

  it("deletes related events when deleting a job", async () => {
    const { store, harness } = makeJobStore();
    await store.init();
    await store.save(createJob());
    await store.appendEvent("job-1", { type: "job_created", sequenceNumber: 1 });
    await store.appendEvent("job-1", { type: "chunk_ready", sequenceNumber: 2 });

    const queryCountBeforeDelete = harness.queries.length;
    expect(await store.delete("job-1")).toBe(true);
    expect(await store.get("job-1")).toBeNull();
    expect(await store.listEvents("job-1")).toEqual([]);
    expect(
      harness.queries
        .slice(queryCountBeforeDelete)
        .some((query) => query.startsWith("delete from job_events")),
    ).toBe(false);
  });

  it("deletes related events when deleting a user-owned job", async () => {
    const { store, harness } = makeJobStore();
    await store.init();
    await store.save(
      createJob({
        userId: "user-1",
      }),
    );
    await store.appendEvent("job-1", { type: "job_created", sequenceNumber: 1 });

    const queryCountBeforeDelete = harness.queries.length;
    expect(await store.deleteForUser("job-1", "user-1")).toBe(true);
    expect(await store.getForUser("job-1", "user-1")).toBeNull();
    expect(await store.listEvents("job-1")).toEqual([]);
    expect(
      harness.queries
        .slice(queryCountBeforeDelete)
        .some((query) => query.startsWith("delete from job_events")),
    ).toBe(false);
  });

  it("cleans orphan events before retrofitting the foreign key", async () => {
    const { store, harness } = makeJobStore();
    harness.jobs.set("job-1", { id: "job-1", user_id: null });
    harness.events.push(
      {
        id: "event-orphan",
        job_id: "missing-job",
        event_type: "job_created",
        sequence_number: 1,
        payload: null,
        occurred_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "event-valid",
        job_id: "job-1",
        event_type: "job_created",
        sequence_number: 2,
        payload: null,
        occurred_at: "2026-01-01T00:01:00.000Z",
      },
    );

    await store.init();

    expect(harness.events.map((event) => event.job_id)).toEqual(["job-1"]);
    const cleanupIndex = harness.queries.findIndex((query) =>
      query.startsWith("delete from job_events where not exists"),
    );
    const fkIndex = harness.queries.findIndex((query) =>
      query.includes("add constraint job_events_job_id_fkey"),
    );
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(fkIndex).toBeGreaterThan(cleanupIndex);
  });
});
