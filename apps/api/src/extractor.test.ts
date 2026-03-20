import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ArticleTooLongError,
  MAX_NARRATION_CHARS,
  extractArticle,
} from "./extractor.js";

const simpleArticleHtml = loadFixture("simple-article.html");
const fallbackArticleHtml = loadFixture("fallback-article.html");
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

  it("rejects articles that exceed narration limits", async () => {
    const filler = "A".repeat(1_000);
    const paragraphs = Array.from({ length: Math.ceil((MAX_NARRATION_CHARS + 500) / 1_000) }, () => `<p>${filler}</p>`).join("\n");
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
        maxCharacterCount: MAX_NARRATION_CHARS,
      },
    });
  });

  it("extracts tweet content via oEmbed for twitter.com URLs", async () => {
    const oembedHtml = [
      '<blockquote class="twitter-tweet">',
      '<p lang="en" dir="ltr">Shipped something cool today. Here is what I learned building in public for 90 days straight.</p>',
      '&mdash; Sero (@0xsero)',
      '<a href="https://twitter.com/0xsero/status/2035022588439581076">March 20, 2026</a>',
      "</blockquote>",
    ].join("\n");

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        html: oembedHtml,
        author_name: "Sero",
        author_url: "https://twitter.com/0xsero",
        provider_name: "Twitter",
        url: "https://twitter.com/0xsero/status/2035022588439581076",
      }),
    }) as typeof fetch;

    const article = await extractArticle({
      url: "https://x.com/0xsero/status/2035022588439581076",
    });

    expect(article.title).toBe("@0xsero on X");
    expect(article.byline).toBe("Sero");
    expect(article.siteName).toBe("X (formerly Twitter)");
    expect(article.textContent).toContain("Shipped something cool today");
    expect(article.textContent).not.toContain("March 20, 2026");
    expect(article.textContent).not.toContain("@0xsero)");
  });

  it("falls back to Twitterbot fetch when oEmbed fails for tweet URLs", async () => {
    // First call (oEmbed) fails, second call (Twitterbot fetch) succeeds
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `<!doctype html><html><head>
          <meta property="og:title" content="@0xsero on X" />
          <meta property="og:description" content="Shipped something cool today. Here is what I learned." />
        </head><body></body></html>`,
      }) as typeof fetch;

    const article = await extractArticle({
      url: "https://x.com/0xsero/status/2035022588439581076",
    });

    expect(article.title).toBe("@0xsero on X");
    expect(article.siteName).toBe("X (formerly Twitter)");
    expect(article.textContent).toContain("Shipped something cool today");
  });

  it("extracts X Article content via Twitterbot fetch", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => `<!doctype html><html><head>
        <meta property="og:title" content="Why I build in public" />
        <meta property="og:description" content="Building in public for 90 days taught me more than 3 years of working in stealth. Here is the full breakdown." />
        <meta property="og:site_name" content="X (formerly Twitter)" />
      </head><body></body></html>`,
    }) as typeof fetch;

    const article = await extractArticle({
      url: "https://x.com/i/article/1234567890",
    });

    expect(article.title).toBe("Why I build in public");
    expect(article.siteName).toBe("X (formerly Twitter)");
    expect(article.textContent).toContain("Building in public for 90 days");
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
