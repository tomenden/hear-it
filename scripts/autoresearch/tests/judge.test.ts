import { describe, it, expect } from "vitest";
import { parseScores, composite } from "../judge.js";

describe("parseScores", () => {
  it("parses a clean JSON response", () => {
    const input = '{"naturalness": 8, "pacing": 7, "engagement": 6, "clarity": 9}';
    expect(parseScores(input)).toEqual({
      naturalness: 8,
      pacing: 7,
      engagement: 6,
      clarity: 9,
    });
  });

  it("strips markdown code fences before parsing", () => {
    const input = "```json\n{\"naturalness\": 7, \"pacing\": 7, \"engagement\": 7, \"clarity\": 7}\n```";
    expect(parseScores(input)).toEqual({
      naturalness: 7,
      pacing: 7,
      engagement: 7,
      clarity: 7,
    });
  });

  it("throws on a missing dimension", () => {
    const input = '{"naturalness": 8, "pacing": 7, "engagement": 6}';
    expect(() => parseScores(input)).toThrow();
  });

  it("throws when a score is out of range", () => {
    const input = '{"naturalness": 11, "pacing": 7, "engagement": 6, "clarity": 9}';
    expect(() => parseScores(input)).toThrow("Invalid score for naturalness");
  });

  it("throws when a score is not a number", () => {
    const input = '{"naturalness": "great", "pacing": 7, "engagement": 6, "clarity": 9}';
    expect(() => parseScores(input)).toThrow("Invalid score for naturalness");
  });
});

describe("composite", () => {
  it("returns the average of four dimensions", () => {
    expect(
      composite({ naturalness: 8, pacing: 6, engagement: 7, clarity: 9 })
    ).toBeCloseTo(7.5);
  });

  it("handles all equal scores", () => {
    expect(
      composite({ naturalness: 5, pacing: 5, engagement: 5, clarity: 5 })
    ).toBe(5);
  });
});
