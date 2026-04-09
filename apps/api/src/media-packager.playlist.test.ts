import { describe, expect, it } from "vitest";

import { appendBatchToHlsEventPlaylist } from "./media-packager.js";

describe("appendBatchToHlsEventPlaylist", () => {
  it("creates an append-only event playlist that retains earlier batches and adds discontinuities for later ones", () => {
    const firstPublish = appendBatchToHlsEventPlaylist(null, {
      initSegmentUri: "segments/batch-0000/init.mp4",
      segments: [
        {
          uri: "segments/batch-0000/chunk-0000.m4s",
          durationSeconds: 12.25,
        },
      ],
      startupBufferPlayable: true,
    });

    const secondPublish = appendBatchToHlsEventPlaylist(firstPublish, {
      initSegmentUri: "segments/batch-0001/init.mp4",
      segments: [
        {
          uri: "segments/batch-0001/chunk-0000.m4s",
          durationSeconds: 9.5,
        },
      ],
    });

    expect(firstPublish).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
    expect(firstPublish).toContain('#EXT-X-MAP:URI="segments/batch-0000/init.mp4"');
    expect(firstPublish).toContain("segments/batch-0000/chunk-0000.m4s");
    expect(firstPublish).not.toContain("#EXT-X-DISCONTINUITY");

    expect(secondPublish).toContain("segments/batch-0000/chunk-0000.m4s");
    expect(secondPublish).toContain("#EXT-X-DISCONTINUITY");
    expect(secondPublish).toContain('#EXT-X-MAP:URI="segments/batch-0001/init.mp4"');
    expect(secondPublish).toContain("segments/batch-0001/chunk-0000.m4s");
    expect(secondPublish).toContain("#EXT-X-TARGETDURATION:13");
    expect(secondPublish).not.toContain("#EXT-X-ENDLIST");
  });

  it("can close the playlist without rewriting earlier batches", () => {
    const playlist = appendBatchToHlsEventPlaylist(null, {
      initSegmentUri: "segments/batch-0000/init.mp4",
      segments: [
        {
          uri: "segments/batch-0000/chunk-0000.m4s",
          durationSeconds: 8,
        },
      ],
      startupBufferPlayable: true,
    });

    const closedPlaylist = appendBatchToHlsEventPlaylist(playlist, {
      initSegmentUri: "segments/batch-0001/init.mp4",
      segments: [
        {
          uri: "segments/batch-0001/chunk-0000.m4s",
          durationSeconds: 11,
        },
      ],
      closePlaylist: true,
    });

    expect(closedPlaylist).toContain("segments/batch-0000/chunk-0000.m4s");
    expect(closedPlaylist).toContain("segments/batch-0001/chunk-0000.m4s");
    expect(closedPlaylist.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});
