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
