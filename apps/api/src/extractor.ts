import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { ExtractArticleInput, ExtractedArticle } from "./types.js";

const WORDS_PER_MINUTE = 160;
const MIN_PARAGRAPH_LENGTH = 40;
const BOILERPLATE_PATTERNS = [
  /subscribe/i,
  /newsletter/i,
  /advertis/i,
  /cookie/i,
  /sign up/i,
  /all rights reserved/i,
];

export async function extractArticle(
  input: ExtractArticleInput,
): Promise<ExtractedArticle> {
  const html = input.html ?? (await fetchHtml(input.url));
  const dom = new JSDOM(html, { url: input.url });
  const document = dom.window.document;
  const article = new Readability(document.cloneNode(true) as Document).parse();
  const fallback = buildFallbackExtraction(document);
  const extracted = pickBestExtraction(article?.textContent ?? "", fallback.textContent);
  const textContent = normalizeText(extracted);

  if (!textContent) {
    throw new Error("Failed to extract article content.");
  }

  const wordCount = countWords(textContent);
  const canonicalUrl = detectCanonicalUrl(document, input.url);

  return {
    url: canonicalUrl,
    title: article?.title ?? fallback.title,
    byline: article?.byline ?? fallback.byline,
    siteName: article?.siteName ?? fallback.siteName,
    excerpt: article?.excerpt ?? fallback.excerpt,
    textContent,
    wordCount,
    estimatedMinutes: Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE)),
  };
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "HearItBot/0.1 (+https://local.dev/hear-it; article extraction prototype)",
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status}`);
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

function countWords(text: string): number {
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

  return normalizedPrimary.length >= normalizedFallback.length * 0.6
    ? normalizedPrimary
    : normalizedFallback;
}

function buildFallbackExtraction(document: Document) {
  const root = selectContentRoot(document) ?? document.body ?? document.documentElement;
  const paragraphs = Array.from(root.querySelectorAll("p"))
    .map((paragraph) => normalizeText(paragraph.textContent ?? ""))
    .filter((paragraph) => isLikelyContentParagraph(paragraph));
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
