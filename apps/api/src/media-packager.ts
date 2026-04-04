import type { PackagerChunkMedia } from "./types.js";

export interface MediaChunkInput {
  index: number;
  chunkMedia: PackagerChunkMedia;
}

export interface MediaChunkOutput {
  index: number;
  key: string;
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

export function buildJobMediaPrefix(jobId: string): string {
  return `jobs/${jobId}`;
}

export function buildChunkMediaKey(jobId: string, index: number): string {
  return `${buildJobMediaPrefix(jobId)}/segments/chunk-${index.toString().padStart(4, "0")}.m4s`;
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
