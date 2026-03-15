import Sentry
import SwiftUI

@main
struct HearItApp: App {
    @State private var model = AppModel()

    init() {
        if let dsn = Bundle.main.object(forInfoDictionaryKey: "SentryDSN") as? String,
           !dsn.isEmpty, dsn != "YOUR_SENTRY_DSN_HERE" {
            SentrySDK.start { options in
                options.dsn = dsn
                options.enableAutoSessionTracking = true
                // Disable App Hang detection — our polling + TTS generation
                // routinely takes >2s and produces false positives
                options.enableAppHangTracking = false
                // Don't report transient network errors from background polling
                options.beforeSend = { event in
                    if let exceptions = event.exceptions,
                       exceptions.contains(where: { ex in
                           let msg = ex.value ?? ""
                           return msg.contains("fetch failed") ||
                                  msg.contains("network connection was lost") ||
                                  msg.contains("timed out") ||
                                  msg.contains("Could not connect to the server")
                       }) {
                        return nil
                    }
                    return event
                }
            }
        }

        Analytics.configure()
        Analytics.track("app_opened")
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
    }
}
