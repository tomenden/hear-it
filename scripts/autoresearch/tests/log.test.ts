import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readLog,
  appendRow,
  getCurrentBest,
  getNextRound,
  getCumulativeSpend,
  estimateCost,
  HEADERS,
  type LogRow,
} from "../log.js";

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autoresearch-test-"));
  logPath = join(tmpDir, "log.tsv");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true });
});

const makeRow = (overrides: Partial<LogRow> = {}): LogRow => ({
  timestamp: "2026-04-11T20:00:00.000Z",
  round: 1,
  instruction: "Read clearly.",
  naturalness: 7,
  pacing: 7,
  engagement: 7,
  clarity: 7,
  composite: 7,
  verdict: "baseline",
  spend_usd: 0.09,
  ...overrides,
});

describe("readLog", () => {
  it("returns [] when file does not exist", () => {
    expect(readLog(logPath)).toEqual([]);
  });

  it("returns [] when file is empty", () => {
    writeFileSync(logPath, "");
    expect(readLog(logPath)).toEqual([]);
  });

  it("returns [] when file has only a header row", () => {
    writeFileSync(logPath, HEADERS.join("\t") + "\n");
    expect(readLog(logPath)).toEqual([]);
  });

  it("parses a written row back correctly", () => {
    const row = makeRow();
    appendRow(row, logPath);
    const result = readLog(logPath);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject(row);
  });
});

describe("getCurrentBest", () => {
  it("returns null for empty log", () => {
    expect(getCurrentBest([])).toBeNull();
  });

  it("returns the baseline row when no improved rows exist", () => {
    const baseline = makeRow({ verdict: "baseline", composite: 6.5 });
    const rejected = makeRow({ round: 2, verdict: "rejected", composite: 6.0 });
    expect(getCurrentBest([baseline, rejected])).toMatchObject(baseline);
  });

  it("returns the last improved row", () => {
    const baseline = makeRow({ verdict: "baseline", composite: 6.5 });
    const improved = makeRow({ round: 2, verdict: "improved", composite: 7.2 });
    const rejected = makeRow({ round: 3, verdict: "rejected", composite: 7.0 });
    expect(getCurrentBest([baseline, improved, rejected])?.composite).toBe(7.2);
  });
});

describe("getNextRound", () => {
  it("returns 1 for empty log", () => {
    expect(getNextRound([])).toBe(1);
  });

  it("returns last round + 1", () => {
    expect(getNextRound([makeRow({ round: 5 })])).toBe(6);
  });
});

describe("getCumulativeSpend", () => {
  it("returns 0 for empty log", () => {
    expect(getCumulativeSpend([])).toBe(0);
  });

  it("returns spend_usd of last row", () => {
    expect(getCumulativeSpend([makeRow({ spend_usd: 0.73 })])).toBe(0.73);
  });
});

describe("estimateCost", () => {
  it("calculates $0.015 per 1000 chars", () => {
    expect(estimateCost(1000)).toBeCloseTo(0.015);
    expect(estimateCost(3000)).toBeCloseTo(0.045);
    expect(estimateCost(0)).toBe(0);
  });
});

describe("appendRow", () => {
  it("writes header on first append", () => {
    appendRow(makeRow(), logPath);
    const content = readFileSync(logPath, "utf-8");
    expect(content.startsWith(HEADERS.join("\t"))).toBe(true);
  });

  it("does not duplicate header on second append", () => {
    appendRow(makeRow({ round: 1 }), logPath);
    appendRow(makeRow({ round: 2 }), logPath);
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3); // header + 2 data rows
  });
});
