import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ArticleTooLongError,
  MAX_NARRATION_CHARS,
  extractArticle,
} from "./extractor.js";

const simpleArticleHtml = loadFixture("simple-article.html");
const fallbackArticleHtml = loadFixture("fallback-article.html");
const wikipediaArticleHtml = loadFixture("wikipedia-article.html");

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
    const oversizedHtml = `
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
    `;

    await expect(
      extractArticle({
        url: "https://example.com/very-long",
        html: oversizedHtml,
      }),
    ).rejects.toMatchObject<ArticleTooLongError>({
      name: "ArticleTooLongError",
      code: "article_too_long",
      statusCode: 422,
      details: {
        maxCharacterCount: MAX_NARRATION_CHARS,
      },
    });
  });
});

function loadFixture(fileName: string): string {
  return readFileSync(join(import.meta.dirname, "fixtures", fileName), "utf8");
}
