import { describe, expect, it } from "vitest";

import { buildSpeechScript } from "./speech-script.js";

describe("buildSpeechScript", () => {
  it("humanizes raw URLs without paraphrasing article meaning", () => {
    const result = buildSpeechScript({
      title: "Example",
      textContent: "Read more at https://example.com/news?id=1",
    });

    expect(result.script).not.toContain("https://");
    expect(result.script).toContain("Read more at");
    expect(result.script).toContain("example dot com");
    expect(result.normalization.urlsHumanized).toBe(1);
    expect(result.normalization.whitespaceCollapsed).toBe(0);
  });

  it("preserves headings with a light cue", () => {
    const result = buildSpeechScript({
      title: "Example",
      textContent: "## Overview\nThe system works.",
    });

    expect(result.script).toContain("Heading: Overview");
    expect(result.script).toContain("The system works.");
    expect(result.normalization.headingsLabeled).toBe(1);
  });

  it("includes meaningful image captions", () => {
    const result = buildSpeechScript({
      title: "Example",
      textContent: "Caption: The team reviewing the live dashboard.\nThe article continues.",
    });

    expect(result.script).toContain("Image caption: The team reviewing the live dashboard.");
    expect(result.script).toContain("The article continues.");
    expect(result.normalization.captionsLabeled).toBe(1);
  });

  it("tracks whitespace cleanup separately from url rewriting", () => {
    const result = buildSpeechScript({
      title: "Example",
      textContent: "##   Overview   \nCaption:   A  helpful   chart.   \nBody   text with   extra spaces.",
    });

    expect(result.script).toContain("Heading: Overview");
    expect(result.script).toContain("Image caption: A helpful chart.");
    expect(result.script).toContain("Body text with extra spaces.");
    expect(result.normalization.whitespaceCollapsed).toBe(3);
    expect(result.normalization.urlsHumanized).toBe(0);
  });

  it("removes noisy repeated separators", () => {
    const result = buildSpeechScript({
      title: "Example",
      textContent: "Intro\n---\n***\n___\nBody text.",
    });

    expect(result.script).toContain("Intro");
    expect(result.script).toContain("Body text.");
    expect(result.script).not.toContain("---");
    expect(result.script).not.toContain("***");
    expect(result.script).not.toContain("___");
    expect(result.normalization.separatorsRemoved).toBe(3);
  });

  it("falls back to the first meaningful words when the title is missing", () => {
    const result = buildSpeechScript({
      title: null,
      textContent: "\n\n## Overview\nThis article explains how the cache behaves in practice.\n",
    });

    expect(result.displayTitle).toBe("This article explains how the cache behaves");
    expect(result.speechScriptVersion).toBe(1);
    expect(result.normalization.titleFallbackUsed).toBe(true);
  });
});
