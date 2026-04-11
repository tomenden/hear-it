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
