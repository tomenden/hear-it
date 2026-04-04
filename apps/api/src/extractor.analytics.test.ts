import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trackEventMock, captureExceptionMock, captureMessageMock } = vi.hoisted(() => ({
  trackEventMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  captureMessageMock: vi.fn(),
}));

vi.mock("./analytics.js", () => ({
  trackEvent: trackEventMock,
}));

vi.mock("@sentry/node", () => ({
  captureException: captureExceptionMock,
  captureMessage: captureMessageMock,
}));

import {
  MAX_NARRATION_CHARS,
  extractArticle,
} from "./extractor.js";

const originalFetch = globalThis.fetch;
const originalFetchTimeout = process.env.ARTICLE_FETCH_TIMEOUT_MS;

describe("extractor analytics", () => {
  beforeEach(() => {
    trackEventMock.mockReset();
    captureExceptionMock.mockReset();
    captureMessageMock.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;

    if (originalFetchTimeout === undefined) {
      delete process.env.ARTICLE_FETCH_TIMEOUT_MS;
    } else {
      process.env.ARTICLE_FETCH_TIMEOUT_MS = originalFetchTimeout;
    }
  });

  it("emits audio_extraction_failed when no article content can be extracted", async () => {
    await expect(
      extractArticle({
        url: "https://example.com/empty",
        html: `
          <!doctype html>
          <html>
            <head><title>Empty</title></head>
            <body><div></div></body>
          </html>
        `,
      }),
    ).rejects.toThrow("Failed to extract article content.");

    expect(trackEventMock).toHaveBeenCalledWith(
      "audio_extraction_failed",
      expect.objectContaining({
        url: "https://example.com/empty",
        domain: "example.com",
        error: "Failed to extract article content.",
      }),
    );
  });

  it("emits audio_article_too_long when narration exceeds the max length", async () => {
    const filler = "A".repeat(1_000);
    const paragraphs = Array.from(
      { length: Math.ceil((MAX_NARRATION_CHARS + 500) / 1_000) },
      () => `<p>${filler}</p>`,
    ).join("\n");

    await expect(
      extractArticle({
        url: "https://example.com/very-long",
        html: `
          <!doctype html>
          <html>
            <head><title>Very Long Article</title></head>
            <body>
              <article>
                <h1>Very Long Article</h1>
                ${paragraphs}
              </article>
            </body>
          </html>
        `,
      }),
    ).rejects.toMatchObject({
      code: "article_too_long",
      statusCode: 422,
    });

    expect(trackEventMock).toHaveBeenCalledWith(
      "audio_article_too_long",
      expect.objectContaining({
        url: "https://example.com/very-long",
        domain: "example.com",
        title: "Very Long Article",
      }),
    );
  });

  it("emits audio_article_fetch_timeout when remote fetches time out", async () => {
    process.env.ARTICLE_FETCH_TIMEOUT_MS = "10";
    globalThis.fetch = vi.fn((_input, init) => new Promise((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;

    await expect(
      extractArticle({
        url: "https://example.com/slow-article",
      }),
    ).rejects.toThrow("Timed out fetching article content.");

    expect(trackEventMock).toHaveBeenCalledWith(
      "audio_article_fetch_timeout",
      expect.objectContaining({
        url: "https://example.com/slow-article",
        domain: "example.com",
        timeout_ms: 10,
      }),
    );
  });
});
