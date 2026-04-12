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

## Documenting Experiments

After each experiment run, archive results in `experiments/` with a date-based folder:

```
experiments/
├── 2026-04-11-tts-optimization/
│   ├── RESULTS.md          # Experiment summary, key findings, iteration insights
│   ├── log.tsv             # Copy of results/log.tsv from the run
│   └── analysis.json       # Optional: structured results for programmatic access
├── 2026-05-15-engagement-focus/
│   ├── RESULTS.md
│   └── log.tsv
```

### RESULTS.md Template

Each `RESULTS.md` should include:

```markdown
# Experiment: [Title]

**Date:** YYYY-MM-DD  
**Objective:** [What we were trying to optimize]

## Summary
- Baseline score: X.XX
- Best score: Y.YY
- Improvement: +Z% (or rejection if no improvement)
- Budget spent: $X / $Y

## Best Instruction (if improved)
\`\`\`
[The winning instruction text]
\`\`\`

## Results Table
| Round | Instruction | Scores | Composite | Verdict |
| ... |

## Key Findings
- Finding 1
- Finding 2

## Iteration Insights
- What worked: ...
- What didn't: ...
```

### Archive Steps

1. After the loop completes, copy `results/log.tsv` to `experiments/YYYY-MM-DD-experiment-name/log.tsv`
2. Create `experiments/YYYY-MM-DD-experiment-name/RESULTS.md` with summary
3. Commit to a PR with title: `docs(autoresearch): archive YYYY-MM-DD experiment results`
4. This serves as a historical record to avoid repeating failed approaches

This prevents duplicating experiments and builds institutional knowledge about what instruction patterns work vs. don't.
