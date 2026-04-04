import { spawn } from "node:child_process";

import {
  buildChunkMediaKey,
  buildFinalAudioKey,
  buildHlsEventPlaylist,
  buildInitSegmentKey,
  buildPlaylistKey,
  evaluateStartupBuffer,
  type MediaChunkInput,
  type MediaPackagingResult,
} from "./media-packager.js";

export interface FfmpegCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface FfmpegCommandRunner {
  run(command: string, args: string[]): Promise<FfmpegCommandResult>;
}

export interface FfmpegMediaPackagerOptions {
  ffmpegPath?: string;
  commandRunner?: FfmpegCommandRunner;
  run?: FfmpegCommandRunner["run"];
  startupBufferSeconds?: number;
}

export class FfmpegBinaryMissingError extends Error {
  readonly code = "ffmpeg_binary_missing";

  constructor(command: string) {
    super(`Unable to run ${command}; the ffmpeg binary was not found.`);
    this.name = "FfmpegBinaryMissingError";
  }
}

export class FfmpegCommandFailedError extends Error {
  readonly code = "ffmpeg_command_failed";

  constructor(
    command: string,
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`ffmpeg exited with code ${exitCode}.`);
    this.name = "FfmpegCommandFailedError";
  }
}

export interface FfmpegMediaPackager {
  packageMedia(jobId: string, chunks: readonly MediaChunkInput[]): Promise<MediaPackagingResult>;
}

export function createFfmpegMediaPackager(
  options: FfmpegMediaPackagerOptions = {},
): FfmpegMediaPackager {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  const commandRunner =
    options.commandRunner ??
    (options.run ? { run: options.run } : null) ??
    createDefaultCommandRunner();
  const startupBufferSeconds = options.startupBufferSeconds ?? 20;

  return {
    async packageMedia(jobId, chunks) {
      const startupBuffer = evaluateStartupBuffer(chunks, startupBufferSeconds);
      const playlistKey = buildPlaylistKey(jobId);
      const initSegmentKey = buildInitSegmentKey(jobId);
      const segmentKeys = chunks.map((chunk) => buildChunkMediaKey(jobId, chunk.index));
      const playlistText = buildHlsEventPlaylist(jobId, chunks, {
        startupBufferPlayable: startupBuffer.isPlayable,
      });

      await runFfmpegCommand(commandRunner, ffmpegPath, [
        "-y",
        "-i",
        ...segmentKeys.flatMap((key) => ["-i", key]),
        "-f",
        "hls",
        "-hls_playlist_type",
        "event",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        initSegmentKey,
        playlistKey,
      ]);

      const finalAudioKey = buildFinalAudioKey(jobId);
      const finalAudioResult = await runFfmpegCommand(commandRunner, ffmpegPath, [
        "-y",
        "-i",
        playlistKey,
        "-c:a",
        "libmp3lame",
        finalAudioKey,
      ]);

      return {
        playlistKey,
        playlistText,
        initSegmentKey,
        segments: chunks.map((chunk) => ({
          index: chunk.index,
          key: buildChunkMediaKey(jobId, chunk.index),
          durationSeconds: chunk.chunkMedia.durationSeconds,
        })),
        startupBuffer,
        finalAudio: {
          key: finalAudioKey,
          audioData: finalAudioResult.stdout,
          contentType: "audio/mpeg",
          format: "mp3",
          durationSeconds: startupBuffer.bufferedSeconds,
          sampleRateHz: chunks[0]?.chunkMedia.sampleRateHz ?? 44_100,
          channelCount: chunks[0]?.chunkMedia.channelCount ?? 1,
        },
      };
    },
  };
}

function createDefaultCommandRunner(): FfmpegCommandRunner {
  return {
    run(command, args) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
        child.on("error", reject);
        child.on("close", (exitCode) => {
          resolve({
            exitCode: exitCode ?? 1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
          });
        });
      });
    },
  };
}

async function runFfmpegCommand(
  commandRunner: FfmpegCommandRunner,
  command: string,
  args: string[],
): Promise<FfmpegCommandResult> {
  try {
    const result = await commandRunner.run(command, args);

    if (result.exitCode !== 0) {
      throw new FfmpegCommandFailedError(command, result.exitCode, result.stderr.toString("utf8"));
    }

    return result;
  } catch (error) {
    if (isMissingBinaryError(error)) {
      throw new FfmpegBinaryMissingError(command);
    }

    if (error instanceof FfmpegCommandFailedError) {
      throw error;
    }

    throw error;
  }
}

function isMissingBinaryError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
