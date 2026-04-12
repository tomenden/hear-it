import { describe, expect, it, vi } from "vitest";

import { mapInternalStateToPublicState, mapJobToPlaybackDescriptor } from "./audio-playback.js";
import {
  buildFinalAudioKey,
  buildJobMediaPrefix,
  type MediaChunkInput,
  type MediaPackagingFinalAudio,
} from "./media-packager.js";
import { createJobPipeline } from "./job-pipeline.js";
import type { AudioStore } from "./storage.js";
import type { AudioJob, AudioRenderResult, ExtractedArticle, SpeechOptions } from "./types.js";
import type { SpeechProvider, SpeechSynthesisContext } from "./tts.js";
import type { FfmpegMediaPackager } from "./ffmpeg-media-packager.js";

class RecordingAudioStore implements AudioStore {
  readonly puts: string[] = [];
  readonly deletedPrefixes: string[] = [];
  onPut?: (key: string) => void;
  private readonly blobs = new Map<string, Buffer>();

  async check(): Promise<void> {}

  async put(
    key: string,
    data: Buffer,
    _contentType?: string,
    _options?: { overwrite?: boolean },
  ): Promise<string> {
    this.puts.push(key);
    this.onPut?.(key);
    this.blobs.set(key, Buffer.from(data));
    return `/audio/${key}`;
  }

  async head(key: string): Promise<string | null> {
    return this.blobs.has(key) ? `/audio/${key}` : null;
  }

  async get(key: string): Promise<Buffer | null> {
    return this.blobs.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async deletePrefix(prefix: string): Promise<void> {
    this.deletedPrefixes.push(prefix);
    for (const key of Array.from(this.blobs.keys())) {
      if (key === prefix || key.startsWith(`${prefix}/`)) {
        this.blobs.delete(key);
      }
    }
  }

  seed(key: string, value: Buffer): void {
    this.blobs.set(key, value);
  }

  has(key: string): boolean {
    return this.blobs.has(key);
  }
}

class IndexedSpeechProvider implements SpeechProvider {
  readonly name = "indexed-test";
  readonly calls: number[] = [];

  constructor(
    private readonly segments: Array<{
      durationSeconds: number;
      delayMs?: number;
    }>,
  ) {}

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    _text: string,
    _speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const match = context.fileKey?.match(/chunk-(\d+)\.mp3$/);
    const index = match ? Number(match[1]) : this.calls.length;
    const segment = this.segments[index];

    if (!segment) {
      throw new Error(`Unexpected chunk synthesis request for index ${index}.`);
    }

    this.calls.push(index);

    if (segment.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, segment.delayMs));
    }

    const audioData = Buffer.from(`ID3chunk-${index}`);
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, audioData, "audio/mpeg")
        : null;

    return {
      audioUrl,
      audioSegments: audioUrl
        ? [{ url: audioUrl, durationSeconds: segment.durationSeconds }]
        : [],
      durationSeconds: segment.durationSeconds,
      audioData,
      contentType: "audio/mpeg",
      chunkMedia: {
        audioData,
        format: "mp3",
        contentType: "audio/mpeg",
        durationSeconds: segment.durationSeconds,
        sampleRateHz: 44_100,
        channelCount: 1,
      },
    };
  }
}

class RecordingPackager {
  readonly calls: Array<{
    kind: "final";
    jobId: string;
    chunks: readonly MediaChunkInput[];
  }> = [];
  private attempts = 0;

  constructor(
    private readonly options: {
      failAttempts?: number;
    } = {},
  ) {}

  async packageFinalAudio(
    jobId: string,
    chunks: readonly MediaChunkInput[],
  ): Promise<MediaPackagingFinalAudio> {
    this.calls.push({ kind: "final", jobId, chunks });
    this.attempts += 1;

    if (this.attempts <= (this.options.failAttempts ?? 0)) {
      throw new Error(`packager failed attempt ${this.attempts}`);
    }

    const bufferedSeconds = chunks.reduce(
      (total, chunk) => total + chunk.chunkMedia.durationSeconds,
      0,
    );

    return {
      key: buildFinalAudioKey(jobId),
      audioData: Buffer.from(`final-${jobId}`),
      contentType: "audio/mpeg",
      format: "mp3",
      durationSeconds: bufferedSeconds,
      sampleRateHz: 44_100,
      channelCount: 1,
    };
  }
}

class UnsupportedChunkMediaSpeechProvider implements SpeechProvider {
  readonly name = "unsupported-chunk-media-test";

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    _text: string,
    _speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const audioData = Buffer.from("RIFFfakewav");
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, audioData, "audio/wav")
        : null;

    return {
      audioUrl,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds: 24 }] : [],
      durationSeconds: 24,
      audioData,
      contentType: "audio/wav",
      chunkMedia: {
        audioData,
        format: "wav",
        contentType: "audio/wav",
        durationSeconds: 24,
        sampleRateHz: 44_100,
        channelCount: 1,
      } as any,
    };
  }
}

class MissingChunkMediaSpeechProvider implements SpeechProvider {
  readonly name = "missing-chunk-media-test";

  async synthesize(
    article: ExtractedArticle,
    speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    return this.synthesizeText(article.textContent, speechOptions, context);
  }

  async synthesizeText(
    _text: string,
    _speechOptions: SpeechOptions,
    context: SpeechSynthesisContext,
  ): Promise<AudioRenderResult> {
    const audioData = Buffer.from("not-mp3");
    const audioUrl =
      context.audioStore && context.fileKey
        ? await context.audioStore.put(context.fileKey, audioData, "audio/wav")
        : null;

    return {
      audioUrl,
      audioSegments: audioUrl ? [{ url: audioUrl, durationSeconds: 24 }] : [],
      durationSeconds: 24,
      audioData,
      contentType: "audio/wav",
    };
  }
}

function createClaimedJob(overrides: Partial<AudioJob> = {}): AudioJob {
  const createdAt = "2026-04-05T10:00:00.000Z";
  const paragraph = (label: string) =>
    Array.from({ length: 64 }, (_, index) => `${label}${index}`).join(" ");

  return {
    id: "job-123",
    status: "processing",
    internalState: "queued",
    displayTitle: null,
    speechScript: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-04-05T10:30:00.000Z",
    runId: "run-1",
    attempt: 1,
    article: {
      url: "https://example.com/article",
      title: "Pipeline test article",
      byline: null,
      siteName: "Example",
      excerpt: null,
      textContent: [
        paragraph("alpha"),
        paragraph("beta"),
        paragraph("gamma"),
      ].join("\n\n"),
      wordCount: 192,
      estimatedMinutes: 3,
    },
    speechOptions: {
      voice: "alloy",
    },
    provider: "indexed-test",
    audioUrl: null,
    audioSegments: [],
    durationSeconds: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    userId: "user-123",
    ...overrides,
  };
}

function snapshotPlayback(job: AudioJob) {
  return mapJobToPlaybackDescriptor({
    state: job.internalState ?? "queued",
    finalAudioUrl: job.audioUrl,
    durationSeconds: job.durationSeconds,
    title: job.displayTitle ?? job.article.title ?? "Untitled audio",
    error: job.error,
  });
}

function createPipelineHarness(options: {
  job?: AudioJob;
  speechProvider?: SpeechProvider;
  packager?: FfmpegMediaPackager;
  audioStore?: RecordingAudioStore;
  sleep?: (ms: number) => Promise<void>;
}) {
  const job = options.job ?? createClaimedJob();
  const audioStore = options.audioStore ?? new RecordingAudioStore();
  const speechProvider =
    options.speechProvider ??
    new IndexedSpeechProvider([
      { durationSeconds: 8 },
      { durationSeconds: 8 },
      { durationSeconds: 8 },
    ]);
  const packager =
    options.packager ??
    new RecordingPackager();
  const snapshots: Array<{ job: AudioJob; playback: ReturnType<typeof snapshotPlayback> }> = [];
  const timeline: Array<
    | { type: "snapshot"; job: AudioJob; playback: ReturnType<typeof snapshotPlayback> }
    | { type: "put"; key: string }
  > = [];
  let currentJob = { ...job };
  audioStore.onPut = (key) => {
    timeline.push({ type: "put", key });
  };

  const pipeline = createJobPipeline({
    audioStore,
    speechProvider,
    mediaPackager: packager,
    sleep: options.sleep,
    onJobUpdate: async (patch) => {
      currentJob = {
        ...currentJob,
        ...patch,
        updatedAt: new Date(Date.parse(currentJob.updatedAt) + snapshots.length + 1).toISOString(),
      };
      snapshots.push({
        job: { ...currentJob },
        playback: snapshotPlayback(currentJob),
      });
      timeline.push({
        type: "snapshot",
        job: { ...currentJob },
        playback: snapshotPlayback(currentJob),
      });
    },
  });

  return {
    pipeline,
    audioStore,
    speechProvider,
    packager,
    snapshots,
    timeline,
    getCurrentJob: () => currentJob,
  };
}

describe("job pipeline", () => {
  it("uploads the final MP3 before the public state becomes ready", async () => {
    const harness = createPipelineHarness({
      speechProvider: new IndexedSpeechProvider([{ durationSeconds: 24 }]),
      job: createClaimedJob({
        article: {
          ...createClaimedJob().article,
          textContent: Array.from({ length: 64 }, (_, index) => `solo${index}`).join(" "),
          wordCount: 64,
          estimatedMinutes: 1,
        },
      }),
    });

    await harness.pipeline.processClaimedJob(harness.getCurrentJob());

    const finalUploadIndex = harness.timeline.findIndex(
      (entry) => entry.type === "put" && entry.key.endsWith("/final.mp3"),
    );
    const readySnapshotIndex = harness.timeline.findIndex(
      (entry) =>
        entry.type === "snapshot" &&
        mapInternalStateToPublicState(entry.job.internalState ?? "queued") === "ready",
    );

    expect(finalUploadIndex).toBeGreaterThanOrEqual(0);
    expect(readySnapshotIndex).toBeGreaterThanOrEqual(0);
    expect(finalUploadIndex).toBeLessThan(readySnapshotIndex);
  });

  it("retries failed packaging up to 3 times with exponential backoff", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const harness = createPipelineHarness({
      speechProvider: new IndexedSpeechProvider([{ durationSeconds: 24 }]),
      job: createClaimedJob({
        article: {
          ...createClaimedJob().article,
          textContent: Array.from({ length: 64 }, (_, index) => `retry${index}`).join(" "),
          wordCount: 64,
          estimatedMinutes: 1,
        },
      }),
      packager: new RecordingPackager({
        failAttempts: 3,
      }),
      sleep,
    });

    await harness.pipeline.processClaimedJob(harness.getCurrentJob());

    expect(harness.getCurrentJob().status).toBe("completed");
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1_000, 2_000]);
  });

  it("deleting a job removes only the current asset tree", async () => {
    const audioStore = new RecordingAudioStore();
    const harness = createPipelineHarness({ audioStore });
    const prefix = buildJobMediaPrefix("job-123");
    audioStore.seed(`${prefix}/final.mp3`, Buffer.from("final"));
    audioStore.seed(`${prefix}/tmp/chunk-0000.mp3`, Buffer.from("temp"));
    audioStore.seed(`${prefix}/segments/chunk-0000.m4s`, Buffer.from("segment"));

    await harness.pipeline.deleteJobArtifacts("job-123");

    expect(audioStore.deletedPrefixes).toEqual([prefix]);
    expect(audioStore.has(`${prefix}/final.mp3`)).toBe(false);
    expect(audioStore.has(`${prefix}/tmp/chunk-0000.mp3`)).toBe(false);
    expect(audioStore.has(`${prefix}/segments/chunk-0000.m4s`)).toBe(false);
  });

  it("preserves active partial progress across retries and resume", async () => {
    const audioStore = new RecordingAudioStore();
    const resumedJob = createClaimedJob({
      internalState: "synthesizing",
      displayTitle: "Resumed article",
      speechScript: [
        Array.from({ length: 64 }, (_, index) => `resume-a${index}`).join(" "),
        Array.from({ length: 64 }, (_, index) => `resume-b${index}`).join(" "),
        Array.from({ length: 64 }, (_, index) => `resume-c${index}`).join(" "),
      ].join("\n\n"),
      audioSegments: [
        {
          url: "/audio/jobs/job-123/tmp/chunk-0000.mp3",
          durationSeconds: 12,
          sampleRateHz: 24_000,
          channelCount: 2,
        },
      ],
    });
    audioStore.seed("jobs/job-123/tmp/chunk-0000.mp3", Buffer.from("ID3chunk-0"));
    const speechProvider = new IndexedSpeechProvider([
      { durationSeconds: 12 },
      { durationSeconds: 11 },
      { durationSeconds: 10 },
    ]);
    const harness = createPipelineHarness({
      job: resumedJob,
      audioStore,
      speechProvider,
    });

    await harness.pipeline.processClaimedJob(resumedJob);

    expect(speechProvider.calls).not.toContain(0);
    expect(harness.getCurrentJob().status).toBe("completed");
    expect(harness.getCurrentJob().audioSegments).toHaveLength(3);
    expect(harness.getCurrentJob().durationSeconds).toBe(33);
    const packager = harness.packager as RecordingPackager;
    expect(packager.calls[0]).toMatchObject({
      kind: "final",
      chunks: [
        {
          index: 0,
          chunkMedia: {
            sampleRateHz: 24_000,
            channelCount: 2,
          },
        },
        {
          index: 1,
        },
        {
          index: 2,
        },
      ],
    });
  });

  it("fails fast when a speech provider returns unsupported chunk media", async () => {
    const harness = createPipelineHarness({
      speechProvider: new UnsupportedChunkMediaSpeechProvider(),
      job: createClaimedJob({
        article: {
          ...createClaimedJob().article,
          textContent: Array.from({ length: 64 }, (_, index) => `wav${index}`).join(" "),
          wordCount: 64,
          estimatedMinutes: 1,
        },
      }),
    });

    await harness.pipeline.processClaimedJob(harness.getCurrentJob());

    expect(harness.getCurrentJob().status).toBe("failed");
    expect(harness.getCurrentJob().error).toContain("Unsupported chunk media");
  });

  it("fails fast when fallback chunk media is not audio/mpeg", async () => {
    const harness = createPipelineHarness({
      speechProvider: new MissingChunkMediaSpeechProvider(),
      job: createClaimedJob({
        article: {
          ...createClaimedJob().article,
          textContent: Array.from({ length: 64 }, (_, index) => `fallback${index}`).join(" "),
          wordCount: 64,
          estimatedMinutes: 1,
        },
      }),
    });

    await harness.pipeline.processClaimedJob(harness.getCurrentJob());

    expect(harness.getCurrentJob().status).toBe("failed");
    expect(harness.getCurrentJob().error).toContain("Unsupported chunk media");
  });
});
