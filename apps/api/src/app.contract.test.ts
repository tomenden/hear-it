import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { AudioJobService } from "./jobs.js";
import { FileAudioStore, FileJobStore } from "./storage-fs.js";
import type {
  AudioJob,
  AudioRenderResult,
  ExtractedArticle,
  SpeechOptions,
} from "./types.js";
import type { SpeechProvider, SpeechSynthesisContext } from "./tts.js";

class ContractTestSpeechProvider implements SpeechProvider {
  readonly name = "contract-test";

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    _text: string,
    _speechOptions: SpeechOptions,
    _context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    throw new Error("Contract tests do not synthesize audio.");
  }
}

function buildJob(overrides: Partial<AudioJob> = {}): AudioJob {
  const createdAt = overrides.createdAt ?? "2026-04-05T10:00:00.000Z";
  const updatedAt = overrides.updatedAt ?? createdAt;

  return {
    id: overrides.id ?? "job-1",
    status: overrides.status ?? "queued",
    internalState: overrides.internalState ?? "queued",
    displayTitle: overrides.displayTitle ?? "Readable title",
    speechScript: overrides.speechScript ?? "Readable title. Body copy.",
    availableDurationSeconds: overrides.availableDurationSeconds ?? 0,
    liveEdgeUpdatedAt: overrides.liveEdgeUpdatedAt ?? null,
    leaseOwner: overrides.leaseOwner ?? null,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    runId: overrides.runId ?? null,
    attempt: overrides.attempt ?? 1,
    article: overrides.article ?? {
      url: "https://example.com/posts/contract",
      title: "Raw article title",
      byline: null,
      siteName: "Example",
      excerpt: null,
      textContent: "Body copy.",
      wordCount: 2,
      estimatedMinutes: 1,
    },
    speechOptions: overrides.speechOptions ?? {
      voice: "alloy",
    },
    provider: overrides.provider ?? "contract-test",
    audioUrl: overrides.audioUrl ?? null,
    audioDownloadPath: overrides.audioDownloadPath ?? "/audio/legacy-download.mp3",
    playlistUrl: overrides.playlistUrl ?? null,
    audioSegments: overrides.audioSegments ?? [],
    durationSeconds: overrides.durationSeconds ?? null,
    error: overrides.error ?? null,
    createdAt,
    updatedAt,
    userId: overrides.userId ?? null,
  };
}

async function createContractHarness(jobs: AudioJob[]) {
  const baseDir = await mkdtemp(join(tmpdir(), "hear-it-app-contract-"));
  const jobsFilePath = join(baseDir, "jobs.json");
  await writeFile(jobsFilePath, JSON.stringify({ jobs }), "utf8");

  const jobStore = new FileJobStore(jobsFilePath);
  const audioStore = new FileAudioStore(join(baseDir, "audio"), "/audio");
  const audioJobService = new AudioJobService({
    jobStore,
    audioStore,
    speechProvider: new ContractTestSpeechProvider(),
  });
  const app = createApp({ audioJobService, jobStore, audioStore });
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");

  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function closeServer(server: ReturnType<typeof createServer>) {
  server.close();
  await once(server, "close");
}

describe("audio job API contract", () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await closeServer(servers.pop()!);
    }
  });

  it("serializes processing jobs with coarse public state and explicit streaming playback", async () => {
    const processingJob = buildJob({
      id: "job-processing",
      status: "processing",
      internalState: "packaging_stream",
      playlistUrl: "/audio/jobs/job-processing/playlist.m3u8",
      audioSegments: [
        { url: "/audio/jobs/job-processing/chunk-0.mp3", durationSeconds: 11 },
        { url: "/audio/jobs/job-processing/chunk-1.mp3", durationSeconds: 16 },
      ],
      availableDurationSeconds: 27,
      liveEdgeUpdatedAt: "2026-04-05T10:02:00.000Z",
      updatedAt: "2026-04-05T10:02:00.000Z",
    });

    const harness = await createContractHarness([processingJob]);
    servers.push(harness.server);

    const response = await fetch(`${harness.baseUrl}/api/jobs/${processingJob.id}`);
    const payload = await response.json() as { job: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.job).toEqual({
      id: "job-processing",
      title: "Readable title",
      state: "processing",
      article: {
        url: "https://example.com/posts/contract",
        siteName: "Example",
        excerpt: null,
        estimatedMinutes: 1,
      },
      voice: "alloy",
      playback: {
        mode: "streaming",
        isPlayable: true,
        playlistUrl: "/audio/jobs/job-processing/playlist.m3u8",
        availableDurationSeconds: 27,
        liveEdgeUpdatedAt: "2026-04-05T10:02:00.000Z",
      },
      progress: {
        chunksTotal: null,
        chunksReady: 2,
        availableDurationSeconds: 27,
      },
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:02:00.000Z",
    });
  });

  it("keeps playlist-only processing jobs in preparing mode until live edge is explicit", async () => {
    const playlistOnlyJob = buildJob({
      id: "job-playlist-only",
      status: "processing",
      internalState: "packaging_stream",
      playlistUrl: "/audio/jobs/job-playlist-only/playlist.m3u8",
      audioSegments: [
        { url: "/audio/jobs/job-playlist-only/chunk-0.mp3", durationSeconds: 11 },
        { url: "/audio/jobs/job-playlist-only/chunk-1.mp3", durationSeconds: 16 },
      ],
      availableDurationSeconds: 27,
      liveEdgeUpdatedAt: null,
      updatedAt: "2026-04-05T10:03:00.000Z",
    });

    const harness = await createContractHarness([playlistOnlyJob]);
    servers.push(harness.server);

    const response = await fetch(`${harness.baseUrl}/api/jobs/${playlistOnlyJob.id}`);
    const payload = await response.json() as { job: Record<string, unknown> };

    expect(response.status).toBe(200);
    expect(payload.job).toEqual({
      id: "job-playlist-only",
      title: "Readable title",
      state: "processing",
      article: {
        url: "https://example.com/posts/contract",
        siteName: "Example",
        excerpt: null,
        estimatedMinutes: 1,
      },
      voice: "alloy",
      playback: {
        mode: "preparing",
        isPlayable: false,
        availableDurationSeconds: 0,
        liveEdgeUpdatedAt: null,
      },
      progress: {
        chunksTotal: null,
        chunksReady: 2,
        availableDurationSeconds: 27,
      },
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:03:00.000Z",
    });
  });

  it("serializes list responses with explicit queued, ready, and failed playback contracts", async () => {
    const queuedJob = buildJob({
      id: "job-queued",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:00:00.000Z",
    });
    const readyJob = buildJob({
      id: "job-ready",
      status: "completed",
      internalState: "completed",
      createdAt: "2026-04-05T10:01:00.000Z",
      updatedAt: "2026-04-05T10:04:00.000Z",
      audioUrl: "/audio/jobs/job-ready/final.mp3",
      audioSegments: [
        { url: "/audio/jobs/job-ready/chunk-0.mp3", durationSeconds: 12 },
        { url: "/audio/jobs/job-ready/chunk-1.mp3", durationSeconds: 18 },
      ],
      availableDurationSeconds: 30,
      durationSeconds: 30,
      liveEdgeUpdatedAt: "2026-04-05T10:03:30.000Z",
    });
    const failedJob = buildJob({
      id: "job-failed",
      status: "failed",
      internalState: "failed",
      createdAt: "2026-04-05T10:02:00.000Z",
      updatedAt: "2026-04-05T10:05:00.000Z",
      error: "Audio generation failed.",
    });

    const harness = await createContractHarness([queuedJob, readyJob, failedJob]);
    servers.push(harness.server);

    const response = await fetch(`${harness.baseUrl}/api/jobs`);
    const payload = await response.json() as {
      jobs: Array<{
        id: string;
        state: string;
        playback: Record<string, unknown>;
        progress: Record<string, unknown>;
        [key: string]: unknown;
      }>;
    };

    expect(response.status).toBe(200);

    expect(payload.jobs).toEqual([
      {
        id: "job-failed",
        title: "Readable title",
        state: "failed",
        article: {
          url: "https://example.com/posts/contract",
          siteName: "Example",
          excerpt: null,
          estimatedMinutes: 1,
        },
        voice: "alloy",
        playback: {
          mode: "failed",
          isPlayable: false,
          errorMessage: "Audio generation failed.",
        },
        progress: {
          chunksTotal: null,
          chunksReady: 0,
          availableDurationSeconds: 0,
        },
        createdAt: "2026-04-05T10:02:00.000Z",
        updatedAt: "2026-04-05T10:05:00.000Z",
      },
      {
        id: "job-ready",
        title: "Readable title",
        state: "ready",
        article: {
          url: "https://example.com/posts/contract",
          siteName: "Example",
          excerpt: null,
          estimatedMinutes: 1,
        },
        voice: "alloy",
        playback: {
          mode: "final",
          isPlayable: true,
          audioUrl: "/audio/jobs/job-ready/final.mp3",
          durationSeconds: 30,
          fileName: "Readable title.mp3",
        },
        progress: {
          chunksTotal: 2,
          chunksReady: 2,
          availableDurationSeconds: 30,
        },
        createdAt: "2026-04-05T10:01:00.000Z",
        updatedAt: "2026-04-05T10:04:00.000Z",
      },
      {
        id: "job-queued",
        title: "Readable title",
        state: "queued",
        article: {
          url: "https://example.com/posts/contract",
          siteName: "Example",
          excerpt: null,
          estimatedMinutes: 1,
        },
        voice: "alloy",
        playback: {
          mode: "preparing",
          isPlayable: false,
          availableDurationSeconds: 0,
          liveEdgeUpdatedAt: null,
        },
        progress: {
          chunksTotal: null,
          chunksReady: 0,
          availableDurationSeconds: 0,
        },
        createdAt: "2026-04-05T10:00:00.000Z",
        updatedAt: "2026-04-05T10:00:00.000Z",
      },
    ]);
  });
});
