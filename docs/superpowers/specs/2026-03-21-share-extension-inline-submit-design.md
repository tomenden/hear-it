# Share Extension Inline Narration Submit

## Overview

Replace the current "open main app" Share Extension behavior with an in-extension flow that submits narration jobs directly. The user shares a URL, the extension submits it with their last-used voice, and dismisses with a brief success confirmation. The user never leaves their current app.

## Flow

1. User taps Share > Hear It from any app (Chrome, Safari, WhatsApp, etc.)
2. Extension appears with a brief loading state ("Creating narration...")
3. Extension reads the last-used voice from shared UserDefaults (falls back to "alloy")
4. Extension reads auth token from shared Keychain
5. Extension POSTs to `/api/jobs` with the URL and voice ID
6. On success: shows "Narration started!" with a checkmark for ~1.5s, then dismisses
7. On error: shows error message for ~2s, then dismisses

## Infrastructure: App Group

Add App Group `group.com.tome.hearit` to both the main app and Share Extension targets.

### project.yml changes

Both targets need entitlements files referencing the App Group:

- `HearIt/Support/HearIt.entitlements` with `com.apple.security.application-groups: [group.com.tome.hearit]`
- `HearItShareExtension/HearItShareExtension.entitlements` with `com.apple.security.application-groups: [group.com.tome.hearit]`

Add `entitlements` paths to each target in `project.yml`.

## Shared State: Voice Selection

### Write side (main app)

`AppSettings` currently stores `selectedVoiceID` in standard `UserDefaults`. Add a write-through to shared `UserDefaults(suiteName: "group.com.tome.hearit")` whenever `selectedVoiceID` changes.

### Read side (Share Extension)

Read `selectedVoiceID` (key: `hear-it.selected-voice-id`) from `UserDefaults(suiteName: "group.com.tome.hearit")`. Fall back to `"alloy"` if nil.

## Shared State: Auth Token

The extension does NOT include the Supabase SDK and cannot refresh tokens. Strategy: attempt the API call with whatever token is stored; treat 401 as "please sign in." This keeps the extension lightweight.

### Write side (main app)

`AuthManager` manages Supabase auth. Write the access token to the shared Keychain on `.signedIn` and `.tokenRefreshed` events from `client.auth.authStateChanges`. Clear it on sign-out.

Use the App Group ID (`group.com.tome.hearit`) as the Keychain access group via `kSecAttrAccessGroup` — no separate Keychain Sharing entitlement needed.

### Read side (Share Extension)

Read the access token from the shared Keychain using the same access group. If no token found, or if the API returns 401, show "Please open Hear It and sign in."

## Share Extension UI

Replace the current `UIViewController` with a SwiftUI-based extension view.

### States

- **Loading**: Spinner + "Creating narration..." text
- **Success**: Checkmark + "Narration started!" text, auto-dismiss after 1.5s
- **Error (auth)**: "Please open Hear It and sign in" text, auto-dismiss after 2s
- **Error (network/other)**: "Couldn't connect. Try again." text, auto-dismiss after 2s

### Implementation

Use a `UIHostingController` wrapping a simple SwiftUI view. The view model handles the submit flow and state transitions.

## API Call

Single `URLRequest` — no API client reuse needed.

```
POST {apiBaseURL}/api/jobs
Headers:
  Authorization: Bearer {token}
  Content-Type: application/json
Body:
  {
    "url": "{sharedURL}",
    "speechOptions": { "voice": "{voiceID}" }
  }
```

The API base URL is hardcoded to `https://hear-it.onrender.com` in the extension. No need to sync it via shared UserDefaults.

Set `timeoutIntervalForRequest` to 15 seconds on the URLRequest to avoid the extension being killed silently by iOS (extensions have a ~30s lifecycle limit). Note: Render.com cold starts can take 10-30s, so some requests may time out. Show "Server is starting up. Please try again." for timeout errors specifically.

## Error Handling

- **No auth token / 401 response**: Show "Please open Hear It and sign in", dismiss after 2s
- **Network error / non-2xx**: Show "Couldn't connect. Try again.", dismiss after 2s
- **Invalid URL (non-HTTP/S)**: Show "This link can't be narrated.", dismiss after 2s

## Files to Create/Modify

### New files
- `HearIt/Support/HearIt.entitlements`
- `HearItShareExtension/HearItShareExtension.entitlements`
- `HearItShareExtension/ShareExtensionView.swift` — SwiftUI UI
- `HearItShareExtension/SharedKeychain.swift` — Keychain read helper

### Modified files
- `project.yml` — add entitlements to both targets, add App Group capability
- `HearItShareExtension/ShareViewController.swift` — replace with UIHostingController presenting ShareExtensionView
- `HearIt/Services/AppSettings.swift` — write-through selectedVoiceID and apiBaseURL to shared UserDefaults
- `HearIt/Services/AuthManager.swift` — write/clear auth token in shared Keychain

## Cleanup

Remove the `com.tome.hearit://share` deep link handler from `AppModel.handleIncomingURL()` (the `url.host == "share"` branch) and the `pendingURL` logic in `HearItApp.swift`, as the extension no longer opens the main app.

## Known Limitations

- If the user hasn't opened the main app recently, the stored auth token may be expired. The extension will show "Please open Hear It and sign in."
- Sharing the same URL twice quickly will create duplicate narrations. Acceptable for now.
- Render.com cold starts may cause timeouts on first share after server idle.

## Out of Scope

- Voice picker UI in the extension
- Voice audio previews
- Article preview/extraction in the extension
- Offline queueing of jobs
- Token refresh in the extension (intentionally excluded for simplicity)
- Plain-text URL items (activation rule only accepts typed URLs)
