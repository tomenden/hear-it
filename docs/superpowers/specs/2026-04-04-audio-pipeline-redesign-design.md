# Audio Pipeline Redesign

## Overview

Redesign Hear It's audio generation and playback pipeline to provide smooth in-progress streaming, a stable completed asset, cleaner naming, stronger observability, and a cheap-but-correct day 1 infrastructure shape.

This spec records the design decisions agreed on before implementation.

## Objectives

- improve perceived startup time without mid-listen starvation
- make completed playback more stable than the previous playlist-only approach
- keep provider choice flexible
- make the client contract explicit
- keep the day 1 hosting bill low while preserving a clean growth path

## Decisions

### Product And Naming

- retire `narration` as the preferred term
- use `audio` in product language
- use `speech generation` and `speech script` in technical language
- add a dedicated ubiquitous-language document

### Playback Architecture

- processing playback uses real AAC/fMP4 HLS
- playback only becomes available after a startup buffer of about 20-30 seconds
- active playback sessions remain pinned to the asset they started with
- completed playback uses a canonical final MP3
- device-local storage is an invisible optimization only

### Media Lifecycle

- HLS is temporary
- HLS artifacts stay available for 6 hours after completion
- the final MP3 remains durable until explicit deletion
- deleting a job removes its final MP3 and any remaining HLS assets

### Backend Architecture

- keep one API service and one worker service on Render Starter instances
- keep Supabase Free for Postgres and Storage on day 1
- keep OpenAI as the day 1 speech provider behind a provider abstraction
- use ffmpeg inside the worker for packaging

### Text Preparation

- preserve extracted text
- derive and persist a deterministic speech script
- do not paraphrase or summarize
- include headings and meaningful captions with light cues
- humanize hostile spoken tokens such as raw URLs

### Processing Model

- semantically chunk text
- target about 15-25 seconds of speech per chunk
- synthesize 2-4 chunks in parallel per job
- preserve strict output order
- publish short HLS batches after a meaningful startup buffer is ready

### State And API Contract

- keep backend internal states richer than public states
- expose coarse public job states: `queued`, `processing`, `ready`, `failed`
- expose an explicit discriminated playback descriptor
- use polling for job status and streaming for audio delivery

### Recovery And Ops

- use Postgres-backed job claims with leases and heartbeats
- retry failed chunk or packaging steps up to 3 times with exponential backoff
- preserve completed chunks across recovery
- add a lightweight internal `job_events` table
- keep maintenance logic abstracted from its trigger mechanism
- run maintenance from the worker interval in v1

## Documentation Outputs

- [System Overview](/Users/tome/projects/hear-it/docs/architecture.md)
- [Ubiquitous Language](/Users/tome/projects/hear-it/docs/ubiquitous-language.md)
- [Audio Pipeline Architecture](/Users/tome/projects/hear-it/docs/audio-pipeline-architecture.md)
- [Streaming Playback Contract](/Users/tome/projects/hear-it/docs/streaming-playback-contract.md)

## Mermaid Coverage

The linked docs include diagrams for:

- high-level system topology
- end-to-end audio flow
- playback handoff rules
- maintenance trigger abstraction
- state mapping between backend and client

## Open Follow-Ups

- when to add a user-facing download/share affordance
- when to introduce a second speech provider
- when to move maintenance triggering from the worker interval to a cron-style trigger
- when to upgrade Supabase from Free based on storage, egress, inactivity, or backup needs
