import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeSpeechProvider,
  OpenAISpeechProvider,
  OpenAITTSTimeoutError,
  measureMP3DurationSeconds,
} from "./tts.js";

const originalFetch = globalThis.fetch;
const originalTimeout = process.env.OPENAI_TTS_TIMEOUT_MS;

function buildMP3Header(options: {
  versionBits: number;
  layerBits: number;
  bitrateIndex: number;
  sampleRateIndex: number;
  channelModeBits?: number;
  padding?: number;
}): Buffer {
  let header = 0xffe00000;
  header |= options.versionBits << 19;
  header |= options.layerBits << 17;
  header |= 0b1 << 16;
  header |= options.bitrateIndex << 12;
  header |= options.sampleRateIndex << 10;
  header |= (options.channelModeBits ?? 0b00) << 6;
  header |= (options.padding ?? 0) << 9;

  return Buffer.from([
    (header >>> 24) & 0xff,
    (header >>> 16) & 0xff,
    (header >>> 8) & 0xff,
    header & 0xff,
  ]);
}

function buildFrame(header: Buffer, frameLength: number): Buffer {
  return Buffer.concat([header, Buffer.alloc(frameLength - header.length)]);
}

function buildID3Tag(footer = false): Buffer {
  const flags = footer ? 0x10 : 0x00;
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x04, 0x00, flags, 0x00, 0x00, 0x00, 0x00,
  ]);
  const footerBytes = footer
    ? Buffer.from([0x33, 0x44, 0x49, 0x04, 0x00, flags, 0x00, 0x00, 0x00, 0x00])
    : Buffer.alloc(0);
  return Buffer.concat([header, footerBytes]);
}

describe("speech providers", () => {
  it("returns a chunk-oriented handoff for fake speech synthesis", async () => {
    const provider = new FakeSpeechProvider();

    const result = await provider.synthesizeText(
      "A tiny line of content.",
      { voice: "alloy" },
      {},
    );

    expect(result.chunkMedia).toMatchObject({
      format: "mp3",
      contentType: "audio/mpeg",
      durationSeconds: result.durationSeconds,
    });
    expect(result.chunkMedia?.audioData.toString()).toBe("fake-audio");
  });

  it("extracts sample rate and channel count from real MP3 bytes", async () => {
    const header = buildMP3Header({
      versionBits: 0b11,
      layerBits: 0b01,
      bitrateIndex: 9,
      sampleRateIndex: 1,
      channelModeBits: 0b11,
    });
    const frame = buildFrame(header, 384);
    const audioData = Buffer.concat([frame, frame, frame, frame]);
    globalThis.fetch = vi.fn(async () => new Response(audioData, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    })) as typeof fetch;

    const provider = new OpenAISpeechProvider("test-api-key");

    const result = await provider.synthesizeText(
      "A tiny line of content.",
      { voice: "alloy" },
      {},
    );

    expect(result.chunkMedia).toMatchObject({
      format: "mp3",
      contentType: "audio/mpeg",
      sampleRateHz: 48_000,
      channelCount: 1,
    });
    expect(result.durationSeconds).toBeCloseTo(4 * 1152 / 48_000, 5);
    expect(result.chunkMedia?.audioData.equals(audioData)).toBe(true);
  });

  it("sends the judged winner delivery instructions to the TTS API", async () => {
    const header = buildMP3Header({
      versionBits: 0b11,
      layerBits: 0b01,
      bitrateIndex: 9,
      sampleRateIndex: 1,
      channelModeBits: 0b11,
    });
    const frame = buildFrame(header, 384);
    const audioData = Buffer.concat([frame, frame, frame, frame]);
    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { instructions?: string };
      expect(body.instructions).toContain("engaging inflection");
      expect(body.instructions).toContain("dynamic pacing");
      expect(body.instructions).toContain("Pause meaningfully between sentences");
      expect(body.instructions).toContain("warm, conversational tone");

      return new Response(audioData, {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }) as typeof fetch;

    const provider = new OpenAISpeechProvider("test-api-key");

    await provider.synthesizeText(
      "A tiny line of content.",
      { voice: "alloy" },
      {},
    );
  });

  it("measures MP3 duration from frame headers", () => {
    const header = buildMP3Header({
      versionBits: 0b11,
      layerBits: 0b01,
      bitrateIndex: 9,
      sampleRateIndex: 0,
    });
    const frame = buildFrame(header, 417);
    const audioData = Buffer.concat([
      buildID3Tag(),
      frame,
      frame,
      frame,
      frame,
      frame,
      frame,
      frame,
      frame,
      frame,
      frame,
    ]);

    expect(measureMP3DurationSeconds(audioData)).toBeCloseTo(10 * 1152 / 44_100, 5);
  });

  it("skips junk bytes and an ID3 footer before measuring frames", () => {
    const header = buildMP3Header({
      versionBits: 0b11,
      layerBits: 0b01,
      bitrateIndex: 9,
      sampleRateIndex: 0,
    });
    const frame = buildFrame(header, 417);
    const audioData = Buffer.concat([
      Buffer.from("junk"),
      buildID3Tag(true),
      frame,
      frame,
      frame,
      frame,
      frame,
      frame,
    ]);

    expect(measureMP3DurationSeconds(audioData)).toBeCloseTo(6 * 1152 / 44_100, 5);
  });

  it("measures MPEG-2 layer III frame durations", () => {
    const header = buildMP3Header({
      versionBits: 0b10,
      layerBits: 0b01,
      bitrateIndex: 8,
      sampleRateIndex: 0,
    });
    const frame = buildFrame(header, 208);
    const audioData = Buffer.concat([frame, frame, frame, frame, frame, frame]);

    expect(measureMP3DurationSeconds(audioData)).toBeCloseTo(6 * 576 / 22_050, 5);
  });

  it("times out stalled OpenAI synthesis requests", async () => {
    process.env.OPENAI_TTS_TIMEOUT_MS = "10";
    globalThis.fetch = vi.fn((_input, init) => new Promise((_, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        reject(signal.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;

    const provider = new OpenAISpeechProvider("test-api-key");

    await expect(
      provider.synthesizeText(
        "This request should time out.",
        { voice: "ash" },
        {},
      ),
    ).rejects.toBeInstanceOf(OpenAITTSTimeoutError);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  if (originalTimeout === undefined) {
    delete process.env.OPENAI_TTS_TIMEOUT_MS;
  } else {
    process.env.OPENAI_TTS_TIMEOUT_MS = originalTimeout;
  }
});
