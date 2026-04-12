export type PublicAudioState = "queued" | "processing" | "ready" | "failed";

export type InternalAudioState =
  | "queued"
  | "normalizing"
  | "chunking"
  | "synthesizing"
  | "packaging"
  | "completed"
  | "failed";

export interface PlaybackFinalSource {
  audioUrl: string;
  durationSeconds: number;
  fileName: string;
}

export interface PlaybackDescriptor {
  isPlayable: boolean;
  final: PlaybackFinalSource | null;
  errorMessage: string | null;
}

export interface JobPlaybackSource {
  state: InternalAudioState;
  finalAudioUrl: string | null;
  durationSeconds: number | null;
  title: string;
  error: string | null;
}

export function mapInternalStateToPublicState(state: InternalAudioState): PublicAudioState {
  switch (state) {
    case "queued":
      return "queued";
    case "normalizing":
    case "chunking":
    case "synthesizing":
    case "packaging":
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
      isPlayable: false,
      final: null,
      errorMessage: job.error ?? "Audio generation failed.",
    };
  }

  const finalSource = job.finalAudioUrl
    ? {
        audioUrl: job.finalAudioUrl,
        durationSeconds: job.durationSeconds ?? 0,
        fileName: buildFileName(job.title),
      }
    : null;

  if (finalSource) {
    return {
      isPlayable: true,
      final: finalSource,
      errorMessage: null,
    };
  }

  return {
    isPlayable: false,
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
