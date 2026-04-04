# Audio Pipeline Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current ad-hoc streaming and completed-audio pipeline with an explicit speech-script, HLS, and final-MP3 architecture that is stable, provider-flexible, and ready for production hardening.

**Architecture:** Keep Render as two services: API and worker. The worker owns speech normalization, semantic chunking, bounded-parallel synthesis, ffmpeg packaging, retries, and maintenance. The API exposes a coarse public job state plus an explicit playback descriptor, while iOS treats local storage as an invisible optimization and never switches an active HLS session to MP3 mid-playback.

**Tech Stack:** TypeScript, Node.js 24, Vitest, Postgres, Supabase Storage, ffmpeg, Swift 6, SwiftUI, AVFoundation, xcodegen, xcodebuild

**Spec:** `docs/superpowers/specs/2026-04-04-audio-pipeline-redesign-design.md`

---

## File Structure

### New API files

| File | Responsibility |
|---|---|
| `apps/api/src/audio-playback.ts` | Public playback descriptor types and mapping helpers |
| `apps/api/src/audio-playback.test.ts` | Tests for public-state and playback mapping |
| `apps/api/src/speech-script.ts` | Deterministic normalization from extracted text to speech script |
| `apps/api/src/speech-script.test.ts` | Golden tests for headings, captions, and hostile tokens |
| `apps/api/src/text-chunker.ts` | Semantic sentence/paragraph chunking using `Intl.Segmenter` |
| `apps/api/src/text-chunker.test.ts` | Tests for chunk size, ordering, and multilingual boundaries |
| `apps/api/src/media-packager.ts` | Packaging interfaces, result types, storage-key helpers |
| `apps/api/src/ffmpeg-media-packager.ts` | ffmpeg-backed HLS/final MP3 implementation |
| `apps/api/src/ffmpeg-media-packager.test.ts` | Packaging tests and command/fixture verification |
| `apps/api/src/job-pipeline.ts` | Worker runtime orchestration, retries, and heartbeat coordination |
| `apps/api/src/job-pipeline.test.ts` | Tests for startup buffer, retries, and finalization flow |
| `apps/api/src/job-events.ts` | Internal job-event types and repository helpers |
| `apps/api/src/maintenance.ts` | Reconciler, HLS cleanup, and finalization repair services |
| `apps/api/src/maintenance.test.ts` | Tests for lease expiry, cleanup, and repair behavior |
| `apps/api/src/storage-postgres.test.ts` | Focused persistence tests for leases and job events |
| `apps/api/src/app.contract.test.ts` | API response contract tests for public state and playback descriptors |

### Modified API files

| File | Change |
|---|---|
| `apps/api/src/types.ts` | Add explicit internal value objects for speech scripts, pipeline state, and chunk results |
| `apps/api/src/tts.ts` | Expand provider contract to support normalized intermediate output metadata |
| `apps/api/src/tts.test.ts` | Update provider tests for the new chunk handoff contract |
| `apps/api/src/jobs.ts` | Slim service facade that delegates runtime work to the new job pipeline |
| `apps/api/src/jobs.test.ts` | Keep service-level behavior tests best expressed at the service boundary |
| `apps/api/src/storage.ts` | Extend store interfaces for events, leases, and maintenance needs |
| `apps/api/src/storage-postgres.ts` | Add new job columns, `job_events`, and maintenance queries |
| `apps/api/src/storage-supabase.ts` | Support new key layout and public URL helpers |
| `apps/api/src/storage-supabase.test.ts` | Rename legacy fixture paths away from `narrations/` |
| `apps/api/src/app.ts` | Return explicit playback descriptors and coarse public states |
| `apps/api/src/production.ts` | Start worker-owned maintenance interval and wire new services |
| `apps/api/src/analytics.ts` | Rename event names away from `narration` |
| `apps/api/src/extractor.ts` | Rename legacy limit/error wording away from `narration` where applicable |
| `apps/api/src/extractor.test.ts` | Keep extractor copy assertions aligned with the renamed terminology |
| `apps/api/public/app.js` | Remove legacy `narration` copy in the web debug surface |
| `apps/api/public/index.html` | Remove legacy `narration` copy in the web debug surface |

### New iOS files

| File | Responsibility |
|---|---|
| `apps/ios/HearIt/Models/AudioPlayback.swift` | Playback descriptor and progress decoding model |
| `apps/ios/HearItTests/AudioJobDecodingTests.swift` | Verifies new API response decoding and mode handling |
| `apps/ios/HearItTests/AppModelAudioPlaybackSessionTests.swift` | Session-pinning and silent-local-storage tests |
| `apps/ios/HearIt/PreviewSupport/PlaybackStateSamples.swift` | Preview/sample states for preparing, streaming, final, and failed playback |

### Renamed iOS files

| Old File | New File | Responsibility |
|---|---|---|
| `apps/ios/HearIt/Services/LocalNarrationAudioStore.swift` | `apps/ios/HearIt/Services/LocalAudioAssetStore.swift` | Silent on-device storage for final audio assets and temporary HLS bundles only when needed |
| `apps/ios/HearItTests/LocalNarrationAudioStoreTests.swift` | `apps/ios/HearItTests/LocalAudioAssetStoreTests.swift` | Tests for local asset persistence and migration |
| `apps/ios/HearItTests/AppModelNarrationPlaybackTests.swift` | `apps/ios/HearItTests/AppModelAudioPlaybackTests.swift` | High-level AppModel playback flow tests |

### Modified iOS files

| File | Change |
|---|---|
| `apps/ios/HearIt/Models/AudioJob.swift` | Decode coarse public state plus nested playback descriptor |
| `apps/ios/HearIt/Services/HearItAPIClient.swift` | Consume the new API contract and rename legacy download methods |
| `apps/ios/HearIt/App/AppModel.swift` | Refactor polling, playback preparation, background final-file fetching, and remove visible cache state |
| `apps/ios/HearIt/Services/AudioPlayerController.swift` | Keep sessions pinned to the started asset and block mid-session source switching |
| `apps/ios/HearIt/Features/Player/PlayerView.swift` | Add live-edge UX and soft seek-beyond-available messaging |
| `apps/ios/HearIt/Features/Library/LibraryView.swift` | Remove caching language from rows and status copy |
| `apps/ios/HearIt/Features/Home/HomeView.swift` | Replace legacy `narration` copy with `audio` copy |
| `apps/ios/HearIt/Features/Player/MiniPlayerView.swift` | Update copy and state handling if needed |
| `apps/ios/HearIt/Services/Analytics.swift` | Rename event names away from `narration` |
| `apps/ios/project.yml` | Update file references after renames |
| `apps/ios/HearItShareExtension/ShareExtensionView.swift` | Remove legacy `narration` copy if still present |

### Docs to keep aligned after implementation

| File | Reason |
|---|---|
| `docs/architecture.md` | Keep high-level system map accurate |
| `docs/ubiquitous-language.md` | Ensure code terms match the glossary |
| `docs/audio-pipeline-architecture.md` | Update if implementation differs from target design |
| `docs/streaming-playback-contract.md` | Keep API contract examples current |

---

## Chunk 1: Backend Foundations

### Task 1: Introduce explicit public playback descriptors as isolated scaffolding

**Files:**
- Create: `apps/api/src/audio-playback.ts`
- Create: `apps/api/src/audio-playback.test.ts`

- [ ] **Step 1: Write failing tests for public-state and playback mapping**

Create `apps/api/src/audio-playback.test.ts` with cases like:

```ts
import { describe, expect, it } from "vitest";
import { mapJobToPlaybackDescriptor, mapInternalStateToPublicState } from "./audio-playback.js";

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
```

- [ ] **Step 2: Run the new test file and verify it fails**

Run:

```bash
cd apps/api && yarn test src/audio-playback.test.ts
```

Expected: FAIL because `audio-playback.ts` does not exist yet.

- [ ] **Step 3: Implement the isolated mapping module**

Create `apps/api/src/audio-playback.ts` with:

- public state union: `queued | processing | ready | failed`
- playback descriptor union: `preparing | streaming | final | failed`
- helpers that map internal worker state and persisted job fields into the public response contract

Do not wire this into `app.ts`, `jobs.ts`, or persistence yet. This task is scaffolding only; the public contract is exposed later in Task 8.

- [ ] **Step 4: Re-run the focused tests and the package build**

Run:

```bash
cd apps/api && yarn test src/audio-playback.test.ts && yarn build
```

Expected: the new playback tests pass and the package still builds.

- [ ] **Step 5: Commit the contract scaffolding**

```bash
git add apps/api/src/audio-playback.ts apps/api/src/audio-playback.test.ts
git commit -m "feat: add explicit playback descriptor scaffolding"
```

### Task 2: Add deterministic speech-script normalization

**Files:**
- Create: `apps/api/src/speech-script.ts`
- Create: `apps/api/src/speech-script.test.ts`
- Modify: `apps/api/src/types.ts`

- [ ] **Step 1: Write failing speech-script golden tests**

Create `apps/api/src/speech-script.test.ts` with cases for:

- raw URLs becoming safe spoken placeholders
- headings preserved with light cues
- meaningful image captions included
- noisy repeated separators removed
- missing title falling back to the first meaningful words

Example:

```ts
it("humanizes raw URLs without paraphrasing article meaning", () => {
  const result = buildSpeechScript({
    title: "Example",
    textContent: "Read more at https://example.com/news?id=1",
  });

  expect(result.script).not.toContain("https://");
  expect(result.script).toContain("Read more at");
});
```

- [ ] **Step 2: Run the new speech-script tests and verify they fail**

Run:

```bash
cd apps/api && yarn test src/speech-script.test.ts
```

Expected: FAIL because `buildSpeechScript` is not implemented yet.

- [ ] **Step 3: Implement a small deterministic normalization layer**

Create `apps/api/src/speech-script.ts` with:

- a `buildSpeechScript(...)` function
- explicit output fields such as `displayTitle`, `script`, `speechScriptVersion`, and normalization metadata
- small rule helpers for whitespace cleanup, caption labeling, URL humanization, and title fallback

Update `apps/api/src/types.ts` to add a dedicated `SpeechScript` value object with the exact persisted field name `speechScript`. The storage wiring for that field lands in Task 5.

Keep this module deterministic and rule-based. Do not introduce paraphrasing or model-assisted rewriting.

- [ ] **Step 4: Re-run the speech-script tests and the package build**

Run:

```bash
cd apps/api && yarn test src/speech-script.test.ts && yarn build
```

Expected: PASS and successful build.

- [ ] **Step 5: Commit the speech-script module**

```bash
git add apps/api/src/speech-script.ts apps/api/src/speech-script.test.ts apps/api/src/types.ts
git commit -m "feat: add deterministic speech script normalization"
```

### Task 3: Add semantic text chunking

**Files:**
- Create: `apps/api/src/text-chunker.ts`
- Create: `apps/api/src/text-chunker.test.ts`
- Modify: `apps/api/src/jobs.ts`

- [ ] **Step 1: Write failing chunking tests**

Create `apps/api/src/text-chunker.test.ts` with cases for:

- preserving sentence order
- preferring paragraph boundaries
- staying near the target speech window
- handling Hebrew, English, and Russian sentences without splitting inside obvious sentence units

Example:

```ts
it("keeps output ordered even when paragraphs differ in size", () => {
  const chunks = chunkSpeechScript({
    script: "Heading.\n\nFirst paragraph. Second sentence.\n\nThird paragraph.",
    targetSecondsPerChunk: 20,
  });

  expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
  expect(chunks[0]?.text).toContain("First paragraph");
});
```

- [ ] **Step 2: Run chunker tests and verify they fail**

Run:

```bash
cd apps/api && yarn test src/text-chunker.test.ts
```

Expected: FAIL because `chunkSpeechScript` is not implemented yet.

- [ ] **Step 3: Implement semantic chunking and remove the inline duplicate**

Create `apps/api/src/text-chunker.ts` with:

- sentence segmentation via `Intl.Segmenter`
- paragraph-aware grouping
- a target range of roughly 15-25 seconds per chunk
- metadata such as `index`, `text`, and estimated duration

Update `apps/api/src/jobs.ts` to remove or stop using the legacy inline chunking helper so there is only one production chunking path.

- [ ] **Step 4: Re-run focused tests and the package build**

Run:

```bash
cd apps/api && yarn test src/text-chunker.test.ts src/speech-script.test.ts src/jobs.test.ts && yarn build
```

Expected: PASS and successful build.

- [ ] **Step 5: Commit semantic chunking**

```bash
git add apps/api/src/text-chunker.ts apps/api/src/text-chunker.test.ts apps/api/src/jobs.ts
git commit -m "feat: add semantic speech chunking"
```

### Task 4: Introduce a packaging abstraction and ffmpeg-backed implementation

**Files:**
- Create: `apps/api/src/media-packager.ts`
- Create: `apps/api/src/ffmpeg-media-packager.ts`
- Create: `apps/api/src/ffmpeg-media-packager.test.ts`
- Modify: `apps/api/src/tts.ts`
- Modify: `apps/api/src/tts.test.ts`
- Modify: `apps/api/src/types.ts`

- [ ] **Step 1: Write failing packager tests**

Create `apps/api/src/ffmpeg-media-packager.test.ts` with tests for:

- stable object-key generation under `jobs/<jobId>/...`
- AAC/fMP4 HLS event playlist creation from ordered chunk inputs
- final MP3 generation metadata
- startup-buffer threshold evaluation
- ffmpeg error handling when the binary is missing or exits non-zero

Use small fixture-level tests first. Example:

```ts
it("generates stable final asset keys", () => {
  expect(buildFinalAudioKey("job-123")).toBe("jobs/job-123/final.mp3");
});
```

- [ ] **Step 2: Run the packager tests and verify they fail**

Run:

```bash
cd apps/api && yarn test src/ffmpeg-media-packager.test.ts
```

Expected: FAIL because the packager modules do not exist yet.

- [ ] **Step 3: Implement the packaging interface and ffmpeg handoff contract**

Create:

- `apps/api/src/media-packager.ts` for shared packaging types and key helpers
- `apps/api/src/ffmpeg-media-packager.ts` for the ffmpeg-backed implementation

Update `apps/api/src/types.ts` and `apps/api/src/tts.ts` so the provider contract returns an explicit chunk-oriented handoff object containing:

- `audioData`
- `format: "wav" | "pcm" | "mp3"`
- `contentType`
- `durationSeconds`
- `sampleRateHz`
- `channelCount`

This task only defines the handoff contract and packager implementation. The worker integration point in `jobs.ts` / `job-pipeline.ts` lands in Task 6.

- [ ] **Step 4: Re-run packager tests, provider tests, and the package build**

Run:

```bash
cd apps/api && yarn test src/ffmpeg-media-packager.test.ts src/tts.test.ts && yarn build
```

Expected: PASS for the new packager tests, including explicit AAC/fMP4 assertions and an ffmpeg runtime/error-path test, updated `tts.test.ts`, and successful build.

- [ ] **Step 5: Commit packaging scaffolding**

```bash
git add apps/api/src/media-packager.ts apps/api/src/ffmpeg-media-packager.ts apps/api/src/ffmpeg-media-packager.test.ts apps/api/src/tts.ts apps/api/src/tts.test.ts apps/api/src/types.ts
git commit -m "feat: add ffmpeg-backed media packaging abstraction"
```

- [ ] **Step 6: Run a Chunk 1 integration checkpoint**

Run:

```bash
cd apps/api && yarn test && yarn build
```

Expected: PASS. If this fails, fix the integration before moving to Chunk 2.

---

## Chunk 2: Worker Runtime, Storage, and Recovery

### Task 5: Extend persistence for internal state, leases, and job events

**Files:**
- Create: `apps/api/src/job-events.ts`
- Create: `apps/api/src/storage-postgres.test.ts`
- Modify: `apps/api/src/storage.ts`
- Modify: `apps/api/src/storage-postgres.ts`
- Modify: `apps/api/src/types.ts`

- [ ] **Step 1: Write failing persistence tests around events and leases**

Create `apps/api/src/storage-postgres.test.ts` with focused tests for:

- recording a `job_created` event
- claiming a job with a lease
- extending a heartbeat
- reading back recent events in order

Example:

```ts
it("records milestone events in order", async () => {
  await eventStore.append(jobID, { type: "job_created", sequenceNumber: 1 });
  await eventStore.append(jobID, { type: "chunk_ready", sequenceNumber: 2 });

  const events = await eventStore.list(jobID);
  expect(events.map((event) => event.type)).toEqual(["job_created", "chunk_ready"]);
});
```

- [ ] **Step 2: Run the failing persistence tests**

Run:

```bash
cd apps/api && yarn test src/storage-postgres.test.ts
```

Expected: FAIL because leases and event persistence are not implemented yet.

- [ ] **Step 3: Add event and lease support to storage**

Implement:

- `apps/api/src/job-events.ts` for event type definitions
- new store methods in `apps/api/src/storage.ts`
- new columns/tables in `apps/api/src/storage-postgres.ts` for:
  - internal state
  - display title
  - speech script stored under the `speech_script` column
  - available duration
  - lease owner / lease expiry
  - run ID / attempt
  - `job_events`

- [ ] **Step 4: Re-run persistence tests and the package build**

Run:

```bash
cd apps/api && yarn test src/storage-postgres.test.ts && yarn build
```

Expected: PASS and successful build.

- [ ] **Step 5: Commit persistence changes**

```bash
git add apps/api/src/job-events.ts apps/api/src/storage.ts apps/api/src/storage-postgres.ts apps/api/src/storage-postgres.test.ts apps/api/src/types.ts
git commit -m "feat: persist job events and worker leases"
```

### Task 6: Extract the worker runtime into a dedicated job pipeline module

**Files:**
- Create: `apps/api/src/job-pipeline.ts`
- Create: `apps/api/src/job-pipeline.test.ts`
- Modify: `apps/api/src/jobs.ts`
- Modify: `apps/api/src/jobs.test.ts`
- Modify: `apps/api/src/types.ts`

- [ ] **Step 1: Add failing orchestration tests for the new lifecycle**

Create `apps/api/src/job-pipeline.test.ts` with cases for:

- job starts as `preparing` until startup buffer is ready
- `availableDurationSeconds` increases while processing
- final MP3 is uploaded before public state becomes `ready`
- failed packaging retries up to 3 times with exponential backoff
- deleting a job removes final and temporary assets
- active partial progress survives retries/resume

Example:

```ts
it("does not expose streaming playback before the startup buffer is ready", async () => {
  const result = await pipeline.processClaimedJob(job);

  expect(result.playback.mode).toBe("preparing");
});
```

- [ ] **Step 2: Run `job-pipeline.test.ts` and capture the failures**

Run:

```bash
cd apps/api && yarn test src/job-pipeline.test.ts
```

Expected: FAIL with mismatches against the legacy `audioUrl` / `playlistUrl` behavior.

- [ ] **Step 3: Implement the new orchestration flow**

Create `apps/api/src/job-pipeline.ts` and move the worker runtime there. The pipeline module should:

- build a speech script before synthesis
- chunk semantically
- synthesize 2-4 chunks in parallel
- publish HLS only after a startup buffer exists
- retry failed chunk synthesis and packaging steps up to 3 times with exponential backoff
- keep public state coarse and derive playback via `audio-playback.ts`
- upload the final MP3 before publishing `ready`
- preserve HLS for later cleanup instead of deleting it immediately

Then slim `apps/api/src/jobs.ts` down so it coordinates store access and delegates processing to `job-pipeline.ts`.

- [ ] **Step 4: Re-run pipeline tests, service tests, and the package build**

Run:

```bash
cd apps/api && yarn test src/job-pipeline.test.ts src/jobs.test.ts && yarn build
```

Expected: PASS.

- [ ] **Step 5: Commit the worker pipeline refactor**

```bash
git add apps/api/src/job-pipeline.ts apps/api/src/job-pipeline.test.ts apps/api/src/jobs.ts apps/api/src/jobs.test.ts apps/api/src/types.ts
git commit -m "feat: refactor audio jobs around startup-buffered HLS and final MP3"
```

### Task 7: Add maintenance services for reconciliation and HLS cleanup

**Files:**
- Create: `apps/api/src/maintenance.ts`
- Create: `apps/api/src/maintenance.test.ts`
- Modify: `apps/api/src/production.ts`
- Modify: `apps/api/src/storage.ts`

- [ ] **Step 1: Write failing maintenance tests**

Create `apps/api/src/maintenance.test.ts` with cases for:

- re-queueing a job after lease expiry
- cleaning HLS after the 6-hour retention window
- repairing a job whose final MP3 exists but state was not finalized
- ensuring only one maintenance runner acts at a time via the maintenance lease

Example:

```ts
it("cleans expired HLS assets after the retention window", async () => {
  await cleaner.runOnce(nowPlusSixHours);
  expect(deletePrefixMock).toHaveBeenCalledWith("jobs/job-123/hls");
});
```

- [ ] **Step 2: Run the maintenance tests and verify they fail**

Run:

```bash
cd apps/api && yarn test src/maintenance.test.ts
```

Expected: FAIL because the maintenance module does not exist yet.

- [ ] **Step 3: Implement maintenance services and wire the worker interval**

Create `apps/api/src/maintenance.ts` with:

- `JobReconciler`
- `HlsRetentionCleaner`
- `FinalizationRepairer`

Update `apps/api/src/production.ts` to start a worker-owned maintenance interval behind a single-instance lease.

- [ ] **Step 4: Re-run maintenance tests plus a focused build**

Run:

```bash
cd apps/api && yarn test src/maintenance.test.ts src/job-pipeline.test.ts && yarn build
```

Expected: PASS and successful TypeScript build.

- [ ] **Step 5: Commit maintenance and recovery**

```bash
git add apps/api/src/maintenance.ts apps/api/src/maintenance.test.ts apps/api/src/production.ts apps/api/src/storage.ts
git commit -m "feat: add reconciliation and HLS cleanup services"
```

### Task 8: Expose the new API contract and rename backend analytics

**Files:**
- Create: `apps/api/src/app.contract.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/analytics.ts`
- Modify: `apps/api/src/jobs.ts`

- [ ] **Step 1: Write failing API-shape assertions**

Create `apps/api/src/app.contract.test.ts` so API responses now expect:

- coarse public state
- nested `playback`
- nested `progress`
- no client dependence on raw segment arrays for behavior

Example:

```ts
expect(response.body.job).toMatchObject({
  state: "processing",
  playback: {
    mode: "streaming",
    isPlayable: true,
  },
});
```

- [ ] **Step 2: Run the focused API tests**

Run:

```bash
cd apps/api && yarn test src/app.contract.test.ts
```

Expected: FAIL until route serialization and analytics names are updated.

- [ ] **Step 3: Update the API surface**

Modify `apps/api/src/app.ts` so the route serializers return the public contract described in `docs/streaming-playback-contract.md`. Update `apps/api/src/jobs.ts` only where it needs to expose the new response fields to the route layer.

Rename analytics events in `apps/api/src/analytics.ts` and `apps/api/src/jobs.ts` from `narration_*` to `audio_*`.

- [ ] **Step 4: Run the contract tests, service tests, and the package build**

Run:

```bash
cd apps/api && yarn test src/app.contract.test.ts src/jobs.test.ts && yarn build
```

Expected: PASS across the API package.

- [ ] **Step 5: Commit the public API contract**

```bash
git add apps/api/src/app.contract.test.ts apps/api/src/app.ts apps/api/src/analytics.ts apps/api/src/jobs.ts
git commit -m "feat: expose explicit audio playback contract"
```

---

## Chunk 3: iOS Migration, Terminology Cleanup, and Verification

### Task 9: Add iOS models for the new playback contract

**Files:**
- Create: `apps/ios/HearIt/Models/AudioPlayback.swift`
- Create: `apps/ios/HearItTests/AudioJobDecodingTests.swift`
- Modify: `apps/ios/HearIt/Models/AudioJob.swift`
- Modify: `apps/ios/HearIt/Services/HearItAPIClient.swift`

- [ ] **Step 1: Write failing decoding tests**

Create `apps/ios/HearItTests/AudioJobDecodingTests.swift` with cases for:

- coarse public job states: `queued`, `processing`, `ready`, `failed`
- `preparing` playback mode
- `streaming` mode with `availableDurationSeconds`
- `final` mode with `fileName`
- `failed` mode with an error message
- progress metadata decoding

Example:

```swift
import Foundation
import Testing
@testable import HearIt

struct AudioJobDecodingTests {
    @Test
    func decodesStreamingPlaybackDescriptor() throws {
        let data = """
        {
          "id": "job-1",
          "title": "Streaming example",
          "state": "processing",
          "playback": {
            "mode": "streaming",
            "isPlayable": true,
            "playlistUrl": "/audio/job-1/playlist.m3u8",
            "availableDurationSeconds": 26,
            "liveEdgeUpdatedAt": "2026-04-04T12:00:00Z"
          },
          "progress": {
            "chunksTotal": 4,
            "chunksReady": 2,
            "availableDurationSeconds": 26
          },
          "createdAt": "2026-04-04T11:59:00Z",
          "updatedAt": "2026-04-04T12:00:00Z"
        }
        """.data(using: .utf8)!

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let job = try decoder.decode(AudioJob.self, from: data)
        #expect(job.playback.mode == .streaming)
        #expect(job.playback.availableDurationSeconds == 26)
    }
}
```

- [ ] **Step 2: Run the decoding test and verify it fails**

Run:

```bash
cd apps/ios && xcodegen generate
xcodebuild test -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:HearItTests/AudioJobDecodingTests
```

Expected: FAIL because the new models do not exist yet.

- [ ] **Step 3: Implement the new models and API decoding**

Create `apps/ios/HearIt/Models/AudioPlayback.swift` and update `AudioJob.swift` / `HearItAPIClient.swift` to decode:

- public job state
- playback descriptor
- progress metadata

Keep the client logic driven by explicit fields, not `audioUrl` / `playlistUrl` inference.

- [ ] **Step 4: Re-run the focused decoding tests**

Run:

```bash
cd apps/ios && xcodegen generate
xcodebuild test -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:HearItTests/AudioJobDecodingTests
```

Expected: PASS.

- [ ] **Step 5: Commit the model migration**

```bash
git add apps/ios/HearIt/Models/AudioPlayback.swift apps/ios/HearIt/Models/AudioJob.swift apps/ios/HearIt/Services/HearItAPIClient.swift apps/ios/HearItTests/AudioJobDecodingTests.swift apps/ios/project.yml apps/ios/HearIt.xcodeproj
git commit -m "feat: add explicit playback descriptor models on iOS"
```

### Task 10: Refactor playback orchestration and invisible local storage

**Files:**
- Rename: `apps/ios/HearIt/Services/LocalNarrationAudioStore.swift` -> `apps/ios/HearIt/Services/LocalAudioAssetStore.swift`
- Rename: `apps/ios/HearItTests/LocalNarrationAudioStoreTests.swift` -> `apps/ios/HearItTests/LocalAudioAssetStoreTests.swift`
- Rename: `apps/ios/HearItTests/AppModelNarrationPlaybackTests.swift` -> `apps/ios/HearItTests/AppModelAudioPlaybackTests.swift`
- Create: `apps/ios/HearItTests/AppModelAudioPlaybackSessionTests.swift`
- Modify: `apps/ios/HearIt/App/AppModel.swift`
- Modify: `apps/ios/HearIt/Services/AudioPlayerController.swift`

- [ ] **Step 1: Add failing playback tests around pinned sessions and silent local optimization**

Create `apps/ios/HearItTests/AppModelAudioPlaybackSessionTests.swift` for session-pinning coverage, and keep the renamed high-level playback test file focused on AppModel flows. Cover:

- processing playback starts from HLS only after `isPlayable`
- active HLS sessions are not switched to final MP3 when the job becomes ready
- final MP3 may be fetched in the background without changing the current player item
- local asset persistence is not exposed as a user-facing state

Example:

```swift
@Test
func keepsStreamingSessionPinnedWhenFinalAudioArrives() async throws {
    // Arrange streaming job, start playback, then mutate fixture to ready/final.
    // Expect currentSourceURL to remain the original playlist URL.
}
```

- [ ] **Step 2: Run the focused iOS playback tests**

Run:

```bash
cd apps/ios && xcodegen generate
xcodebuild test -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:HearItTests/AppModelNarrationPlaybackTests -only-testing:HearItTests/AppModelAudioPlaybackSessionTests -only-testing:HearItTests/LocalNarrationAudioStoreTests
```

Expected: FAIL until the AppModel and local-store behavior are updated.

- [ ] **Step 3: Implement playback pinning and rename the local store**

Use `git mv` for the file renames, then update:

- `AppModel.swift` to follow the new playback descriptor
- `AudioPlayerController.swift` to keep the current session pinned to its started asset
- the local store to treat device files as an invisible optimization

Remove code that surfaces caching/downloading as a primary product concept.

- [ ] **Step 4: Re-run focused playback tests**

Run:

```bash
cd apps/ios && xcodegen generate
xcodebuild test -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:HearItTests/AppModelAudioPlaybackTests -only-testing:HearItTests/AppModelAudioPlaybackSessionTests -only-testing:HearItTests/LocalAudioAssetStoreTests
```

Expected: PASS.

- [ ] **Step 5: Commit playback orchestration changes**

```bash
git add apps/ios/HearIt/App/AppModel.swift apps/ios/HearIt/Services/AudioPlayerController.swift apps/ios/HearIt/Services/LocalAudioAssetStore.swift apps/ios/HearItTests/AppModelAudioPlaybackTests.swift apps/ios/HearItTests/AppModelAudioPlaybackSessionTests.swift apps/ios/HearItTests/LocalAudioAssetStoreTests.swift apps/ios/project.yml apps/ios/HearIt.xcodeproj
git commit -m "feat: pin streaming sessions and hide local storage as an implementation detail"
```

### Task 11: Update player and library UX for available-vs-final audio

**Files:**
- Create: `apps/ios/HearIt/PreviewSupport/PlaybackStateSamples.swift`
- Modify: `apps/ios/HearIt/Features/Player/PlayerView.swift`
- Modify: `apps/ios/HearIt/Features/Library/LibraryView.swift`
- Modify: `apps/ios/HearIt/Features/Home/HomeView.swift`
- Modify: `apps/ios/HearIt/Features/Player/MiniPlayerView.swift`

- [ ] **Step 1: Add explicit preview fixtures for the new playback states**

Create `apps/ios/HearIt/PreviewSupport/PlaybackStateSamples.swift` with fixtures that exercise:

- preparing
- streaming with partial availability
- ready/final
- failed

Use those fixtures in `PlayerView`, `LibraryView`, and `MiniPlayerView` previews so the implementation can be reviewed visually without hiding failures behind `|| true`.

- [ ] **Step 2: Run the relevant iOS tests**

Run:

```bash
cd apps/ios && xcodegen generate
xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16' build
```

Expected: `BUILD SUCCEEDED`, with preview/sample states ready to inspect after the UI updates land.

- [ ] **Step 3: Update the SwiftUI surfaces**

Modify the player and list views so they:

- speak in `audio`, not `narration`
- distinguish unavailable future audio from failure
- remove caching language
- keep the UX soft and honest for live-edge seeking

- [ ] **Step 4: Build the app and do a simulator smoke pass**

Run:

```bash
cd apps/ios && xcodegen generate
xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16' build
```

Expected: `BUILD SUCCEEDED`.

Then launch the app in the simulator and manually verify:

- a preparing job shows `Preparing audio`
- a streaming job with partial availability shows soft live-edge messaging
- a ready/final job shows `Ready`
- a failed job shows a failure-specific state rather than a live-edge state
- no cache/downloading label is shown in the library

- [ ] **Step 5: Commit the UX adjustments**

```bash
git add apps/ios/HearIt/PreviewSupport/PlaybackStateSamples.swift apps/ios/HearIt/Features/Player/PlayerView.swift apps/ios/HearIt/Features/Library/LibraryView.swift apps/ios/HearIt/Features/Home/HomeView.swift apps/ios/HearIt/Features/Player/MiniPlayerView.swift
git commit -m "feat: align iOS playback UX with the new audio contract"
```

### Task 12: Remove legacy `narration` terminology from code and docs

**Files:**
- Modify: `apps/api/src/analytics.ts`
- Modify: `apps/api/src/jobs.ts`
- Modify: `apps/api/src/jobs.test.ts`
- Modify: `apps/api/src/storage-supabase.test.ts`
- Modify: `apps/api/src/extractor.ts`
- Modify: `apps/api/src/extractor.test.ts`
- Modify: `apps/api/public/app.js`
- Modify: `apps/api/public/index.html`
- Modify: `apps/ios/HearIt/App/AppModel.swift`
- Modify: `apps/ios/HearIt/Services/Analytics.swift`
- Modify: `apps/ios/HearIt/Models/AudioJob.swift`
- Modify: `apps/ios/HearItShareExtension/ShareExtensionView.swift`
- Modify: `docs/architecture.md`
- Modify: `docs/ubiquitous-language.md`
- Modify: `docs/audio-pipeline-architecture.md`
- Modify: `docs/streaming-playback-contract.md`

- [ ] **Step 1: Write or update failing assertions for renamed analytics and visible copy**

Add or update tests so the code expects `audio_*` analytics events and `audio`-based copy instead of `narration`.

- [ ] **Step 2: Run a repo-wide search to identify remaining legacy terms**

Run:

```bash
rg -n "narration" apps docs
```

Expected: this returns the remaining files to rename in Step 3.

- [ ] **Step 3: Rename remaining legacy terms**

Use `git mv` where file names still contain `Narration`, and update:

- product copy to use `audio`
- technical copy to use `speech generation`, `speech script`, or `audio asset` where appropriate
- analytics event names
- Sentry breadcrumbs
- visible copy
- comments and docs

Only keep the term when explicitly describing the migration itself.

- [ ] **Step 4: Run full verification**

Run:

```bash
cd apps/api && yarn test && yarn build
cd ../ios && xcodegen generate
xcodebuild test -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 16'
```

Expected: API tests pass, API build passes, iOS tests pass.

- [ ] **Step 5: Commit the terminology sweep**

```bash
git add apps/api apps/ios docs
git commit -m "refactor: retire legacy narration terminology"
```

---

## Manual Verification Checklist

- [ ] Create a new audio job from a long article and confirm the app stays in `Preparing audio` until the startup buffer exists.
- [ ] Start playback while the job is still processing and confirm the player uses HLS.
- [ ] Let the job complete during playback and confirm the active session does not switch sources.
- [ ] Stop playback and start again; confirm the new session uses the final MP3.
- [ ] Wait past the 6-hour HLS retention boundary in a controlled test or lowered-threshold environment and confirm the cleaner deletes temporary HLS without affecting the final MP3.
- [ ] Kill and relaunch the app; confirm the completed asset can still be played from remote storage and optionally from local optimization if present.
- [ ] Delete a job and confirm the final MP3 and any remaining HLS artifacts are deleted remotely.
- [ ] Verify the share extension still creates audio jobs successfully and uses the new copy.

## Post-Implementation Cleanup

- [ ] Compare the implemented contract against `docs/streaming-playback-contract.md` and update docs if the code deliberately diverged.
- [ ] Compare actual backend terms against `docs/ubiquitous-language.md` and remove any stale migration wording.
- [ ] Re-run `rg -n "narration" apps docs` and leave only intentional historical references.

Plan complete and saved to `docs/superpowers/plans/2026-04-04-audio-pipeline-redesign.md`. Ready to execute?
