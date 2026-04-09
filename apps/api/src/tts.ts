import { countWords } from "./extractor.js";
import type {
  AudioRenderResult,
  ExtractedArticle,
  PackagerChunkMedia,
  SpeechOptions,
} from "./types.js";
import type { AudioStore } from "./storage.js";

const OPENAI_API_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENAI_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_INSTRUCTIONS =
  "Read this article aloud in a natural, engaging tone with clear pacing and clean sentence boundaries.";

export const AVAILABLE_VOICES = ["alloy", "ash", "sage", "verse"] as const;
export const VOICE_PREVIEW_TEXT =
  "This is Hear It. I turn articles into clear, natural audio you can listen to on the move.";
const DEFAULT_CHUNK_SAMPLE_RATE_HZ = 44_100;
const DEFAULT_CHUNK_CHANNEL_COUNT = 1;

export class OpenAITTSTimeoutError extends Error {
  readonly code = "tts_timeout";

  constructor(
    readonly details: {
      timeoutMs: number;
      voice: string;
      textLength: number;
    },
  ) {
    super("OpenAI speech generation timed out.");
    this.name = "OpenAITTSTimeoutError";
  }
}

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
      chunkMedia: buildChunkMedia(audioData, durationSeconds),
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
    const timeoutMs = Number(process.env.OPENAI_TTS_TIMEOUT_MS ?? DEFAULT_OPENAI_TTS_TIMEOUT_MS);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);

    let response: Response;
    try {
      response = await fetch(OPENAI_API_URL, {
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
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new OpenAITTSTimeoutError({
          timeoutMs,
          voice: speechOptions.voice,
          textLength: text.length,
        });
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json() as { error?: { message?: string; code?: string; type?: string } };
        detail = body.error?.message ?? JSON.stringify(body);
      } catch {
        detail = await response.text().catch(() => "");
      }
      throw new Error(
        `OpenAI speech generation failed: ${response.status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, buffer, "audio/mpeg")
        : null;

    const mp3Inspection = inspectMP3Audio(buffer);
    const durationSeconds = mp3Inspection?.durationSeconds ?? estimateDurationSeconds(text);

    return {
      audioUrl,
      playlistUrl: null,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds }] : [],
      durationSeconds,
      audioData: buffer,
      contentType: "audio/mpeg",
      chunkMedia: buildChunkMedia(buffer, durationSeconds, mp3Inspection),
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

type MPEGVersion = "1" | "2" | "2.5";
type MPEGLayer = "1" | "2" | "3";

type MP3FrameInfo = {
  frameLength: number;
  sampleRate: number;
  samplesPerFrame: number;
  channelCount: number;
};

const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000] as const;
const MPEG2_SAMPLE_RATES = [22_050, 24_000, 16_000] as const;
const MPEG25_SAMPLE_RATES = [11_025, 12_000, 8_000] as const;

const BITRATE_TABLE = {
  "1": {
    "1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    "2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    "3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  "2": {
    "1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    "2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    "3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
  "2.5": {
    "1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    "2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    "3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
} as const;

export interface MP3AudioInspection {
  sampleRateHz: number;
  channelCount: number;
  durationSeconds: number;
}

export function inspectMP3Audio(audioData: Buffer): MP3AudioInspection | null {
  if (audioData.length < 4) {
    return null;
  }

  const startOffset = leadingID3TagLength(audioData);

  for (let offset = startOffset; offset <= audioData.length - 4; offset += 1) {
    const firstFrame = parseMP3FrameHeader(audioData.readUInt32BE(offset));
    if (!firstFrame || offset + firstFrame.frameLength > audioData.length) {
      continue;
    }

    let totalSamples = 0;
    let position = offset;
    let sampleRate = firstFrame.sampleRate;
    let channelCount = firstFrame.channelCount;

    while (position <= audioData.length - 4) {
      const frame = parseMP3FrameHeader(audioData.readUInt32BE(position));
      if (!frame || position + frame.frameLength > audioData.length) {
        break;
      }

      if (frame.sampleRate !== sampleRate) {
        return null;
      }

      if (frame.channelCount !== channelCount) {
        return null;
      }

      totalSamples += frame.samplesPerFrame;
      position += frame.frameLength;
    }

    if (totalSamples > 0) {
      return {
        sampleRateHz: sampleRate,
        channelCount,
        durationSeconds: totalSamples / sampleRate,
      };
    }
  }

  return null;
}

export function measureMP3DurationSeconds(audioData: Buffer): number | null {
  return inspectMP3Audio(audioData)?.durationSeconds ?? null;
}

function leadingID3TagLength(audioData: Buffer): number {
  if (
    audioData.length < 10 ||
    audioData[0] !== 0x49 ||
    audioData[1] !== 0x44 ||
    audioData[2] !== 0x33
  ) {
    return 0;
  }

  const flags = audioData[5] ?? 0;
  const footerLength = (flags & 0x10) !== 0 ? 10 : 0;
  return Math.min(10 + synchsafeInteger(audioData.subarray(6, 10)) + footerLength, audioData.length);
}

function synchsafeInteger(bytes: Buffer): number {
  return (
    ((bytes[0] ?? 0) << 21) |
    ((bytes[1] ?? 0) << 14) |
    ((bytes[2] ?? 0) << 7) |
    (bytes[3] ?? 0)
  );
}

function parseMP3FrameHeader(header: number): MP3FrameInfo | null {
  if (((header & 0xffe00000) >>> 0) !== 0xffe00000) {
    return null;
  }

  const versionBits = (header >>> 19) & 0b11;
  const layerBits = (header >>> 17) & 0b11;
  const bitrateIndex = (header >>> 12) & 0b1111;
  const sampleRateIndex = (header >>> 10) & 0b11;
  const padding = (header >>> 9) & 0b1;

  const version = parseVersion(versionBits);
  const layer = parseLayer(layerBits);
  if (!version || !layer || bitrateIndex === 0 || bitrateIndex === 0b1111 || sampleRateIndex === 0b11) {
    return null;
  }

  const bitrate = BITRATE_TABLE[version][layer][bitrateIndex];
  const sampleRate = resolveSampleRate(version, sampleRateIndex);
  if (!bitrate || !sampleRate) {
    return null;
  }

  const samplesPerFrame = resolveSamplesPerFrame(version, layer);
  const channelCount = resolveChannelCount((header >>> 6) & 0b11);
  const frameLength = resolveFrameLength(version, layer, bitrate, sampleRate, padding);
  if (!frameLength || frameLength < 4) {
    return null;
  }

  return { frameLength, sampleRate, samplesPerFrame, channelCount };
}

function parseVersion(versionBits: number): MPEGVersion | null {
  switch (versionBits) {
    case 0b11:
      return "1";
    case 0b10:
      return "2";
    case 0b00:
      return "2.5";
    default:
      return null;
  }
}

function parseLayer(layerBits: number): MPEGLayer | null {
  switch (layerBits) {
    case 0b11:
      return "1";
    case 0b10:
      return "2";
    case 0b01:
      return "3";
    default:
      return null;
  }
}

function resolveSampleRate(version: MPEGVersion, sampleRateIndex: number): number | null {
  switch (version) {
    case "1":
      return MPEG1_SAMPLE_RATES[sampleRateIndex] ?? null;
    case "2":
      return MPEG2_SAMPLE_RATES[sampleRateIndex] ?? null;
    case "2.5":
      return MPEG25_SAMPLE_RATES[sampleRateIndex] ?? null;
  }
}

function resolveSamplesPerFrame(version: MPEGVersion, layer: MPEGLayer): number {
  if (layer === "1") {
    return 384;
  }

  if (layer === "2") {
    return 1152;
  }

  return version === "1" ? 1152 : 576;
}

function resolveChannelCount(channelModeBits: number): number {
  return channelModeBits === 0b11 ? 1 : 2;
}

function resolveFrameLength(
  version: MPEGVersion,
  layer: MPEGLayer,
  bitrateKbps: number,
  sampleRate: number,
  padding: number,
): number {
  const bitrate = bitrateKbps * 1000;

  if (layer === "1") {
    return Math.floor((12 * bitrate) / sampleRate + padding) * 4;
  }

  if (layer === "3" && version !== "1") {
    return Math.floor((72 * bitrate) / sampleRate) + padding;
  }

  return Math.floor((144 * bitrate) / sampleRate) + padding;
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

function buildChunkMedia(
  audioData: Buffer,
  durationSeconds: number,
  inspection?: MP3AudioInspection | null,
): PackagerChunkMedia {
  return {
    audioData,
    format: "mp3",
    contentType: "audio/mpeg",
    durationSeconds,
    sampleRateHz: inspection?.sampleRateHz ?? DEFAULT_CHUNK_SAMPLE_RATE_HZ,
    channelCount: inspection?.channelCount ?? DEFAULT_CHUNK_CHANNEL_COUNT,
  };
}
