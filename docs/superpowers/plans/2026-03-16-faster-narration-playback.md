# Faster Narration Playback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player open immediately after narration creation, start playback as soon as the first playable audio is available, show `?` for duration until the full narration is finished and cached, and clearly surface in-progress, completed, and failed states.

**Architecture:** Add a segmented early-playback transport from the API to the iOS app while narration generation is still running. The app should treat duration as unknown until the final narration metadata arrives, while a foreground background-task-in-app download continues to save the finished audio locally for later playback. Keep the final-file path for caching and replay, but stop gating playback on that full-file download.

**Tech Stack:** SwiftUI, AVFoundation, Swift Testing, Node.js, Express, TypeScript, existing job/audio storage, Vitest.

---

## Current Constraints

- The app opens the player immediately, but [`AppModel.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/App/AppModel.swift) unloads the player for any job that is not `completed`.
- Playback currently requires a finished server-side MP3 plus a full device download into [`LocalNarrationAudioStore.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Services/LocalNarrationAudioStore.swift).
- The backend only exposes `/api/jobs/:jobId/audio` after job completion in [`app.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/app.ts), so there is no playable URL during `queued` or `processing`.
- The backend deletes the stored narration after a successful download, which conflicts with background caching, replay, and any remote playback handoff.
- The existing schema already has `playlistUrl` and `audioSegments`, which is a better fit for progressive playback than inventing a completely separate model.

## Approach Options

### Option A: UI-only fast open

- Open the player immediately.
- Show a richer processing state.
- Keep playback blocked until the full audio file is ready and downloaded.

**Pros:** Smallest change set.

**Cons:** Does not satisfy the core requirement of starting to listen early.

### Option B: Progressive single-stream proxy

- Add a server endpoint that proxies the provider response as it arrives.
- Start AVPlayer against that live endpoint before the final file exists.
- Continue saving the same bytes in the background and expose the completed file later.

**Pros:** Potentially faster to implement if the provider actually emits useful audio bytes early.

**Cons:** Depends on provider streaming behavior, makes cleanup and replay harder, and may still not produce meaningful early playback.

### Option C: Segmented narration pipeline using `playlistUrl` and `audioSegments`

- Split narration into segments.
- Make the first segment playable as soon as it finishes.
- Publish a playlist or ordered segment list while later segments continue rendering.
- Final duration becomes known only when all segments complete.

**Pros:** Most reliable path to true early listening, matches the existing data model, and handles mid-run failures cleanly.

**Cons:** Larger backend and player change set.

## Confirmed Product Decisions

- Foreground-first is acceptable for v1, even though it is not ideal. The implementation should not promise guaranteed completion after the app is backgrounded or killed.
- Signed or other short-lived direct media URLs are acceptable for playback. Media does not need to stay behind bearer-authenticated `AVPlayer` requests.
- If generation fails after playback already started, the app should stop auto-progression, show failure clearly, and only let already-buffered audio finish naturally if that happens without special handling.

## Recommendation

Use Option C as the primary implementation path.

Do not start with a live byte-stream proxy spike. In the current codebase that path is blocked by three concrete issues:

- the provider stack is fully buffered today
- the job pipeline only updates state after synthesis completes
- `AVPlayer` currently loads plain URLs, so authenticated `/api` playback endpoints would add another transport problem

That makes segmented playback the shortest credible route to early listening. It is more work than a UI-only change, but it is materially less speculative than retrofitting true live streaming into the current stack.

## Optional Variant: No Persistent Cloud Narration Storage

This is feasible, but it should stay an explicit design choice rather than an assumption baked into the first implementation pass.

- If early playback uses a live proxy or segmented transport successfully, narration audio does not necessarily need to be persisted in blob storage long-term.
- The app could become the system of record for completed narration audio by saving the final result only in [`LocalNarrationAudioStore.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Services/LocalNarrationAudioStore.swift).
- Even in that model, some temporary server-side buffering, fan-out, or segment retention may still be needed while playback is in progress.
- The trade-off is that replay on a second device, reinstall recovery, and recovery after interrupted downloads become weaker unless the app is willing to regenerate narration.

Treat this as a checkpoint decision after the segmented transport is working, not as a prerequisite for the feature itself.

## Chunk 1: Backend Segmented Transport

### Task 1: Create a playable segmented narration contract

**Files:**
- Modify: [`apps/api/src/tts.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/tts.ts)
- Modify: [`apps/api/src/jobs.test.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.test.ts)
- Modify: [`apps/api/src/jobs.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.ts)
- Modify: [`apps/api/src/types.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/types.ts)

- [ ] **Step 1: Add a focused test-only segmented provider scenario**

Create a mock provider in [`jobs.test.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.test.ts) that emits multiple delayed segments so the backend can expose a playable first segment before final completion.

- [ ] **Step 2: Extend the provider and job pipeline for partial results**

Add the minimal abstractions needed so [`tts.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/tts.ts) and [`jobs.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.ts) can publish progress before the full narration is finished:

- first finished segment
- current segment list
- final completion

- [ ] **Step 3: Define the first-playable threshold**

Use a representative medium article and require that the first segment becomes playable materially earlier than full completion, for example by at least 30% or at least 8-10 seconds.

- [ ] **Step 4: Run the backend tests**

Run: `npm test -- apps/api/src/jobs.test.ts`

Expected: existing tests still pass, and the new segmented test demonstrates an early-playable state before final completion.

- [ ] **Step 5: Record the contract**

Confirm the backend can expose a stable segment or playlist contract without forcing player reloads on every poll.

**Checkpoint:** Do not continue until the backend can surface a first playable segment while the job is still `processing`.

## Chunk 2: Backend Early-Playback Contract

### Task 2: Expose playback metadata before final completion

**Files:**
- Modify: [`apps/api/src/types.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/types.ts)
- Modify: [`apps/api/src/jobs.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.ts)
- Modify: [`apps/api/src/app.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/app.ts)
- Modify if needed: [`apps/api/src/storage-vercel.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/storage-vercel.ts)
- Modify if needed: [`apps/api/src/storage-fs.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/storage-fs.ts)
- Test: [`apps/api/src/jobs.test.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.test.ts)

- [ ] **Step 1: Reuse the existing job shape instead of inventing parallel fields**

Prefer:

- `playlistUrl` for the stable signed playlist URL
- `audioSegments` for segment-level readiness
- `durationSeconds = null` until narration is fully complete
- `audioDownloadPath` for final-file caching to device

- [ ] **Step 2: Make jobs transition into a “playable while processing” state**

Update [`jobs.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.ts) so a job can stay `processing` while already exposing a signed playlist or segment list with at least one playable segment.

- [ ] **Step 3: Add the early-playback endpoint**

Update [`app.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/app.ts) to expose signed direct playback URLs for:

- `GET /api/jobs/:jobId/playlist.m3u8`
- segment URLs referenced by that playlist

Do not rely on bearer-authenticated `AVPlayer` requests for v1.

- [ ] **Step 4: Stop deleting server-side audio immediately after download**

Remove the current eager cleanup in [`app.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/app.ts) after `/api/jobs/:jobId/audio` succeeds. Move cleanup to job deletion or a separate retention policy so remote playback, retry, and background caching remain valid.

- [ ] **Step 5: Keep duration intentionally unknown until the real final value exists**

Do not synthesize a fake duration for in-progress playback. The client requirement is to show `?`, not an unstable estimate.

- [ ] **Step 6: Add failure semantics**

If generation fails after playback started:

- mark the job `failed`
- preserve any useful error message
- make the playback endpoint terminate cleanly
- keep the job queryable so the client can replace the spinner with a failure state

- [ ] **Step 7: Verify the API contract**

Run: `npm test -- apps/api/src/jobs.test.ts`

Expected new assertions:

- a processing job can expose a non-null signed playlist URL
- `durationSeconds` remains `null` until completion
- final download remains available after first retrieval
- failure mid-run updates job status and error correctly

**Checkpoint:** The app should be able to poll `/api/jobs` and learn three separate facts independently:

- playback can start now
- final duration is still unknown
- final cached file is or is not ready yet

## Chunk 3: iOS Playback State and Background Download

### Task 3: Decouple playback from local-file completion

**Files:**
- Modify: [`apps/ios/HearIt/Models/AudioJob.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Models/AudioJob.swift)
- Modify: [`apps/ios/HearIt/Services/HearItAPIClient.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Services/HearItAPIClient.swift)
- Modify: [`apps/ios/HearIt/App/AppModel.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/App/AppModel.swift)
- Modify: [`apps/ios/HearIt/Services/LocalNarrationAudioStore.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Services/LocalNarrationAudioStore.swift) only if caching semantics change
- Test: create [`apps/ios/HearItTests/AppModelNarrationPlaybackTests.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearItTests/AppModelNarrationPlaybackTests.swift)

- [ ] **Step 1: Teach `AudioJob` to prefer early playback sources**

Update [`AudioJob.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Models/AudioJob.swift) so `playbackURL(relativeTo:)` prefers:

1. local cached file when present
2. early playback URL (`playlistUrl` or live stream) when the job is still processing
3. final `audioUrl` if no local cache exists

- [ ] **Step 2: Split “can present player” from “has fully cached audio”**

In [`AppModel.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/App/AppModel.swift), add separate logic for:

- `canStartPlaybackNow`
- `isDownloadingFinalAudio`
- `hasLocallyCachedAudio`

Do not reuse `hasPlayableAudio` for all three.

- [ ] **Step 3: Change `preparePlayer(for:)`**

Allow `preparePlayer(for:)` in [`AppModel.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/App/AppModel.swift) to load:

- the early remote playback URL while the job is `processing`
- the local cached file once it exists
- nothing only when the job is still waiting for its first playable chunk

- [ ] **Step 4: Keep the background final download path**

Preserve the current device caching flow, but trigger it only for the final-file path. Do not block playback on that download anymore.

- [ ] **Step 5: Handle the completion handoff without interrupting playback**

When polling updates a playing job from `processing` to `completed`:

- update the displayed duration
- keep current playback running if the remote playlist is already playing successfully
- finish the local cache in the background
- use the local file for the next open/replay instead of forcing a live swap mid-session

- [ ] **Step 6: Handle failure after playback started**

If the job flips to `failed` while the player is open:

- stop auto-resume attempts
- show a failure banner and message
- leave any already-cached file available only if it is complete and valid

- [ ] **Step 7: Add model tests**

Add Swift Testing coverage for:

- processing job with a playback URL is treated as playable
- duration stays unknown until completion
- completion updates duration and starts final download
- failure while presented clears the “in progress” affordance

Run: `xcodebuild test -project apps/ios/HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16'`

Expected: new AppModel tests pass along with existing URL/local-store tests.

**Checkpoint:** From the app’s perspective, “playable now” must no longer mean “downloaded to device.”

## Chunk 4: Player UX and Status Indicators

### Task 4: Show unknown duration and explicit in-progress/completed/failed states

**Files:**
- Modify: [`apps/ios/HearIt/Services/AudioPlayerController.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Services/AudioPlayerController.swift)
- Modify: [`apps/ios/HearIt/Features/Player/PlayerView.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Features/Player/PlayerView.swift)
- Modify: [`apps/ios/HearIt/Features/Player/MiniPlayerView.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Features/Player/MiniPlayerView.swift)
- Modify: [`apps/ios/HearIt/Features/Library/LibraryView.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Features/Library/LibraryView.swift)
- Modify: [`apps/ios/HearIt/PreviewSupport/PreviewSamples.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/PreviewSupport/PreviewSamples.swift)
- Modify: [`apps/ios/HearIt/PreviewSupport/AppModel+Preview.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/PreviewSupport/AppModel+Preview.swift)

- [ ] **Step 1: Represent unknown duration explicitly**

In [`AudioPlayerController.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Services/AudioPlayerController.swift), distinguish between:

- no duration yet
- known finite duration
- non-seekable live playback

Do not overload `0` to mean all three.

- [ ] **Step 2: Update time formatting**

In [`PlayerView.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Features/Player/PlayerView.swift), render:

- elapsed time normally
- trailing duration as `?` while final length is unknown
- disabled seek interactions until the stream becomes seekable

- [ ] **Step 3: Add explicit status copy**

Show one compact status treatment in the player and library:

- `Generating audio… playback will continue as new parts arrive`
- `Finishing download to device`
- `Ready`
- `Generation failed`

Avoid relying on `?` alone.

- [ ] **Step 4: Show a distinct “listening while generating” state**

When playback is active and the job is still `processing`, display a badge or inline message in [`PlayerView.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Features/Player/PlayerView.swift) instead of the current generic processing screen.

- [ ] **Step 5: Keep the mini player honest**

In [`MiniPlayerView.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Features/Player/MiniPlayerView.swift), show whether the current session is:

- live/in progress
- ready/cached
- failed

- [ ] **Step 6: Refresh previews**

Add preview data for:

- processing but not yet playable
- processing and already playable with unknown duration
- completed and cached
- failed after partial progress

Use [`PreviewSamples.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/PreviewSupport/PreviewSamples.swift) and [`AppModel+Preview.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/PreviewSupport/AppModel+Preview.swift).

**Checkpoint:** A tester should be able to tell, at a glance, whether the app is waiting for the first audio, currently playing while generation continues, fully ready, or failed.

## Chunk 5: End-to-End Verification

### Task 5: Verify the full experience and guard the failure paths

**Files:**
- Test: [`apps/api/src/jobs.test.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/jobs.test.ts)
- Test: [`apps/ios/HearItTests/AppModelNarrationPlaybackTests.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearItTests/AppModelNarrationPlaybackTests.swift)
- Manual QA: [`apps/ios/HearIt/Features/Player/PlayerView.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/Features/Player/PlayerView.swift)

- [ ] **Step 1: Backend regression test run**

Run: `npm test`

Expected: all backend tests pass, including new early-playback cases.

- [ ] **Step 2: iOS automated test run**

Run: `xcodebuild test -project apps/ios/HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16'`

Expected: Swift tests pass, especially the new AppModel playback-state cases.

- [ ] **Step 3: Manual simulator QA**

Validate this exact flow:

1. Create narration.
2. Player opens immediately.
3. Before first playable audio exists, player shows an in-progress waiting state.
4. As soon as playback is possible, audio starts and duration shows `?`.
5. While playback continues, job still reports `processing`.
6. When generation completes, duration updates to a real value.
7. Final device download completes without interrupting current playback.

- [ ] **Step 4: Failure-path manual QA**

Simulate a mid-generation failure and verify:

1. the spinner/progress state does not get stuck
2. the player surfaces a clear failure message
3. no infinite retry loop begins
4. the library item reflects failure on the next poll

- [ ] **Step 5: Analytics review**

Update or add analytics around:

- player opened before completion
- first-playable-audio reached
- final-download completed
- generation failed after playback began

Use existing analytics touchpoints in [`AppModel.swift`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/ios/HearIt/App/AppModel.swift) and [`analytics.ts`](/Users/tome/.dev3.0/worktrees/Users-tome-projects-hear-it/0a027efd/worktree/apps/api/src/analytics.ts) if implementation adds new events.

## Main Risks

1. **Segment generation may still be too coarse.**
If segments are too large, “playable early” may still feel slow. Segment sizing is part of the core implementation, not a tuning detail.

2. **Current cleanup behavior is incompatible with the new UX.**
The backend currently deletes audio after download. That must change before remote playback plus background caching can be reliable.

3. **Unknown-duration playback changes interaction rules.**
Seeking and skip-forward behavior are straightforward for fixed files, but not for live or partially generated playback.

4. **Failure can now happen after playback has already started.**
The current UI mostly treats failure as a pre-playback state. This feature introduces a new “failed mid-run” case that must not leave the player in a misleading ready state.

5. **Background completion on iOS is not guaranteed in v1.**
The current app stops polling when backgrounded and uses plain in-process networking. WebSockets would improve foreground updates, but they would not by themselves solve background suspension. A true background-capable design would need its own dedicated task.

## Review Checkpoints

1. **Transport checkpoint:** Confirm the segmented contract produces earlier audible playback in practice.
2. **Contract checkpoint:** Confirm the API can report playback-ready, duration-unknown, and final-download-ready independently.
3. **UX checkpoint:** Confirm the player shows `?` plus explicit in-progress messaging instead of pretending the file is complete.
4. **Completion checkpoint:** Confirm duration updates when the full narration finishes and that final-file caching does not interrupt the active session.
5. **Failure checkpoint:** Confirm mid-run failures switch the UI into a terminal state without stuck playback controls or endless retries.

## Suggested Execution Order

1. Finish the transport spike and choose Option B or C.
2. Land backend contract changes and tests.
3. Land iOS model/player state changes and tests.
4. Land UI copy and preview updates.
5. Run end-to-end verification and only then decide whether the UX is good enough for rollout.

Plan complete and saved to `docs/superpowers/plans/2026-03-16-faster-narration-playback.md`. Ready to execute after plan approval.
