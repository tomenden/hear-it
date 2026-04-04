import * as Sentry from "@sentry/node";

import { mapJobToPlaybackDescriptor, type PlaybackDescriptor } from "./audio-playback.js";
import {
  createFfmpegMediaPackager,
  type FfmpegMediaPackager,
} from "./ffmpeg-media-packager.js";
import {
  buildFinalAudioKey,
  buildJobMediaPrefix,
  type MediaChunkInput,
  type MediaPackagingResult,
} from "./media-packager.js";
import { buildSpeechScript } from "./speech-script.js";
import type { AudioStore } from "./storage.js";
import { chunkSpeechScript } from "./text-chunker.js";
import type { AudioJob, AudioRenderResult, PackagerChunkMedia, SpeechOptions } from "./types.js";
import type { SpeechProvider } from "./tts.js";

const DEFAULT_STARTUP_BUFFER_SECONDS = 20;
const DEFAULT_TTS_CONCURRENCY = 3;
const MAX_TTS_CONCURRENCY = 4;
const MIN_TTS_CONCURRENCY = 2;
const DEFAULT_SYNTHESIS_RETRY_COUNT = 3;
const DEFAULT_PACKAGING_RETRY_COUNT = 3;
const RETRY_BASE_DELAY_MS = 500;
const TARGET_SECONDS_PER_CHUNK = 20;

export interface JobPipelineOptions {
  audioStore: AudioStore;
  speechProvider: SpeechProvider;
  mediaPackager?: FfmpegMediaPackager;
  startupBufferSeconds?: number;
  ttsConcurrency?: number;
  synthesisRetryCount?: number;
  packagingRetryCount?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onJobUpdate?: (
    patch: Partial<AudioJob>,
    snapshot: AudioJob,
    playback: PlaybackDescriptor,
  ) => Promise<void> | void;
}

export interface JobPipelineResult {
  job: AudioJob;
  playback: PlaybackDescriptor;
}

type SynthesizedChunk = {
  index: number;
  durationSeconds: number;
  url: string;
  media: PackagerChunkMedia;
};

export function createJobPipeline(options: JobPipelineOptions) {
  const audioStore = options.audioStore;
  const speechProvider = options.speechProvider;
  const mediaPackager = options.mediaPackager ?? createFfmpegMediaPackager();
  const startupBufferSeconds =
    options.startupBufferSeconds ?? DEFAULT_STARTUP_BUFFER_SECONDS;
  const ttsConcurrency = clampTtsConcurrency(
    options.ttsConcurrency ?? getConfiguredTtsConcurrency(),
  );
  const synthesisRetryCount =
    options.synthesisRetryCount ?? DEFAULT_SYNTHESIS_RETRY_COUNT;
  const packagingRetryCount =
    options.packagingRetryCount ?? DEFAULT_PACKAGING_RETRY_COUNT;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;

  return {
    async processClaimedJob(job: AudioJob): Promise<JobPipelineResult> {
      let currentJob = { ...job };
      const synthesizedChunks = new Map<number, SynthesizedChunk>();
      let lastPackagedChunkCount = 0;
      let lastPackagingResult: MediaPackagingResult | null = null;
      let playlistUrl = currentJob.playlistUrl;
      let publishPromise = Promise.resolve();
      let nextChunkIndex = 0;
      let workerPromises: Promise<void>[] = [];

      const emitUpdate = async (patch: Partial<AudioJob>) => {
        currentJob = {
          ...currentJob,
          ...patch,
          updatedAt: now().toISOString(),
        };
        const playback = snapshotPlayback(currentJob);
        await options.onJobUpdate?.(patch, currentJob, playback);
        return playback;
      };

      const failJob = async (error: unknown) => {
        const message =
          error instanceof Error ? error.message : "Speech generation failed.";
        Sentry.captureException(error, {
          tags: {
            jobId: currentJob.id,
            voice: currentJob.speechOptions.voice,
            provider: currentJob.provider,
          },
        });
        try {
          await audioStore.deletePrefix(buildJobMediaPrefix(currentJob.id));
        } catch (cleanupError) {
          Sentry.captureException(cleanupError, {
            tags: {
              jobId: currentJob.id,
              operation: "job_cleanup_after_failure",
            },
          });
        }
        const playback = await emitUpdate({
          status: "failed",
          internalState: "failed",
          audioUrl: null,
          playlistUrl: null,
          audioSegments: [],
          availableDurationSeconds: 0,
          liveEdgeUpdatedAt: null,
          durationSeconds: null,
          error: message,
        });
        return { job: currentJob, playback };
      };

      try {
        await emitUpdate({
          status: "processing",
          internalState: "normalizing",
          error: null,
          audioUrl: currentJob.audioUrl ?? null,
          playlistUrl: currentJob.playlistUrl ?? null,
          liveEdgeUpdatedAt: currentJob.liveEdgeUpdatedAt ?? null,
          durationSeconds: null,
        });

        const speechScript =
          currentJob.speechScript &&
          typeof currentJob.displayTitle === "string" &&
          currentJob.displayTitle.trim()
            ? {
                speechScript: currentJob.speechScript,
                displayTitle: currentJob.displayTitle,
              }
            : buildSpeechScript({
                title: currentJob.article.title,
                textContent: currentJob.article.textContent,
              });

        await emitUpdate({
          displayTitle: speechScript.displayTitle,
          speechScript: speechScript.speechScript,
          internalState: "chunking",
        });

        const textChunks = chunkSpeechScript({
          script: speechScript.speechScript,
          targetSecondsPerChunk: TARGET_SECONDS_PER_CHUNK,
        });

        if (textChunks.length === 0) {
          return failJob(new Error("No playable script content was generated."));
        }

        const restoredChunks = await restorePersistedChunks(
          currentJob,
          audioStore,
          textChunks.length,
        );

        for (const chunk of restoredChunks) {
          synthesizedChunks.set(chunk.index, chunk);
        }

        nextChunkIndex = restoredChunks.length;
        playlistUrl = currentJob.playlistUrl;
        await emitUpdate({
          audioSegments: buildAudioSegments(restoredChunks),
          availableDurationSeconds: sumChunkDurations(restoredChunks),
          playlistUrl,
          internalState: "synthesizing",
        });

        const publishStreamingArtifacts = async (force = false) => {
          const contiguousChunks = getContiguousChunks(synthesizedChunks);
          if (contiguousChunks.length === 0) {
            return;
          }

          const availableDurationSeconds = sumChunkDurations(contiguousChunks);
          await emitUpdate({
            audioSegments: buildAudioSegments(contiguousChunks),
            availableDurationSeconds,
            internalState: playlistUrl ? "packaging_stream" : "synthesizing",
          });

          const shouldPublishStream =
            availableDurationSeconds >= startupBufferSeconds || force || Boolean(playlistUrl);
          if (!shouldPublishStream) {
            return;
          }

          if (!force && lastPackagedChunkCount === contiguousChunks.length && lastPackagingResult) {
            return;
          }

          await emitUpdate({ internalState: "packaging_stream" });
          const packagingResult = await retryWithBackoff(
            () =>
              mediaPackager.packageMedia(
                currentJob.id,
                contiguousChunks.map((chunk) => ({
                  index: chunk.index,
                  chunkMedia: chunk.media,
                })),
              ),
            {
              retryCount: packagingRetryCount,
              shouldRetry: () => true,
              sleep,
            },
          );

          lastPackagedChunkCount = contiguousChunks.length;
          lastPackagingResult = packagingResult;

          await audioStore.put(
            packagingResult.initSegment.key,
            packagingResult.initSegment.audioData,
            packagingResult.initSegment.contentType,
            { overwrite: true },
          );

          for (const segment of packagingResult.segments) {
            await audioStore.put(segment.key, segment.audioData, segment.contentType, {
              overwrite: true,
            });
          }

          playlistUrl = await audioStore.put(
            packagingResult.playlist.key,
            packagingResult.playlist.audioData,
            packagingResult.playlist.contentType,
            { overwrite: true },
          );
          const liveEdgeUpdatedAt = now().toISOString();

          await emitUpdate({
            playlistUrl,
            liveEdgeUpdatedAt,
            availableDurationSeconds,
            audioSegments: buildAudioSegments(contiguousChunks),
            internalState: "packaging_stream",
          });
        };

        const runWorker = async () => {
          while (true) {
            const index = nextChunkIndex;
            nextChunkIndex += 1;

            if (index >= textChunks.length) {
              return;
            }

            const chunk = textChunks[index];
            if (!chunk) {
              return;
            }

            const synthesized = await retryWithBackoff(
              () =>
                synthesizeChunk(
                  speechProvider,
                  audioStore,
                  currentJob.id,
                  index,
                  chunk.text,
                  currentJob.speechOptions,
                ),
              {
                retryCount: synthesisRetryCount,
                shouldRetry: isRetryableSynthesisError,
                sleep,
              },
            );

            synthesizedChunks.set(index, synthesized);
            publishPromise = publishPromise.then(() => publishStreamingArtifacts());
            await publishPromise;
          }
        };

        const remainingChunks = textChunks.length - restoredChunks.length;
        const workerCount =
          remainingChunks > 0
            ? Math.min(ttsConcurrency, remainingChunks)
            : 0;

        workerPromises = Array.from({ length: workerCount }, () => runWorker());
        await Promise.all(workerPromises);
        await publishPromise;

        const contiguousChunks = getContiguousChunks(synthesizedChunks);
        await emitUpdate({
          internalState: "finalizing",
          availableDurationSeconds: sumChunkDurations(contiguousChunks),
          audioSegments: buildAudioSegments(contiguousChunks),
        });
        await publishStreamingArtifacts(true);

        const finalPackagingResult =
          lastPackagingResult && lastPackagedChunkCount === contiguousChunks.length
            ? lastPackagingResult
            : await retryWithBackoff(
                () =>
                  mediaPackager.packageMedia(
                    currentJob.id,
                    contiguousChunks.map((chunk) => ({
                      index: chunk.index,
                      chunkMedia: chunk.media,
                    })),
                  ),
                {
                  retryCount: packagingRetryCount,
                  shouldRetry: () => true,
                  sleep,
                },
              );

        if (!playlistUrl) {
          await audioStore.put(
            finalPackagingResult.initSegment.key,
            finalPackagingResult.initSegment.audioData,
            finalPackagingResult.initSegment.contentType,
            { overwrite: true },
          );

          for (const segment of finalPackagingResult.segments) {
            await audioStore.put(segment.key, segment.audioData, segment.contentType, {
              overwrite: true,
            });
          }

          playlistUrl = await audioStore.put(
            finalPackagingResult.playlist.key,
            finalPackagingResult.playlist.audioData,
            finalPackagingResult.playlist.contentType,
            { overwrite: true },
          );
        }

        const finalAudioUrl = await audioStore.put(
          buildFinalAudioKey(currentJob.id),
          finalPackagingResult.finalAudio.audioData,
          finalPackagingResult.finalAudio.contentType,
          { overwrite: true },
        );

        const playback = await emitUpdate({
          status: "completed",
          internalState: "completed",
          audioUrl: finalAudioUrl,
          playlistUrl,
          liveEdgeUpdatedAt: currentJob.liveEdgeUpdatedAt ?? now().toISOString(),
          availableDurationSeconds: sumChunkDurations(contiguousChunks),
          audioSegments: buildAudioSegments(contiguousChunks),
          durationSeconds: finalPackagingResult.finalAudio.durationSeconds,
          error: null,
        });

        return {
          job: currentJob,
          playback,
        };
      } catch (error) {
        await Promise.allSettled(workerPromises);
        await Promise.allSettled([publishPromise]);
        return failJob(error);
      }
    },

    async deleteJobArtifacts(jobId: string): Promise<void> {
      await audioStore.deletePrefix(buildJobMediaPrefix(jobId));
    },
  };
}

export function buildTemporaryChunkKey(jobId: string, index: number): string {
  return `${buildJobMediaPrefix(jobId)}/tmp/chunk-${index.toString().padStart(4, "0")}.mp3`;
}

async function synthesizeChunk(
  speechProvider: SpeechProvider,
  audioStore: AudioStore,
  jobId: string,
  index: number,
  text: string,
  speechOptions: SpeechOptions,
): Promise<SynthesizedChunk> {
  const fileKey = buildTemporaryChunkKey(jobId, index);
  const result = await speechProvider.synthesizeText(text, speechOptions, {
    audioStore,
    fileKey,
  });

  const audioUrl = result.audioUrl ?? (await audioStore.head(fileKey));
  const audioData = result.audioData ?? (await audioStore.get(fileKey));

  if (!audioUrl || !audioData) {
    throw new Error("Chunk synthesis did not produce playable audio.");
  }

  return {
    index,
    url: audioUrl,
    durationSeconds: result.durationSeconds,
    media: buildPackagerChunkMedia(result, audioData),
  };
}

async function restorePersistedChunks(
  job: AudioJob,
  audioStore: AudioStore,
  maxChunkCount: number,
): Promise<SynthesizedChunk[]> {
  const restored: SynthesizedChunk[] = [];
  const persistedSegments = job.audioSegments.slice(0, maxChunkCount);

  for (let index = 0; index < persistedSegments.length; index += 1) {
    const audioData = await audioStore.get(buildTemporaryChunkKey(job.id, index));
    if (!audioData) {
      break;
    }

    const segment = persistedSegments[index];
    if (!segment) {
      break;
    }

    restored.push({
      index,
      url: segment.url,
      durationSeconds: segment.durationSeconds,
      media: {
        audioData,
        format: "mp3",
        contentType: "audio/mpeg",
        durationSeconds: segment.durationSeconds,
        sampleRateHz: 44_100,
        channelCount: 1,
      },
    });
  }

  return restored;
}

function buildPackagerChunkMedia(
  result: AudioRenderResult,
  audioData: Buffer,
): PackagerChunkMedia {
  if (result.chunkMedia) {
    if (
      result.chunkMedia.format !== "mp3" ||
      result.chunkMedia.contentType !== "audio/mpeg"
    ) {
      throw new Error(
        `Unsupported chunk media format: ${result.chunkMedia.format} (${result.chunkMedia.contentType}).`,
      );
    }

    return {
      ...result.chunkMedia,
      audioData,
    };
  }

  if (result.contentType && result.contentType !== "audio/mpeg") {
    throw new Error(
      `Unsupported chunk media format: fallback content type ${result.contentType}.`,
    );
  }

  return {
    audioData,
    format: "mp3",
    contentType: "audio/mpeg",
    durationSeconds: result.durationSeconds,
    sampleRateHz: 44_100,
    channelCount: 1,
  };
}

function getContiguousChunks(chunks: ReadonlyMap<number, SynthesizedChunk>): SynthesizedChunk[] {
  const contiguous: SynthesizedChunk[] = [];
  for (let index = 0; ; index += 1) {
    const chunk = chunks.get(index);
    if (!chunk) {
      return contiguous;
    }
    contiguous.push(chunk);
  }
}

function buildAudioSegments(chunks: readonly SynthesizedChunk[]): AudioJob["audioSegments"] {
  return chunks.map((chunk) => ({
    url: chunk.url,
    durationSeconds: chunk.durationSeconds,
  }));
}

function sumChunkDurations(chunks: readonly Pick<SynthesizedChunk, "durationSeconds">[]): number {
  return chunks.reduce((total, chunk) => total + chunk.durationSeconds, 0);
}

function snapshotPlayback(job: AudioJob): PlaybackDescriptor {
  return mapJobToPlaybackDescriptor({
    state: job.internalState ?? "queued",
    streamPlaylistUrl: job.playlistUrl,
    finalAudioUrl: job.audioUrl,
    availableDurationSeconds: job.availableDurationSeconds ?? 0,
    durationSeconds: job.durationSeconds,
    title: job.displayTitle ?? job.article.title ?? "Untitled audio",
    error: job.error,
    liveEdgeUpdatedAt: job.liveEdgeUpdatedAt ?? (job.playlistUrl ? job.updatedAt : null),
  });
}

function clampTtsConcurrency(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return DEFAULT_TTS_CONCURRENCY;
  }

  return Math.max(MIN_TTS_CONCURRENCY, Math.min(MAX_TTS_CONCURRENCY, value));
}

function getConfiguredTtsConcurrency(): number {
  const configured = Number(process.env.TTS_CONCURRENCY ?? DEFAULT_TTS_CONCURRENCY);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_TTS_CONCURRENCY;
}

async function retryWithBackoff<T>(
  action: () => Promise<T>,
  options: {
    retryCount: number;
    shouldRetry: (error: unknown) => boolean;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= options.retryCount || !options.shouldRetry(error)) {
        throw error;
      }

      await options.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      attempt += 1;
    }
  }
}

function isRetryableSynthesisError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    /bad gateway/i.test(error.message) ||
    /gateway timeout/i.test(message) ||
    /timed out/i.test(message) ||
    /timeout/i.test(message) ||
    /fetch failed/i.test(message) ||
    /econnreset/i.test(message) ||
    /eai_again/i.test(message) ||
    /temporarily unavailable/i.test(message) ||
    /openai speech generation failed: 5\d\d/i.test(message)
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
