import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { AudioJob } from "./types.js";

function createFakeJob(overrides: Partial<AudioJob> = {}): AudioJob {
  return {
    id: overrides.id ?? "job-background",
    status: overrides.status ?? "queued",
    internalState: overrides.internalState ?? "queued",
    displayTitle: overrides.displayTitle ?? "Readable title",
    speechScript: overrides.speechScript ?? "Readable title. Body copy.",
    leaseOwner: overrides.leaseOwner ?? null,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    runId: overrides.runId ?? null,
    attempt: overrides.attempt ?? 1,
    article: overrides.article ?? {
      url: "https://example.com/posts/background",
      title: "Background Test",
      byline: null,
      siteName: "Example",
      excerpt: null,
      textContent: "Body copy.",
      wordCount: 2,
      estimatedMinutes: 1,
    },
    speechOptions: overrides.speechOptions ?? { voice: "alloy" },
    provider: overrides.provider ?? "test-provider",
    audioUrl: overrides.audioUrl ?? null,
    audioSegments: overrides.audioSegments ?? [],
    durationSeconds: overrides.durationSeconds ?? null,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? "2026-04-05T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-05T10:00:00.000Z",
    userId: overrides.userId ?? null,
  };
}

describe("app background task handling", () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    consoleErrorSpy.mockClear();
    while (servers.length > 0) {
      const server = servers.pop()!;
      server.close();
      await once(server, "close");
    }
  });

  it("logs detached startup recovery failures", async () => {
    const initError = new Error("startup recovery failed");
    const audioJobService = {
      init: vi.fn().mockRejectedValue(initError),
      requeueInterruptedJobs: vi.fn(),
      getProviderName: vi.fn().mockReturnValue("test-provider"),
      getAvailableVoices: vi.fn().mockReturnValue(["alloy"]),
    } as any;
    const jobStore = { check: vi.fn() } as any;
    const audioStore = { check: vi.fn() } as any;

    createApp({
      audioJobService,
      jobStore,
      audioStore,
      recoverInterruptedJobsOnStartup: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Background task failed: startup_recovery",
      initError,
    );
    expect(audioJobService.requeueInterruptedJobs).not.toHaveBeenCalled();
  });

  it("logs detached processJob failures after creating a job", async () => {
    const processError = new Error("background process failed");
    const createdJob = createFakeJob();
    const audioJobService = {
      init: vi.fn().mockResolvedValue(undefined),
      createJob: vi.fn().mockResolvedValue(createdJob),
      processJob: vi.fn().mockRejectedValue(processError),
      getProviderName: vi.fn().mockReturnValue("test-provider"),
      getAvailableVoices: vi.fn().mockReturnValue(["alloy"]),
      listJobs: vi.fn().mockResolvedValue([]),
      getJob: vi.fn(),
      deleteJob: vi.fn(),
      getOrCreateVoicePreview: vi.fn(),
    } as any;
    const jobStore = { check: vi.fn() } as any;
    const audioStore = { check: vi.fn() } as any;

    const app = createApp({
      audioJobService,
      jobStore,
      audioStore,
    });
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");
    servers.push(server);

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/posts/background",
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(202);
    expect(audioJobService.processJob).toHaveBeenCalledWith(createdJob.id);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      `Background task failed: process_job:${createdJob.id}`,
      processError,
    );
  });
});
