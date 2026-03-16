import Sentry
import SwiftUI

@main
struct HearItApp: App {
    @State private var authManager = AuthManager()
    @State private var model: AppModel?

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
            Group {
                switch authManager.state {
                case .loading:
                    splashView
                case .signedOut:
                    LoginView(authManager: authManager)
                case .signedIn:
                    if let model {
                        RootView(model: model)
                    } else {
                        splashView
                            .onAppear { createModel() }
                    }
                }
            }
            .task {
                await authManager.initialize()
            }
            .onChange(of: authManager.state) { _, newState in
                if case .signedOut = newState {
                    model = nil
                }
            }
            .onOpenURL { url in
                Task { await authManager.handleOpenURL(url) }
                model?.handleIncomingURL(url)
            }
        }
    }

    private var splashView: some View {
        ZStack {
            AppTheme.Gradients.page.ignoresSafeArea()
            ProgressView().tint(AppTheme.Colors.accentGreen)
        }
    }

    private func createModel() {
        guard model == nil else { return }
        model = AppModel(authManager: authManager)
    }
}
