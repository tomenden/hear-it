import { countWords } from "./extractor.js";
import type {
  AudioRenderResult,
  ExtractedArticle,
  SpeechOptions,
} from "./types.js";
import type { AudioStore } from "./storage.js";

const OPENAI_API_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_INSTRUCTIONS =
  "Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries.";

export const AVAILABLE_VOICES = ["alloy", "ash", "sage", "verse"] as const;
export const VOICE_PREVIEW_TEXT =
  "This is Hear It. I turn articles into clear, natural audio you can listen to on the move.";

export interface SpeechSynthesisContext {
  audioStore?: AudioStore;
  /** Path-like key for the audio file, e.g. "voice-preview--alloy.mp3" */
  fileKey?: string;
}

export interface SpeechProvider {
  readonly name: string;
  synthesizeText(
    text: string,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult>;
  synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult>;
}

export const DEFAULT_SPEECH_OPTIONS: SpeechOptions = {
  voice: "alloy",
};

export class FakeSpeechProvider implements SpeechProvider {
  readonly name = "fake";

  async synthesizeText(
    text: string,
    _speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const audioData = Buffer.from("fake-audio");
    const durationSeconds = Math.max(15, Math.ceil(countWords(text) / 2.7));
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, audioData, "audio/mpeg")
        : null;

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds }] : [],
      durationSeconds,
      audioData,
      contentType: "audio/mpeg",
    };
  }

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }
}

export class OpenAISpeechProvider implements SpeechProvider {
  readonly name = "openai";

  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENAI_TTS_MODEL || DEFAULT_OPENAI_MODEL,
  ) {}

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    text: string,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        voice: speechOptions.voice,
        input: text,
        instructions: DEFAULT_TTS_INSTRUCTIONS,
        response_format: "mp3",
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI speech generation failed: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, buffer, "audio/mpeg")
        : null;

    const durationSeconds = estimateDurationSeconds(text);

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds }] : [],
      durationSeconds,
      audioData: buffer,
      contentType: "audio/mpeg",
    };
  }
}

export function createSpeechProvider(): SpeechProvider {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (apiKey) {
    return new OpenAISpeechProvider(apiKey);
  }

  return new FakeSpeechProvider();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function estimateDurationSeconds(text: string): number {
  return Math.max(1, Math.ceil(countWords(text) / 2.7));
}

export function buildAudioFileKey(
  titleOrUrl: string,
  voice: string,
  uniqueSuffix?: string,
): string {
  const base = `${slugify(titleOrUrl)}--${voice}`;
  const stem = uniqueSuffix ? `${base}--${slugify(uniqueSuffix)}` : base;
  return `${stem}.mp3`;
}
