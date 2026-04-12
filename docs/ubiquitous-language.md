# Hear It Ubiquitous Language

This glossary defines the product, backend, and playback terms used across Hear It. The goal is to make naming explicit and stable.

## Naming Principles

- prefer `audio` in product copy
- prefer `speech generation` for the process of turning text into spoken audio
- prefer `audio asset` for stored media outputs
- keep internal terms explicit
- avoid leaking backend implementation details into user-facing language

## Product Terms

### audio

The user-facing output created from an article.

Examples:

- `Create Audio`
- `Preparing audio`
- `Ready to play`

### article

The extracted readable content from a shared URL, including title and body text.

### voice

The speech style selected for generation.

### processing

The product-facing state meaning the system is still generating the final audio asset.

### ready

The product-facing state meaning the final audio asset is available.

## Content Terms

### extracted text

The article text produced by the extraction pipeline before speech-specific cleanup.

### speech script

The deterministic, cleaned, speakable version of the extracted text used for speech generation.

Rules:

- it may clean, label, omit obvious garbage, and humanize machine-hostile tokens
- it must not paraphrase, summarize, or change meaning

### heading cue

A light spoken treatment that preserves heading meaning without sounding robotic. Headings stay in the speech script; only the cueing style is soft.

### image caption

Spoken when it appears meaningful to article comprehension. It should be labeled lightly, for example `Image caption:`.

## Media Terms

### chunk

A semantic unit of text sent to the speech provider for synthesis.

### available duration

The amount of synthesized audio currently persisted. In the batch-only design this is progress metadata, not a signal that playback is ready.

### final MP3

The canonical completed audio asset stored remotely. Internally this uses a stable object key such as `jobs/<jobId>/final.mp3`.

### temporary chunk asset

A short-lived per-chunk MP3 stored during processing so retries, repair, and fallback local caching can reuse completed work.

### user-facing filename

The human-readable filename used for downloads or sharing, derived from the article title or a safe fallback. This is distinct from the internal storage key.

## Playback Terms

### playback descriptor

The API object that tells the client whether playback is currently possible and, when ready, where to load the final asset from.

### final source

The canonical completed MP3 playback source exposed by the API once finalization succeeds.

## Backend Terms

### speech provider

An adapter that turns speech script text into audio bytes. Day 1 provider: OpenAI.

### normalized intermediate audio

Short-lived worker-side audio output used before packaging. This may be PCM or WAV. It is not a user-facing stored format.

### packaging

The media pipeline step that converts synthesized chunks into the final MP3.

### reconciler

Background maintenance logic that repairs stalled jobs, re-queues resumable work, and drives cleanup.

### job event

A durable, queryable lifecycle fact stored in the internal event log table.

### run ID

An identifier for a particular processing run of a job, used for retries and recovery.

## State Vocabulary

### public product states

- `queued`
- `processing`
- `ready`
- `failed`

These are the states the client can reason about.

### internal pipeline states

- `queued`
- `normalizing`
- `chunking`
- `synthesizing`
- `packaging`
- `completed`
- `failed`

These are backend states used for correctness, observability, and recovery. They should not drive user-facing UI directly.

## Storage Terms

### canonical asset

The durable remote source of truth for completed audio. Day 1 this is the final MP3 in Supabase Storage.

### local cache

An invisible device-side optimization for repeat and offline playback. It is not a product-visible state in v1.
