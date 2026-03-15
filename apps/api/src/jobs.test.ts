import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAudioJobSchema, extractRequestSchema } from "./app.js";
import { AudioJobService, isTerminalStatus } from "./jobs.js";
import { FileJobStore, FileAudioStore } from "./storage-fs.js";
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
    const audioUrl = await context.audioStore.put(
      context.fileKey,
      Buffer.from("ID3FAKEAUDIO"),
      "audio/mpeg",
    );

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: [{ url: audioUrl, durationSeconds: 42 }],
      durationSeconds: 42,
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

function createTestService(audioDir: string, jobsFilePath: string) {
  const audioStore = new FileAudioStore(audioDir, "/audio");
  const jobStore = new FileJobStore(jobsFilePath);
  return new AudioJobService({
    jobStore,
    audioStore,
    speechProvider: new InstantSpeechProvider(),
  });
}

describe("audio job service", () => {
  it("creates and completes an audio job", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const service = createTestService(audioDir, jobsFilePath);
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
    expect(completedJob?.audioUrl).toContain("/audio/queueing-speech-jobs--narrator--job-1.mp3");
    expect(completedJob?.playlistUrl).toBeNull();
    expect(completedJob?.audioSegments).toHaveLength(1);
    expect(completedJob?.durationSeconds).toBe(42);
  });

  it("reloads persisted jobs from disk", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const firstService = createTestService(audioDir, jobsFilePath);

    const createdJob = await firstService.createJob({
      url: "https://example.com/posts/jobs",
      html: sampleHtml,
    });
    await firstService.processJob(createdJob.id);

    const secondService = createTestService(audioDir, jobsFilePath);
    await secondService.init();

    const persistedJob = await secondService.getJob(createdJob.id);
    expect(persistedJob?.status).toBe("completed");
    expect(await secondService.listJobs()).toHaveLength(1);
    expect(persistedJob?.audioSegments).toHaveLength(1);
  });

  it("creates a cached voice preview", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const service = createTestService(audioDir, join(audioDir, "jobs.json"));

    const preview = await service.getOrCreateVoicePreview("alloy");
    expect(preview.audioUrl).toBe("/audio/previews/voice-preview--alloy.mp3");
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
