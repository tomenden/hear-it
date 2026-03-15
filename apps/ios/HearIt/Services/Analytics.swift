import Foundation
import PostHog

enum Analytics {
    static func configure() {
        guard let apiKey = Bundle.main.infoDictionary?["POSTHOG_API_KEY"] as? String,
              !apiKey.isEmpty else {
            return
        }

        let host = (Bundle.main.infoDictionary?["POSTHOG_HOST"] as? String)
            .flatMap { $0.isEmpty ? nil : $0 } ?? "https://us.i.posthog.com"

        let config = PostHogConfig(apiKey: apiKey, host: host)
        PostHogSDK.shared.setup(config)
    }

    static func track(_ event: String, properties: [String: Any] = [:]) {
        PostHogSDK.shared.capture(event, properties: properties)
    }

    static func identify(_ distinctId: String) {
        PostHogSDK.shared.identify(distinctId)
    }
}
