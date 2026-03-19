import Foundation
import Observation

@MainActor
@Observable
final class AppSettings {
    private enum Key {
        static let apiBaseURL = "hear-it.api-base-url"
        static let selectedVoiceID = "hear-it.selected-voice-id"
        static let selectedLanguage = "hear-it.selected-language"
        static let lastPresentedJobID = "hear-it.last-presented-job-id"
    }

    @ObservationIgnored private let defaults: UserDefaults

    var apiBaseURLString: String {
        didSet {
            defaults.set(Self.normalizeBaseURLString(apiBaseURLString), forKey: Key.apiBaseURL)
        }
    }

    var selectedVoiceID: String {
        didSet {
            defaults.set(selectedVoiceID, forKey: Key.selectedVoiceID)
        }
    }

    /// BCP 47 language tag (e.g. "en", "ru", "he") or nil for auto-detect.
    var selectedLanguage: String? {
        didSet {
            if let lang = selectedLanguage {
                defaults.set(lang, forKey: Key.selectedLanguage)
            } else {
                defaults.removeObject(forKey: Key.selectedLanguage)
            }
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
        self.selectedLanguage = defaults.string(forKey: Key.selectedLanguage)
        self.lastPresentedJobID = defaults.string(forKey: Key.lastPresentedJobID)
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
