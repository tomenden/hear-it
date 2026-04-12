# HLS Streaming Playback — Learnings

Captured 2026-04-12 before removing streaming in favor of batch-only audio generation.
These notes are for our future selves if we ever reintroduce streaming playback.

## Architecture

The pipeline used HLS EVENT playlists with fMP4/AAC segments. As TTS chunks were
synthesized, they were transcoded to fMP4 via ffmpeg and appended to a growing playlist.
A startup buffer of ~20s was required before exposing the stream. Once all chunks were
ready, the playlist was finalized with `#EXT-X-ENDLIST` and a canonical MP3 was generated.

## Key Findings

### 1. Per-batch init segments cause silent playback

Each batch was packaged independently by ffmpeg, producing its own init segment with
codec parameters derived from `chunks[0]` of that batch. Batches were separated by
`#EXT-X-DISCONTINUITY` tags in the playlist. If OpenAI TTS returned MP3 audio with
different sample rates or channel counts across chunks, the init segments became
codec-incompatible. AVPlayer silently stopped producing audio at the discontinuity
boundary while still reporting `timeControlStatus == .playing`.

**Fix if re-implementing:** Use a single init segment for all batches. Force consistent
`-ar` and `-ac` ffmpeg params across the entire job. Avoid `#EXT-X-DISCONTINUITY` unless
the codec genuinely changes.

### 2. AVPlayer buffering looks like "stopped" to users

When AVPlayer catches up to the HLS live edge (all available segments consumed, waiting
for more), `timeControlStatus` becomes `.waitingToPlayAtSpecifiedRate`. Naively mapping
this to `isPlaying = false` makes the UI show a play button during what is actually a
temporary buffer stall. Users perceive this as broken playback.

**Fix if re-implementing:** Track `isBuffering` separately. Keep `isPlaying = true` during
buffer stalls and show a spinner/loading indicator instead.

### 3. The HLS-to-final handoff is fragile

When the finalized playlist's last segment plays, `AVPlayerItemDidPlayToEndTime` fires.
The player pauses. Transitioning to the final MP3 requires knowing whether the user was
actively listening (auto-resume) or had already finished (don't restart). This requires
tracking user-initiated vs system-initiated pauses (`wasActivelyPlaying` flag).

### 4. Reload loop at stream end

If `EXT-X-ENDLIST` is published but the backend hasn't emitted "completed" yet, the iOS
client reloads the same finalized m3u8. AVPlayer seeks near the end and immediately
triggers `didPlayToEndTime` again, creating a play/pause loop. Guard against this by
checking if `currentTime >= availableDurationSeconds - 0.5` before reloading a complete
stream.

### 5. didPlayToEndTime must be scoped to the current item

The `AVPlayerItemDidPlayToEndTime` notification observer should check
`notification.object === player.currentItem`. Registering with `object: nil` catches
notifications from replaced items, which can incorrectly trigger pause logic on the
new item.

### 6. Startup buffer of ~20s worked well

Users perceived playback starting within 10-20 seconds as responsive. This is worth
preserving if streaming is re-introduced.

## Files that contained streaming logic (for reference)

- `apps/api/src/job-pipeline.ts` — `publishStreamingArtifacts`, batch coordination
- `apps/api/src/media-packager.ts` — HLS playlist construction, batch key builders
- `apps/api/src/ffmpeg-media-packager.ts` — `packageStreamBatch`, fMP4 packaging
- `apps/api/src/audio-playback.ts` — `PlaybackStreamSource`, stream/final mode logic
- `apps/ios/HearIt/Services/AudioPlayerController.swift` — `pendingStreamContinuation` state machine
- `apps/ios/HearIt/App/AppModel.swift` — dual-mode `preparePlayer`, continuation logic
- `apps/ios/HearIt/Models/AudioPlayback.swift` — `StreamSource`, `PreferredMode`
