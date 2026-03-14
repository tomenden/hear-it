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

- iOS share extension
- offline caching
- billing or accounts

## Repository Layout

- `docs/`: product and technical design notes
- `apps/api/`: TypeScript extraction service
- `apps/ios/`: SwiftUI iPhone app wired to the existing API

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

## Native iOS App

The repo now includes a SwiftUI iPhone app under [`apps/ios`](./apps/ios).

Generate the Xcode project:

```bash
cd apps/ios
xcodegen generate
```

Open the project:

```bash
open HearIt.xcodeproj
```

The app is built around the current prototype flow:

1. Paste an article URL on Home.
2. Choose a narration voice.
3. Create a narration job against the existing Hear It API.
4. Watch the processing state in the player.
5. Return to the library to reopen completed narrations.

### Mac testing workflow

Use the native app in three different ways depending on what you are validating:

1. `SwiftUI Preview`
   Best for fast visual iteration on individual screens. The previews use stable sample data, so they stay fast and do not hit the live backend.
2. `iOS Simulator`
   Best for end-to-end testing on your Mac. By default the app uses `http://127.0.0.1:3000` in Simulator, so it can talk to the local Hear It API directly.
3. `Physical iPhone`
   Best for final QA of real-device behavior such as signing, audio session behavior, network access over Wi-Fi, and anything that depends on actual hardware or device settings.

The app now includes preview fixtures for the main flows:

- Home
- Library
- Voice selection
- Player in ready and processing states
- Settings

In Xcode, open the canvas on those SwiftUI files to iterate on layout and styling without redeploying the app.

### Device testing

When you run the app on a physical iPhone, the app needs the API base URL of the Mac running `npm run dev`.

Use the in-app Settings screen and enter something like:

```text
http://192.168.1.12:3000
```

`http://localhost:3000` works for Simulator, but not for a physical phone.

### What still needs real-device QA

The simulator is great for layout and end-to-end flow checks, but keep a short QA pass on an actual iPhone for:

- developer signing and install flow
- playback behavior through the real iPhone audio session
- any future share extension work
- network behavior over local Wi-Fi instead of the Mac loopback interface
- final spacing and typography feel on the actual device

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
