import type { PackagerChunkMedia } from "./types.js";

export interface MediaChunkInput {
  index: number;
  chunkMedia: PackagerChunkMedia;
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

export function buildJobMediaPrefix(jobId: string): string {
  return `jobs/${jobId}`;
}

export function buildFinalAudioKey(jobId: string): string {
  return `${buildJobMediaPrefix(jobId)}/final.mp3`;
}
