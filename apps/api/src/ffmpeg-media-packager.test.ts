import { describe, expect, it, vi } from "vitest";

import {
  buildChunkMediaKey,
  buildFinalAudioKey,
  buildHlsEventPlaylist,
  buildInitSegmentKey,
  buildPlaylistKey,
  evaluateStartupBuffer,
} from "./media-packager.js";
import { createFfmpegMediaPackager, FfmpegBinaryMissingError, FfmpegCommandFailedError } from "./ffmpeg-media-packager.js";

const sampleChunks = [
  {
    index: 0,
    chunkMedia: {
      audioData: Buffer.from("chunk-0"),
      format: "wav" as const,
      contentType: "audio/wav",
      durationSeconds: 8,
      sampleRateHz: 44_100,
      channelCount: 1,
    },
  },
  {
    index: 1,
    chunkMedia: {
      audioData: Buffer.from("chunk-1"),
      format: "pcm" as const,
      contentType: "audio/L16",
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
    const run = vi.fn(async () => ({
      exitCode: 0,
      stdout: Buffer.from("final-mp3-bytes"),
      stderr: Buffer.alloc(0),
    }));
    const packager = createFfmpegMediaPackager({ run });

    const result = await packager.packageMedia("job-123", sampleChunks);

    expect(result.playlistKey).toBe("jobs/job-123/playlist.m3u8");
    expect(result.finalAudio.key).toBe("jobs/job-123/final.mp3");
    expect(result.finalAudio.contentType).toBe("audio/mpeg");
    expect(result.finalAudio.format).toBe("mp3");
    expect(result.finalAudio.durationSeconds).toBe(20);
    expect(result.finalAudio.sampleRateHz).toBe(44_100);
    expect(result.finalAudio.channelCount).toBe(1);
    expect(result.finalAudio.audioData.toString()).toBe("final-mp3-bytes");
    expect(result.startupBuffer.isPlayable).toBe(true);
    expect(result.playlistText).toContain("jobs/job-123/segments/chunk-0000.m4s");
    expect(run).toHaveBeenCalledTimes(2);
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
