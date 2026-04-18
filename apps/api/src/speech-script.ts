import type { SpeechScript } from "./types.js";

export interface SpeechScriptInput {
  title: string | null;
  textContent: string;
}

const SPEECH_SCRIPT_VERSION = 1;
const TITLE_FALLBACK_WORD_LIMIT = 7;
const STANDALONE_HEADING_WORD_LIMIT = 10;
const SEPARATOR_LINE = /^[\s\-*_~•·=]{3,}$/;
const HEADING_LINE = /^(#{1,6})\s+(.+)$/;
const CAPTION_LINE = /^(?:image\s+)?caption:\s*(.+)$/i;
const RAW_URL = /(https?:\/\/[^\s<>"']+)/gi;

export function buildSpeechScript(input: SpeechScriptInput): SpeechScript {
  const normalization = {
    whitespaceCollapsed: 0,
    separatorsRemoved: 0,
    headingsLabeled: 0,
    captionsLabeled: 0,
    urlsHumanized: 0,
    titleFallbackUsed: false,
  };

  const cleanedBlocks: string[][] = [];
  const rawLines = normalizeLineBreaks(input.textContent).split("\n");
  const bodyFallbackSourceLines: string[] = [];
  const headingFallbackSourceLines: string[] = [];
  const cleanedTitle = cleanupWhitespace(input.title ?? "");
  let currentBlock: string[] = [];

  const flushBlock = () => {
    if (currentBlock.length === 0) {
      return;
    }

    cleanedBlocks.push(currentBlock);
    currentBlock = [];
  };

  const pushToCurrentBlock = (line: string) => {
    currentBlock.push(line);
  };

  for (const [index, rawLine] of rawLines.entries()) {
    const trimmedLine = cleanupWhitespace(rawLine);
    const nextTrimmedLine = cleanupWhitespace(rawLines[index + 1] ?? "");
    if (!trimmedLine) {
      flushBlock();
      continue;
    }

    if (trimmedLine !== rawLine) {
      normalization.whitespaceCollapsed += 1;
    }

    if (isSeparatorLine(trimmedLine)) {
      normalization.separatorsRemoved += 1;
      flushBlock();
      continue;
    }

    const headingMatch = trimmedLine.match(HEADING_LINE);
    if (headingMatch) {
      const { text: headingText, urlsHumanized } = humanizeUrls(
        cleanupWhitespace(headingMatch[2]!),
      );
      flushBlock();
      cleanedBlocks.push([headingText]);
      normalization.headingsLabeled += 1;
      normalization.urlsHumanized += urlsHumanized;
      headingFallbackSourceLines.push(headingText);
      continue;
    }

    if (
      currentBlock.length === 0 &&
      !nextTrimmedLine &&
      trimmedLine !== cleanedTitle &&
      isStandaloneHeading(trimmedLine)
    ) {
      const { text: headingText, urlsHumanized } = humanizeUrls(trimmedLine);
      flushBlock();
      cleanedBlocks.push([headingText]);
      normalization.headingsLabeled += 1;
      normalization.urlsHumanized += urlsHumanized;
      headingFallbackSourceLines.push(headingText);
      continue;
    }

    const captionMatch = trimmedLine.match(CAPTION_LINE);
    if (captionMatch) {
      const { text: captionText, urlsHumanized } = humanizeUrls(
        cleanupWhitespace(captionMatch[1]!),
      );
      pushToCurrentBlock(`Image caption: ${captionText}`);
      normalization.captionsLabeled += 1;
      normalization.urlsHumanized += urlsHumanized;
      continue;
    }

    const { text: humanizedLine, urlsHumanized } = humanizeUrls(trimmedLine);
    pushToCurrentBlock(humanizedLine);
    normalization.urlsHumanized += urlsHumanized;
    bodyFallbackSourceLines.push(humanizedLine);
  }

  flushBlock();

  const script = cleanedBlocks.map((block) => block.join(" ")).join("\n\n");
  const displayTitle = buildDisplayTitle(
    input.title,
    bodyFallbackSourceLines,
    headingFallbackSourceLines,
    normalization,
  );

  return {
    displayTitle,
    script,
    speechScript: script,
    speechScriptVersion: SPEECH_SCRIPT_VERSION,
    normalization,
  };
}

function buildDisplayTitle(
  title: string | null,
  bodyFallbackSourceLines: string[],
  headingFallbackSourceLines: string[],
  normalization: SpeechScript["normalization"],
): string {
  const cleanedTitle = cleanupWhitespace(title ?? "");
  if (cleanedTitle) {
    return cleanedTitle;
  }

  normalization.titleFallbackUsed = true;

  for (const line of bodyFallbackSourceLines) {
    const fallback = takeFirstMeaningfulWords(line, TITLE_FALLBACK_WORD_LIMIT);
    if (fallback) {
      return fallback;
    }
  }

  for (const line of headingFallbackSourceLines) {
    const fallback = takeFirstMeaningfulWords(line, TITLE_FALLBACK_WORD_LIMIT);
    if (fallback) {
      return fallback;
    }
  }

  return "Untitled audio";
}

function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function cleanupWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isSeparatorLine(line: string): boolean {
  return SEPARATOR_LINE.test(line);
}

function isStandaloneHeading(line: string): boolean {
  if (/[.!?]$/.test(line) || line.includes(":")) {
    return false;
  }

  const words = line.match(/\S+/g) ?? [];
  return words.length > 0 && words.length <= STANDALONE_HEADING_WORD_LIMIT && line.length <= 80;
}

function humanizeUrls(text: string): { text: string; urlsHumanized: number } {
  let urlsHumanized = 0;
  const humanizedText = text.replace(RAW_URL, (rawUrl) => {
    const { core, trailing } = splitTrailingPunctuation(rawUrl);
    const spoken = humanizeUrl(core);
    urlsHumanized += 1;
    return `${spoken}${trailing}`;
  });

  return { text: humanizedText, urlsHumanized };
}

function splitTrailingPunctuation(value: string): { core: string; trailing: string } {
  const trailingMatches = value.match(/[.,!?;:\)\]]+$/);
  const trailing = trailingMatches?.[0] ?? "";
  const core = trailing ? value.slice(0, -trailing.length) : value;
  return { core, trailing };
}

function humanizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname
      .split(".")
      .map((part) => cleanupWhitespace(part.replace(/-/g, " ")))
      .filter(Boolean)
      .join(" dot ");

    const pathSegments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => cleanupWhitespace(segment.replace(/[-_]+/g, " ")))
      .filter(Boolean);

    const querySegments = Array.from(url.searchParams.entries()).map(
      ([key, value]) => `${spokenToken(key)} equals ${spokenToken(value)}`,
    );

    const hashSegment = url.hash ? spokenToken(url.hash.slice(1)) : "";
    const spokenParts = [`link to ${host}`];

    if (pathSegments.length > 0) {
      spokenParts.push(`slash ${pathSegments.join(" slash ")}`);
    }

    if (querySegments.length > 0) {
      spokenParts.push(`question mark ${querySegments.join(" and ")}`);
    }

    if (hashSegment) {
      spokenParts.push(`hash ${hashSegment}`);
    }

    return spokenParts.join(" ");
  } catch {
    return "link";
  }
}

function spokenToken(value: string): string {
  return cleanupWhitespace(
    value
      .replace(/[-_]+/g, " ")
      .replace(/[^\p{L}\p{N}\s.]+/gu, " ")
      .replace(/\./g, " dot "),
  );
}

function takeFirstMeaningfulWords(text: string, wordLimit: number): string {
  const cleaned = cleanupWhitespace(text);
  if (!cleaned) {
    return "";
  }

  const words = cleaned.split(" ");
  return words.slice(0, wordLimit).join(" ");
}
