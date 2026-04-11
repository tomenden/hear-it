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
