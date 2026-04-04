# Hear It Streaming Playback Contract

This document defines the public-facing API and client behavior for job status and playback.

The goal is to make playback behavior explicit so the client never has to infer semantics from the presence or absence of low-level fields.

## Design Principles

- the client should reason about playback through one canonical descriptor
- public job states stay coarse and stable
- backend internals stay richer than product states
- playback availability is explicit

## Public Job States

- `queued`
- `processing`
- `ready`
- `failed`

These states are product-facing. The backend may use richer internal states, but the client should not depend on them.

## Playback Descriptor

The API should expose a discriminated playback object.

```ts
type PlaybackDescriptor =
  | {
      mode: "preparing";
      isPlayable: false;
      availableDurationSeconds: 0;
      liveEdgeUpdatedAt: string | null;
    }
  | {
      mode: "streaming";
      isPlayable: true;
      playlistUrl: string;
      availableDurationSeconds: number;
      liveEdgeUpdatedAt: string;
    }
  | {
      mode: "final";
      isPlayable: true;
      audioUrl: string;
      durationSeconds: number;
      fileName: string;
    }
  | {
      mode: "failed";
      isPlayable: false;
      errorMessage: string;
    };
```

## Audio Job Response

```ts
type AudioJobResponse = {
  id: string;
  title: string;
  state: "queued" | "processing" | "ready" | "failed";
  playback: PlaybackDescriptor;
  progress: {
    chunksTotal: number | null;
    chunksReady: number;
    availableDurationSeconds: number;
  };
  createdAt: string;
  updatedAt: string;
};
```

## Client Rules

### While Preparing

If `playback.mode === "preparing"`:

- the play button should not start playback
- UI may say `Preparing audio`
- the user should not be promised that playback is ready yet

### While Streaming

If `playback.mode === "streaming"`:

- start a new AVPlayer item from `playlistUrl`
- treat `availableDurationSeconds` as the current playable range
- do not allow seeking beyond the available duration
- if the user tries, show soft copy such as `That part is still being generated`

### While Final

If `playback.mode === "final"`:

- start a new AVPlayer item from `audioUrl`
- full seeking is now supported
- the user-facing filename should come from `fileName`

### While Failed

If `playback.mode === "failed"`:

- do not try to start playback
- show the user-facing failure state

## Session Pinning

Once playback starts, the session stays on the asset it started with.

Rules:

- if a session started on HLS, keep it on HLS until stop, unload, or natural end
- if the job completes during playback, do not switch the current player item
- use the final MP3 only for future playback sessions

## Polling Contract

The app should use:

- HTTP polling for job state
- HLS or MP3 for audio delivery

Suggested polling behavior:

- visible processing job: every 2-3 seconds
- actively streaming and live edge moving: every 2-3 seconds
- background or non-visible state: back off hard or stop polling

## UX Semantics

### User-Facing Concepts

The app should communicate:

- `Preparing audio`
- `Generating audio`
- `Ready`
- `Failed`

The app should not communicate:

- cache status
- packaging internals
- provider identity
- backend step names such as `synthesizing`

### Seeking Before Completion

Seeking past the live edge should be treated as a normal product case, not an error.

Recommended soft copy:

- `That part is still being generated`
- `More audio is on the way`

## State Mapping

```mermaid
flowchart LR
    A["Internal pipeline states"] --> B["queued / normalizing / chunking / synthesizing / packaging_stream / finalizing / completed / failed"]
    B --> C["Public state mapping"]
    C --> D["queued / processing / ready / failed"]
    C --> E["playback descriptor"]
    E --> F["preparing / streaming / final / failed"]
```

## Future Compatibility

This contract is designed to survive:

- speech provider swaps
- storage backend changes
- introduction of local TTS
- migration of maintenance triggers

As long as the API still produces the same playback descriptor semantics, the client should not need to care about those backend changes.
