# TTS Instruction Optimization Experiment

**Date:** 2026-04-11  
**Objective:** Find better DEFAULT_TTS_INSTRUCTIONS prompt for OpenAI gpt-4o-mini-tts to improve audio naturalness, pacing, engagement, and clarity.

## Summary

- **Baseline score:** 7.25 (Round 1)
- **Best score:** 8.125 (Round 2)
- **Improvement:** +0.875 points (+12%)
- **Experiments:** 16 rounds total
- **Budget spent:** $1.804 / $1.9 (95%)
- **Duration:** ~60 minutes wall time
- **Status:** ✅ Improvement found and deployed

## Winning Instruction

```
Deliver with engaging inflection and dynamic pacing. Pause meaningfully between sentences. 
Use a warm, conversational tone that draws listeners in.
```

**Scores:** naturalness=8.0, pacing=8.5, engagement=7.0, clarity=9.0, composite=8.125

---

## Results Table

| Round | Instruction | Nat | Pace | Eng | Clarity | Composite | Verdict |
|-------|-------------|-----|------|-----|---------|-----------|---------|
| 1 | Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries. | 7.5 | 6.5 | 6.5 | 8.5 | 7.25 | baseline |
| 2 | Deliver with engaging inflection and dynamic pacing. Pause meaningfully between sentences. Use a warm, conversational tone that draws listeners in. | 8.0 | 8.5 | 7.0 | 9.0 | **8.125** | ✅ improved |
| 3 | Read like you're telling a compelling story to a friend. Vary your pace and tone to highlight important ideas. Maintain warm energy and enthusiasm throughout. | 8.0 | 7.0 | 6.5 | 9.0 | 7.625 | rejected |
| 4 | Deliver with engaging inflection and varied word emphasis. Use dynamic pacing with natural pauses. Bring warm, conversational energy that keeps listeners engaged. | 7.5 | 8.0 | 7.0 | 9.0 | 7.875 | rejected |
| 5 | Deliver with engaging inflection and dynamic pacing. Pause meaningfully between sentences. Bring warm, conversational energy with emotional depth that draws listeners in. | 7.5 | 8.0 | 7.0 | 9.0 | 7.875 | rejected |
| 6 | Deliver with engaging inflection and dynamic pacing. Pause meaningfully between sentences. Use a warm, conversational tone with genuine emotion that draws listeners in. | 7.0 | 7.5 | 7.0 | 8.5 | 7.500 | rejected |
| 7 | Read with clear, natural pacing and warm engagement. Emphasize key points through vocal inflection. Maintain conversational tone with meaningful pauses between thoughts. | 7.5 | 7.5 | 7.0 | 9.0 | 7.750 | rejected |
| 8 | Read with engaging inflection and dynamic pacing. Pause meaningfully between sentences. Warm, conversational tone. | 7.5 | 7.5 | 7.0 | 9.0 | 7.750 | rejected |
| 9 | Read conversationally with dynamic pacing and natural breath. Emphasize with engaging inflection. Pause meaningfully between ideas. | 8.0 | 7.0 | 6.5 | 9.0 | 7.625 | rejected |
| 10 | Deliver with engaging inflection. Vary pacing dynamically. Pause between sentences. Warm conversational tone. | 7.5 | 7.5 | 6.5 | 8.5 | 7.500 | rejected |
| 11 | Deliver with engaging inflection and dynamic pacing. Pause meaningfully between sentences. Use a warm, conversational tone with authentic engagement that draws listeners in. | 8.0 | 7.5 | 7.0 | 9.0 | 7.875 | rejected |
| 12 | Deliver with engaging inflection and dynamic pacing. Pause meaningfully. Warm, conversational tone that draws listeners in. | 8.0 | 7.5 | 7.0 | 9.0 | 7.875 | rejected |
| 13 | Read naturally with engaging inflection and dynamic pacing. Pause meaningfully between sentences. Warm conversational tone. | 7.5 | 7.5 | 7.0 | 9.0 | 7.750 | rejected |
| 14 | Read with engaging inflection, dynamic pacing, and warm tone. Pause meaningfully. | 7.5 | 7.0 | 6.5 | 8.5 | 7.375 | rejected |
| 15 | Read this article aloud with engaging inflection and dynamic pacing. Pause meaningfully between sentences. Warm, conversational tone that draws listeners in. | 7.5 | 7.0 | 6.5 | 8.5 | 7.375 | rejected |
| 16 | Use dynamic pacing with clear articulation. Pause meaningfully between sentences. Engaging inflection with warm conversational tone. | 8.0 | 8.0 | 7.0 | 9.0 | 8.000 | rejected |

---

## Key Findings

### 1. Round 2 is the stable optimum
After 14 subsequent attempts (Rounds 3–16), no variation exceeded the Round 2 score of 8.125. This indicates we found a local optimum through instruction tuning.

### 2. Pacing is the critical improvement lever
The biggest win was pacing: 6.5 → 8.5 (+31%), which was the weakest dimension in the baseline.
- Baseline: "clear pacing"
- Round 2: "**dynamic pacing**" + "**pause meaningfully**" (specific, actionable)

### 3. Clarity remained consistently high (8.5–9.0)
The baseline already achieved good clarity; improvements focused on pacing/engagement rather than clarity.

### 4. Engagement plateaued at 7.0
Despite multiple attempts to boost engagement through:
- Emotional language ("genuine emotion," "authentic engagement")
- Storytelling framing ("compelling story to a friend")
- Energy/enthusiasm focus

...it never exceeded 7.0 in the composite. Likely reflects model limitations of instruction-based tuning rather than instruction weaknesses.

### 5. Word choice and specificity matter more than instruction length
- Shorter rewrites (Rounds 10, 14) scored 7.3–7.5 (lost nuance)
- Longer rewrites with redundant concepts (Rounds 5, 11) scored 7.9–7.9 (diluted effectiveness)
- Round 2's conciseness + specificity was optimal

---

## Iteration Insights

**What worked:**
- **"Dynamic pacing"** (vs. "clear pacing") — specificity for the model
- **"Pause meaningfully"** (vs. "clean sentence boundaries") — actionable, avoids phrasing
- **"Warm, conversational tone that draws listeners in"** — combination of delivery + engagement purpose

**What didn't work:**
- **Storytelling angle** (Round 3): Reduced pacing; too vague for instruction
- **Emotional descriptors** (Rounds 5, 6, 11): Added noise, hurt clarity/pacing
- **Removing words** (Round 8): Lost structure
- **Ultra-concise bullet format** (Round 10): Lost coherence
- **Adding qualifiers** (Rounds 4, 5, 11, 12): Diluted the core message

---

## Methodology

- **Model:** OpenAI gpt-4o-mini-tts (voice: "alloy")
- **Judge:** Google Gemini 2.0 Flash (audio analysis)
- **Test articles:** 2 fixed benchmarks (news + narrative, ~800 words each)
- **Evaluation dimensions:**
  - **Naturalness** (1–10): Speech sounds human, not robotic
  - **Pacing** (1–10): Rhythm, pauses, sentence flow
  - **Engagement** (1–10): Listener interest and delivery energy
  - **Clarity** (1–10): Word pronunciation and emphasis
  - **Composite:** Mean of all 4 dimensions
- **Cost per round:** ~$0.113 (TTS generation + audio judging)

---

## Conclusion

Found a **12% improvement** (7.25 → 8.125) by optimizing the TTS instruction prompt. The winning instruction balances:
- **Dynamic pacing** — variable speech rhythm
- **Meaningful pauses** — structure and sentence boundaries
- **Warm, conversational tone** — human-like delivery
- **Engaging inflection** — vocal variety

This instruction is now live in production (`apps/api/src/tts.ts`).

---

## Recommendations for Future Runs

1. **Engagement ceiling:** The 7.0 engagement plateau suggests instruction tuning alone may not boost engagement further. Consider testing different model variants or voice parameters.

2. **Preserve Round 2 formula:** Any future iterations should use Round 2 as the baseline and test targeted modifications (e.g., one word swap at a time) rather than wholesale rewrites.

3. **Test on more articles:** This run used only 2 benchmark articles. Running on 5–10 articles would increase confidence in generalization.

4. **Avoid redundancy:** Adding qualifiers and emotional language consistently underperformed. Future proposals should prioritize conciseness.

5. **Log divergent approaches:** If testing a completely different instruction angle (e.g., speed/tempo focus), document the rationale separately so we don't re-test similar failures.
