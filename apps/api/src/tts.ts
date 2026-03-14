import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AudioRenderResult,
  AudioSegment,
  ExtractedArticle,
  SpeechOptions,
} from "./types.js";

const OPENAI_API_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_INSTRUCTIONS =
  "Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries.";

export const AVAILABLE_VOICES = ["alloy", "ash", "sage", "verse"] as const;
export const VOICE_PREVIEW_TEXT =
  "This is Hear It. I turn articles into clear, natural audio you can listen to on the move.";

export interface SpeechSynthesisContext {
  outputDir: string;
  publicBaseUrl: string;
  fileStem: string;
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
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const fileName = `${context.fileStem}.mp3`;
    const audioUrl = toPublicUrl(context.publicBaseUrl, fileName);
    const durationSeconds = Math.max(15, Math.ceil(countWords(text) / 2.7));

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: [
        {
          url: audioUrl,
          durationSeconds,
        },
      ],
      durationSeconds,
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
    await mkdir(context.outputDir, { recursive: true });
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

    const fileName = `${context.fileStem}.mp3`;
    const filePath = join(context.outputDir, fileName);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(filePath, buffer);

    const durationSeconds = estimateDurationSeconds(text);
    const audioUrl = toPublicUrl(context.publicBaseUrl, fileName);

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: [
        {
          url: audioUrl,
          durationSeconds,
        },
      ],
      durationSeconds,
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

function toPublicUrl(baseUrl: string, fileName: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBaseUrl}/${fileName}`;
}

function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

export function buildAudioFileStem(
  titleOrUrl: string,
  voice: string,
  uniqueSuffix?: string,
): string {
  const base = `${slugify(titleOrUrl)}--${voice}`;
  return uniqueSuffix ? `${base}--${slugify(uniqueSuffix)}` : base;
}
