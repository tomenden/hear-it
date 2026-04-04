import { describe, expect, it } from "vitest";

import { chunkSpeechScript } from "./text-chunker.js";

describe("chunkSpeechScript", () => {
  it("keeps output ordered even when paragraphs differ in size", () => {
    const chunks = chunkSpeechScript({
      script:
        "Heading.\n\nFirst paragraph has enough words to anchor the order and keep the introduction calm. It stays readable.\n\nSecond paragraph is long enough to fill most of a target chunk without breaking sentence order or paragraph flow. It keeps moving.\n\nThird paragraph closes the sample with a short ending.",
      targetSecondsPerChunk: 20,
    });

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks[0]?.text).toContain("First paragraph");
    expect(chunks[1]?.text).toContain("Third paragraph");
  });

  it("prefers keeping whole paragraphs together when they fit the target window", () => {
    const chunks = chunkSpeechScript({
      script:
        "Paragraph one has enough words to matter and keep the listener in the first section without sounding rushed. It stays intact.\n\nParagraph two also has enough words to matter and keeps the middle section together instead of fragmenting it. It stays intact.\n\nParagraph three closes things out with a short ending that still feels natural.",
      targetSecondsPerChunk: 20,
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain("Paragraph one");
    expect(chunks[0]?.text).toContain("Paragraph two");
    expect(chunks[0]?.text).not.toContain("Paragraph three");
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
        "Hello world and a little more context for the listener. שלום עולם עם עוד מעט הקשר למאזין. Привет мир и немного дополнительного контекста для слушателя.",
      targetSecondsPerChunk: 6,
    });

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks[0]?.text).toContain("Hello world and a little more context for the listener.");
    expect(chunks[0]?.text).toContain("שלום עולם עם עוד מעט הקשר למאזין.");
    expect(chunks[1]?.text).toContain("Привет мир и немного дополнительного контекста для слушателя.");
  });
});
