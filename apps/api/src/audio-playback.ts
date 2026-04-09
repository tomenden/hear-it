export type PublicAudioState = "queued" | "processing" | "ready" | "failed";

export type PreferredPlaybackMode = "none" | "stream" | "final";

export type InternalAudioState =
  | "queued"
  | "normalizing"
  | "chunking"
  | "synthesizing"
  | "packaging_stream"
  | "finalizing"
  | "completed"
  | "failed";

export interface PlaybackStreamSource {
  playlistUrl: string;
  availableDurationSeconds: number;
  liveEdgeUpdatedAt: string;
  isComplete: boolean;
}

export interface PlaybackFinalSource {
  audioUrl: string;
  durationSeconds: number;
  fileName: string;
}

export interface PlaybackDescriptor {
  preferredModeForNewSessions: PreferredPlaybackMode;
  isPlayable: boolean;
  stream: PlaybackStreamSource | null;
  final: PlaybackFinalSource | null;
  errorMessage: string | null;
}

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
      preferredModeForNewSessions: "none",
      isPlayable: false,
      stream: null,
      final: null,
      errorMessage: job.error ?? "Audio generation failed.",
    };
  }

  const canonicalCompletedDurationSeconds =
    job.state === "completed" && typeof job.durationSeconds === "number"
      ? job.durationSeconds
      : job.availableDurationSeconds;

  const streamSource =
    job.streamPlaylistUrl && job.liveEdgeUpdatedAt
      ? {
          playlistUrl: job.streamPlaylistUrl,
          availableDurationSeconds: canonicalCompletedDurationSeconds,
          liveEdgeUpdatedAt: job.liveEdgeUpdatedAt,
          isComplete: job.state === "completed",
        }
      : null;

  const finalSource = job.finalAudioUrl
    ? {
        audioUrl: job.finalAudioUrl,
        durationSeconds: job.durationSeconds ?? canonicalCompletedDurationSeconds,
        fileName: buildFileName(job.title),
      }
    : null;

  if (finalSource || streamSource) {
    return {
      preferredModeForNewSessions: finalSource ? "final" : "stream",
      isPlayable: true,
      stream: streamSource,
      final: finalSource,
      errorMessage: null,
    };
  }

  return {
    preferredModeForNewSessions: "none",
    isPlayable: false,
    stream: null,
    final: null,
    errorMessage: null,
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
