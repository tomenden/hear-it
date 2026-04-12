import { readFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LOG_PATH = join(__dirname, "results/log.tsv");

export const HEADERS = [
  "timestamp",
  "round",
  "instruction",
  "naturalness",
  "pacing",
  "engagement",
  "clarity",
  "composite",
  "verdict",
  "spend_usd",
] as const;

export type Verdict = "baseline" | "improved" | "rejected" | "error";

export interface LogRow {
  timestamp: string;
  round: number;
  instruction: string;
  naturalness: number;
  pacing: number;
  engagement: number;
  clarity: number;
  composite: number;
  verdict: Verdict;
  spend_usd: number;
}

export function readLog(logPath = DEFAULT_LOG_PATH): LogRow[] {
  if (!existsSync(logPath)) return [];
  const content = readFileSync(logPath, "utf-8").trim();
  if (!content) return [];
  const lines = content.split("\n");
  // First line is header — skip it
  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map(parseLine);
}

const VALID_VERDICTS: readonly string[] = ["baseline", "improved", "rejected", "error"];

function toVerdict(value: string | undefined): Verdict {
  if (value !== undefined && VALID_VERDICTS.includes(value)) {
    return value as Verdict;
  }
  return "error";
}

function parseLine(line: string): LogRow {
  const parts = line.split("\t");
  return {
    timestamp: parts[0] ?? "",
    round: parseInt(parts[1] ?? "0", 10),
    instruction: parts[2] ?? "",
    naturalness: parseFloat(parts[3] ?? "0"),
    pacing: parseFloat(parts[4] ?? "0"),
    engagement: parseFloat(parts[5] ?? "0"),
    clarity: parseFloat(parts[6] ?? "0"),
    composite: parseFloat(parts[7] ?? "0"),
    verdict: toVerdict(parts[8]),
    spend_usd: parseFloat(parts[9] ?? "0"),
  };
}

// Returns the most recent accepted row (baseline or improved), i.e. the current
// champion instruction. Relies on log rows being in append (chronological) order.
export function getCurrentBest(log: LogRow[]): LogRow | null {
  const relevant = log.filter(
    (r) => r.verdict === "improved" || r.verdict === "baseline"
  );
  return relevant.at(-1) ?? null;
}

export function getNextRound(log: LogRow[]): number {
  return log.length === 0 ? 1 : (log.at(-1)?.round ?? 0) + 1;
}

export function getCumulativeSpend(log: LogRow[]): number {
  return log.at(-1)?.spend_usd ?? 0;
}

export function appendRow(row: LogRow, logPath = DEFAULT_LOG_PATH): void {
  const fileContent = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
  const needsHeader = !fileContent.trimStart().startsWith(HEADERS[0]);
  if (needsHeader) {
    appendFileSync(logPath, HEADERS.join("\t") + "\n");
  }
  const line = [
    row.timestamp,
    row.round,
    row.instruction,
    row.naturalness,
    row.pacing,
    row.engagement,
    row.clarity,
    row.composite,
    row.verdict,
    row.spend_usd,
  ].join("\t");
  appendFileSync(logPath, line + "\n");
}

// $0.015 / 1000 chars — OpenAI gpt-4o-mini-tts rate as of 2026-04
export function estimateCost(charCount: number): number {
  return (charCount / 1000) * 0.015;
}
