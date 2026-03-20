/**
 * Autoresearch experiment runner for Hear It TTS prompt optimization.
 *
 * Evaluates the current DEFAULT_TTS_INSTRUCTIONS in apps/api/src/tts.ts by
 * asking an LLM judge to rate the instructions across three benchmark article
 * types on four quality dimensions: naturalness, pacing, engagement, clarity.
 *
 * Usage (from repo root):
 *   cd apps/api && npx tsx ../../scripts/autoresearch/experiment.ts
 *
 * Requires:
 *   ANTHROPIC_API_KEY  — Claude API key for the LLM judge
 *
 * Outputs:
 *   - Progress logs to stdout
 *   - A row appended to scripts/autoresearch/results.tsv
 *   - Final line: autoresearch_score:X.XXXX  (for the agent to parse)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const TTS_FILE = path.join(REPO_ROOT, "apps/api/src/tts.ts");
const RESULTS_FILE = path.join(__dirname, "results.tsv");
const RESULTS_HEADER = "experiment_id\ttimestamp\tcomposite_score\tinstructions_preview\n";

// ---------------------------------------------------------------------------
// Benchmark corpus — three article types Hear It commonly serves
// ---------------------------------------------------------------------------

const BENCHMARK_SNIPPETS = [
  {
    id: "technical",
    label: "Technical / science article",
    text: `The transformer architecture, introduced in 2017, revolutionized natural language processing. At its core, transformers use a self-attention mechanism that weighs the relevance of every token against every other token in a sequence simultaneously—enabling far richer contextual understanding than the step-by-step processing of recurrent networks. This parallelism also made transformers dramatically faster to train on modern GPUs. The architecture has since underpinned virtually every major language model, from BERT and GPT to the multimodal systems that can reason across text, images, and audio. One continuing challenge is the quadratic memory cost of full self-attention as sequence length grows, which has spurred research into sparse attention variants and linear approximations.`,
  },
  {
    id: "news",
    label: "Breaking news article",
    text: `Scientists announced a significant breakthrough in battery technology this week, claiming their new lithium-sulfur cells can store up to five times the energy of conventional lithium-ion batteries of the same weight. The research team developed a novel polymer coating for the sulfur cathode that dramatically slows the "polysulfide shuttle" reaction—a degradation mechanism that has long prevented lithium-sulfur batteries from surviving more than a few hundred charge cycles. In laboratory tests, the new cells retained over 80 percent of their original capacity after 1,000 cycles. Independent experts called the results promising but said large-scale manufacturing and cost challenges remain before the technology could appear in electric vehicles or grid-storage systems.`,
  },
  {
    id: "narrative",
    label: "Longform narrative / opinion",
    text: `Walking through the old quarter at dusk, she noticed how the fading light transformed the familiar into something almost luminous. The bakery that had operated since 1923, the pharmacy with its original glass cabinets, the small bookshop whose owner could recommend the perfect title for any mood—these places existed outside the ordinary flow of commerce, sustained by something harder to quantify than profit. She had lived here for eleven years, but only now, on the brink of leaving, did the neighbourhood feel fully hers. There is a particular tenderness reserved for things you are about to lose, a sharpness of attention that ordinary life rarely demands. She had come to think of this as one of loss's few gifts.`,
  },
] as const;

// ---------------------------------------------------------------------------
// Extract current instructions from tts.ts
// ---------------------------------------------------------------------------

function extractCurrentInstructions(): string {
  const source = fs.readFileSync(TTS_FILE, "utf-8");

  // Match both single-line and potentially multi-line string declarations
  const match =
    source.match(/const DEFAULT_TTS_INSTRUCTIONS\s*=\s*"([^"\\]*(?:\\.[^"\\]*)*)"/s) ??
    source.match(/const DEFAULT_TTS_INSTRUCTIONS\s*=\s*`([^`]*)`/s);

  if (!match) {
    throw new Error(
      `Could not find DEFAULT_TTS_INSTRUCTIONS in ${TTS_FILE}.\n` +
        `Make sure the constant is defined as:\n` +
        `  const DEFAULT_TTS_INSTRUCTIONS = "..."`,
    );
  }

  return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
}

// ---------------------------------------------------------------------------
// LLM judge — evaluates (instructions, article) pair on four quality axes
// ---------------------------------------------------------------------------

interface DimensionScores {
  naturalness: number; // 1–10: will the speech sound human and uncontrived?
  pacing: number; // 1–10: will the delivery have appropriate rhythm and pauses?
  engagement: number; // 1–10: will listeners want to keep listening?
  clarity: number; // 1–10: will the speech be easy to follow and understand?
}

interface SnippetEvaluation {
  snippetId: string;
  scores: DimensionScores;
  average: number;
}

async function evaluateSnippet(
  instructions: string,
  snippet: (typeof BENCHMARK_SNIPPETS)[number],
  apiKey: string,
): Promise<SnippetEvaluation> {
  const systemPrompt = `You are an expert in text-to-speech (TTS) system design, voice acting direction, and audio production quality. You evaluate TTS instruction prompts by reasoning about the acoustic and perceptual qualities they would produce.`;

  const userPrompt = `A TTS system will read the following article excerpt aloud. The model receives two inputs: the article text, and a set of instructions that shape how it should deliver the narration.

INSTRUCTIONS (what the TTS model is told):
"${instructions}"

ARTICLE EXCERPT (${snippet.label}):
${snippet.text}

Rate the quality of these TTS instructions for this article type on four dimensions (each 1–10):

- naturalness: Will the speech sound human and uncontrived, avoiding robotic or overly theatrical delivery?
- pacing: Will the delivery have appropriate rhythm, sentence-level pausing, and reading speed?
- engagement: Will listeners find it compelling enough to keep listening through a long article?
- clarity: Will the speech be easy to follow, with appropriate emphasis on key ideas?

Consider: specificity of the instructions, alignment with the article type, what the model would likely do with ambiguous guidance, and any anti-patterns that could lead to poor delivery.

Respond ONLY with a JSON object — no explanation, no markdown:
{"naturalness": N, "pacing": N, "engagement": N, "clarity": N}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content.find((c) => c.type === "text")?.text ?? "{}";

  let scores: Partial<DimensionScores>;
  try {
    const jsonMatch = text.match(/\{[^}]+\}/);
    scores = jsonMatch ? (JSON.parse(jsonMatch[0]) as Partial<DimensionScores>) : {};
  } catch {
    console.warn(`  Warning: could not parse scores for ${snippet.id}, defaulting to 5`);
    scores = {};
  }

  const naturalness = clamp(scores.naturalness ?? 5, 1, 10);
  const pacing = clamp(scores.pacing ?? 5, 1, 10);
  const engagement = clamp(scores.engagement ?? 5, 1, 10);
  const clarity = clamp(scores.clarity ?? 5, 1, 10);
  const average = (naturalness + pacing + engagement + clarity) / 4;

  return {
    snippetId: snippet.id,
    scores: { naturalness, pacing, engagement, clarity },
    average,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Main experiment run
// ---------------------------------------------------------------------------

async function runExperiment(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required.");
  }

  const instructions = extractCurrentInstructions();
  const preview = instructions.slice(0, 80).replace(/\t/g, " ").replace(/\n/g, " ");

  console.log("=".repeat(60));
  console.log("Hear It TTS Autoresearch — Experiment");
  console.log("=".repeat(60));
  console.log(`Instructions: "${preview}${instructions.length > 80 ? "…" : ""}"`);
  console.log(`Evaluating ${BENCHMARK_SNIPPETS.length} benchmark snippets...`);
  console.log();

  const evaluations: SnippetEvaluation[] = [];

  for (const snippet of BENCHMARK_SNIPPETS) {
    process.stdout.write(`  [${snippet.id}] ${snippet.label}... `);
    const evaluation = await evaluateSnippet(instructions, snippet, apiKey);
    evaluations.push(evaluation);
    const { naturalness, pacing, engagement, clarity } = evaluation.scores;
    console.log(
      `avg=${evaluation.average.toFixed(2)} ` +
        `(nat=${naturalness} pac=${pacing} eng=${engagement} cla=${clarity})`,
    );
  }

  const composite = evaluations.reduce((sum, e) => sum + e.average, 0) / evaluations.length;

  console.log();
  console.log(`Composite score: ${composite.toFixed(4)} / 10`);

  // Append result to TSV
  if (!fs.existsSync(RESULTS_FILE)) {
    fs.writeFileSync(RESULTS_FILE, RESULTS_HEADER);
  }

  const experimentId = Date.now().toString();
  const timestamp = new Date().toISOString();
  const row = `${experimentId}\t${timestamp}\t${composite.toFixed(4)}\t${preview}\n`;
  fs.appendFileSync(RESULTS_FILE, row);

  console.log(`Result appended to results.tsv`);
  console.log();

  // Agent-parseable output — must be last meaningful line
  console.log(`autoresearch_score:${composite.toFixed(4)}`);
}

runExperiment().catch((err) => {
  console.error("Experiment failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
