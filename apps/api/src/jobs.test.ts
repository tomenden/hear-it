import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAudioJobSchema, extractRequestSchema } from "./app.js";
import { AudioJobService, isTerminalStatus } from "./jobs.js";
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
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const audioFile = join(context.outputDir, `${context.fileStem}.mp3`);
    await writeFixtureAudio(audioFile);

    return {
      audioUrl: `${context.publicBaseUrl}/${context.fileStem}.mp3`,
      playlistUrl: null,
      audioSegments: [
        {
          url: `${context.publicBaseUrl}/${context.fileStem}.mp3`,
          durationSeconds: 42,
        },
      ],
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
        title: context.fileStem,
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

describe("audio job service", () => {
  it("creates and completes an audio job", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const service = new AudioJobService({
      speechProvider: new InstantSpeechProvider(),
      audioOutputDir: audioDir,
      audioPublicBaseUrl: "/audio",
      jobsFilePath,
    });
    const queuedJob = await service.createJob({
      url: "https://example.com/posts/jobs",
      html: sampleHtml,
      speechOptions: {
        voice: "narrator",
      },
    });

    expect(queuedJob.status).toBe("queued");
    expect(queuedJob.provider).toBe("instant-test");

    await waitForTerminalStatus(service, queuedJob.id);

    const completedJob = service.getJob(queuedJob.id);
    expect(completedJob?.status).toBe("completed");
    expect(completedJob?.audioUrl).toContain("/audio/queueing-speech-jobs--narrator--job-1.mp3");
    expect(completedJob?.playlistUrl).toBeNull();
    expect(completedJob?.audioSegments).toHaveLength(1);
    expect(completedJob?.durationSeconds).toBe(42);
  });

  it("reloads persisted jobs from disk", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const jobsFilePath = join(audioDir, "jobs.json");
    const firstService = new AudioJobService({
      speechProvider: new InstantSpeechProvider(),
      audioOutputDir: audioDir,
      audioPublicBaseUrl: "/audio",
      jobsFilePath,
    });

    const createdJob = await firstService.createJob({
      url: "https://example.com/posts/jobs",
      html: sampleHtml,
    });
    await waitForTerminalStatus(firstService, createdJob.id);

    const secondService = new AudioJobService({
      speechProvider: new InstantSpeechProvider(),
      audioOutputDir: audioDir,
      audioPublicBaseUrl: "/audio",
      jobsFilePath,
    });
    await secondService.init();

    const persistedJob = secondService.getJob(createdJob.id);
    expect(persistedJob?.status).toBe("completed");
    expect(secondService.listJobs()).toHaveLength(1);
    expect(persistedJob?.audioSegments).toHaveLength(1);
  });

  it("creates a cached voice preview", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "hear-it-audio-"));
    const service = new AudioJobService({
      speechProvider: new InstantSpeechProvider(),
      audioOutputDir: audioDir,
      audioPublicBaseUrl: "/audio",
      jobsFilePath: join(audioDir, "jobs.json"),
    });

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

async function waitForTerminalStatus(service: AudioJobService, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const job = service.getJob(jobId);
    if (job && isTerminalStatus(job.status)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Job did not reach a terminal state.");
}

async function writeFixtureAudio(filePath: string): Promise<string> {
  const fakeAudio = Buffer.from("ID3FAKEAUDIO");
  await writeFile(filePath, fakeAudio);
  return filePath;
}
