import * as Sentry from "@sentry/node";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import { trackEvent } from "./analytics.js";
import type { ExtractArticleInput, ExtractedArticle } from "./types.js";

const WORDS_PER_MINUTE = 160;
export const MAX_AUDIO_CHARS = 100_000;
const DEFAULT_ARTICLE_FETCH_TIMEOUT_MS = 15_000;
const MIN_PARAGRAPH_LENGTH = 40;
const BROWSER_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const HEAR_IT_BOT_USER_AGENT =
  "HearItBot/0.1 (+https://local.dev/hear-it; article extraction prototype)";
const BOILERPLATE_PATTERNS = [
  /subscribe/i,
  /newsletter/i,
  /advertis/i,
  /cookie/i,
  /sign up/i,
  /all rights reserved/i,
];
const ARTICLE_METADATA_PATTERNS = [
  /^by\s+.+/i,
  /\b\d+\s+minute read\b/i,
  /^(?:share|go back)$/i,
];
const TITLE_SUFFIX_SEPARATORS = [" | ", " - ", " — ", " – ", ": "];
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
      `This article is too long to turn into audio right now (${details.characterCount.toLocaleString()} characters, limit ${details.maxCharacterCount.toLocaleString()}). Try a shorter article.`,
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
  const html = input.html ?? (await fetchHtml(input.url));
  const dom = new JSDOM(html, { url: input.url });
  const document = dom.window.document;
  sanitizeDocumentForExtraction(document, input.url);
  const article = new Readability(document.cloneNode(true) as Document).parse();
  const fallback = buildFallbackExtraction(document);
  const readability = buildReadabilityExtraction(article, input.url);
  const extracted = pickBestExtraction(readability.textContent, fallback.textContent);
  const siteName = article?.siteName ?? fallback.siteName;
  const title = normalizeExtractedTitle({
    candidate: article?.title ?? fallback.title,
    h1Title:
      normalizeText(document.querySelector("article h1, article h2, main h1, main h2, h1, h2")?.textContent ?? "")
      || null,
    siteName,
  });
  const bodyText = normalizeExtractedText(extracted, input.url);

  if (!bodyText) {
    const err = new Error("Failed to extract article content.");
    Sentry.captureException(err, { tags: { url: input.url } });
    trackEvent("audio_extraction_failed", {
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

  if (textContent.length > MAX_AUDIO_CHARS) {
    const details = {
      url: canonicalUrl,
      title,
      characterCount: textContent.length,
      maxCharacterCount: MAX_AUDIO_CHARS,
      wordCount,
      estimatedMinutes,
    };

    console.warn("[extractor] article_too_long", details);
    Sentry.captureMessage("Article too long for audio generation", {
      level: "warning",
      tags: {
        url: canonicalUrl,
        title: title ?? "untitled",
      },
      extra: details,
    });
    trackEvent("audio_article_too_long", {
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
    siteName,
    excerpt: article?.excerpt ?? fallback.excerpt,
    textContent,
    wordCount,
    estimatedMinutes,
  };
}

async function fetchHtml(url: string): Promise<string> {
  const timeoutMs = Number(process.env.ARTICLE_FETCH_TIMEOUT_MS ?? DEFAULT_ARTICLE_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

  let response: Response | null = null;
  let lastError: unknown;
  try {
    const fetchProfiles = [
      {
        attempt: "browser_like",
        headers: {
          "user-agent": BROWSER_LIKE_USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
        },
      },
      {
        attempt: "hearit_bot",
        headers: {
          "user-agent": HEAR_IT_BOT_USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
      },
    ] as const;

    for (const profile of fetchProfiles) {
      try {
        response = await fetch(url, {
          headers: profile.headers,
          signal: controller.signal,
        });
        lastError = undefined;
        break;
      } catch (error) {
        if (controller.signal.aborted) {
          throw error;
        }

        lastError = error;
        console.error("[extractor] fetch_html_attempt_failed", {
          url,
          timeoutMs,
          attempt: profile.attempt,
          error: serializeErrorDetails(error),
        });
        Sentry.captureException(error, {
          tags: { url, phase: "fetch_html", attempt: profile.attempt },
          extra: { timeoutMs, attempt: profile.attempt },
        });
      }
    }

    if (lastError !== undefined) {
      throw lastError;
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new ArticleFetchTimeoutError({ url, timeoutMs });
      Sentry.captureException(timeoutError, {
        tags: { url, phase: "fetch_html" },
        extra: { timeoutMs },
      });
      trackEvent("audio_article_fetch_timeout", {
        url,
        domain: safeHostname(url),
        timeout_ms: timeoutMs,
      });
      throw timeoutError;
    }

    console.error("[extractor] fetch_html_failed", {
      url,
      timeoutMs,
      error: serializeErrorDetails(error),
    });
    Sentry.captureException(error, { tags: { url, phase: "fetch_html" } });
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response) {
    throw new Error("Article fetch completed without a response.");
  }

  if (!response.ok) {
    const err = new Error(`Failed to fetch URL: ${response.status}`);
    Sentry.captureException(err, { tags: { url, httpStatus: response.status } });
    throw err;
  }

  return await response.text();
}

function serializeErrorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: error };
  }

  return {
    name: error.name,
    message: error.message,
    cause:
      error.cause instanceof Error
        ? {
            name: error.cause.name,
            message: error.cause.message,
          }
        : error.cause,
  };
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
  const paragraphs = collectContentBlocks(root);
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

function buildReadabilityExtraction(
  article: ReturnType<Readability["parse"]>,
  sourceUrl: string,
): { textContent: string } {
  if (!article?.content) {
    return { textContent: "" };
  }

  const dom = new JSDOM(`<!doctype html><html><body>${article.content}</body></html>`, {
    url: sourceUrl,
  });

  return {
    textContent: collectContentBlocks(dom.window.document.body).join("\n\n"),
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

function collectContentBlocks(root: ParentNode): string[] {
  const olCounters = new WeakMap<Element, number>();
  const blocks: string[] = [];
  const candidates = Array.from(
    root.querySelectorAll("h2, h3, h4, h5, h6, p, li, blockquote, figcaption"),
  );

  for (const el of candidates) {
    if (shouldSkipContentElement(el)) {
      continue;
    }

    const text = normalizeText(el.textContent ?? "");
    if (!text || isLikelyArticleMetadata(text)) {
      continue;
    }

    if (/^H[2-6]$/.test(el.tagName)) {
      if (isLikelySectionHeading(text)) {
        pushUniqueBlock(blocks, text);
      }
      continue;
    }

    const isListItem = el.tagName === "LI";
    if (!(isListItem ? text.length > 0 : isLikelyContentParagraph(text))) {
      continue;
    }

    if (isListItem && el.parentElement?.tagName === "OL") {
      const count = (olCounters.get(el.parentElement) ?? 0) + 1;
      olCounters.set(el.parentElement, count);
      pushUniqueBlock(blocks, `${count}. ${text}`);
      continue;
    }

    pushUniqueBlock(blocks, text);
  }

  return blocks;
}

function shouldSkipContentElement(element: Element): boolean {
  return element.closest("nav, header, footer, aside") != null;
}

function isLikelyContentParagraph(text: string): boolean {
  if (text.length < MIN_PARAGRAPH_LENGTH) {
    return false;
  }

  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  const words = text.match(/\S+/g) ?? [];
  if (words.length < 6) {
    return false;
  }

  const linkLikeTokens = text.match(/\b(home|menu|login|sign in|next|previous)\b/gi) ?? [];
  return linkLikeTokens.length <= 2;
}

function isLikelyArticleMetadata(text: string): boolean {
  if (ARTICLE_METADATA_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  return /^by\s+.+\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
    text,
  );
}

function isLikelySectionHeading(text: string): boolean {
  if (BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  if (/[.!?]$/.test(text)) {
    return false;
  }

  const words = text.match(/\S+/g) ?? [];
  return words.length > 0 && words.length <= 10 && text.length <= 80;
}

function pushUniqueBlock(blocks: string[], text: string) {
  if (blocks.at(-1) !== text) {
    blocks.push(text);
  }
}

function normalizeExtractedTitle(input: {
  candidate: string | null;
  h1Title: string | null;
  siteName: string | null;
}): string | null {
  const candidate = normalizeText(input.candidate ?? "");
  if (!candidate) {
    return input.h1Title;
  }

  const h1Title = normalizeText(input.h1Title ?? "");
  if (!h1Title) {
    return candidate;
  }

  if (candidate === h1Title) {
    return candidate;
  }

  const siteName = normalizeText(input.siteName ?? "");
  if (
    siteName &&
    TITLE_SUFFIX_SEPARATORS.some((separator) => candidate === `${h1Title}${separator}${siteName}`)
  ) {
    return h1Title;
  }

  if (
    TITLE_SUFFIX_SEPARATORS.some(
      (separator) => candidate.startsWith(`${h1Title}${separator}`) && candidate.length > h1Title.length,
    )
  ) {
    return h1Title;
  }

  return candidate;
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
