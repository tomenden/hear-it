import { describe, expect, it } from "vitest";

import {
  mapJobToPlaybackDescriptor,
  mapInternalStateToPublicState,
} from "./audio-playback.js";

describe("mapInternalStateToPublicState", () => {
  it("maps every internal state to the expected public state", () => {
    expect(mapInternalStateToPublicState("queued")).toBe("queued");
    expect(mapInternalStateToPublicState("normalizing")).toBe("processing");
    expect(mapInternalStateToPublicState("chunking")).toBe("processing");
    expect(mapInternalStateToPublicState("synthesizing")).toBe("processing");
    expect(mapInternalStateToPublicState("packaging_stream")).toBe("processing");
    expect(mapInternalStateToPublicState("finalizing")).toBe("processing");
    expect(mapInternalStateToPublicState("completed")).toBe("ready");
    expect(mapInternalStateToPublicState("failed")).toBe("failed");
  });
});

describe("mapJobToPlaybackDescriptor", () => {
  it("returns preparing before startup buffer is ready", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "synthesizing",
      streamPlaylistUrl: null,
      finalAudioUrl: null,
      availableDurationSeconds: 0,
      durationSeconds: null,
      title: "Example",
      error: null,
    });

    expect(playback).toEqual({
      mode: "preparing",
      isPlayable: false,
      availableDurationSeconds: 0,
      liveEdgeUpdatedAt: null,
    });
  });

  it("returns streaming when the playlist and live edge are present", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "packaging_stream",
      streamPlaylistUrl: "https://example.com/live.m3u8",
      finalAudioUrl: null,
      availableDurationSeconds: 27,
      durationSeconds: null,
      title: "Example",
      error: null,
      liveEdgeUpdatedAt: "2026-04-04T20:30:00.000Z",
    });

    expect(playback).toEqual({
      mode: "streaming",
      isPlayable: true,
      playlistUrl: "https://example.com/live.m3u8",
      availableDurationSeconds: 27,
      liveEdgeUpdatedAt: "2026-04-04T20:30:00.000Z",
    });
  });

  it("returns final when the final asset is present", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "completed",
      streamPlaylistUrl: "https://example.com/live.m3u8",
      finalAudioUrl: "https://cdn.example.com/final.mp3",
      availableDurationSeconds: 27,
      durationSeconds: 42,
      title: 'Example: "Best/Audio"*?',
      error: null,
      liveEdgeUpdatedAt: "2026-04-04T20:30:00.000Z",
    });

    expect(playback).toEqual({
      mode: "final",
      isPlayable: true,
      audioUrl: "https://cdn.example.com/final.mp3",
      durationSeconds: 42,
      fileName: "Example BestAudio.mp3",
    });
  });

  it("returns failed with the job error message", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "failed",
      streamPlaylistUrl: null,
      finalAudioUrl: null,
      availableDurationSeconds: 0,
      durationSeconds: null,
      title: "Example",
      error: "Something went wrong.",
    });

    expect(playback).toEqual({
      mode: "failed",
      isPlayable: false,
      errorMessage: "Something went wrong.",
    });
  });

  it("falls back to a safe filename when the title sanitizes to empty", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "completed",
      streamPlaylistUrl: null,
      finalAudioUrl: "https://cdn.example.com/final.mp3",
      availableDurationSeconds: 27,
      durationSeconds: 42,
      title: '"/\\:*?"<>|',
      error: null,
      liveEdgeUpdatedAt: "2026-04-04T20:30:00.000Z",
    });

    expect(playback).toEqual({
      mode: "final",
      isPlayable: true,
      audioUrl: "https://cdn.example.com/final.mp3",
      durationSeconds: 42,
      fileName: "audio.mp3",
    });
  });

  it("does not fabricate a live edge timestamp when the streaming url exists without one", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "synthesizing",
      streamPlaylistUrl: "https://example.com/live.m3u8",
      finalAudioUrl: null,
      availableDurationSeconds: 0,
      durationSeconds: null,
      title: "Example",
      error: null,
      liveEdgeUpdatedAt: null,
    });

    expect(playback).toEqual({
      mode: "preparing",
      isPlayable: false,
      availableDurationSeconds: 0,
      liveEdgeUpdatedAt: null,
    });
  });
});
