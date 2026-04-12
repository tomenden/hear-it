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
