import { writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { buildFinalAudioKey } from "./media-packager.js";
import type { MediaChunkInput } from "./media-packager.js";
import {
  createFfmpegMediaPackager,
  EmptyMediaChunkInputError,
  FfmpegBinaryMissingError,
  FfmpegCommandFailedError,
} from "./ffmpeg-media-packager.js";

const sampleChunks = [
  {
    index: 0,
    chunkMedia: {
      audioData: Buffer.from("chunk-0"),
      format: "mp3" as const,
      contentType: "audio/mpeg" as const,
      durationSeconds: 8,
      sampleRateHz: 44_100,
      channelCount: 1,
    },
  },
  {
    index: 1,
    chunkMedia: {
      audioData: Buffer.from("chunk-1"),
      format: "mp3" as const,
      contentType: "audio/mpeg" as const,
      durationSeconds: 12,
      sampleRateHz: 44_100,
      channelCount: 1,
    },
  },
];

describe("media packager key helpers", () => {
  it("generates stable media object keys under jobs/<jobId>/...", () => {
    expect(buildFinalAudioKey("job-123")).toBe("jobs/job-123/final.mp3");
  });
});

describe("createFfmpegMediaPackager", () => {
  it("packages final MP3 from ordered chunk inputs", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const concatListPath = args[args.indexOf("-i") + 1];
      if (typeof concatListPath === "string" && concatListPath.endsWith("inputs.txt")) {
        const { readFile } = await import("node:fs/promises");
        const concatListText = await readFile(concatListPath, "utf8");
        expect(concatListText).toContain("chunk-0000.mp3");
        expect(concatListText).toContain("chunk-0001.mp3");
      }

      const outputPath = args.at(-1);
      if (typeof outputPath === "string" && outputPath.endsWith("final.mp3")) {
        await writeFile(outputPath, Buffer.from("packaged-mp3-bytes"));
      }

      return {
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    });

    const packager = createFfmpegMediaPackager({ run });
    const finalAudio = await packager.packageFinalAudio("job-123", sampleChunks);

    expect(finalAudio.key).toBe("jobs/job-123/final.mp3");
    expect(finalAudio.contentType).toBe("audio/mpeg");
    expect(finalAudio.format).toBe("mp3");
    expect(finalAudio.durationSeconds).toBe(20);
    expect(finalAudio.sampleRateHz).toBe(44_100);
    expect(finalAudio.channelCount).toBe(1);
    expect(finalAudio.audioData.toString()).toBe("packaged-mp3-bytes");

    expect(run).toHaveBeenCalledOnce();
    const callArgs = run.mock.calls[0]![1];
    expect(callArgs).toContain("-c:a");
    expect(callArgs).toContain("libmp3lame");
  });

  it("fails fast when no chunks are provided", async () => {
    const packager = createFfmpegMediaPackager({
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })),
    });

    await expect(packager.packageFinalAudio("job-123", [])).rejects.toBeInstanceOf(
      EmptyMediaChunkInputError,
    );
  });

  it("rejects unsupported chunk formats before invoking ffmpeg", async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    const packager = createFfmpegMediaPackager({ run });

    const unsupportedChunk = [
      {
        index: 0,
        chunkMedia: {
          audioData: Buffer.from("raw-wav"),
          format: "wav",
          contentType: "audio/wav",
          durationSeconds: 8,
          sampleRateHz: 44_100,
          channelCount: 1,
        },
      },
    ] as const as unknown as MediaChunkInput[];

    await expect(packager.packageFinalAudio("job-123", unsupportedChunk)).rejects.toMatchObject({
      code: "unsupported_chunk_media_format",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("fails loudly when ffmpeg is missing", async () => {
    const run = vi.fn(async () => {
      const error = new Error("spawn ffmpeg ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    const packager = createFfmpegMediaPackager({ run });

    await expect(packager.packageFinalAudio("job-123", sampleChunks)).rejects.toBeInstanceOf(
      FfmpegBinaryMissingError,
    );
  });

  it("fails loudly when ffmpeg exits non-zero", async () => {
    const run = vi.fn(async () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("ffmpeg exploded"),
    }));
    const packager = createFfmpegMediaPackager({ run });

    await expect(packager.packageFinalAudio("job-123", sampleChunks)).rejects.toBeInstanceOf(
      FfmpegCommandFailedError,
    );
  });
});
