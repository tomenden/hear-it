# Autoresearch TTS Instruction Optimisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an autonomous hill-climbing harness that proposes `DEFAULT_TTS_INSTRUCTIONS` variants, generates real audio with OpenAI TTS, judges quality with Gemini 2.0 Flash, and commits improvements — all orchestrated by Claude Code via `/loop`.

**Architecture:** A standalone TypeScript package in `scripts/autoresearch/` with three pure modules (`log.ts`, `judge.ts`, `tts.ts`) composed by a CLI entry point (`run-experiment.ts`). Claude Code acts as the proposer and loop controller. The harness lives on `autoresearch-infra`; experiment results land on `autoresearch/2026-04-11` branched from it.

**Tech Stack:** TypeScript + tsx (no build step), vitest, `@google/generative-ai`, raw `fetch` for OpenAI TTS, dotenv.

---

## File Map

| Path | Role |
|---|---|
| `scripts/autoresearch/package.json` | Package config, deps, test script |
| `scripts/autoresearch/tsconfig.json` | TypeScript config for tsx |
| `scripts/autoresearch/.env.example` | Documents required env vars |
| `scripts/autoresearch/log.ts` | TSV log read/write, cost tracking, round numbering |
| `scripts/autoresearch/judge.ts` | Gemini Flash audio scoring |
| `scripts/autoresearch/tts.ts` | OpenAI TTS MP3 generation |
| `scripts/autoresearch/run-experiment.ts` | CLI entry point — orchestrates one full experiment |
| `scripts/autoresearch/tests/log.test.ts` | Unit tests for log.ts pure functions |
| `scripts/autoresearch/tests/judge.test.ts` | Unit tests for judge.ts score parsing |
| `scripts/autoresearch/benchmarks/article-news.txt` | Fixed ~500-word news/factual article fixture |
| `scripts/autoresearch/benchmarks/article-narrative.txt` | Fixed ~500-word narrative/opinion article fixture |
| `scripts/autoresearch/results/.gitkeep` | Keeps results dir in git |
| `scripts/autoresearch/README.md` | Setup, usage, and `/loop` instructions |
| `apps/api/src/tts.ts` | Modified only when an improvement is committed |

---

## Task 1: Branch and package setup

**Files:**
- Create: `scripts/autoresearch/package.json`
- Create: `scripts/autoresearch/tsconfig.json`

- [ ] **Step 1: Create the autoresearch-infra branch**

```bash
git checkout master
git checkout -b autoresearch-infra
```

- [ ] **Step 2: Create the package.json**

Create `scripts/autoresearch/package.json`:

```json
{
  "name": "hear-it-autoresearch",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `scripts/autoresearch/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["./*.ts", "./tests/**/*.ts"]
}
```

- [ ] **Step 4: Install dependencies**

```bash
cd scripts/autoresearch && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Verify tsx works**

```bash
cd scripts/autoresearch && echo 'console.log("ok")' > _smoke.ts && npx tsx _smoke.ts && rm _smoke.ts
```

Expected output: `ok`

- [ ] **Step 6: Commit**

```bash
git add scripts/autoresearch/package.json scripts/autoresearch/tsconfig.json scripts/autoresearch/package-lock.json
git commit -m "chore: scaffold autoresearch package"
```

---

## Task 2: Log module with unit tests

**Files:**
- Create: `scripts/autoresearch/log.ts`
- Create: `scripts/autoresearch/tests/log.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scripts/autoresearch/tests/log.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd scripts/autoresearch && npx vitest run tests/log.test.ts
```

Expected: all tests fail with "Cannot find module '../log.js'"

- [ ] **Step 3: Implement log.ts**

Create `scripts/autoresearch/log.ts`:

```typescript
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
    verdict: (parts[8] ?? "error") as Verdict,
    spend_usd: parseFloat(parts[9] ?? "0"),
  };
}

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
  const isNew =
    !existsSync(logPath) ||
    readFileSync(logPath, "utf-8").trim() === "";
  if (isNew) {
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

export function estimateCost(charCount: number): number {
  return (charCount / 1000) * 0.015;
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
cd scripts/autoresearch && npx vitest run tests/log.test.ts
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add scripts/autoresearch/log.ts scripts/autoresearch/tests/log.test.ts
git commit -m "feat(autoresearch): add log module with TSV read/write and cost tracking"
```

---

## Task 3: Judge module with score parsing tests

**Files:**
- Create: `scripts/autoresearch/judge.ts`
- Create: `scripts/autoresearch/tests/judge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `scripts/autoresearch/tests/judge.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd scripts/autoresearch && npx vitest run tests/judge.test.ts
```

Expected: all tests fail with "Cannot find module '../judge.js'"

- [ ] **Step 3: Implement judge.ts**

Create `scripts/autoresearch/judge.ts`:

```typescript
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface JudgeScores {
  naturalness: number;
  pacing: number;
  engagement: number;
  clarity: number;
}

const SCORING_PROMPT = `You are evaluating a text-to-speech audio recording of a news or opinion article.
Score the audio on each of the following dimensions from 1 to 10:

- naturalness: Does the speech sound human and uncontrived, or robotic and awkward?
- pacing: Is the rhythm appropriate — sentences flow cleanly, pauses feel natural, not rushed or dragging?
- engagement: Would a listener stay engaged through a full article, or does the delivery feel monotonous?
- clarity: Are all words clearly pronounced and easy to follow? Is emphasis placed on the right words?

Respond with ONLY valid JSON and nothing else:
{"naturalness": N, "pacing": N, "engagement": N, "clarity": N}`;

export async function judgeAudio(
  audioBuffer: Buffer,
  apiKey: string
): Promise<JudgeScores> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: "audio/mpeg",
        data: audioBuffer.toString("base64"),
      },
    },
    SCORING_PROMPT,
  ]);

  return parseScores(result.response.text());
}

export function parseScores(text: string): JudgeScores {
  const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const score = (key: string): number => {
    const v = parsed[key];
    if (typeof v !== "number" || v < 1 || v > 10) {
      throw new Error(`Invalid score for ${key}: ${JSON.stringify(v)}`);
    }
    return v;
  };
  return {
    naturalness: score("naturalness"),
    pacing: score("pacing"),
    engagement: score("engagement"),
    clarity: score("clarity"),
  };
}

export function composite(scores: JudgeScores): number {
  return (
    (scores.naturalness + scores.pacing + scores.engagement + scores.clarity) /
    4
  );
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
cd scripts/autoresearch && npx vitest run tests/judge.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

```bash
cd scripts/autoresearch && npx vitest run
```

Expected: all tests pass across both test files.

- [ ] **Step 6: Commit**

```bash
git add scripts/autoresearch/judge.ts scripts/autoresearch/tests/judge.test.ts
git commit -m "feat(autoresearch): add Gemini Flash judge module with score parsing"
```

---

## Task 4: TTS module

**Files:**
- Create: `scripts/autoresearch/tts.ts`

No unit tests here — the function is a thin wrapper around an external API call. Integration is verified in Task 5's smoke test.

- [ ] **Step 1: Implement tts.ts**

Create `scripts/autoresearch/tts.ts`:

```typescript
const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "alloy";

export async function generateSpeech(
  text: string,
  instruction: string,
  apiKey: string
): Promise<Buffer> {
  const response = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      instructions: instruction,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: { message?: string } };
      detail = body.error?.message ?? JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => "");
    }
    throw new Error(`OpenAI TTS failed: ${response.status} — ${detail}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/autoresearch/tts.ts
git commit -m "feat(autoresearch): add OpenAI TTS generation module"
```

---

## Task 5: CLI entry point

**Files:**
- Create: `scripts/autoresearch/run-experiment.ts`
- Create: `scripts/autoresearch/.env.example`
- Create: `scripts/autoresearch/results/.gitkeep`

- [ ] **Step 1: Create the results directory and .env.example**

Create `scripts/autoresearch/results/.gitkeep`:
```
```
(empty file)

Create `scripts/autoresearch/.env.example`:
```
OPENAI_API_KEY=your-openai-api-key-here
GOOGLE_AI_API_KEY=your-google-ai-api-key-here
```

- [ ] **Step 2: Implement run-experiment.ts**

Create `scripts/autoresearch/run-experiment.ts`:

```typescript
import { readFileSync } from "fs";
import { join } from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { generateSpeech } from "./tts.js";
import { judgeAudio } from "./judge.js";
import {
  readLog,
  appendRow,
  getCurrentBest,
  getNextRound,
  getCumulativeSpend,
  estimateCost,
} from "./log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, ".env") });

const BUDGET_HARD_STOP_USD = 1.9;
const BENCHMARK_DIR = join(__dirname, "benchmarks");

async function main(): Promise<void> {
  // Parse --instruction flag
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf("--instruction");
  if (flagIndex === -1 || args[flagIndex + 1] === undefined) {
    console.error("Usage: npx tsx run-experiment.ts --instruction <text>");
    process.exit(1);
  }
  const instruction = args[flagIndex + 1] as string;

  // Validate env
  const openaiKey = process.env.OPENAI_API_KEY;
  const googleKey = process.env.GOOGLE_AI_API_KEY;
  if (!openaiKey) {
    console.error("ERROR: OPENAI_API_KEY not set in scripts/autoresearch/.env");
    process.exit(1);
  }
  if (!googleKey) {
    console.error("ERROR: GOOGLE_AI_API_KEY not set in scripts/autoresearch/.env");
    process.exit(1);
  }

  // Budget check
  const log = readLog();
  const currentSpend = getCumulativeSpend(log);
  if (currentSpend >= BUDGET_HARD_STOP_USD) {
    console.error(
      `BUDGET EXHAUSTED: $${currentSpend.toFixed(3)} >= $${BUDGET_HARD_STOP_USD}. Stopping.`
    );
    process.exit(2);
  }

  const round = getNextRound(log);
  const currentBest = getCurrentBest(log);

  console.log(`\n=== Round ${round} ===`);
  console.log(`Instruction: "${instruction}"`);
  console.log(`Budget used: $${currentSpend.toFixed(3)} / $${BUDGET_HARD_STOP_USD}`);

  // Load benchmark articles
  const articles = [
    readFileSync(join(BENCHMARK_DIR, "article-news.txt"), "utf-8"),
    readFileSync(join(BENCHMARK_DIR, "article-narrative.txt"), "utf-8"),
  ];

  // Run TTS + judge for each article
  let roundCost = 0;
  const allNaturalness: number[] = [];
  const allPacing: number[] = [];
  const allEngagement: number[] = [];
  const allClarity: number[] = [];

  for (const [i, articleText] of articles.entries()) {
    console.log(`\nArticle ${i + 1}/${articles.length}: generating speech...`);
    const audio = await generateSpeech(articleText, instruction, openaiKey);
    roundCost += estimateCost(articleText.length);

    console.log(`Article ${i + 1}/${articles.length}: judging audio...`);
    const scores = await judgeAudio(audio, googleKey);
    console.log(`  → naturalness=${scores.naturalness} pacing=${scores.pacing} engagement=${scores.engagement} clarity=${scores.clarity}`);

    allNaturalness.push(scores.naturalness);
    allPacing.push(scores.pacing);
    allEngagement.push(scores.engagement);
    allClarity.push(scores.clarity);
  }

  const avg = (nums: number[]): number =>
    nums.reduce((a, b) => a + b, 0) / nums.length;

  const naturalness = avg(allNaturalness);
  const pacing = avg(allPacing);
  const engagement = avg(allEngagement);
  const clarity = avg(allClarity);
  const comp = avg([naturalness, pacing, engagement, clarity]);
  const newSpend = currentSpend + roundCost;

  const verdict =
    currentBest === null
      ? "baseline"
      : comp > currentBest.composite
      ? "improved"
      : "rejected";

  appendRow({
    timestamp: new Date().toISOString(),
    round,
    instruction,
    naturalness,
    pacing,
    engagement,
    clarity,
    composite: comp,
    verdict,
    spend_usd: newSpend,
  });

  // Print structured output for Claude Code to parse
  console.log(`\n--- RESULT ---`);
  console.log(`ROUND: ${round}`);
  console.log(`COMPOSITE: ${comp.toFixed(2)}`);
  console.log(`VERDICT: ${verdict}`);
  console.log(`SPEND: $${newSpend.toFixed(3)}`);
  console.log(`INSTRUCTION: ${instruction}`);
  if (currentBest) {
    console.log(`PREVIOUS_BEST: ${currentBest.composite.toFixed(2)}`);
  }
  console.log(`BUDGET_REMAINING: $${(BUDGET_HARD_STOP_USD - newSpend).toFixed(3)}`);
}

main().catch((err: unknown) => {
  console.error("Experiment failed:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Commit**

```bash
git add scripts/autoresearch/run-experiment.ts scripts/autoresearch/.env.example scripts/autoresearch/results/.gitkeep
git commit -m "feat(autoresearch): add CLI entry point run-experiment.ts"
```

---

## Task 6: Benchmark article fixtures

**Files:**
- Create: `scripts/autoresearch/benchmarks/article-news.txt`
- Create: `scripts/autoresearch/benchmarks/article-narrative.txt`

- [ ] **Step 1: Create the benchmarks directory**

```bash
mkdir -p scripts/autoresearch/benchmarks
```

- [ ] **Step 2: Find and save a news/factual article**

Find a real news or science article of approximately 500 words. Good sources: BBC News, Reuters, AP News, The Verge, Ars Technica. Requirements:
- 450–600 words of body text
- At least 2 paragraphs with a subheading or topic shift
- No paywalled content
- Factual, third-person reporting style
- Copy the article body text only (no headlines, author names, or HTML) into `scripts/autoresearch/benchmarks/article-news.txt`

Verify length:

```bash
wc -w scripts/autoresearch/benchmarks/article-news.txt
```

Expected: 450–600 words.

- [ ] **Step 3: Find and save a narrative/opinion article**

Find a real opinion, essay, or narrative piece of approximately 500 words. Good sources: The Atlantic, The Guardian Opinion, Wired, Slate, personal essay publications. Requirements:
- 450–600 words
- First-person or strong editorial voice
- Varied sentence lengths (short punchy sentences mixed with longer ones)
- Emotional arc or a clear argument
- Copy body text only into `scripts/autoresearch/benchmarks/article-narrative.txt`

```bash
wc -w scripts/autoresearch/benchmarks/article-narrative.txt
```

Expected: 450–600 words.

- [ ] **Step 4: Commit**

```bash
git add scripts/autoresearch/benchmarks/
git commit -m "feat(autoresearch): add benchmark article fixtures (news + narrative)"
```

---

## Task 7: README and infra branch finalisation

**Files:**
- Create: `scripts/autoresearch/README.md`

- [ ] **Step 1: Write README.md**

Create `scripts/autoresearch/README.md`:

```markdown
# Autoresearch — TTS Instruction Optimiser

Autonomous hill-climbing loop that finds better `DEFAULT_TTS_INSTRUCTIONS` for the Hear It TTS pipeline.

## How it works

1. Claude Code (you, via `/loop`) proposes a new instruction candidate
2. `run-experiment.ts` generates TTS audio for 2 benchmark articles using OpenAI `gpt-4o-mini-tts`
3. Gemini 2.0 Flash listens to each MP3 and scores it on naturalness, pacing, engagement, clarity (1–10)
4. If the composite score beats the current best, Claude Code commits the improvement to `apps/api/src/tts.ts`
5. Repeat until $1.90 budget is exhausted

All results are logged to `results/log.tsv`.

## Setup

### 1. Install dependencies

```bash
cd scripts/autoresearch && npm install
```

### 2. Add API keys

Create `scripts/autoresearch/.env` with your keys. **Never paste keys into chat.** In Claude Code's terminal prompt, use the `!` prefix to run the command directly:

```
! echo "OPENAI_API_KEY=sk-..." >> scripts/autoresearch/.env
! echo "GOOGLE_AI_API_KEY=AI..." >> scripts/autoresearch/.env
```

Required keys:
- `OPENAI_API_KEY` — existing OpenAI key (also used by the API server)
- `GOOGLE_AI_API_KEY` — Google AI Studio key for Gemini 2.0 Flash ([get one free](https://aistudio.google.com/apikey))

### 3. Check out the experiment branch

```bash
git checkout autoresearch/2026-04-11
```

### 4. Run the tests

```bash
cd scripts/autoresearch && npm test
```

Expected: all tests pass.

## Running the loop

1. Open Claude Code
2. **Switch model to Haiku** (minimises subscription token usage — the proposer role is simple)
3. Make sure you are on branch `autoresearch/2026-04-11`
4. Type the following `/loop` command:

```
/loop Read scripts/autoresearch/results/log.tsv to understand the experiment history. If the file is empty or missing, run the baseline first. Propose one new DEFAULT_TTS_INSTRUCTIONS candidate (informed by the history), run `cd scripts/autoresearch && npx tsx run-experiment.ts --instruction "YOUR INSTRUCTION HERE"`, read the VERDICT from stdout, and if VERDICT is "improved" edit line 13-14 of apps/api/src/tts.ts to replace the DEFAULT_TTS_INSTRUCTIONS value with the new instruction and commit with message "autoresearch: improve TTS instructions (X.X → X.X)". Then schedule the next wakeup for 4 minutes.
```

5. The loop will self-pace at ~4 minute intervals. Press Escape to stop at any time.

## Manual single run

```bash
cd scripts/autoresearch
npx tsx run-experiment.ts --instruction "Read this article with natural, unhurried pacing. Pause briefly between paragraphs. Treat headings as natural topic transitions."
```

## Files

| File | Purpose |
|---|---|
| `run-experiment.ts` | CLI — one experiment end-to-end |
| `tts.ts` | OpenAI TTS MP3 generation |
| `judge.ts` | Gemini Flash audio scoring |
| `log.ts` | TSV log read/write, cost tracking |
| `benchmarks/article-news.txt` | Fixed news article fixture |
| `benchmarks/article-narrative.txt` | Fixed narrative article fixture |
| `results/log.tsv` | Experiment log (committed at end of run) |

## Budget

Hard stop at $1.90 of OpenAI TTS spend (~21 rounds at ~$0.09/round). The script refuses to start a new round once this limit is reached.
```

- [ ] **Step 2: Run the full test suite one final time**

```bash
cd scripts/autoresearch && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Final infra commit**

```bash
git add scripts/autoresearch/README.md
git commit -m "docs(autoresearch): add README with setup and loop instructions"
```

- [ ] **Step 4: Push the infra branch**

```bash
git push -u origin autoresearch-infra
```

---

## Task 8: Create the experiment branch

- [ ] **Step 1: Branch from autoresearch-infra**

```bash
git checkout -b autoresearch/2026-04-11
```

- [ ] **Step 2: Push the experiment branch**

```bash
git push -u origin autoresearch/2026-04-11
```

- [ ] **Step 3: Verify the env file exists (do not commit it)**

```bash
ls scripts/autoresearch/.env
```

If missing, create it now using the `!` prefix in Claude Code's prompt (see README Setup section — never paste keys into chat).

- [ ] **Step 4: Smoke test — run the baseline experiment**

This is the first real run. It will cost ~$0.09 in OpenAI credits and establish the baseline score.

```bash
cd scripts/autoresearch
npx tsx run-experiment.ts --instruction "Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries."
```

Expected stdout ends with something like:
```
--- RESULT ---
ROUND: 1
COMPOSITE: 6.80
VERDICT: baseline
SPEND: $0.090
INSTRUCTION: Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries.
BUDGET_REMAINING: $1.810
```

Verify `results/log.tsv` was created and contains one data row.

- [ ] **Step 5: Commit the baseline log**

```bash
git add scripts/autoresearch/results/log.tsv
git commit -m "autoresearch: establish baseline TTS instruction score"
```

The loop is now ready. Follow the `/loop` instructions in the README to start tonight's run.
```
