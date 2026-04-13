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

    #if DEBUG
    private enum EnvironmentKey {
        static let debugAPIBaseURL = "HEAR_IT_DEBUG_API_BASE_URL"
    }
    #endif

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let sharedDefaults = UserDefaults(suiteName: "group.com.tome.hearit")
    @ObservationIgnored private let hasDebugAPIBaseURLOverride: Bool

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

    init(
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        self.defaults = defaults
        let persistedBaseURL = defaults.string(forKey: Key.apiBaseURL) ?? Self.defaultBaseURLString
        let debugAPIBaseURLOverride = Self.debugAPIBaseURLOverride(from: environment)
        let resolvedBaseURL = debugAPIBaseURLOverride ?? persistedBaseURL
        self.hasDebugAPIBaseURLOverride = debugAPIBaseURLOverride != nil

        self.apiBaseURLString = resolvedBaseURL
        self.selectedVoiceID = defaults.string(forKey: Key.selectedVoiceID) ?? "marin"
        self.lastPresentedJobID = defaults.string(forKey: Key.lastPresentedJobID)
        if !hasDebugAPIBaseURLOverride {
            defaults.set(Self.normalizeBaseURLString(apiBaseURLString), forKey: Key.apiBaseURL)
            sharedDefaults?.set(Self.normalizeBaseURLString(apiBaseURLString), forKey: Key.apiBaseURL)
        }
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

    private static func debugAPIBaseURLOverride(from environment: [String: String]) -> String? {
        #if DEBUG
        guard let rawValue = environment[EnvironmentKey.debugAPIBaseURL] else {
            return nil
        }

        let normalized = normalizeBaseURLString(rawValue)
        return normalized.isEmpty ? nil : normalized
        #else
        _ = environment
        return nil
        #endif
    }
}
