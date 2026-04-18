export interface SpeechChunk {
  index: number;
  text: string;
  estimatedDurationSeconds: number;
}

export interface ChunkSpeechScriptInput {
  script: string;
  targetSecondsPerChunk?: number;
}

const WORDS_PER_SECOND = 4;
const PARAGRAPH_SPLIT = /\n\s*\n+/;
const WORD_REGEX = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const HEADING_WORD_LIMIT = 12;
const HEADING_LENGTH_LIMIT = 100;

export function chunkSpeechScript(
  input: ChunkSpeechScriptInput,
): SpeechChunk[] {
  const normalizedScript = normalizeScript(input.script);
  if (!normalizedScript) {
    return [];
  }

  const targetSecondsPerChunk = Math.max(1, input.targetSecondsPerChunk ?? 20);
  const minSecondsPerChunk = Math.max(1, Math.round(targetSecondsPerChunk * 0.75));
  const maxSecondsPerChunk = Math.max(
    1,
    Math.round(targetSecondsPerChunk * 1.25),
  );

  const units = buildUnits(normalizedScript, maxSecondsPerChunk);
  const chunks: Omit<SpeechChunk, "index">[] = [];
  let currentUnits: ChunkUnit[] = [];
  let currentDuration = 0;

  const flushCurrent = () => {
    if (currentUnits.length === 0) {
      return;
    }

    const [firstUnit, ...remainingUnits] = currentUnits;
    if (!firstUnit) {
      return;
    }

    let text = firstUnit.text;
    for (const unit of remainingUnits) {
      text += `${unit.separatorBefore}${unit.text}`;
    }

    chunks.push({
      text,
      estimatedDurationSeconds: currentDuration,
    });
    currentUnits = [];
    currentDuration = 0;
  };

  for (const unit of units) {
    const wouldExceedTarget =
      currentDuration + unit.estimatedDurationSeconds > targetSecondsPerChunk;
    const wouldExceedMaximum =
      currentDuration + unit.estimatedDurationSeconds > maxSecondsPerChunk;
    const hasReachedMinimum = currentDuration >= minSecondsPerChunk;

    if (
      currentUnits.length > 0 &&
      ((hasReachedMinimum && wouldExceedTarget) || wouldExceedMaximum)
    ) {
      flushCurrent();
    }

    currentUnits.push(unit);
    currentDuration += unit.estimatedDurationSeconds;
  }

  flushCurrent();

  return chunks.map((chunk, index) => ({ index, ...chunk }));
}

type ChunkUnit = {
  text: string;
  estimatedDurationSeconds: number;
  separatorBefore: "" | " " | "\n\n";
};

function buildUnits(script: string, maxSecondsPerChunk: number): ChunkUnit[] {
  const blocks = script
    .split(PARAGRAPH_SPLIT)
    .map((block) => block.trim())
    .filter(Boolean);
  const sections = buildSections(blocks);

  const units: ChunkUnit[] = [];

  for (const section of sections) {
    appendSectionUnits(units, section, maxSecondsPerChunk);
  }

  return units;
}

type ScriptSection = {
  heading: string | null;
  paragraphs: string[];
};

function buildSections(blocks: string[]): ScriptSection[] {
  const sections: ScriptSection[] = [];
  let currentSection: ScriptSection | null = null;

  const flushCurrent = () => {
    if (!currentSection) {
      return;
    }

    sections.push(currentSection);
    currentSection = null;
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = cleanupWhitespace(blocks[index] ?? "");
    if (!block) {
      continue;
    }

    if (isHeadingBlock(block)) {
      flushCurrent();
      currentSection = {
        heading: block,
        paragraphs: [],
      };
      continue;
    }

    if (currentSection?.heading) {
      currentSection.paragraphs.push(block);
      continue;
    }

    sections.push({
      heading: null,
      paragraphs: [block],
    });
  }

  flushCurrent();

  return sections;
}

function appendSectionUnits(
  units: ChunkUnit[],
  section: ScriptSection,
  maxSecondsPerChunk: number,
): void {
  const sectionText = formatSection(section);
  if (!sectionText) {
    return;
  }

  const sectionDuration = estimateDurationSeconds(sectionText);
  if (sectionDuration <= maxSecondsPerChunk) {
    units.push(buildUnit(sectionText, sectionDuration, units.length === 0 ? "" : "\n\n"));
    return;
  }

  if (section.paragraphs.length === 0 && section.heading) {
    units.push(buildUnit(section.heading, sectionDuration, units.length === 0 ? "" : "\n\n"));
    return;
  }

  section.paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphText =
      section.heading && paragraphIndex === 0
        ? `${section.heading}\n\n${paragraph}`
        : paragraph;
    const paragraphDuration = estimateDurationSeconds(paragraphText);
    const paragraphSeparator = units.length === 0 ? "" : "\n\n";

    if (paragraphDuration <= maxSecondsPerChunk) {
      units.push(buildUnit(paragraphText, paragraphDuration, paragraphSeparator));
      return;
    }

    const sentences = splitIntoSentences(paragraph);
    sentences.forEach((sentence, sentenceIndex) => {
      const sentenceText =
        section.heading && paragraphIndex === 0 && sentenceIndex === 0
          ? `${section.heading}\n\n${sentence}`
          : sentence;
      const separatorBefore =
        units.length === 0
          ? ""
          : sentenceIndex === 0
            ? "\n\n"
            : " ";

      units.push(
        buildUnit(
          sentenceText,
          estimateDurationSeconds(sentenceText),
          separatorBefore,
        ),
      );
    });
  });
}

function buildUnit(
  text: string,
  estimatedDurationSeconds: number,
  separatorBefore: "" | " " | "\n\n",
): ChunkUnit {
  return {
    text,
    estimatedDurationSeconds,
    separatorBefore,
  };
}

function formatSection(section: ScriptSection): string {
  const parts = [
    section.heading,
    ...section.paragraphs,
  ].filter(Boolean);

  return parts.join("\n\n");
}

function isHeadingBlock(block: string): boolean {
  if (/[.!?]$/.test(block) || block.includes(":")) {
    return false;
  }

  const words = block.match(/\S+/g) ?? [];
  return words.length > 0 && words.length <= HEADING_WORD_LIMIT && block.length <= HEADING_LENGTH_LIMIT;
}

function splitIntoSentences(paragraph: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    const sentences = Array.from(segmenter.segment(paragraph), (segment) =>
      cleanupWhitespace(segment.segment),
    ).filter(Boolean);

    if (sentences.length > 0) {
      return sentences;
    }
  }

  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanupWhitespace(sentence))
    .filter(Boolean);
}

function normalizeScript(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function cleanupWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function estimateDurationSeconds(text: string): number {
  const wordCount = countWords(text);
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_SECOND));
}

function countWords(text: string): number {
  return text.match(WORD_REGEX)?.length ?? 0;
}
