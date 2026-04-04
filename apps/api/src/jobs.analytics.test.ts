import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { trackEventMock } = vi.hoisted(() => ({
  trackEventMock: vi.fn(),
}));

vi.mock("./analytics.js", () => ({
  trackEvent: trackEventMock,
}));

import { AudioJobService } from "./jobs.js";
import { FileAudioStore, FileJobStore } from "./storage-fs.js";
import type {
  AudioRenderResult,
  ExtractedArticle,
  SpeechOptions,
} from "./types.js";
import type { SpeechProvider, SpeechSynthesisContext } from "./tts.js";

class AlwaysFailingSpeechProvider implements SpeechProvider {
  readonly name = "always-failing-test";

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
    throw new Error("Synthetic provider failure.");
  }
}

describe("AudioJobService analytics", () => {
  beforeEach(() => {
    trackEventMock.mockReset();
  });

  it("emits audio_failed when job processing fails", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "hear-it-jobs-analytics-"));
    const jobStore = new FileJobStore(join(baseDir, "jobs.json"));
    const audioStore = new FileAudioStore(join(baseDir, "audio"), "/audio");
    const service = new AudioJobService({
      jobStore,
      audioStore,
      speechProvider: new AlwaysFailingSpeechProvider(),
    });

    const job = await service.createJob({
      url: "https://example.com/posts/failure",
      html: `
        <!doctype html>
        <html>
          <head><title>Audio Failure</title></head>
          <body>
            <article>
              <h1>Audio Failure</h1>
              <p>This job fails after it starts processing.</p>
            </article>
          </body>
        </html>
      `,
    });

    await service.processJob(job.id);

    expect(trackEventMock).toHaveBeenCalledWith(
      "audio_failed",
      expect.objectContaining({
        job_id: job.id,
        voice: "alloy",
        error: "Synthetic provider failure.",
      }),
    );
    expect(trackEventMock).not.toHaveBeenCalledWith(
      "tts_failed",
      expect.anything(),
    );
  });
});
