import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildBatchInitSegmentKey,
  buildBatchSegmentKey,
  buildChunkMediaKey,
  buildFinalAudioKey,
  buildHlsEventPlaylist,
  buildInitSegmentKey,
  buildPlaylistKey,
  buildPlaylistUri,
  evaluateStartupBuffer,
} from "./media-packager.js";
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
    expect(buildChunkMediaKey("job-123", 7)).toBe("jobs/job-123/segments/chunk-0007.m4s");
    expect(buildBatchInitSegmentKey("job-123", 2)).toBe("jobs/job-123/segments/batch-0002/init.mp4");
    expect(buildBatchSegmentKey("job-123", 2, 3)).toBe(
      "jobs/job-123/segments/batch-0002/chunk-0003.m4s",
    );
    expect(buildInitSegmentKey("job-123")).toBe("jobs/job-123/segments/init.mp4");
    expect(buildPlaylistKey("job-123")).toBe("jobs/job-123/playlist.m3u8");
    expect(buildFinalAudioKey("job-123")).toBe("jobs/job-123/final.mp3");
  });
});

describe("buildHlsEventPlaylist", () => {
  it("creates an AAC/fMP4 event playlist from ordered chunk inputs", () => {
    const playlist = buildHlsEventPlaylist("job-123", sampleChunks, {
      startupBufferPlayable: true,
    });

    expect(playlist).toContain("#EXTM3U");
    expect(playlist).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(playlist).toContain("#EXT-X-MAP:URI=\"jobs/job-123/segments/init.mp4\"");
    expect(playlist).toContain("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
    expect(playlist).toContain("jobs/job-123/segments/chunk-0000.m4s");
    expect(playlist).toContain("jobs/job-123/segments/chunk-0001.m4s");
    expect(
      playlist.indexOf("jobs/job-123/segments/chunk-0000.m4s"),
    ).toBeLessThan(
      playlist.indexOf("jobs/job-123/segments/chunk-0001.m4s"),
    );
  });
});

describe("evaluateStartupBuffer", () => {
  it("marks a chunk set playable only after the startup threshold is met", () => {
    expect(evaluateStartupBuffer(sampleChunks, 20)).toEqual({
      bufferedSeconds: 20,
      isPlayable: true,
    });

    expect(evaluateStartupBuffer(sampleChunks.slice(0, 1), 20)).toEqual({
      bufferedSeconds: 8,
      isPlayable: false,
    });
  });
});

describe("createFfmpegMediaPackager", () => {
  it("packages append-only HLS batches and final MP3 artifacts from ordered chunk inputs", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = vi.fn(async (_command: string, args: string[]) => {
      calls.push({ command: "ffmpeg", args });
      const concatListPath = args[args.indexOf("-i") + 1];
      if (typeof concatListPath === "string" && concatListPath.endsWith("inputs.txt")) {
        const concatListText = await readFile(concatListPath, "utf8");
        expect(concatListText).toContain("chunk-0000.mp3");
        expect(concatListText).toContain("chunk-0001.mp3");
      }

      const outputPath = args.at(-1);
      if (typeof outputPath === "string" && outputPath.endsWith("playlist.m3u8")) {
        const initPath = args[args.indexOf("-hls_fmp4_init_filename") + 1];
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];

        if (typeof initPath === "string") {
          const resolvedInitPath = isAbsolute(initPath)
            ? initPath
            : join(dirname(outputPath), initPath);
          await writeFile(resolvedInitPath, Buffer.from("init-bytes"));
        }

        if (typeof segmentPattern === "string") {
          await writeFile(segmentPattern.replace("%04d", "0000"), Buffer.from("segment-0-bytes"));
          await writeFile(segmentPattern.replace("%04d", "0001"), Buffer.from("segment-1-bytes"));
        }

        await writeFile(
          outputPath,
          Buffer.from(
            [
              "#EXTM3U",
              "#EXT-X-VERSION:7",
              "#EXT-X-TARGETDURATION:12",
              "#EXT-X-MEDIA-SEQUENCE:0",
              "#EXT-X-PLAYLIST-TYPE:EVENT",
              "#EXT-X-MAP:URI=\"init.mp4\"",
              "#EXTINF:8.000,",
              "chunk-0000.m4s",
              "#EXTINF:12.000,",
              "chunk-0001.m4s",
              "",
            ].join("\n"),
          ),
        );
      }

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

    const streamBatch = await packager.packageStreamBatch("job-123", 0, sampleChunks);
    const finalAudio = await packager.packageFinalAudio("job-123", sampleChunks);

    expect(streamBatch.initSegment.key).toBe(buildBatchInitSegmentKey("job-123", 0));
    expect(streamBatch.initSegment.uri).toBe(
      buildPlaylistUri("job-123", buildBatchInitSegmentKey("job-123", 0)),
    );
    expect(streamBatch.initSegment.audioData.toString()).toBe("init-bytes");
    expect(streamBatch.segments).toHaveLength(2);
    expect(streamBatch.segments[0]?.key).toBe(buildBatchSegmentKey("job-123", 0, 0));
    expect(streamBatch.segments[0]?.uri).toBe(
      buildPlaylistUri("job-123", buildBatchSegmentKey("job-123", 0, 0)),
    );
    expect(streamBatch.segments[0]?.audioData.toString()).toBe("segment-0-bytes");
    expect(streamBatch.segments[1]?.key).toBe(buildBatchSegmentKey("job-123", 0, 1));
    expect(streamBatch.batchDurationSeconds).toBe(20);

    expect(finalAudio.key).toBe("jobs/job-123/final.mp3");
    expect(finalAudio.contentType).toBe("audio/mpeg");
    expect(finalAudio.format).toBe("mp3");
    expect(finalAudio.durationSeconds).toBe(20);
    expect(finalAudio.sampleRateHz).toBe(44_100);
    expect(finalAudio.channelCount).toBe(1);
    expect(finalAudio.audioData.toString()).toBe("packaged-mp3-bytes");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("-hls_playlist_type");
    expect(calls[0]?.args).toContain("event");
    expect(calls[0]?.args).toContain("-hls_segment_type");
    expect(calls[0]?.args).toContain("fmp4");
    expect(calls[1]?.args).toContain("-c:a");
    expect(calls[1]?.args).toContain("libmp3lame");
  });

  it("uses packaged playlist segment durations for append-only HLS batch metadata", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const outputPath = args.at(-1);

      if (typeof outputPath === "string" && outputPath.endsWith("playlist.m3u8")) {
        const initPath = args[args.indexOf("-hls_fmp4_init_filename") + 1];
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];

        if (typeof initPath === "string") {
          const resolvedInitPath = isAbsolute(initPath)
            ? initPath
            : join(dirname(outputPath), initPath);
          await writeFile(resolvedInitPath, Buffer.from("init-bytes"));
        }

        if (typeof segmentPattern === "string") {
          await writeFile(segmentPattern.replace("%04d", "0000"), Buffer.from("segment-0-bytes"));
          await writeFile(segmentPattern.replace("%04d", "0001"), Buffer.from("segment-1-bytes"));
        }

        await writeFile(
          outputPath,
          Buffer.from(
            [
              "#EXTM3U",
              "#EXT-X-VERSION:7",
              "#EXT-X-TARGETDURATION:8",
              "#EXT-X-MEDIA-SEQUENCE:0",
              "#EXT-X-PLAYLIST-TYPE:EVENT",
              "#EXT-X-MAP:URI=\"init.mp4\"",
              "#EXTINF:6.125,",
              "chunk-0000.m4s",
              "#EXTINF:7.375,",
              "chunk-0001.m4s",
              "",
            ].join("\n"),
          ),
        );
      }

      if (typeof outputPath === "string" && outputPath.endsWith("final.mp3")) {
        await writeFile(outputPath, Buffer.from("packaged-mp3-bytes"));
      }

      return {
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      };
    });

    const packager = createFfmpegMediaPackager({ run, startupBufferSeconds: 20 });
    const streamBatch = await packager.packageStreamBatch("job-123", 0, sampleChunks);

    expect(streamBatch.batchDurationSeconds).toBeCloseTo(13.5, 5);
    expect(streamBatch.segments.map((segment) => segment.durationSeconds)).toEqual([
      6.125,
      7.375,
    ]);
  });

  it("returns every HLS segment referenced by the ffmpeg playlist, not just one per input chunk", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const outputPath = args.at(-1);

      if (typeof outputPath === "string" && outputPath.endsWith("playlist.m3u8")) {
        const initPath = args[args.indexOf("-hls_fmp4_init_filename") + 1];
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];

        if (typeof initPath === "string") {
          const resolvedInitPath = isAbsolute(initPath)
            ? initPath
            : join(dirname(outputPath), initPath);
          await writeFile(resolvedInitPath, Buffer.from("init-bytes"));
        }

        if (typeof segmentPattern === "string") {
          for (const index of ["0000", "0001", "0002", "0003"]) {
            await writeFile(
              segmentPattern.replace("%04d", index),
              Buffer.from(`segment-${index}-bytes`),
            );
          }
        }

        await writeFile(
          outputPath,
          Buffer.from(
            [
              "#EXTM3U",
              "#EXT-X-VERSION:7",
              "#EXT-X-TARGETDURATION:2",
              "#EXT-X-MEDIA-SEQUENCE:0",
              "#EXT-X-PLAYLIST-TYPE:EVENT",
              "#EXT-X-MAP:URI=\"init.mp4\"",
              "#EXTINF:2.005333,",
              "chunk-0000.m4s",
              "#EXTINF:2.005333,",
              "chunk-0001.m4s",
              "#EXTINF:2.005333,",
              "chunk-0002.m4s",
              "#EXTINF:1.962667,",
              "chunk-0003.m4s",
              "",
            ].join("\n"),
          ),
        );
      }

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
    const streamBatch = await packager.packageStreamBatch("job-123", 2, sampleChunks);

    expect(streamBatch.segments).toHaveLength(4);
    expect(streamBatch.segments.map((segment) => segment.key)).toEqual([
      "jobs/job-123/segments/batch-0002/chunk-0000.m4s",
      "jobs/job-123/segments/batch-0002/chunk-0001.m4s",
      "jobs/job-123/segments/batch-0002/chunk-0002.m4s",
      "jobs/job-123/segments/batch-0002/chunk-0003.m4s",
    ]);
    expect(streamBatch.segments.map((segment) => segment.durationSeconds)).toEqual([
      2.005333,
      2.005333,
      2.005333,
      1.962667,
    ]);
  });

  it("retains a compatibility wrapper for legacy callers while using flattened whole-stream keys", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      const outputPath = args.at(-1);

      if (typeof outputPath === "string" && outputPath.endsWith("playlist.m3u8")) {
        const initPath = args[args.indexOf("-hls_fmp4_init_filename") + 1];
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];

        if (typeof initPath === "string") {
          const resolvedInitPath = isAbsolute(initPath)
            ? initPath
            : join(dirname(outputPath), initPath);
          await writeFile(resolvedInitPath, Buffer.from("init-bytes"));
        }

        if (typeof segmentPattern === "string") {
          await writeFile(segmentPattern.replace("%04d", "0000"), Buffer.from("segment-0-bytes"));
          await writeFile(segmentPattern.replace("%04d", "0001"), Buffer.from("segment-1-bytes"));
        }

        await writeFile(
          outputPath,
          Buffer.from(
            [
              "#EXTM3U",
              "#EXT-X-VERSION:7",
              "#EXT-X-TARGETDURATION:12",
              "#EXT-X-MEDIA-SEQUENCE:0",
              "#EXT-X-PLAYLIST-TYPE:EVENT",
              "#EXT-X-MAP:URI=\"init.mp4\"",
              "#EXTINF:8.000,",
              "chunk-0000.m4s",
              "#EXTINF:12.000,",
              "chunk-0001.m4s",
              "",
            ].join("\n"),
          ),
        );
      }

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
    const result = await packager.packageMedia("job-123", sampleChunks);

    expect(result.playlist.key).toBe(buildPlaylistKey("job-123"));
    expect(result.initSegment.key).toBe(buildInitSegmentKey("job-123"));
    expect(result.segments.map((segment) => segment.key)).toEqual([
      buildChunkMediaKey("job-123", 0),
      buildChunkMediaKey("job-123", 1),
    ]);
    expect(result.finalAudio.key).toBe(buildFinalAudioKey("job-123"));
    expect(result.startupBuffer).toEqual({
      bufferedSeconds: 20,
      isPlayable: true,
    });
    expect(result.playlist.audioData.toString("utf8")).toBe(
      buildHlsEventPlaylist("job-123", sampleChunks, { startupBufferPlayable: true }),
    );
  });

  it("fails fast when no chunks are provided", async () => {
    const packager = createFfmpegMediaPackager({
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      })),
    });

    await expect(packager.packageMedia("job-123", [])).rejects.toBeInstanceOf(
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

    await expect(packager.packageMedia("job-123", unsupportedChunk)).rejects.toMatchObject({
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

    await expect(packager.packageMedia("job-123", sampleChunks)).rejects.toBeInstanceOf(
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

    await expect(packager.packageMedia("job-123", sampleChunks)).rejects.toBeInstanceOf(
      FfmpegCommandFailedError,
    );
  });
});
