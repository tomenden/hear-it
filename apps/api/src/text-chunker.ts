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
  let currentUnits: string[] = [];
  let currentDuration = 0;

  const flushCurrent = () => {
    if (currentUnits.length === 0) {
      return;
    }

    chunks.push({
      text: currentUnits.join(" "),
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

    currentUnits.push(unit.text);
    currentDuration += unit.estimatedDurationSeconds;
  }

  flushCurrent();

  return chunks.map((chunk, index) => ({ index, ...chunk }));
}

type ChunkUnit = {
  text: string;
  estimatedDurationSeconds: number;
};

function buildUnits(script: string, maxSecondsPerChunk: number): ChunkUnit[] {
  const blocks = script
    .split(PARAGRAPH_SPLIT)
    .map((block) => block.trim())
    .filter(Boolean);

  const units: ChunkUnit[] = [];

  for (const block of blocks) {
    const lines = block
      .split(/\n+/)
      .map((line) => cleanupWhitespace(line))
      .filter(Boolean);

    for (const line of lines) {
      const lineDuration = estimateDurationSeconds(line);
      if (lineDuration <= maxSecondsPerChunk) {
        units.push({
          text: line,
          estimatedDurationSeconds: lineDuration,
        });
        continue;
      }

      const sentences = splitIntoSentences(line);
      for (const sentence of sentences) {
        const sentenceDuration = estimateDurationSeconds(sentence);
        if (sentenceDuration <= maxSecondsPerChunk) {
          units.push({
            text: sentence,
            estimatedDurationSeconds: sentenceDuration,
          });
          continue;
        }

        const wordSlices = splitLongSentence(sentence, maxSecondsPerChunk);
        for (const slice of wordSlices) {
          units.push({
            text: slice,
            estimatedDurationSeconds: estimateDurationSeconds(slice),
          });
        }
      }
    }
  }

  return units;
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

function splitLongSentence(sentence: string, maxSecondsPerChunk: number): string[] {
  const maxWordsPerSlice = Math.max(
    1,
    Math.floor(maxSecondsPerChunk * WORDS_PER_SECOND),
  );
  const words = sentence.match(WORD_REGEX) ?? [sentence];
  if (words.length <= maxWordsPerSlice) {
    return [sentence];
  }

  const slices: string[] = [];
  for (let index = 0; index < words.length; index += maxWordsPerSlice) {
    slices.push(words.slice(index, index + maxWordsPerSlice).join(" "));
  }

  return slices;
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
