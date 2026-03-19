# Hear It

**Turn any article into a podcast — instantly.**

Hear It is an iOS app that converts long-form web articles into natural-sounding audio. Paste a link, pick a voice, and listen while you commute, cook, or work out.

## Features

- **One-tap conversion** — paste any article URL and get a spoken version in seconds
- **Natural voices** — powered by OpenAI's text-to-speech with multiple voice options
- **Background playback** — keep listening while you use other apps
- **Offline listening** — audio is stored on your device for anytime access
- **Article library** — revisit past narrations from your personal library
- **Smart extraction** — strips ads, nav bars, and page chrome to narrate just the article

## How It Works

1. Paste an article URL (or share from Safari)
2. Choose a narration voice
3. Hear It extracts the article and generates spoken audio
4. Listen from the built-in player with full background audio support

## Architecture

| Component | Stack |
|-----------|-------|
| iOS app | SwiftUI, AVFoundation |
| API server | Express, TypeScript |
| Auth | Supabase Auth |
| TTS | OpenAI `gpt-4o-mini-tts` |
| Database | Supabase (Postgres) |
| Hosting | Render (Docker) |
| Analytics | PostHog |
| Error tracking | Sentry |

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│   iOS App    │──────▶│  Express API │──────▶│  OpenAI TTS  │
│  (SwiftUI)   │◀──────│  (Render)    │       └──────────────┘
└──────────────┘       │              │
                       │              │──────▶ Supabase (Auth + DB + Storage)
                       └──────────────┘
```

## Repository Layout

```
apps/
  ios/          SwiftUI iPhone app
  api/          Express API server (extraction, TTS, job management)
docs/           Product and technical design notes
scripts/        Dev tooling
```

## Getting Started

### Prerequisites

- Node.js 20+
- Yarn
- Xcode 26+ (for iOS development)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)

### API Server

```bash
yarn install
yarn dev
```

The API starts on `http://localhost:3000`.

Create a `.env` file at the repo root:

```env
OPENAI_API_KEY=sk-...          # Required for real TTS (omit for fake provider)
SUPABASE_URL=...               # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY=...  # Supabase admin key
SUPABASE_JWT_SECRET=...        # JWT verification
```

Optional variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | TTS model |
| `TTS_CONCURRENCY` | `5` | Parallel TTS jobs |
| `AUDIO_PUBLIC_BASE_URL` | `/audio` | Audio URL prefix |
| `AUDIO_OUTPUT_DIR` | `data/audio` | Local audio storage (dev) |

### iOS App

```bash
cd apps/ios
cp local.xcconfig.example local.xcconfig
# Edit local.xcconfig → set DEVELOPMENT_TEAM to your Apple Team ID
xcodegen generate
open HearIt.xcodeproj
```

Build and run on Simulator (uses `http://127.0.0.1:3000`) or a physical device (configure the API URL in the in-app Settings screen).

## Privacy

Hear It collects minimal data. See the full [Privacy Policy](/privacy) served by the API.

- No cross-app tracking
- No data sold to third parties
- Anonymous analytics only (PostHog)
- Crash reporting via Sentry (no personal content)

## License

Private — all rights reserved.
