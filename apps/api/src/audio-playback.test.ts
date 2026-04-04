import { describe, expect, it } from "vitest";

import {
  mapJobToPlaybackDescriptor,
  mapInternalStateToPublicState,
} from "./audio-playback.js";

describe("mapInternalStateToPublicState", () => {
  it("maps synthesizing to processing", () => {
    expect(mapInternalStateToPublicState("synthesizing")).toBe("processing");
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
});
