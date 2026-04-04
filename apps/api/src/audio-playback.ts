export type PublicAudioState = "queued" | "processing" | "ready" | "failed";

export type PlaybackMode = "preparing" | "streaming" | "final" | "failed";

export type InternalAudioState =
  | "queued"
  | "normalizing"
  | "chunking"
  | "synthesizing"
  | "packaging_stream"
  | "finalizing"
  | "completed"
  | "failed";

export interface PlaybackDescriptorPreparing {
  mode: "preparing";
  isPlayable: false;
  availableDurationSeconds: number;
  liveEdgeUpdatedAt: string | null;
}

export interface PlaybackDescriptorStreaming {
  mode: "streaming";
  isPlayable: true;
  playlistUrl: string;
  availableDurationSeconds: number;
  liveEdgeUpdatedAt: string;
}

export interface PlaybackDescriptorFinal {
  mode: "final";
  isPlayable: true;
  audioUrl: string;
  durationSeconds: number;
  fileName: string;
}

export interface PlaybackDescriptorFailed {
  mode: "failed";
  isPlayable: false;
  errorMessage: string;
}

export type PlaybackDescriptor =
  | PlaybackDescriptorPreparing
  | PlaybackDescriptorStreaming
  | PlaybackDescriptorFinal
  | PlaybackDescriptorFailed;

export interface JobPlaybackSource {
  state: InternalAudioState;
  streamPlaylistUrl: string | null;
  finalAudioUrl: string | null;
  availableDurationSeconds: number;
  durationSeconds: number | null;
  title: string;
  error: string | null;
  liveEdgeUpdatedAt?: string | null;
}

export function mapInternalStateToPublicState(state: InternalAudioState): PublicAudioState {
  switch (state) {
    case "queued":
      return "queued";
    case "normalizing":
    case "chunking":
    case "synthesizing":
    case "packaging_stream":
    case "finalizing":
      return "processing";
    case "completed":
      return "ready";
    case "failed":
      return "failed";
    default:
      return assertNever(state);
  }
}

export function mapJobToPlaybackDescriptor(job: JobPlaybackSource): PlaybackDescriptor {
  if (job.state === "failed") {
    return {
      mode: "failed",
      isPlayable: false,
      errorMessage: job.error ?? "Audio generation failed.",
    };
  }

  if (job.finalAudioUrl) {
    return {
      mode: "final",
      isPlayable: true,
      audioUrl: job.finalAudioUrl,
      durationSeconds: job.durationSeconds ?? job.availableDurationSeconds,
      fileName: buildFileName(job.title),
    };
  }

  if (job.streamPlaylistUrl && job.liveEdgeUpdatedAt) {
    return {
      mode: "streaming",
      isPlayable: true,
      playlistUrl: job.streamPlaylistUrl,
      availableDurationSeconds: job.availableDurationSeconds,
      liveEdgeUpdatedAt: job.liveEdgeUpdatedAt,
    };
  }

  return {
    mode: "preparing",
    isPlayable: false,
    availableDurationSeconds: job.availableDurationSeconds,
    liveEdgeUpdatedAt: job.liveEdgeUpdatedAt ?? null,
  };
}

function buildFileName(title: string): string {
  const trimmedTitle = title.trim();
  const safeBaseName = (trimmedTitle || "audio")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return `${safeBaseName || "audio"}.mp3`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled audio playback state: ${String(value)}`);
}
