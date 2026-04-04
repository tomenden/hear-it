# Share Extension Inline Submit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "open main app" Share Extension with an in-extension flow that submits audio jobs directly via API, so users never leave their current app.

**Architecture:** App Group shares voice preference (UserDefaults) and auth token (Keychain) between main app and extension. Extension makes a single POST to `/api/jobs` and shows a brief loading/success/error UI.

**Tech Stack:** Swift 6, SwiftUI, iOS App Groups, Keychain Services, URLSession

**Spec:** `docs/superpowers/specs/2026-03-21-share-extension-inline-submit-design.md`

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `apps/ios/HearIt/Support/HearIt.entitlements` | App Group entitlement for main app |
| `apps/ios/HearItShareExtension/HearItShareExtension.entitlements` | App Group entitlement for extension |
| `apps/ios/HearIt/Services/SharedKeychain.swift` | Read/write auth token to shared Keychain (used by both targets) |
| `apps/ios/HearItShareExtension/ShareExtensionView.swift` | SwiftUI UI for the extension (loading/success/error states) |

### Modified files
| File | Change |
|---|---|
| `apps/ios/project.yml` | Add entitlements to both targets; add `SharedKeychain.swift` to extension sources |
| `apps/ios/HearIt/Services/AppSettings.swift` | Write-through `selectedVoiceID` to shared UserDefaults |
| `apps/ios/HearIt/Services/AuthManager.swift` | Write/clear auth token in shared Keychain on auth events |
| `apps/ios/HearItShareExtension/ShareViewController.swift` | Replace with UIHostingController presenting ShareExtensionView |
| `apps/ios/HearIt/App/AppModel.swift` | Remove `url.host == "share"` deep link branch |
| `apps/ios/HearIt/App/HearItApp.swift` | Remove `pendingURL` state and related logic |

---

### Task 1: Add App Group entitlements to both targets

**Files:**
- Create: `apps/ios/HearIt/Support/HearIt.entitlements`
- Create: `apps/ios/HearItShareExtension/HearItShareExtension.entitlements`
- Modify: `apps/ios/project.yml`

- [ ] **Step 1: Create main app entitlements file**

Create `apps/ios/HearIt/Support/HearIt.entitlements`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>group.com.tome.hearit</string>
    </array>
</dict>
</plist>
```

- [ ] **Step 2: Create extension entitlements file**

Create `apps/ios/HearItShareExtension/HearItShareExtension.entitlements` with identical content to the main app entitlements.

- [ ] **Step 3: Add entitlements references to project.yml**

In `apps/ios/project.yml`, add `entitlements` to both targets:

For `HearIt` target (after line ~26, inside the target block before `dependencies`):
```yaml
    entitlements:
      path: HearIt/Support/HearIt.entitlements
```

For `HearItShareExtension` target (after line ~95, inside the target block before `sources`):
```yaml
    entitlements:
      path: HearItShareExtension/HearItShareExtension.entitlements
```

- [ ] **Step 4: Regenerate Xcode project and verify it builds**

Run:
```bash
cd apps/ios && xcodegen generate
xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'generic/platform=iOS' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 5: Commit**

```bash
git add apps/ios/HearIt/Support/HearIt.entitlements apps/ios/HearItShareExtension/HearItShareExtension.entitlements apps/ios/project.yml apps/ios/HearIt.xcodeproj
git commit -m "feat: add App Group entitlements to main app and Share Extension"
```

---

### Task 2: Create SharedKeychain helper

**Files:**
- Create: `apps/ios/HearIt/Services/SharedKeychain.swift`
- Modify: `apps/ios/project.yml` (add to extension sources)

- [ ] **Step 1: Create SharedKeychain.swift**

Create `apps/ios/HearIt/Services/SharedKeychain.swift`:
```swift
import Foundation
import Security

enum SharedKeychain {
    private static let accessGroup = "group.com.tome.hearit"
    private static let service = "com.tome.hearit"
    private static let tokenAccount = "auth-access-token"

    static func saveToken(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecAttrAccessGroup as String: accessGroup,
        ]

        // Delete existing, then add new
        SecItemDelete(query as CFDictionary)

        var addQuery = query
        addQuery[kSecValueData as String] = data
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    static func loadToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func deleteToken() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
```

- [ ] **Step 2: Add SharedKeychain.swift to Share Extension sources in project.yml**

In `apps/ios/project.yml`, update the `HearItShareExtension` target's `sources` to also include the shared file:
```yaml
    sources:
      - path: HearItShareExtension
      - path: HearIt/Services/SharedKeychain.swift
```

- [ ] **Step 3: Regenerate and verify build**

Run:
```bash
cd apps/ios && xcodegen generate
xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'generic/platform=iOS' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 4: Commit**

```bash
git add apps/ios/HearIt/Services/SharedKeychain.swift apps/ios/project.yml apps/ios/HearIt.xcodeproj
git commit -m "feat: add SharedKeychain helper for cross-target auth token sharing"
```

---

### Task 3: Sync auth token from main app to shared Keychain

**Files:**
- Modify: `apps/ios/HearIt/Services/AuthManager.swift`

- [ ] **Step 1: Add token sync to authStateChanges handler**

In `apps/ios/HearIt/Services/AuthManager.swift`, update the `authStateChanges` loop (around line 62-74) to write/clear the token:

Replace the existing switch block inside the `for await` loop:
```swift
switch event {
case .signedIn, .tokenRefreshed:
    if let session {
        self.state = .signedIn(session.user)
        SharedKeychain.saveToken(session.accessToken)
    }
case .signedOut:
    self.state = .signedOut
    SharedKeychain.deleteToken()
default:
    break
}
```

- [ ] **Step 2: Also sync token on initial session restore**

In the `initialize()` method (around line 52-54), after successfully restoring session, add the token save:
```swift
let session = try await client.auth.session
state = .signedIn(session.user)
SharedKeychain.saveToken(session.accessToken)
```

- [ ] **Step 3: Clear token on explicit sign-out**

In the `signOut()` method (around line 97-100), add `SharedKeychain.deleteToken()`:
```swift
func signOut() async throws {
    try await client.auth.signOut()
    SharedKeychain.deleteToken()
    state = .signedOut
}
```

- [ ] **Step 4: Build and verify**

Run:
```bash
cd apps/ios && xcodegen generate
xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'generic/platform=iOS' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 5: Commit**

```bash
git add apps/ios/HearIt/Services/AuthManager.swift apps/ios/HearIt.xcodeproj
git commit -m "feat: sync auth token to shared Keychain on auth events"
```

---

### Task 4: Write-through voice selection to shared UserDefaults

**Files:**
- Modify: `apps/ios/HearIt/Services/AppSettings.swift`

- [ ] **Step 1: Add shared UserDefaults write-through**

In `apps/ios/HearIt/Services/AppSettings.swift`, add a shared defaults property and update the `selectedVoiceID` setter.

Add after the existing `defaults` property (line 13):
```swift
@ObservationIgnored private let sharedDefaults = UserDefaults(suiteName: "group.com.tome.hearit")
```

Update the `selectedVoiceID` didSet (line 22-24) to also write to shared:
```swift
var selectedVoiceID: String {
    didSet {
        defaults.set(selectedVoiceID, forKey: Key.selectedVoiceID)
        sharedDefaults?.set(selectedVoiceID, forKey: Key.selectedVoiceID)
    }
}
```

Also seed shared defaults on init — add after line 47 (`self.lastPresentedJobID = ...`):
```swift
sharedDefaults?.set(selectedVoiceID, forKey: Key.selectedVoiceID)
```

- [ ] **Step 2: Build and verify**

Run:
```bash
cd apps/ios && xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'generic/platform=iOS' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 3: Commit**

```bash
git add apps/ios/HearIt/Services/AppSettings.swift
git commit -m "feat: write-through selectedVoiceID to shared UserDefaults"
```

---

### Task 5: Build the Share Extension SwiftUI view

**Files:**
- Create: `apps/ios/HearItShareExtension/ShareExtensionView.swift`

- [ ] **Step 1: Create ShareExtensionView.swift**

Create `apps/ios/HearItShareExtension/ShareExtensionView.swift`:
```swift
import SwiftUI

struct ShareExtensionView: View {
    let url: URL?
    let onDismiss: () -> Void

    @State private var state: SubmitState = .loading

    enum SubmitState {
        case loading
        case success
        case error(String)
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()

            VStack(spacing: 12) {
                switch state {
                case .loading:
                    ProgressView()
                        .tint(.white)
                    Text("Creating audio...")
                        .foregroundStyle(.white)
                        .font(.headline)
                case .success:
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.green)
                    Text("Narration started!")
                        .foregroundStyle(.white)
                        .font(.headline)
                case .error(let message):
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.yellow)
                    Text(message)
                        .foregroundStyle(.white)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(32)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
        .task {
            await submitNarration()
        }
    }

    private func submitNarration() async {
        // Handle invalid URL
        guard let url else {
            state = .error("This link can't\nbe narrated.")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
            return
        }

        // Read voice from shared UserDefaults
        let sharedDefaults = UserDefaults(suiteName: "group.com.tome.hearit")
        let voiceID = sharedDefaults?.string(forKey: "hear-it.selected-voice-id") ?? "alloy"

        // Read auth token from shared Keychain
        guard let token = SharedKeychain.loadToken() else {
            state = .error("Please open Hear It\nand sign in")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
            return
        }

        // Build request
        let apiURL = URL(string: "https://hear-it.onrender.com/api/jobs")!
        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15

        let body: [String: Any] = [
            "url": url.absoluteString,
            "speechOptions": ["voice": voiceID],
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        // Submit
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let httpResponse = response as? HTTPURLResponse

            if httpResponse?.statusCode == 401 {
                state = .error("Please open Hear It\nand sign in")
                try? await Task.sleep(for: .seconds(2))
                onDismiss()
                return
            }

            guard let statusCode = httpResponse?.statusCode,
                  (200...299).contains(statusCode) else {
                state = .error("Couldn't connect.\nTry again.")
                try? await Task.sleep(for: .seconds(2))
                onDismiss()
                return
            }

            state = .success
            try? await Task.sleep(for: .seconds(1.5))
            onDismiss()
        } catch let error as URLError where error.code == .timedOut {
            state = .error("Server is starting up.\nPlease try again.")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
        } catch {
            state = .error("Couldn't connect.\nTry again.")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
        }
    }
}
```

- [ ] **Step 2: Build and verify**

Run:
```bash
cd apps/ios && xcodegen generate
xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'generic/platform=iOS' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 3: Commit**

```bash
git add apps/ios/HearItShareExtension/ShareExtensionView.swift apps/ios/HearIt.xcodeproj
git commit -m "feat: add SwiftUI view for Share Extension inline submit"
```

---

### Task 6: Rewrite ShareViewController to use the new SwiftUI view

**Files:**
- Modify: `apps/ios/HearItShareExtension/ShareViewController.swift`

- [ ] **Step 1: Replace ShareViewController**

Replace the entire contents of `apps/ios/HearItShareExtension/ShareViewController.swift` with:
```swift
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        extractURL()
    }

    private func extractURL() {
        guard
            let item = extensionContext?.inputItems.first as? NSExtensionItem,
            let attachments = item.attachments
        else {
            cancel()
            return
        }

        let urlType = UTType.url.identifier

        for attachment in attachments {
            guard attachment.hasItemConformingToTypeIdentifier(urlType) else { continue }

            Task { @MainActor in
                do {
                    let data = try await attachment.loadItem(forTypeIdentifier: urlType)
                    let url: URL?
                    if let u = data as? URL {
                        url = u
                    } else if let s = data as? String {
                        url = URL(string: s)
                    } else {
                        url = nil
                    }

                    if let url, ["http", "https"].contains(url.scheme?.lowercased()) {
                        presentShareView(for: url)
                    } else {
                        presentShareView(invalidURL: true)
                    }
                } catch {
                    cancel()
                }
            }
            return
        }

        cancel()
    }

    private func presentShareView(for url: URL) {
        let shareView = ShareExtensionView(url: url) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        embedHostingController(rootView: shareView)
    }

    private func presentShareView(invalidURL: Bool) {
        let shareView = ShareExtensionView(url: nil) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        embedHostingController(rootView: shareView)
    }

    private func embedHostingController(rootView: some View) {
        let hostingController = UIHostingController(rootView: rootView)
        hostingController.view.backgroundColor = .clear

        addChild(hostingController)
        view.addSubview(hostingController.view)
        hostingController.view.frame = view.bounds
        hostingController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        hostingController.didMove(toParent: self)
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "HearItShareExtension", code: 0))
    }
}
```

- [ ] **Step 2: Build and verify**

Run:
```bash
cd apps/ios && xcodegen generate
xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'generic/platform=iOS' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 3: Commit**

```bash
git add apps/ios/HearItShareExtension/ShareViewController.swift apps/ios/HearIt.xcodeproj
git commit -m "feat: rewrite ShareViewController to submit audio jobs inline"
```

---

### Task 7: Clean up dead deep link code in main app

**Files:**
- Modify: `apps/ios/HearIt/App/AppModel.swift`
- Modify: `apps/ios/HearIt/App/HearItApp.swift`

- [ ] **Step 1: Remove share deep link branch from AppModel**

In `apps/ios/HearIt/App/AppModel.swift`, in `handleIncomingURL(_:)` (around line 117-131), remove the `url.host == "share"` code path. The first `if` block that parses `com.tome.hearit://share?url=...` is no longer needed. Remove lines 118-131 entirely (the entire first `if let components` block).

The method should now only handle plain HTTP/S URLs:
```swift
func handleIncomingURL(_ url: URL) {
    if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        urlInput = url.absoluteString
        selectedTab = .home
        homeMessage = InlineMessage(text: "Imported a shared article URL.", kind: .success)
    }
}
```

- [ ] **Step 2: Remove pendingURL from HearItApp**

In `apps/ios/HearIt/App/HearItApp.swift`:

1. Remove the `@State private var pendingURL: URL?` property (line 9)... **No, keep it.** The `pendingURL` mechanism handles cold-launch deep links (e.g., HTTP/S URLs opened via universal links before the model is ready). Only remove the share-specific comment on line 8.
2. Simplify the `.onOpenURL` handler (lines 74-81) — remove the share-specific comment but keep the pendingURL logic:
```swift
.onOpenURL { url in
    Task { await authManager.handleOpenURL(url) }
    if let model {
        model.handleIncomingURL(url)
    } else {
        pendingURL = url
    }
}
```
3. Keep `createModel()` as-is (it still needs to replay `pendingURL` for HTTP/S deep links).

- [ ] **Step 3: Build and verify**

Run:
```bash
cd apps/ios && xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'generic/platform=iOS' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 4: Run existing tests**

Run:
```bash
cd apps/ios && xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test 2>&1 | grep -E "Test Suite|Executed|error:" | tail -10
```
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/HearIt/App/AppModel.swift apps/ios/HearIt/App/HearItApp.swift
git commit -m "cleanup: remove dead share deep link code from main app"
```

---

### Task 8: Build for device and test end-to-end

**Files:** None (testing only)

- [ ] **Step 1: Regenerate Xcode project**

Run:
```bash
cd apps/ios && xcodegen generate
```

- [ ] **Step 2: Build for physical device**

Run:
```bash
cd apps/ios && xcodebuild -project HearIt.xcodeproj -scheme HearIt -destination 'platform=iOS,id=00008130-000929E11433803A' -allowProvisioningUpdates build 2>&1 | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED"
```
Expected: `BUILD SUCCEEDED`

- [ ] **Step 3: Install on device and test**

Install via XcodeBuildMCP `install_app_device` tool.

Test manually:
1. Open the main app, sign in, select a voice — this seeds shared UserDefaults and Keychain
2. Open Chrome/Safari on the phone
3. Share a URL → tap "Hear It"
4. Should see "Creating audio..." briefly, then "Audio started!" with checkmark
5. Open main app → audio job should appear in the library

- [ ] **Step 4: Test error states**

1. Sign out of the main app, then try sharing — should see "Please open Hear It and sign in"
2. Share a non-HTTP URL (if possible) — extension should dismiss without action
