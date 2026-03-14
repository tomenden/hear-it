# Hear It

Hear It turns long-form web articles into something you can listen to while driving.

## Product Direction

The first usable version is intentionally narrow:

1. Share a blog post URL from Safari or another app into Hear It.
2. Hear It sends the URL to a backend ingestion API.
3. The backend fetches the page, extracts the article body, and removes page chrome.
4. Hear It requests audio generation from a speech provider.
5. The user gets a playable queue item with article text and narration.

This repo starts with the hardest backend problem first: reliable article extraction.

## MVP

The MVP focuses on:

- URL ingestion
- article extraction
- cleanup for spoken narration
- speech generation
- a simple HTTP API
- a mobile-first web client for product iteration

It explicitly does not yet include:

- iOS app UI
- iOS share extension
- background audio playback
- offline caching
- billing or accounts

## Repository Layout

- `docs/`: product and technical design notes
- `apps/api/`: TypeScript extraction service

## Getting Started

```bash
npm install
npm test
npm run dev
```

The API will start on `http://localhost:3000`.

Set `OPENAI_API_KEY` to enable real speech generation through OpenAI. Without it, the app uses a fake provider for local development.

Optional environment variables:

- `OPENAI_TTS_MODEL`: defaults to `gpt-4o-mini-tts`
- `AUDIO_PUBLIC_BASE_URL`: defaults to `/audio`
- `AUDIO_OUTPUT_DIR`: defaults to `data/audio`

You can put those in a local `.env` file at the repo root or under `apps/api/` before starting the server.

## Endpoints

`POST /api/extract`

Request body:

```json
{
  "url": "https://example.com/blog-post"
}
```

Optional `html` can be sent for tests or future client-side prefetch flows:

```json
{
  "url": "https://example.com/blog-post",
  "html": "<html>...</html>"
}
```

`POST /api/jobs`

Creates an extraction-plus-speech job and immediately returns queued job metadata.

```json
{
  "url": "https://example.com/blog-post",
  "speechOptions": {
    "voice": "alloy"
  }
}
```

`GET /api/jobs`

Returns all jobs in reverse chronological order.

`GET /api/jobs/:jobId`

Returns the current state of a single job.

## Mobile Prototype

This repo now serves a mobile-first web prototype from `/` on the same API server.

Start it with:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Test It Like An iPhone On Your Mac

### Fastest path: Safari Responsive Design Mode

1. Open Safari.
2. Enable the Develop menu in Safari Settings if it is not already enabled.
3. Open `http://localhost:3000`.
4. Choose `Develop -> Enter Responsive Design Mode`.
5. Pick an iPhone device preset.
6. Paste a real article URL and create a job.

This is the fastest way to get a phone-sized feel for the product on this machine.

### Chrome alternative

1. Open `http://localhost:3000`.
2. Open DevTools.
3. Toggle device emulation.
4. Pick an iPhone profile.

### If you want the real iOS Simulator later

This machine currently has Command Line Tools but not full Xcode/Simulator tooling. To run a true iPhone simulator you will need:

1. Full Xcode installed from Apple.
2. `xcode-select` pointed at the Xcode app.
3. Simulator runtimes installed inside Xcode.

At that point we can scaffold the native SwiftUI app and run it in Simulator against the same backend.

## Shared tmux Workflow

For long-running or interactive commands, use a named tmux session so both you and the agent can access the same shell.

Create or reuse the default shared session:

```bash
./scripts/shared-tmux-session.sh
```

Then attach from your Terminal:

```bash
tmux attach -t hear-it-codex
```

This is the preferred pattern for:

- Xcode installs
- long-running dev servers
- interactive auth flows
- watch mode processes you may want to inspect directly

## Why This Architecture

Native iOS share extensions are constrained. They should stay thin:

- accept the shared URL
- hand it off quickly
- poll or receive updates
- let the main app manage playback

That keeps heavy HTML parsing, retry logic, provider integration, and caching on the server side where it is easier to iterate.
