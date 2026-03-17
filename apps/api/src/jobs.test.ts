import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import * as jose from "jose";

import { createAuthMiddleware } from "./auth.js";
import { createApp, createAudioJobSchema, extractRequestSchema } from "./app.js";
import { MAX_NARRATION_CHARS } from "./extractor.js";
import { AudioJobService } from "./jobs.js";
import { FileJobStore, FileAudioStore } from "./storage-fs.js";
import type { AudioStore } from "./storage.js";
import type {
  AudioRenderResult,
  ExtractedArticle,
  SpeechOptions,
} from "./types.js";
import type { SpeechProvider, SpeechSynthesisContext } from "./tts.js";

class InstantSpeechProvider implements SpeechProvider {
  readonly name = "instant-test";

  async synthesize(
    _article: ExtractedArticle,
    _speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const audioData = Buffer.from("ID3FAKEAUDIO");
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(
            context.fileKey,
            audioData,
            "audio/mpeg",
          )
        : null;

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds: 42 }] : [],
      durationSeconds: 42,
      audioData,
      contentType: "audio/mpeg",
    };
  }

  async synthesizeText(
    _text: string,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesize(
      {
        url: "https://example.com",
        title: "preview",
        byline: null,
        siteName: null,
        excerpt: null,
        textContent: "preview",
        wordCount: 1,
        estimatedMinutes: 1,
      },
      speechOptions,
      context,
    );
  }
}

class DelayedSegmentSpeechProvider implements SpeechProvider {
  readonly name = "delayed-segments-test";

  constructor(
    private readonly segments: Array<{
      audioData: Buffer;
      durationSeconds: number;
      delayMs: number;
    }>,
  ) {}

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    text: string,
    _speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const segment = this.segments.shift();
    if (!segment) {
      throw new Error(`Unexpected synthesizeText call for text: ${text.slice(0, 40)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, segment.delayMs));
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(
            context.fileKey,
            segment.audioData,
            "audio/mpeg",
          )
        : null;

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl
        ? [{ url: audioUrl, durationSeconds: segment.durationSeconds }]
        : [],
      durationSeconds: segment.durationSeconds,
      audioData: segment.audioData,
      contentType: "audio/mpeg",
    };
  }
}

class FailingAfterFirstSegmentSpeechProvider implements SpeechProvider {
  readonly name = "failing-after-first-segment-test";
  private callCount = 0;

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
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    this.callCount += 1;

    if (this.callCount > 1) {
      throw new Error("Segment generation failed after the first playable chunk.");
    }

    const audioData = Buffer.from("ID3SEGMENTONE");
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(
            context.fileKey,
            audioData,
            "audio/mpeg",
          )
        : null;

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl
        ? [{ url: audioUrl, durationSeconds: 11 }]
        : [],
      durationSeconds: 11,
      audioData,
      contentType: "audio/mpeg",
    };
  }
}

class StrictDuplicateKeyAudioStore implements AudioStore {
  private readonly blobs = new Map<string, Buffer>();

  async check(): Promise<void> {}

  async put(
    key: string,
    data: Buffer,
    _contentType?: string,
    options?: { overwrite?: boolean },
  ): Promise<string> {
    if (this.blobs.has(key) && !options?.overwrite) {
      throw new Error(`Duplicate key write denied for ${key}`);
    }

    this.blobs.set(key, data);
    return `/audio/${key}`;
  }

  async head(key: string): Promise<string | null> {
    return this.blobs.has(key) ? `/audio/${key}` : null;
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

const sampleHtml = `
<!doctype html>
<html>
  <head>
    <title>Queueing Speech Jobs</title>
  </head>
  <body>
    <article>
      <h1>Queueing Speech Jobs</h1>
      <p>Background audio generation should feel fast even when the source article is long.</p>
      <p>A clean queue model lets the mobile client submit work and poll for completion safely.</p>
      <p>Provider isolation also makes it practical to swap voices or vendors without redesigning the app.</p>
    </article>
  </body>
</html>
`;

function createTestContext(audioDir: string, jobsFilePath: string) {
  const audioStore = new FileAudioStore(audioDir, "/audio");
  const jobStore = new FileJobStore(jobsFilePath);
  const service = new AudioJobService({
    jobStore,
    audioStore,
    speechProvider: new InstantSpeechProvider(),
  });
  return { service, jobStore, audioStore };
}

async function waitFor<T>(
  action: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await action();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("audio job service", () => {
  it("creates and completes an audio job", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const { service } = createTestContext(audioDir, jobsFilePath);
    const queuedJob = await service.createJob({
      url: "https://example.com/posts/jobs",
      html: sampleHtml,
      speechOptions: {
        voice: "narrator",
      },
    });

    expect(queuedJob.status).toBe("queued");
    expect(queuedJob.provider).toBe("instant-test");

    // Process the job directly (in tests we don't rely on background fire)
    await service.processJob(queuedJob.id);

    const completedJob = await service.getJob(queuedJob.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.audioUrl).toBeNull();
    expect(completedJob?.playlistUrl).toContain("playlist.m3u8");
    expect(completedJob?.audioSegments.length ?? 0).toBeGreaterThan(0);
    expect(completedJob?.durationSeconds).toBeGreaterThan(0);
  });

  it("generates globally unique job ids across isolated stores", async () => {
    const firstAudioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const secondAudioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const first = createTestContext(firstAudioDir, join(firstAudioDir, "jobs.json"));
    const second = createTestContext(secondAudioDir, join(secondAudioDir, "jobs.json"));

    const firstJob = await first.service.createJob({
      url: "https://example.com/posts/jobs-1",
      html: sampleHtml,
    });
    const secondJob = await second.service.createJob({
      url: "https://example.com/posts/jobs-2",
      html: sampleHtml,
    });

    expect(firstJob.id).not.toBe(secondJob.id);
    expect(firstJob.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(secondJob.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("reloads persisted jobs from disk", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const { service: firstService } = createTestContext(audioDir, jobsFilePath);

    const createdJob = await firstService.createJob({
      url: "https://example.com/posts/jobs",
      html: sampleHtml,
    });
    await firstService.processJob(createdJob.id);

    const { service: secondService } = createTestContext(audioDir, jobsFilePath);
    await secondService.init();

    const persistedJob = await secondService.getJob(createdJob.id);
    expect(persistedJob?.status).toBe("completed");
    expect(await secondService.listJobs()).toHaveLength(1);
    expect(persistedJob?.audioSegments.length ?? 0).toBeGreaterThan(0);
  });

  it("creates a cached voice preview", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const { service } = createTestContext(audioDir, join(audioDir, "jobs.json"));

    const preview = await service.getOrCreateVoicePreview("alloy");
    expect(preview.audioUrl).toBe("/audio/previews/voice-preview--alloy.mp3");
  });

  it("does not expose a single-file narration download for completed jobs", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const { service, jobStore, audioStore } = createTestContext(audioDir, jobsFilePath);
    const queuedJob = await service.createJob({
      url: "https://example.com/posts/jobs",
      html: sampleHtml,
    });
    await service.processJob(queuedJob.id);

    const app = createApp({ audioJobService: service, jobStore, audioStore });
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");

    try {
      const address = server.address() as AddressInfo;
      const jobResponse = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${queuedJob.id}`);
      const jobPayload = await jobResponse.json() as { job: { audioDownloadPath: string | null } };
      expect(jobPayload.job.audioDownloadPath).toBeNull();

      const audioResponse = await fetch(`http://127.0.0.1:${address.port}/api/jobs/${queuedJob.id}/audio`);
      expect(audioResponse.status).toBe(404);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("rescues queued jobs when polling sees background processing was dropped", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const { service, jobStore, audioStore } = createTestContext(audioDir, jobsFilePath);
    const app = createApp({
      audioJobService: service,
      jobStore,
      audioStore,
    });
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");

    try {
      const address = server.address() as AddressInfo;
      const queuedJob = await service.createJob({
        url: "https://example.com/posts/jobs",
        html: sampleHtml,
      });

      expect(queuedJob.status).toBe("queued");

      const pollResponse = await fetch(`http://127.0.0.1:${address.port}/api/jobs`);
      expect(pollResponse.status).toBe(200);

      const completedJob = await waitFor(
        () => service.getJob(queuedJob.id),
        (job) => job !== null && job.status === "completed",
      );

      expect(completedJob?.playlistUrl).toContain("playlist.m3u8");
      expect(completedJob?.audioSegments.length ?? 0).toBeGreaterThan(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("makes a job playable before full completion via a growing playlist", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const audioStore = new FileAudioStore(audioDir, "/audio");
    const jobStore = new FileJobStore(jobsFilePath);
    const service = new AudioJobService({
      jobStore,
      audioStore,
      speechProvider: new DelayedSegmentSpeechProvider([
        { audioData: Buffer.from("ID3SEGMENTONE"), durationSeconds: 11, delayMs: 20 },
        { audioData: Buffer.from("ID3SEGMENTTWO"), durationSeconds: 13, delayMs: 250 },
        { audioData: Buffer.from("ID3SEGMENTTHREE"), durationSeconds: 17, delayMs: 250 },
        { audioData: Buffer.from("ID3SEGMENTFOUR"), durationSeconds: 19, delayMs: 250 },
      ]),
    });

    const queuedJob = await service.createJob({
      url: "https://example.com/posts/jobs",
      html: `
        <!doctype html>
        <html>
          <head><title>Segmented Article</title></head>
          <body>
            <article>
              <h1>Segmented Article</h1>
              <p>${"First segment content. ".repeat(40)}</p>
              <p>${"Second segment content. ".repeat(40)}</p>
              <p>${"Third segment content. ".repeat(40)}</p>
            </article>
          </body>
        </html>
      `,
    });

    const processingPromise = service.processJob(queuedJob.id);

    const partiallyReadyJob = await waitFor(
      () => service.getJob(queuedJob.id),
      (job) =>
        job !== null &&
        job.status === "processing" &&
        job.audioSegments.length === 1 &&
        typeof job.playlistUrl === "string" &&
        job.playlistUrl.length > 0,
    );

    expect(partiallyReadyJob?.durationSeconds).toBeNull();
    expect(partiallyReadyJob?.audioUrl).toBeNull();
    expect(partiallyReadyJob?.audioSegments).toHaveLength(1);

    const playlistPath = join(audioDir, "narrations", `job-${queuedJob.id}`, "playlist.m3u8");
    const partialPlaylist = await readFile(playlistPath, "utf8");
    expect(partialPlaylist).toContain("#EXTM3U");
    expect(partialPlaylist).toContain("/audio/narrations/");
    expect(partialPlaylist).not.toContain("#EXT-X-ENDLIST");

    await processingPromise;

    const completedJob = await service.getJob(queuedJob.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.audioSegments.length ?? 0).toBeGreaterThan(1);
    expect(completedJob?.playlistUrl).toBe(`/audio/narrations/job-${queuedJob.id}/playlist.m3u8`);
    expect(completedJob?.audioUrl).toBeNull();
    expect(completedJob?.durationSeconds).toBeGreaterThan(11);
    await expect(readFile(join(audioDir, "narrations", `narration-${queuedJob.id}.mp3`))).rejects.toThrow();

    const completedPlaylist = await readFile(playlistPath, "utf8");
    expect(completedPlaylist).toContain("#EXT-X-ENDLIST");
  });

  it("clears partial playback metadata when generation fails mid-run", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const audioStore = new FileAudioStore(audioDir, "/audio");
    const jobStore = new FileJobStore(jobsFilePath);
    const service = new AudioJobService({
      jobStore,
      audioStore,
      speechProvider: new FailingAfterFirstSegmentSpeechProvider(),
    });

    const queuedJob = await service.createJob({
      url: "https://example.com/posts/jobs",
      html: `
        <!doctype html>
        <html>
          <head><title>Segment failure article</title></head>
          <body>
            <article>
              <h1>Segment failure article</h1>
              <p>${"First segment content. ".repeat(40)}</p>
              <p>${"Second segment content. ".repeat(40)}</p>
            </article>
          </body>
        </html>
      `,
    });

    await service.processJob(queuedJob.id);

    const failedJob = await service.getJob(queuedJob.id);
    expect(failedJob?.status).toBe("failed");
    expect(failedJob?.playlistUrl).toBeNull();
    expect(failedJob?.audioSegments).toEqual([]);
    expect(failedJob?.durationSeconds).toBeNull();
    expect(failedJob?.error).toContain("failed after the first playable chunk");
  });

  it("can rewrite the stable playlist key as new segments arrive", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const jobStore = new FileJobStore(jobsFilePath);
    const audioStore = new StrictDuplicateKeyAudioStore();
    const service = new AudioJobService({
      jobStore,
      audioStore,
      speechProvider: new DelayedSegmentSpeechProvider([
        { audioData: Buffer.from("ID3SEGMENTONE"), durationSeconds: 11, delayMs: 5 },
        { audioData: Buffer.from("ID3SEGMENTTWO"), durationSeconds: 13, delayMs: 5 },
      ]),
    });

    const queuedJob = await service.createJob({
      url: "https://example.com/posts/jobs",
      html: `
        <!doctype html>
        <html>
          <head><title>Segmented Article</title></head>
          <body>
            <article>
              <h1>Segmented Article</h1>
              <p>${"First segment content. ".repeat(40)}</p>
              <p>${"Second segment content. ".repeat(40)}</p>
            </article>
          </body>
        </html>
      `,
    });

    await service.processJob(queuedJob.id);

    const completedJob = await service.getJob(queuedJob.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.playlistUrl).toBe(`/audio/narrations/job-${queuedJob.id}/playlist.m3u8`);
    expect(completedJob?.audioSegments).toHaveLength(2);
  });

  it("rejects oversized articles before creating a job", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const { service, jobStore, audioStore } = createTestContext(audioDir, jobsFilePath);
    const app = createApp({ audioJobService: service, jobStore, audioStore });
    const server = createServer(app);
    server.listen(0);
    await once(server, "listening");

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/posts/too-long",
          html: `
            <!doctype html>
            <html>
              <head><title>Very Long Article</title></head>
              <body>
                <article>
                  <h1>Very Long Article</h1>
                  <p>${"A".repeat(MAX_NARRATION_CHARS + 500)}</p>
                </article>
              </body>
            </html>
          `,
        }),
      });
      const payload = await response.json() as {
        error: string;
        code: string;
        details: { maxCharacterCount: number; characterCount: number };
      };

      expect(response.status).toBe(422);
      expect(payload.code).toBe("article_too_long");
      expect(payload.details.maxCharacterCount).toBe(MAX_NARRATION_CHARS);
      expect(payload.details.characterCount).toBeGreaterThan(MAX_NARRATION_CHARS);
      expect(await service.listJobs()).toHaveLength(0);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("applies request validation for audio job creation", () => {
    const validRequest = createAudioJobSchema.safeParse({
      url: "https://example.com/posts/jobs",
      speechOptions: {
        voice: "ash",
      },
    });
    const invalidExtractRequest = extractRequestSchema.safeParse({
      url: "not-a-url",
    });

    expect(validRequest.success).toBe(true);
    expect(invalidExtractRequest.success).toBe(false);
  });
});

describe("auth middleware", () => {
  const secret = "test-jwt-secret-at-least-32-characters-long!!";

  async function makeTestJWT(sub: string) {
    return new jose.SignJWT({})
      .setSubject(sub)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
  }

  function callMiddleware(authHeader?: string) {
    const middleware = createAuthMiddleware({ jwtSecret: secret });
    return new Promise<{ statusCode?: number; userId?: string; nextCalled: boolean }>((resolve) => {
      const req = { headers: { authorization: authHeader } } as any;
      const res = {
        _status: undefined as number | undefined,
        status(code: number) { this._status = code; return this; },
        json() { resolve({ statusCode: this._status, nextCalled: false }); },
      } as any;
      const next = () => resolve({ userId: req.userId, nextCalled: true });
      middleware(req, res, next);
    });
  }

  it("passes through when no secret configured", async () => {
    const middleware = createAuthMiddleware({});
    const result = await new Promise<{ nextCalled: boolean }>((resolve) => {
      const req = { headers: {} } as any;
      const next = () => resolve({ nextCalled: true });
      middleware(req, {} as any, next);
    });
    expect(result.nextCalled).toBe(true);
  });

  it("rejects missing token", async () => {
    const result = await callMiddleware(undefined);
    expect(result.statusCode).toBe(401);
  });

  it("rejects invalid token", async () => {
    const result = await callMiddleware("Bearer invalid.token.here");
    expect(result.statusCode).toBe(401);
  });

  it("accepts valid token and sets userId", async () => {
    const token = await makeTestJWT("user-abc");
    const result = await callMiddleware(`Bearer ${token}`);
    expect(result.nextCalled).toBe(true);
    expect(result.userId).toBe("user-abc");
  });
});
