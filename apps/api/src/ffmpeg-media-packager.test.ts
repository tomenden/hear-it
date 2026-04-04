import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  buildChunkMediaKey,
  buildFinalAudioKey,
  buildHlsEventPlaylist,
  buildInitSegmentKey,
  buildPlaylistKey,
  evaluateStartupBuffer,
} from "./media-packager.js";
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
  it("packages final MP3 metadata from ordered chunk inputs", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const run = vi.fn(async (_command: string, args: string[]) => {
      calls.push({ command: "ffmpeg", args });
      const concatListPath = args[args.indexOf("-i") + 1];
      if (concatListPath?.endsWith("inputs.txt")) {
        const concatListText = await readFile(concatListPath, "utf8");
        expect(concatListText).toContain("chunk-0000.mp3");
        expect(concatListText).toContain("chunk-0001.mp3");

        const initPath = args[args.indexOf("-hls_fmp4_init_filename") + 1];
        const segmentPattern = args[args.indexOf("-hls_segment_filename") + 1];
        const playlistPath = args.at(-1);

        if (typeof initPath === "string") {
          await writeFile(initPath, Buffer.from("init-bytes"));
        }

        if (typeof playlistPath === "string") {
          await writeFile(
            playlistPath,
            Buffer.from(
              buildHlsEventPlaylist("job-123", sampleChunks, {
                startupBufferPlayable: true,
              }),
            ),
          );
        }

        if (typeof segmentPattern === "string") {
          await writeFile(segmentPattern.replace("%04d", "0000"), Buffer.from("segment-0-bytes"));
          await writeFile(segmentPattern.replace("%04d", "0001"), Buffer.from("segment-1-bytes"));
        }
      }
      const outputPath = args.at(-1);
      if (outputPath?.endsWith("final.mp3")) {
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

    expect(result.playlist.key).toBe("jobs/job-123/playlist.m3u8");
    expect(result.playlist.audioData.toString()).toBe(
      buildHlsEventPlaylist("job-123", sampleChunks, { startupBufferPlayable: true }),
    );
    expect(result.initSegment.key).toBe("jobs/job-123/segments/init.mp4");
    expect(result.initSegment.audioData.toString()).toBe("init-bytes");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.key).toBe("jobs/job-123/segments/chunk-0000.m4s");
    expect(result.segments[0]?.audioData.toString()).toBe("segment-0-bytes");
    expect(result.finalAudio.key).toBe("jobs/job-123/final.mp3");
    expect(result.finalAudio.contentType).toBe("audio/mpeg");
    expect(result.finalAudio.format).toBe("mp3");
    expect(result.finalAudio.durationSeconds).toBe(20);
    expect(result.finalAudio.sampleRateHz).toBe(44_100);
    expect(result.finalAudio.channelCount).toBe(1);
    expect(result.finalAudio.audioData.toString()).toBe("packaged-mp3-bytes");
    expect(result.startupBuffer.isPlayable).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args[0]).toBe("-y");
    expect(calls[0]?.args[4]).toBe("-f");
    expect(calls[0]?.args[5]).toBe("concat");
    expect(calls[0]?.args[8]).toBe("-i");
    expect(calls[0]?.args[9]).toContain("inputs.txt");
    expect(calls[0]?.args).toContain("-hls_playlist_type");
    expect(calls[0]?.args).toContain("event");
    expect(calls[0]?.args).toContain("-hls_segment_type");
    expect(calls[0]?.args).toContain("fmp4");
    expect(calls[0]?.args).toContain("-hls_segment_filename");
    expect(calls[0]?.args.at(-1)).toContain("playlist.m3u8");
    expect(calls[1]?.args[4]).toBe("-f");
    expect(calls[1]?.args[5]).toBe("concat");
    expect(calls[1]?.args[8]).toBe("-i");
    expect(calls[1]?.args[9]).toContain("inputs.txt");
    expect(calls[1]?.args).toContain("-c:a");
    expect(calls[1]?.args).toContain("libmp3lame");
    expect(calls[1]?.args.at(-1)).toContain("final.mp3");
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
    ] as any;

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
