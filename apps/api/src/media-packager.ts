import type { PackagerChunkMedia } from "./types.js";

export interface MediaChunkInput {
  index: number;
  chunkMedia: PackagerChunkMedia;
}

export interface MediaChunkOutput {
  index: number;
  key: string;
  uri?: string;
  audioData: Buffer;
  contentType: "video/mp4";
  durationSeconds: number;
}

export interface MediaArtifact {
  key: string;
  audioData: Buffer;
  contentType: string;
}

export interface StartupBufferEvaluation {
  bufferedSeconds: number;
  isPlayable: boolean;
}

export interface MediaPackagingFinalAudio {
  key: string;
  audioData: Buffer;
  contentType: "audio/mpeg";
  format: "mp3";
  durationSeconds: number;
  sampleRateHz: number;
  channelCount: number;
}

export interface MediaPackagingResult {
  playlist: MediaArtifact;
  initSegment: MediaArtifact;
  segments: MediaChunkOutput[];
  startupBuffer: StartupBufferEvaluation;
  finalAudio: MediaPackagingFinalAudio;
}

export interface HlsPlaylistOptions {
  startupBufferPlayable?: boolean;
}

export interface AppendOnlyPlaylistSegment {
  uri: string;
  durationSeconds: number;
}

export interface AppendOnlyPlaylistBatch {
  initSegmentUri: string;
  segments: readonly AppendOnlyPlaylistSegment[];
  startupBufferPlayable?: boolean;
  closePlaylist?: boolean;
}

export interface StreamBatchPackagingResult {
  initSegment: MediaArtifact & { uri: string };
  segments: Array<MediaChunkOutput & { uri: string }>;
  batchDurationSeconds: number;
}

export function buildJobMediaPrefix(jobId: string): string {
  return `jobs/${jobId}`;
}

export function buildChunkMediaKey(jobId: string, index: number): string {
  return `${buildJobMediaPrefix(jobId)}/segments/chunk-${index.toString().padStart(4, "0")}.m4s`;
}

export function buildBatchMediaPrefix(jobId: string, batchStartChunkIndex: number): string {
  return `${buildJobMediaPrefix(jobId)}/segments/batch-${batchStartChunkIndex
    .toString()
    .padStart(4, "0")}`;
}

export function buildBatchInitSegmentKey(jobId: string, batchStartChunkIndex: number): string {
  return `${buildBatchMediaPrefix(jobId, batchStartChunkIndex)}/init.mp4`;
}

export function buildBatchSegmentKey(
  jobId: string,
  batchStartChunkIndex: number,
  segmentIndex: number,
): string {
  return `${buildBatchMediaPrefix(jobId, batchStartChunkIndex)}/chunk-${segmentIndex
    .toString()
    .padStart(4, "0")}.m4s`;
}

export function buildInitSegmentKey(jobId: string): string {
  return `${buildJobMediaPrefix(jobId)}/segments/init.mp4`;
}

export function buildPlaylistKey(jobId: string): string {
  return `${buildJobMediaPrefix(jobId)}/playlist.m3u8`;
}

export function buildFinalAudioKey(jobId: string): string {
  return `${buildJobMediaPrefix(jobId)}/final.mp3`;
}

export function evaluateStartupBuffer(
  chunks: readonly Pick<MediaChunkInput, "chunkMedia">[],
  thresholdSeconds: number,
): StartupBufferEvaluation {
  const bufferedSeconds = chunks.reduce(
    (total, chunk) => total + chunk.chunkMedia.durationSeconds,
    0,
  );

  return {
    bufferedSeconds,
    isPlayable: bufferedSeconds >= thresholdSeconds,
  };
}

export function buildHlsEventPlaylist(
  jobId: string,
  chunks: readonly MediaChunkInput[],
  options: HlsPlaylistOptions = {},
): string {
  const segmentLines: string[] = [];
  const targetDuration = Math.max(
    1,
    Math.ceil(
      chunks.reduce(
        (maxDuration, chunk) => Math.max(maxDuration, chunk.chunkMedia.durationSeconds),
        0,
      ),
    ),
  );

  for (const chunk of chunks) {
    segmentLines.push(`#EXTINF:${chunk.chunkMedia.durationSeconds.toFixed(3)},`);
    segmentLines.push(buildChunkMediaKey(jobId, chunk.index));
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${buildInitSegmentKey(jobId)}"`,
  ];

  if (options.startupBufferPlayable) {
    lines.push("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
  }

  lines.push(...segmentLines, "#EXT-X-ENDLIST");

  return `${lines.join("\n")}\n`;
}

export function appendBatchToHlsEventPlaylist(
  existingPlaylist: string | null,
  batch: AppendOnlyPlaylistBatch,
): string {
  if (batch.segments.length === 0) {
    throw new Error("An HLS playlist batch must contain at least one segment.");
  }

  const current = parseExistingPlaylist(existingPlaylist);
  const targetDuration = Math.max(
    current.targetDuration,
    Math.ceil(
      batch.segments.reduce(
        (longest, segment) => Math.max(longest, segment.durationSeconds),
        0,
      ),
    ),
  );

  const bodyLines = [...current.bodyLines];

  if (bodyLines.length > 0) {
    bodyLines.push("#EXT-X-DISCONTINUITY");
  }

  bodyLines.push(`#EXT-X-MAP:URI="${batch.initSegmentUri}"`);

  for (const segment of batch.segments) {
    bodyLines.push(`#EXTINF:${segment.durationSeconds.toFixed(3)},`);
    bodyLines.push(segment.uri);
  }

  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${Math.max(1, targetDuration)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];

  if (current.includesStartTag || batch.startupBufferPlayable) {
    lines.push("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES");
  }

  lines.push(...bodyLines);

  if (batch.closePlaylist) {
    lines.push("#EXT-X-ENDLIST");
  }

  return `${lines.join("\n")}\n`;
}

export function finalizeHlsEventPlaylist(playlist: string): string {
  if (playlist.includes("#EXT-X-ENDLIST")) {
    return playlist.endsWith("\n") ? playlist : `${playlist}\n`;
  }

  const normalized = playlist.endsWith("\n") ? playlist : `${playlist}\n`;
  return `${normalized}#EXT-X-ENDLIST\n`;
}

export function buildPlaylistUri(jobId: string, key: string): string {
  const playlistDirectory = buildPlaylistKey(jobId).split("/").slice(0, -1).join("/");
  if (!key.startsWith(`${playlistDirectory}/`)) {
    return key;
  }

  return key.slice(`${playlistDirectory}/`.length);
}

export function inspectHlsEventPlaylist(playlist: string | null): {
  targetDuration: number;
  includesStartTag: boolean;
  bodyLines: string[];
  bufferedSeconds: number;
  isClosed: boolean;
} {
  const parsed = parseExistingPlaylist(playlist);
  return {
    ...parsed,
    isClosed: parsed.isClosed,
  };
}

function parseExistingPlaylist(playlist: string | null): {
  targetDuration: number;
  includesStartTag: boolean;
  bodyLines: string[];
  bufferedSeconds: number;
  isClosed: boolean;
} {
  if (!playlist) {
    return {
      targetDuration: 0,
      includesStartTag: false,
      bodyLines: [],
      bufferedSeconds: 0,
      isClosed: false,
    };
  }

  const bodyLines: string[] = [];
  let targetDuration = 0;
  let includesStartTag = false;
  let bufferedSeconds = 0;
  let pendingDurationSeconds: number | null = null;
  let isClosed = false;

  for (const rawLine of playlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.slice("#EXT-X-TARGETDURATION:".length)) || 0;
      continue;
    }

    if (line.startsWith("#EXT-X-START:")) {
      includesStartTag = true;
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      const durationToken = line.slice("#EXTINF:".length).split(",", 1)[0];
      const parsedDuration = Number(durationToken);
      pendingDurationSeconds = Number.isFinite(parsedDuration) ? parsedDuration : 0;
      bodyLines.push(line);
      continue;
    }

    if (
      line === "#EXTM3U" ||
      line.startsWith("#EXT-X-VERSION:") ||
      line.startsWith("#EXT-X-MEDIA-SEQUENCE:") ||
      line.startsWith("#EXT-X-PLAYLIST-TYPE:") ||
      line === "#EXT-X-INDEPENDENT-SEGMENTS" ||
      line === "#EXT-X-ENDLIST"
    ) {
      if (line === "#EXT-X-ENDLIST") {
        isClosed = true;
      }
      continue;
    }

    bodyLines.push(line);
    if (!line.startsWith("#")) {
      bufferedSeconds += pendingDurationSeconds ?? 0;
      pendingDurationSeconds = null;
    }
  }

  return {
    targetDuration,
    includesStartTag,
    bodyLines,
    bufferedSeconds,
    isClosed,
  };
}
