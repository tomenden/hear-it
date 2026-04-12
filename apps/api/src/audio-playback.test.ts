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
    expect(mapInternalStateToPublicState("packaging")).toBe("processing");
    expect(mapInternalStateToPublicState("completed")).toBe("ready");
    expect(mapInternalStateToPublicState("failed")).toBe("failed");
  });
});

describe("mapJobToPlaybackDescriptor", () => {
  it("returns not playable while audio is still processing", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "synthesizing",
      finalAudioUrl: null,
      durationSeconds: null,
      title: "Example",
      error: null,
    });

    expect(playback).toEqual({
      isPlayable: false,
      final: null,
      errorMessage: null,
    });
  });

  it("returns playable with final source when completed", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "completed",
      finalAudioUrl: "https://cdn.example.com/final.mp3",
      durationSeconds: 42,
      title: 'Example: "Best/Audio"*?',
      error: null,
    });

    expect(playback).toEqual({
      isPlayable: true,
      final: {
        audioUrl: "https://cdn.example.com/final.mp3",
        durationSeconds: 42,
        fileName: "Example BestAudio.mp3",
      },
      errorMessage: null,
    });
  });

  it("returns failed with the job error message", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "failed",
      finalAudioUrl: null,
      durationSeconds: null,
      title: "Example",
      error: "Something went wrong.",
    });

    expect(playback).toEqual({
      isPlayable: false,
      final: null,
      errorMessage: "Something went wrong.",
    });
  });

  it("falls back to a safe filename when the title sanitizes to empty", () => {
    const playback = mapJobToPlaybackDescriptor({
      state: "completed",
      finalAudioUrl: "https://cdn.example.com/final.mp3",
      durationSeconds: 42,
      title: '"/\\:*?"<>|',
      error: null,
    });

    expect(playback).toEqual({
      isPlayable: true,
      final: {
        audioUrl: "https://cdn.example.com/final.mp3",
        durationSeconds: 42,
        fileName: "audio.mp3",
      },
      errorMessage: null,
    });
  });
});
