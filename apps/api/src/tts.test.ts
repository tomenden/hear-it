import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAISpeechProvider, OpenAITTSTimeoutError } from "./tts.js";

const originalFetch = globalThis.fetch;
const originalTimeout = process.env.OPENAI_TTS_TIMEOUT_MS;

describe("openai speech provider", () => {
  it("times out stalled OpenAI synthesis requests", async () => {
    process.env.OPENAI_TTS_TIMEOUT_MS = "10";
    globalThis.fetch = vi.fn((_input, init) => new Promise((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;

    const provider = new OpenAISpeechProvider("test-api-key");

    await expect(
      provider.synthesizeText(
        "This request should time out.",
        { voice: "ash" },
        {},
      ),
    ).rejects.toBeInstanceOf(OpenAITTSTimeoutError);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalTimeout === undefined) {
    delete process.env.OPENAI_TTS_TIMEOUT_MS;
  } else {
    process.env.OPENAI_TTS_TIMEOUT_MS = originalTimeout;
  }
});
