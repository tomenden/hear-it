import { describe, expect, it } from "vitest";

import { chunkSpeechScript } from "./text-chunker.js";

describe("chunkSpeechScript", () => {
  it("keeps output ordered even when paragraphs differ in size", () => {
    const chunks = chunkSpeechScript({
      script:
        "Heading.\n\nFirst paragraph has enough words to anchor the order and keep the introduction calm while still staying under the target window and still sounding natural when spoken aloud. It stays readable.\n\nSecond paragraph is long enough to fill most of a target chunk without breaking sentence order or paragraph flow and still leaves room for the pacing to breathe. It keeps moving along at a steady pace.\n\nThird paragraph closes the sample with a short ending that still has enough substance to remain clearly spoken and still finish the thought cleanly.",
      targetSecondsPerChunk: 20,
    });

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks[0]?.text).toContain("First paragraph");
    expect(chunks[1]?.text).toContain("Third paragraph");
  });

  it("prefers keeping whole paragraphs together when they fit the target window", () => {
    const chunks = chunkSpeechScript({
      script:
        "Paragraph one has enough words to matter and keep the listener in the first section without sounding rushed, while still staying under the target window and preserving the paragraph boundary. It stays intact.\n\nParagraph two also has enough words to matter and keeps the middle section together instead of fragmenting it, while still staying under the target window and preserving the paragraph boundary. It stays intact.\n\nParagraph three closes things out with a short ending that still feels natural and stays under the target window too, without forcing a split.",
      targetSecondsPerChunk: 20,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain("Paragraph one");
    expect(chunks[0]?.text).toContain("Paragraph two");
    expect(chunks[0]?.text).not.toContain("Paragraph three");
  });

  it("keeps headed sections together and preserves paragraph breaks inside a chunk", () => {
    const firstParagraph =
      "First paragraph has enough words to fill most of the target window while keeping the opening idea fully intact for the listener.";
    const secondParagraph =
      "Second paragraph continues the same section without changing topic so it should stay grouped with the heading when the section still fits.";
    const thirdParagraph =
      "Third paragraph starts the next section and should not steal the previous heading when a new chunk begins.";

    const chunks = chunkSpeechScript({
      script: `Section One\n\n${firstParagraph}\n\n${secondParagraph}\n\nSection Two\n\n${thirdParagraph}`,
      targetSecondsPerChunk: 14,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toBe(
      `Section One\n\n${firstParagraph}\n\n${secondParagraph}`,
    );
    expect(chunks[1]?.text).toBe(`Section Two\n\n${thirdParagraph}`);
  });

  it("falls back from section boundaries to paragraph boundaries before splitting sentences", () => {
    const firstParagraph =
      "Paragraph one stays complete so the heading remains attached to real content and the first chunk lands on a clean paragraph break.";
    const secondParagraph =
      "Paragraph two is also long enough to stand on its own and should arrive as a full paragraph rather than a sentence fragment.";
    const thirdParagraph =
      "Paragraph three closes the section with another complete thought that can share a later chunk if space allows.";

    const chunks = chunkSpeechScript({
      script: `Deep Dive\n\n${firstParagraph}\n\n${secondParagraph}\n\n${thirdParagraph}`,
      targetSecondsPerChunk: 7,
    });

    expect(chunks[0]?.text).toBe(`Deep Dive\n\n${firstParagraph}`);
    expect(chunks.some((chunk) => chunk.text.trim() === "Deep Dive")).toBe(false);
    expect(chunks[1]?.text.startsWith(secondParagraph)).toBe(true);
  });

  it("stays near the target speech window", () => {
    const sentences = Array.from({ length: 18 }, (_, index) => `Sentence ${index + 1} keeps the cadence moving along at a steady pace.`);
    const chunks = chunkSpeechScript({
      script: sentences.join(" "),
      targetSecondsPerChunk: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.estimatedDurationSeconds).toBeGreaterThanOrEqual(15);
      expect(chunk.estimatedDurationSeconds).toBeLessThanOrEqual(25);
    }
  });

  it("handles Hebrew, English, and Russian sentences without splitting inside obvious sentence units", () => {
    const chunks = chunkSpeechScript({
      script:
        "Hello world and a little more context for the listener so the speech script stays clear and easy to follow. שלום עולם עם עוד מעט הקשר למאזין כדי שהמשפט יישאר שלם וברור. Привет мир и немного дополнительного контекста для слушателя, чтобы предложение осталось цельным и понятным.",
      targetSecondsPerChunk: 6,
    });

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks[0]?.text).toContain(
      "Hello world and a little more context for the listener so the speech script stays clear and easy to follow.",
    );
    expect(chunks[1]?.text).toContain(
      "שלום עולם עם עוד מעט הקשר למאזין כדי שהמשפט יישאר שלם וברור.",
    );
    expect(chunks[1]?.text).toContain(
      "Привет мир и немного дополнительного контекста для слушателя, чтобы предложение осталось цельным и понятным.",
    );
  });

  it("keeps an oversized sentence intact instead of breaking it mid-sentence", () => {
    const script =
      "This long sentence, with commas and a semicolon; keeps every punctuation mark intact while it grows long enough to require chunking, because the content should be partitioned rather than rewritten, and the original text must remain recognizable even after multiple slices.";

    const chunks = chunkSpeechScript({
      script,
      targetSecondsPerChunk: 3,
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(script);
    expect(chunks[0]?.estimatedDurationSeconds).toBeGreaterThan(3);
  });
});
