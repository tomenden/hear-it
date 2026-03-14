# Hear It Architecture

## User Problem

People discover articles when they cannot or should not read them, especially while commuting. Most blogs do not provide clean audio, and browser reader modes are inconsistent.

## Product Hypothesis

If sharing a URL to an app reliably produces high-quality spoken audio from the article body, users will treat it like "save to podcast."

## Core Workflow

1. User taps `Share` on an article URL.
2. iOS share extension hands the URL to Hear It.
3. Hear It creates an ingestion job.
4. Backend fetches the page and extracts the readable article.
5. Backend normalizes the text for narration.
6. Backend generates audio through a speech provider.
7. Main app shows progress and plays the result.

## System Components

### 1. iOS App

Responsibilities:

- queue and library UI
- audio playback
- progress display
- retry and error recovery
- optional article preview

Likely stack:

- SwiftUI
- AVFoundation / AVAudioSession
- Background audio support

### 2. iOS Share Extension

Responsibilities:

- receive shared URLs
- validate supported schemes
- create a queue item fast
- transfer control back to the main app

Design rule:

Keep it minimal. Share extensions are not the place to do network-heavy parsing or long TTS jobs.

### 3. API Service

Responsibilities:

- fetch page HTML
- run article extraction
- clean text for narration
- create audio jobs
- expose job status and playback metadata

This repo starts here.

### 4. Future Worker

Responsibilities:

- speech generation
- retries
- provider failover
- caching rendered audio

## Extraction Strategy

Target result:

- page title
- byline when available
- site name
- main article text
- normalized speaking text

Approach:

1. Fetch raw HTML.
2. Parse DOM in a headless-safe environment.
3. Use a readability-style extractor as the first pass.
4. Fall back to metadata and heuristic paragraph extraction when needed.
5. Normalize whitespace and remove boilerplate fragments.

## TTS Strategy

Use a provider abstraction from the beginning. The app should not care whether speech comes from OpenAI, ElevenLabs, or a local engine later.

Provider contract:

- input: cleaned text plus voice settings
- output: audio file URL, duration, provider metadata

## Risks

### Extraction Quality

Some sites break readability parsers, render content client-side, or interleave newsletter/signup blocks with content.

Mitigation:

- keep raw extraction metadata
- store fallback signals
- add domain-specific overrides later

### Cost

Long articles can be expensive to synthesize.

Mitigation:

- cap free article length
- chunk text
- cache audio by canonical URL and voice

### Copyright / Terms

Some sites may disallow automated fetching or derivative audio generation.

Mitigation:

- respect robots and publisher rules where required by product policy
- keep support initially focused on standard public blog/article pages

## MVP API Surface

### `POST /api/extract`

Input:

- `url`
- optional `html`

Output:

- canonical URL
- title
- byline
- site name
- excerpt
- article text
- estimated speaking minutes

### Future Endpoints

- `POST /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/feed`
- `POST /api/tts/preview`

## Delivery Plan

### Phase 1

- extraction API
- tests with representative HTML fixtures

### Phase 2

- TTS provider abstraction
- audio job model
- storage contract

### Phase 3

- SwiftUI app
- share extension
- playback queue
