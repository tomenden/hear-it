import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { inspectMP3Audio } from "./tts.js";
import {
  buildBatchInitSegmentKey,
  buildBatchSegmentKey,
  buildChunkMediaKey,
  buildFinalAudioKey,
  buildHlsEventPlaylist,
  buildInitSegmentKey,
  buildPlaylistKey,
  buildPlaylistUri,
  type MediaChunkInput,
  type MediaPackagingFinalAudio,
  type MediaPackagingResult,
  type StreamBatchPackagingResult,
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

export class EmptyMediaChunkInputError extends Error {
  readonly code = "empty_media_chunk_input";

  constructor() {
    super("At least one chunk is required for media packaging.");
    this.name = "EmptyMediaChunkInputError";
  }
}

export class UnsupportedChunkMediaFormatError extends Error {
  readonly code = "unsupported_chunk_media_format";

  constructor(
    readonly index: number,
    readonly format: string,
  ) {
    super(`Unsupported chunk media format at index ${index}: ${format}.`);
    this.name = "UnsupportedChunkMediaFormatError";
  }
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
  packageStreamBatch(
    jobId: string,
    batchStartChunkIndex: number,
    chunks: readonly MediaChunkInput[],
  ): Promise<StreamBatchPackagingResult>;
  packageFinalAudio(
    jobId: string,
    chunks: readonly MediaChunkInput[],
  ): Promise<MediaPackagingFinalAudio>;
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
    async packageStreamBatch(jobId, batchStartChunkIndex, chunks) {
      assertChunks(chunks);
      const workingDir = await mkdtemp(join(tmpdir(), "hear-it-packager-"));

      try {
        const { concatListPath, outputsDir } = await stageWorkingInputs(chunks, workingDir);
        const hlsPlaylistPath = join(outputsDir, "playlist.m3u8");
        const hlsInitSegmentPath = join(outputsDir, "init.mp4");
        const hlsSegmentPattern = join(outputsDir, "chunk-%04d.m4s");

        await runFfmpegCommand(commandRunner, ffmpegPath, [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatListPath,
          "-c:a",
          "aac",
          "-ar",
          String(chunks[0]!.chunkMedia.sampleRateHz),
          "-ac",
          String(chunks[0]!.chunkMedia.channelCount),
          "-f",
          "hls",
          "-hls_playlist_type",
          "event",
          "-hls_segment_type",
          "fmp4",
          "-hls_fmp4_init_filename",
          "init.mp4",
          "-hls_segment_filename",
          hlsSegmentPattern,
          hlsPlaylistPath,
        ]);

        const rawPlaylistText = (await readFile(hlsPlaylistPath)).toString("utf8");
        const initSegmentData = await readFile(hlsInitSegmentPath);
        const playlistSegments = parsePlaylistSegments(rawPlaylistText);
        const initSegmentKey = buildBatchInitSegmentKey(jobId, batchStartChunkIndex);

        const segments = await Promise.all(
          playlistSegments.map(async (segment) => {
            const segmentPath = join(outputsDir, segment.fileName);
            const audioData = await readFile(segmentPath);
            const key = buildBatchSegmentKey(jobId, batchStartChunkIndex, segment.index);
            return {
              index: segment.index,
              key,
              uri: buildPlaylistUri(jobId, key),
              audioData,
              contentType: "video/mp4" as const,
              durationSeconds: segment.durationSeconds,
            };
          }),
        );

        return {
          initSegment: {
            key: initSegmentKey,
            uri: buildPlaylistUri(jobId, initSegmentKey),
            audioData: initSegmentData,
            contentType: "video/mp4",
          },
          segments,
          batchDurationSeconds: segments.reduce(
            (total, segment) => total + segment.durationSeconds,
            0,
          ),
        };
      } finally {
        await rm(workingDir, { recursive: true, force: true });
      }
    },

    async packageFinalAudio(jobId, chunks) {
      assertChunks(chunks);
      const workingDir = await mkdtemp(join(tmpdir(), "hear-it-packager-"));

      try {
        const { concatListPath, outputsDir } = await stageWorkingInputs(chunks, workingDir);
        const finalAudioPath = join(outputsDir, "final.mp3");

        await runFfmpegCommand(commandRunner, ffmpegPath, [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatListPath,
          "-c:a",
          "libmp3lame",
          "-ar",
          String(chunks[0]!.chunkMedia.sampleRateHz),
          "-ac",
          String(chunks[0]!.chunkMedia.channelCount),
          finalAudioPath,
        ]);

        const finalAudioData = await readFile(finalAudioPath);
        const inspectedFinalAudio = inspectMP3Audio(finalAudioData);
        const durationSeconds =
          inspectedFinalAudio?.durationSeconds ??
          chunks.reduce((total, chunk) => total + chunk.chunkMedia.durationSeconds, 0);

        return {
          key: buildFinalAudioKey(jobId),
          audioData: finalAudioData,
          contentType: "audio/mpeg",
          format: "mp3",
          durationSeconds,
          sampleRateHz: inspectedFinalAudio?.sampleRateHz ?? chunks[0]!.chunkMedia.sampleRateHz,
          channelCount: inspectedFinalAudio?.channelCount ?? chunks[0]!.chunkMedia.channelCount,
        };
      } finally {
        await rm(workingDir, { recursive: true, force: true });
      }
    },

    async packageMedia(jobId, chunks) {
      const streamBatch = await this.packageStreamBatch(jobId, 0, chunks);
      const finalAudio = await this.packageFinalAudio(jobId, chunks);
      const startupBuffer = {
        bufferedSeconds: streamBatch.batchDurationSeconds,
        isPlayable: streamBatch.batchDurationSeconds >= startupBufferSeconds,
      };

      return {
        playlist: {
          key: buildPlaylistKey(jobId),
          audioData: Buffer.from(
            buildHlsEventPlaylist(jobId, chunks, {
              startupBufferPlayable: startupBuffer.isPlayable,
            }),
            "utf8",
          ),
          contentType: "application/vnd.apple.mpegurl",
        },
        initSegment: {
          key: buildInitSegmentKey(jobId),
          audioData: streamBatch.initSegment.audioData,
          contentType: streamBatch.initSegment.contentType,
        },
        segments: streamBatch.segments.map((segment, index) => ({
          index,
          key: buildChunkMediaKey(jobId, index),
          audioData: segment.audioData,
          contentType: segment.contentType,
          durationSeconds: segment.durationSeconds,
        })),
        startupBuffer,
        finalAudio,
      };
    },
  };
}

type PlaylistSegmentReference = {
  index: number;
  fileName: string;
  durationSeconds: number;
};

function parsePlaylistSegments(playlistText: string): PlaylistSegmentReference[] {
  const segments: PlaylistSegmentReference[] = [];
  const lines = playlistText.split(/\r?\n/);
  let pendingDurationSeconds: number | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      const durationToken = line.slice("#EXTINF:".length).split(",", 1)[0];
      const durationSeconds = Number(durationToken);
      pendingDurationSeconds = Number.isFinite(durationSeconds) ? durationSeconds : 0;
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    const fileName = line.split("/").at(-1) ?? line;
    const indexMatch = fileName.match(/^chunk-(\d+)\.m4s$/);
    if (!indexMatch) {
      continue;
    }

    segments.push({
      index: Number(indexMatch[1]),
      fileName,
      durationSeconds: pendingDurationSeconds ?? 0,
    });
    pendingDurationSeconds = null;
  }

  return segments;
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

async function stageWorkingInputs(
  chunks: readonly MediaChunkInput[],
  workingDir: string,
): Promise<{ concatListPath: string; outputsDir: string }> {
  const inputsDir = join(workingDir, "inputs");
  const outputsDir = join(workingDir, "outputs");
  await mkdir(inputsDir, { recursive: true });
  await mkdir(outputsDir, { recursive: true });

  const stagedInputs = await stageChunkInputs(chunks, inputsDir);
  const concatListPath = join(workingDir, "inputs.txt");
  await writeFile(
    concatListPath,
    stagedInputs.map((input) => `file '${escapeConcatPath(input.path)}'`).join("\n"),
  );

  return { concatListPath, outputsDir };
}

async function stageChunkInputs(
  chunks: readonly MediaChunkInput[],
  inputsDir: string,
): Promise<Array<{ index: number; path: string }>> {
  const staged: Array<{ index: number; path: string }> = [];

  for (const chunk of chunks) {
    const inputPath = join(
      inputsDir,
      `chunk-${chunk.index.toString().padStart(4, "0")}.${chunk.chunkMedia.format}`,
    );
    await writeFile(inputPath, chunk.chunkMedia.audioData);
    staged.push({ index: chunk.index, path: inputPath });
  }

  return staged;
}

function assertChunks(chunks: readonly MediaChunkInput[]): void {
  if (chunks.length === 0) {
    throw new EmptyMediaChunkInputError();
  }

  for (const chunk of chunks) {
    assertSupportedChunkMedia(chunk);
  }
}

function assertSupportedChunkMedia(chunk: MediaChunkInput): void {
  if (chunk.chunkMedia.format !== "mp3" || chunk.chunkMedia.contentType !== "audio/mpeg") {
    throw new UnsupportedChunkMediaFormatError(chunk.index, chunk.chunkMedia.format);
  }
}

function escapeConcatPath(path: string): string {
  return path.replace(/'/g, "'\\''");
}

function isMissingBinaryError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
