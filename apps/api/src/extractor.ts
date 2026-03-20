import * as Sentry from "@sentry/node";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import { trackEvent } from "./analytics.js";
import type { ExtractArticleInput, ExtractedArticle } from "./types.js";

const WORDS_PER_MINUTE = 160;
export const MAX_NARRATION_CHARS = 100_000;
const DEFAULT_ARTICLE_FETCH_TIMEOUT_MS = 15_000;
const MIN_PARAGRAPH_LENGTH = 40;
const BOILERPLATE_PATTERNS = [
  /subscribe/i,
  /newsletter/i,
  /advertis/i,
  /cookie/i,
  /sign up/i,
  /all rights reserved/i,
];
const WIKIPEDIA_REMOVAL_SELECTORS = [
  ".hatnote",
  ".shortdescription",
  ".mw-editsection",
  ".reference",
  ".reflist",
  ".mw-references-wrap",
  ".navbox",
  ".vertical-navbox",
  ".metadata",
  ".ambox",
  ".infobox",
  ".sidebar",
  ".toc",
  ".thumb",
  ".portal",
  ".catlinks",
  ".printfooter",
  "sup.reference",
  "sup[id^='cite_ref']",
  "ol.references",
  "ul.gallery",
];
const WIKIPEDIA_TRAILING_SECTIONS = new Set([
  "references",
  "notes",
  "citations",
  "sources",
  "further reading",
  "external links",
  "see also",
]);

export class ArticleTooLongError extends Error {
  readonly code = "article_too_long";
  readonly statusCode = 422;

  constructor(
    readonly details: {
      url: string;
      title: string | null;
      characterCount: number;
      maxCharacterCount: number;
      wordCount: number;
      estimatedMinutes: number;
    },
  ) {
    super(
      `This article is too long to narrate right now (${details.characterCount.toLocaleString()} characters, limit ${details.maxCharacterCount.toLocaleString()}). Try a shorter article.`,
    );
    this.name = "ArticleTooLongError";
  }
}

export class ArticleFetchTimeoutError extends Error {
  readonly code = "article_fetch_timeout";
  readonly statusCode = 504;

  constructor(
    readonly details: {
      url: string;
      timeoutMs: number;
    },
  ) {
    super(`Timed out fetching article content.`);
    this.name = "ArticleFetchTimeoutError";
  }
}

export async function extractArticle(
  input: ExtractArticleInput,
): Promise<ExtractedArticle> {
  if (!input.html && isTwitterUrl(input.url)) {
    return extractTwitterArticle(input.url);
  }

  const html = input.html ?? (await fetchHtml(input.url));
  const dom = new JSDOM(html, { url: input.url });
  const document = dom.window.document;
  sanitizeDocumentForExtraction(document, input.url);
  const article = new Readability(document.cloneNode(true) as Document).parse();
  const fallback = buildFallbackExtraction(document);
  const extracted = pickBestExtraction(article?.textContent ?? "", fallback.textContent);
  const title = article?.title ?? fallback.title;
  const bodyText = normalizeExtractedText(extracted, input.url);

  if (!bodyText) {
    const err = new Error("Failed to extract article content.");
    Sentry.captureException(err, { tags: { url: input.url } });
    trackEvent("extraction_failed", {
      url: input.url,
      domain: safeHostname(input.url),
      error: err.message,
    });
    throw err;
  }

  const textContent = title ? `${title}\n\n${bodyText}` : bodyText;
  const wordCount = countWords(textContent);
  const canonicalUrl = detectCanonicalUrl(document, input.url);
  const estimatedMinutes = Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));

  if (textContent.length > MAX_NARRATION_CHARS) {
    const details = {
      url: canonicalUrl,
      title,
      characterCount: textContent.length,
      maxCharacterCount: MAX_NARRATION_CHARS,
      wordCount,
      estimatedMinutes,
    };

    console.warn("[extractor] article_too_long", details);
    Sentry.captureMessage("Article too long for narration", {
      level: "warning",
      tags: {
        url: canonicalUrl,
        title: title ?? "untitled",
      },
      extra: details,
    });
    trackEvent("article_too_long", {
      url: canonicalUrl,
      domain: safeHostname(canonicalUrl),
      title,
      character_count: details.characterCount,
      max_character_count: details.maxCharacterCount,
      word_count: wordCount,
      estimated_minutes: estimatedMinutes,
    });
    throw new ArticleTooLongError(details);
  }

  return {
    url: canonicalUrl,
    title,
    byline: article?.byline ?? fallback.byline,
    siteName: article?.siteName ?? fallback.siteName,
    excerpt: article?.excerpt ?? fallback.excerpt,
    textContent,
    wordCount,
    estimatedMinutes,
  };
}

function isTwitterUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "twitter.com" || hostname === "x.com"
      || hostname === "www.twitter.com" || hostname === "www.x.com";
  } catch {
    return false;
  }
}

interface TwitterOEmbedResponse {
  html: string;
  author_name: string;
  author_url: string;
  provider_name: string;
  url: string;
}

async function extractTwitterArticle(url: string): Promise<ExtractedArticle> {
  const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
  const timeoutMs = Number(process.env.ARTICLE_FETCH_TIMEOUT_MS ?? DEFAULT_ARTICLE_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let oembed: TwitterOEmbedResponse;
  try {
    const response = await fetch(oembedUrl, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Twitter oEmbed request failed: ${response.status}`);
    }

    oembed = await response.json() as TwitterOEmbedResponse;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ArticleFetchTimeoutError({ url, timeoutMs });
    }
    Sentry.captureException(error, { tags: { url, phase: "twitter_oembed" } });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  // Parse the oEmbed HTML to extract the tweet text.
  // The HTML is a <blockquote> containing <p> elements with the tweet content
  // followed by an attribution <a> tag, e.g.:
  //   <blockquote class="twitter-tweet">
  //     <p lang="en">Tweet text</p>
  //     &mdash; Name (@handle) <a href="...">timestamp</a>
  //   </blockquote>
  const dom = new JSDOM(oembed.html);
  const blockquote = dom.window.document.querySelector("blockquote");
  if (!blockquote) {
    throw new Error("Unexpected Twitter oEmbed format: no blockquote found");
  }

  // Remove the trailing attribution link (last <a> in the blockquote)
  blockquote.querySelector("a:last-of-type")?.remove();

  const tweetText = normalizeText(blockquote.textContent ?? "");
  if (!tweetText) {
    throw new Error("Failed to extract tweet content");
  }

  // Strip the em-dash attribution suffix left after link removal (e.g. "— Name (@handle)")
  const bodyText = tweetText.replace(/\s*[—–-]\s*\S.*\(@\w+\)\s*$/, "").trim();

  const handle = oembed.author_url.split("/").pop() ?? "";
  const title = `@${handle} on X`;
  const textContent = `${title}\n\n${bodyText}`;
  const wordCount = countWords(textContent);

  return {
    url,
    title,
    byline: oembed.author_name,
    siteName: "X (formerly Twitter)",
    excerpt: bodyText.slice(0, 200) || null,
    textContent,
    wordCount,
    estimatedMinutes: Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE)),
  };
}

async function fetchHtml(url: string): Promise<string> {
  const timeoutMs = Number(process.env.ARTICLE_FETCH_TIMEOUT_MS ?? DEFAULT_ARTICLE_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "user-agent":
          "HearItBot/0.1 (+https://local.dev/hear-it; article extraction prototype)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new ArticleFetchTimeoutError({ url, timeoutMs });
      Sentry.captureException(timeoutError, {
        tags: { url, phase: "fetch_html" },
        extra: { timeoutMs },
      });
      trackEvent("article_fetch_timeout", {
        url,
        domain: safeHostname(url),
        timeout_ms: timeoutMs,
      });
      throw timeoutError;
    }

    Sentry.captureException(error, { tags: { url, phase: "fetch_html" } });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const err = new Error(`Failed to fetch URL: ${response.status}`);
    Sentry.captureException(err, { tags: { url, httpStatus: response.status } });
    throw err;
  }

  return await response.text();
}

function normalizeText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeExtractedText(text: string, sourceUrl: string): string {
  let normalized = normalizeText(text);

  if (isWikipediaUrl(sourceUrl)) {
    normalized = stripWikipediaArtifacts(normalized);
  }

  return normalized;
}

export function countWords(text: string): number {
  const parts = text.match(/\S+/g);
  return parts ? parts.length : 0;
}

function pickBestExtraction(primary: string, fallback: string): string {
  const normalizedPrimary = normalizeText(primary);
  const normalizedFallback = normalizeText(fallback);

  if (!normalizedPrimary) {
    return normalizedFallback;
  }

  if (!normalizedFallback) {
    return normalizedPrimary;
  }

  if (isRepetitiveText(normalizedPrimary)) {
    return normalizedFallback;
  }

  return normalizedPrimary.length >= normalizedFallback.length * 0.6
    ? normalizedPrimary
    : normalizedFallback;
}

function isRepetitiveText(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 10) {
    return false;
  }

  const freq = new Map<string, number>();
  for (const line of lines) {
    freq.set(line, (freq.get(line) ?? 0) + 1);
  }

  const mostRepeated = Math.max(...freq.values());
  return mostRepeated / lines.length > 0.3;
}

function buildFallbackExtraction(document: Document) {
  const root = selectContentRoot(document) ?? document.body ?? document.documentElement;
  const olCounters = new WeakMap<Element, number>();
  const paragraphs: string[] = [];
  for (const el of Array.from(root.querySelectorAll("p, li, blockquote"))) {
    const text = normalizeText(el.textContent ?? "");
    const isListItem = el.tagName === "LI";
    if (!(isListItem ? text.length > 0 : isLikelyContentParagraph(text))) {
      continue;
    }
    if (isListItem && el.parentElement?.tagName === "OL") {
      const count = (olCounters.get(el.parentElement) ?? 0) + 1;
      olCounters.set(el.parentElement, count);
      paragraphs.push(`${count}. ${text}`);
    } else {
      paragraphs.push(text);
    }
  }
  const fallbackTitle = firstDefined(
    readMetaContent(document, 'meta[property="og:title"]'),
    normalizeText(document.querySelector("title")?.textContent ?? "") || null,
    normalizeText(document.querySelector("h1")?.textContent ?? "") || null,
  );
  const fallbackByline = firstDefined(
    readMetaContent(document, 'meta[name="author"]'),
    normalizeText(document.querySelector('[rel="author"]')?.textContent ?? "") || null,
  );

  const textContent = paragraphs.join("\n\n");

  return {
    title: fallbackTitle,
    byline: fallbackByline,
    siteName: readMetaContent(document, 'meta[property="og:site_name"]')
      ?? readMetaContent(document, 'meta[name="application-name"]')
      ?? safeHostname(document.URL),
    excerpt: readMetaContent(document, 'meta[name="description"]')
      ?? paragraphs[0]
      ?? null,
    textContent,
  };
}

function sanitizeDocumentForExtraction(document: Document, sourceUrl: string) {
  if (!isWikipediaUrl(sourceUrl)) {
    return;
  }

  for (const selector of WIKIPEDIA_REMOVAL_SELECTORS) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      node.remove();
    }
  }
}

function selectContentRoot(document: Document): Element | null {
  const preferredSelectors = [
    "article",
    "main article",
    "main",
    '[role="main"]',
    ".post-content",
    ".entry-content",
    ".article-content",
    ".content",
  ];

  for (const selector of preferredSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
  }

  return null;
}

function isLikelyContentParagraph(text: string): boolean {
  if (text.length < MIN_PARAGRAPH_LENGTH) {
    return false;
  }

  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  const words = text.match(/\S+/g) ?? [];
  if (words.length < 8) {
    return false;
  }

  const linkLikeTokens = text.match(/\b(home|menu|login|sign in|next|previous)\b/gi) ?? [];
  return linkLikeTokens.length <= 2;
}

function detectCanonicalUrl(document: Document, fallbackUrl: string): string {
  const candidate =
    document.querySelector('link[rel="canonical"]')?.getAttribute("href")
    ?? readMetaContent(document, 'meta[property="og:url"]')
    ?? fallbackUrl;

  try {
    return new URL(candidate, fallbackUrl).toString();
  } catch {
    return fallbackUrl;
  }
}

function isWikipediaUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("wikipedia.org");
  } catch {
    return false;
  }
}

function stripWikipediaArtifacts(text: string): string {
  const cleanedLines: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .replace(/\[(?:edit|citation needed)\]/gi, "")
      .replace(/\[(?:\d+|[a-z]{1,3}|[A-Z]{1,3})\]/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!line) {
      cleanedLines.push("");
      continue;
    }

    if (WIKIPEDIA_TRAILING_SECTIONS.has(line.toLowerCase())) {
      break;
    }

    cleanedLines.push(line);
  }

  return normalizeText(cleanedLines.join("\n"));
}

function readMetaContent(document: Document, selector: string): string | null {
  const value = document.querySelector(selector)?.getAttribute("content");
  const normalized = normalizeText(value ?? "");
  return normalized || null;
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | null {
  for (const value of values) {
    if (value != null) {
      return value;
    }
  }

  return null;
}
