# Autoresearch: Autonomous TTS Instruction Optimisation

**Date:** 2026-04-11  
**Status:** Approved  
**Branch strategy:** `autoresearch-infra` (harness) → `autoresearch/2026-04-11` (run)

---

## Goal

Autonomously search for a better `DEFAULT_TTS_INSTRUCTIONS` string in `apps/api/src/tts.ts` by running a hill-climbing loop overnight. Each iteration proposes a candidate instruction, generates real TTS audio, judges the audio with a multimodal LLM, and commits improvements to the experiment branch.

---

## Constraints

- **No production auto-merge.** All work stays on feature branches.
- **OpenAI budget: $2.** Hard-capped. The script stops when cumulative spend reaches $1.90 (leaving a $0.10 buffer).
- **No Anthropic API key.** The proposer is Claude Code itself (user's subscription), invoked via `/loop`.
- **Gemini judge is free.** Uses Google AI free tier (1,500 req/day, 15 RPM).

---

## Optimisation Target

**One variable:** `DEFAULT_TTS_INSTRUCTIONS` in `apps/api/src/tts.ts` (line 13–14).

Current value:
```
"Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries."
```

Everything else (voice, model, chunking, speech-script transformations) is held constant.

---

## Architecture

The harness lives in `scripts/autoresearch/`. It is TypeScript, runnable with `npx tsx`.

### Components

#### `scripts/autoresearch/run-experiment.ts`
CLI script. Takes `--instruction "..."` as argument. Runs one full experiment:
1. Loads both benchmark articles from `scripts/autoresearch/benchmarks/`
2. Calls OpenAI `gpt-4o-mini-tts` with the given instruction for each article → writes MP3 to a temp dir
3. Sends each MP3 to Gemini 2.0 Flash with the scoring rubric → receives JSON scores
4. Computes composite score (average of 4 dimensions)
5. Appends one row to `scripts/autoresearch/results/log.tsv`
6. Prints composite score to stdout
7. Exits 0 on success, non-zero on error

#### `scripts/autoresearch/benchmarks/`
Two fixed article fixtures, committed on the infra branch:
- `article-news.txt` — ~500-word news/factual article
- `article-narrative.txt` — ~500-word narrative/opinion article

Selected once by a human. Never regenerated. This ensures all experiments are comparable.

#### `scripts/autoresearch/results/log.tsv`
Tab-separated log of every experiment. One row per run. Columns:

| Column | Description |
|---|---|
| `timestamp` | ISO 8601 |
| `round` | Integer, incrementing |
| `instruction` | The full instruction string tested |
| `naturalness` | Gemini score 1–10 |
| `pacing` | Gemini score 1–10 |
| `engagement` | Gemini score 1–10 |
| `clarity` | Gemini score 1–10 |
| `composite` | Average of the 4 dimensions |
| `verdict` | `improved` / `rejected` / `error` |
| `spend_usd` | Cumulative OpenAI spend at time of this row |

The log is the single source of truth. The loop is fully restartable from it.

#### Claude Code (`/loop`) — the proposer and orchestrator
Not a script. Claude Code itself, running on the user's subscription, acts as the proposer and loop controller. Each iteration:

1. Reads `log.tsv` to understand full history (current best, rejected candidates, score trends)
2. Proposes 1 new instruction candidate with brief reasoning
3. Shells out: `npx tsx scripts/autoresearch/run-experiment.ts --instruction "..."`
4. Reads composite score from stdout
5. If `composite > currentBest`: edits `apps/api/src/tts.ts`, commits with message `autoresearch: improve TTS instructions (X.X → X.X)`
6. Schedules next wakeup (~3–5 min) via `ScheduleWakeup`
7. Stops when log shows `spend_usd >= 1.90` or user interrupts

---

## Scoring Rubric (sent to Gemini Flash)

```
You are evaluating a text-to-speech audio recording of a news/opinion article.
Score the audio on each dimension from 1 to 10:

- naturalness: Does the speech sound human and uncontrived?
- pacing: Is the rhythm appropriate — neither rushed nor plodding? Are sentence boundaries clean?
- engagement: Is the delivery compelling enough to hold attention for a long article?
- clarity: Is every word easy to understand? Is emphasis placed appropriately?

Return only valid JSON: {"naturalness": N, "pacing": N, "engagement": N, "clarity": N}
```

Composite = (naturalness + pacing + engagement + clarity) / 4

An improvement is recorded only when `composite > currentBest.composite`.

---

## Cost Tracking

OpenAI TTS pricing: ~$0.015 per 1,000 characters (`gpt-4o-mini-tts`).

Per round (2 articles × ~500 words ≈ 6,000 chars): ~$0.09.  
At $1.90 hard stop: ~21 rounds maximum.  
Expected run time at 3–5 min/round: **1–2 hours**.

The script tracks cumulative spend and refuses to start a new round if `spend_usd >= 1.90`.

---

## Branch & Commit Strategy

### `autoresearch-infra`
Contains:
- `scripts/autoresearch/run-experiment.ts`
- `scripts/autoresearch/benchmarks/article-news.txt`
- `scripts/autoresearch/benchmarks/article-narrative.txt`
- `scripts/autoresearch/results/.gitkeep` (empty results dir)
- `scripts/autoresearch/package.json` (deps: openai, @google/generative-ai)
- `scripts/autoresearch/README.md` (setup + usage instructions)
- `scripts/autoresearch/.env.example`

Does **not** touch `apps/api/src/tts.ts`.

### `autoresearch/2026-04-11`
Branched from `autoresearch-infra`. During the run:
- Each improvement: commits `apps/api/src/tts.ts` with `autoresearch: improve TTS instructions (X.X → X.X)`
- End of run: commits the full `log.tsv`

No auto-merge to `master`.

---

## Setup Instructions (for README)

### Prerequisites
1. Repo cloned, on branch `autoresearch/2026-04-11`
2. `cd scripts/autoresearch && npm install`
3. Add `GOOGLE_AI_API_KEY` to your local env:
   ```
   ! echo "GOOGLE_AI_API_KEY=your-key-here" >> apps/api/.env
   ```
   (Run this in Claude Code's terminal prompt using `!` prefix — key never enters chat history)

### Running the loop
1. Open Claude Code
2. **Use Sonnet or a stronger reasoning model for proposing candidates** (top of screen — the proposer role needs better judgment than a cheap baseline model)
3. Ensure you are on branch `autoresearch/2026-04-11`
4. Type `/loop` in the prompt
5. Claude will self-pace, running one experiment every ~3–5 minutes
6. To stop: press Escape or wait for budget exhaustion

### What to expect
- First round tests the baseline (current instruction) to establish a reference score
- Subsequent rounds propose variants informed by all previous results
- Each improvement is committed immediately; you can inspect `git log` at any time
- Final `log.tsv` committed at end of run

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | `apps/api/.env` | TTS generation (existing) |
| `GOOGLE_AI_API_KEY` | `apps/api/.env` | Gemini Flash judge (new) |

`ANTHROPIC_API_KEY` is **not required** — the proposer runs as Claude Code.

---

## Files Not Modified

- `apps/api/src/speech-script.ts` — out of scope for this run
- `apps/api/src/text-chunker.ts` — out of scope
- Any iOS or infrastructure files
