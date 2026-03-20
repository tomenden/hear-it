# Hear It — TTS Prompt Autoresearch

## Mission

Optimize the `DEFAULT_TTS_INSTRUCTIONS` constant in `apps/api/src/tts.ts` to produce
the most natural, engaging, and clear audio narration of web articles via OpenAI TTS.

## What you are optimizing

One string constant in `apps/api/src/tts.ts`:

```ts
const DEFAULT_TTS_INSTRUCTIONS = "...";
```

**Current baseline:**

```
"Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries."
```

The metric is a **composite quality score out of 10** (higher is better), averaged across
three benchmark article types (technical, news, narrative). It is evaluated by an LLM
judge that rates each (instructions, article) pair on naturalness, pacing, engagement,
and clarity.

## Branch setup

Work on branch `autoresearch/YYYY-MM-DD`. Create it from the current branch:

```bash
git checkout -b autoresearch/$(date +%Y-%m-%d)
```

Before making any changes, run the experiment once to record a baseline:

```bash
cd apps/api && npx tsx ../../scripts/autoresearch/experiment.ts
```

The script will print `autoresearch_score:X.XXXX` and append a row to
`scripts/autoresearch/results.tsv`. Commit this initial state:

```bash
git add scripts/autoresearch/results.tsv
git commit -m "autoresearch: record baseline"
```

## The core loop

1. Read `scripts/autoresearch/results.tsv` to understand what has been tried and scored.
2. Propose a new value for `DEFAULT_TTS_INSTRUCTIONS` based on your analysis.
3. Edit `apps/api/src/tts.ts` — change only that one string.
4. Run the experiment:
   ```bash
   cd apps/api && npx tsx ../../scripts/autoresearch/experiment.ts
   ```
5. Parse the `autoresearch_score:X.XXXX` line in the output.
6. **If score improved** (strictly higher than best so far):
   ```bash
   git add apps/api/src/tts.ts scripts/autoresearch/results.tsv
   git commit -m "autoresearch: <brief description of change> (score: X.XX)"
   ```
7. **If score did not improve** (equal or worse):
   ```bash
   git checkout apps/api/src/tts.ts
   # still save the result row — it was already appended
   git add scripts/autoresearch/results.tsv
   git commit -m "autoresearch: try <brief description>, reverted (score: X.XX)"
   ```
8. Go to step 1.

## Ideas to explore

### Specificity of tone
- Vague: "natural, engaging tone"
- Specific: "warm, measured tone — as if a knowledgeable friend is explaining a topic"
- Very specific: mention sentence-level pausing, breath patterns, conversational register

### Pacing guidance
- Explicit instruction to slow down at complex technical terms
- Instruction to maintain steady pace through enumerated lists
- Guidance on handling parenthetical asides vs main sentences

### Content-type awareness
- The prompt can acknowledge the article is non-fiction
- Mention that headings should be treated as section markers with a slight pause
- Guide the voice to treat quoted text differently from narrative text

### Delivery style
- "Podcast host" style vs "audiobook narrator" style vs "news anchor" style
- First-person vs second-person framing of the instructions
- Instructions about where to add subtle emphasis

### What NOT to do
- Avoid robotic, monotone delivery
- Avoid theatrical over-expression
- Avoid rushing through complex sentences

### Advanced approaches
- Multi-sentence instructions covering different aspects separately
- Instructions with examples ("treat headings like: [pause] Section title. [pause]")
- Negative instructions ("do not speed up at list items")
- Instructions targeting the specific weakness you saw in the results (check results.tsv!)

## Constraints — do NOT touch these

- The structure of `tts.ts` beyond `DEFAULT_TTS_INSTRUCTIONS`
- The model name, voice options, timeout, or any other API parameters
- Any file outside `apps/api/src/tts.ts` (besides appending to results.tsv)
- The experiment script or benchmark data

## Reading results.tsv

The columns are:

```
experiment_id   timestamp   composite_score   instructions_preview
```

- `composite_score` is 0–10, higher is better.
- `instructions_preview` is the first 80 chars of the instructions string tested.
- Look for patterns: which kinds of changes improved score? Which regressed?
- If you see a cluster of improvements, go deeper in that direction.
- If a direction hits a plateau after 3–4 attempts, pivot to a different approach.

## NEVER STOP

Once the experiment loop has started, **never** pause to ask whether to continue.
The human may be asleep. Run experiments continuously until manually stopped.

If you run out of obvious ideas:
- Re-read `results.tsv` carefully for patterns you missed
- Try combining two near-miss approaches into one prompt
- Try the opposite direction from a failed experiment (sometimes failure is a signal)
- Think about what professional audiobook or podcast producers tell narrators
- Try shorter, more imperative instructions
- Try longer, more descriptive instructions

The loop runs until the human interrupts it. Keep going.
