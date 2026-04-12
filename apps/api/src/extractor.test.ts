import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArticleTooLongError,
  MAX_AUDIO_CHARS,
  extractArticle,
} from "./extractor.js";

const simpleArticleHtml = loadFixture("simple-article.html");
const fallbackArticleHtml = loadFixture("fallback-article.html");
const factoryArticleHtml = loadFixture("factory-live-article.html");
const wikipediaArticleHtml = loadFixture("wikipedia-article.html");
const originalFetch = globalThis.fetch;
const originalFetchTimeout = process.env.ARTICLE_FETCH_TIMEOUT_MS;

describe("article extraction", () => {
  it("extracts article content from supplied HTML", async () => {
    const article = await extractArticle({
      url: "https://example.com/posts/side-projects",
      html: simpleArticleHtml,
    });

    expect(article.title).toContain("How to Ship Better Side Projects");
    expect(article.textContent).toContain(
      "Most side projects fail because they try to do too much too early.",
    );
    expect(article.textContent).not.toContain("Subscribe to our newsletter");
    expect(article.estimatedMinutes).toBe(1);
  });

  it("uses canonical metadata and paragraph fallback when needed", async () => {
    const article = await extractArticle({
      url: "https://example.com/shared-link",
      html: fallbackArticleHtml,
    });

    expect(article.url).toBe("https://blog.example.com/posts/reader-apps");
    expect(article.siteName).toBe("Example Engineering");
    expect(article.byline).toBe("Nina Patel");
    expect(article.excerpt).toContain("reducing perceived latency");
    expect(article.textContent).toContain(
      "Instant-feeling apps do less work before the first meaningful response reaches the user.",
    );
    expect(article.textContent).not.toContain("All rights reserved.");
    expect(article.textContent).not.toContain("Subscribe to our newsletter");
  });

  it("drops article chrome and preserves paragraph structure from readability content", async () => {
    const article = await extractArticle({
      url: "https://factory.ai/news/missions-architecture",
      html: factoryArticleHtml,
    });
    const blocks = article.textContent.split(/\n{2,}/);
    const flattenedBlocks = blocks.map((block) => block.replace(/\s+/g, " ").trim());

    expect(article.title).toBe("How Missions Work");
    expect(blocks[0]).toBe("How Missions Work");
    expect(flattenedBlocks[1]).toBe(
      "The architecture behind Missions: why agent context shapes every design decision, how separation of concerns and test-driven development at two levels produce reliable multi-day autonomous work, and how the system actually runs.",
    );
    expect(flattenedBlocks[2]).toBe(
      "Agent sessions work well for focused tasks, but most real projects are too broad and complex for a single context window to hold. A single agent eventually runs into a problem: the more it sees, the less focused and reliable it becomes.",
    );
    expect(blocks).toContain("Rationale");
    expect(flattenedBlocks).toContain(
      "Most of the architecture follows from one core observation: agents are highly reactive to their context.",
    );
    expect(article.textContent).not.toContain("Go back");
    expect(article.textContent).not.toContain("5 minute read");
    expect(article.textContent).not.toContain("Engineering");
    expect(article.textContent).not.toContain("Research");
    expect(article.textContent).not.toContain("New");
  });

  it("strips wikipedia citation noise and trailing references", async () => {
    const article = await extractArticle({
      url: "https://en.wikipedia.org/wiki/Chinese_room",
      html: wikipediaArticleHtml,
    });
    const flattenedText = article.textContent.replace(/\s+/g, " ");

    expect(flattenedText).toContain(
      "The Chinese room argument claims that symbol manipulation alone does not amount to understanding.",
    );
    expect(flattenedText).toContain(
      "Searle imagines a person in a room following rules to produce convincing Chinese replies without understanding Chinese.",
    );
    expect(article.textContent).not.toContain("For the video game studio");
    expect(article.textContent).not.toContain("[1]");
    expect(article.textContent).not.toContain("[a]");
    expect(article.textContent).not.toContain("[edit]");
    expect(article.textContent).not.toContain("John Searle, \"Minds, Brains, and Programs\".");
  });

  it("rejects articles that exceed audio limits", async () => {
    const filler = "Alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(18).trim();
    const paragraphs = Array.from(
      { length: Math.ceil((MAX_AUDIO_CHARS + 500) / 1_000) },
      (_, index) => `<p>Section ${index + 1}. ${filler}</p>`,
    ).join("\n");
    const oversizedHtml = `
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
    `;

    await expect(
      extractArticle({
        url: "https://example.com/very-long",
        html: oversizedHtml,
      }),
    ).rejects.toMatchObject({
      name: "ArticleTooLongError",
      code: "article_too_long",
      statusCode: 422,
      details: {
        maxCharacterCount: MAX_AUDIO_CHARS,
      },
    });
  });

  it("times out external article fetches instead of hanging indefinitely", async () => {
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
  });

  it("retries article fetches with a fallback profile when the first request errors", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(simpleArticleHtml, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      ) as typeof fetch;

    const article = await extractArticle({
      url: "https://example.com/posts/side-projects",
    });

    expect(article.title).toContain("How to Ship Better Side Projects");
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://example.com/posts/side-projects",
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": expect.stringContaining("Safari"),
          "accept-language": "en-US,en;q=0.9",
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://example.com/posts/side-projects",
      expect.objectContaining({
        headers: expect.objectContaining({
          "user-agent": expect.stringContaining("HearItBot"),
        }),
      }),
    );
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalFetchTimeout === undefined) {
    delete process.env.ARTICLE_FETCH_TIMEOUT_MS;
  } else {
    process.env.ARTICLE_FETCH_TIMEOUT_MS = originalFetchTimeout;
  }
});

function loadFixture(fileName: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", fileName), "utf8");
}
