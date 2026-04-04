import Foundation
import Observation

@MainActor
@Observable
final class AppSettings {
    private enum Key {
        static let apiBaseURL = "hear-it.api-base-url"
        static let selectedVoiceID = "hear-it.selected-voice-id"
        static let lastPresentedJobID = "hear-it.last-presented-job-id"
    }

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let sharedDefaults = UserDefaults(suiteName: "group.com.tome.hearit")

    var apiBaseURLString: String {
        didSet {
            let normalized = Self.normalizeBaseURLString(apiBaseURLString)
            defaults.set(normalized, forKey: Key.apiBaseURL)
            sharedDefaults?.set(normalized, forKey: Key.apiBaseURL)
        }
    }

    var selectedVoiceID: String {
        didSet {
            defaults.set(selectedVoiceID, forKey: Key.selectedVoiceID)
            sharedDefaults?.set(selectedVoiceID, forKey: Key.selectedVoiceID)
        }
    }

    var lastPresentedJobID: String? {
        didSet {
            defaults.set(lastPresentedJobID, forKey: Key.lastPresentedJobID)
        }
    }

    var apiBaseURL: URL? {
        guard let url = URL(string: Self.normalizeBaseURLString(apiBaseURLString)),
              let scheme = url.scheme,
              ["http", "https"].contains(scheme.lowercased()) else {
            return nil
        }

        return url
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.apiBaseURLString = defaults.string(forKey: Key.apiBaseURL) ?? Self.defaultBaseURLString
        self.selectedVoiceID = defaults.string(forKey: Key.selectedVoiceID) ?? "alloy"
        self.lastPresentedJobID = defaults.string(forKey: Key.lastPresentedJobID)
        sharedDefaults?.set(Self.normalizeBaseURLString(apiBaseURLString), forKey: Key.apiBaseURL)
        sharedDefaults?.set(selectedVoiceID, forKey: Key.selectedVoiceID)
    }

    static func normalizeBaseURLString(_ rawValue: String) -> String {
        rawValue
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private static var defaultBaseURLString: String {
        "https://hear-it.onrender.com"
    }
}
