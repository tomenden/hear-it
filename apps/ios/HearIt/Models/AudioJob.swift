import Foundation

struct AudioJob: Codable, Hashable, Identifiable {
    enum Status: String, Codable, CaseIterable {
        case queued
        case processing
        case completed
        case failed

        var label: String {
            switch self {
            case .queued:
                "Queued"
            case .processing:
                "Processing"
            case .completed:
                "Ready"
            case .failed:
                "Failed"
            }
        }
    }

    struct SpeechOptions: Codable, Hashable {
        let voice: String
    }

    struct Segment: Codable, Hashable {
        let url: String
        let durationSeconds: Double
    }

    let id: String
    let status: Status
    let article: Article
    let speechOptions: SpeechOptions
    let provider: String
    let audioUrl: String?
    let audioDownloadPath: String?
    let playlistUrl: String?
    let audioSegments: [Segment]
    let durationSeconds: Double?
    let error: String?
    let createdAt: Date
    let updatedAt: Date

    var statusMessage: String {
        switch status {
        case .queued:
            "Waiting in line to generate your narration."
        case .processing:
            "Generating audio now. This usually finishes in under a minute for shorter reads."
        case .completed:
            "Ready to play."
        case .failed:
            error ?? "Narration failed before audio was generated."
        }
    }

    func playbackURL(relativeTo baseURL: URL) -> URL? {
        if let playlistUrl {
            return HearItAPIClient.resolveURL(playlistUrl, relativeTo: baseURL)
        }

        return HearItAPIClient.resolveURL(audioUrl, relativeTo: baseURL)
    }

    func narrationDownloadURL(relativeTo baseURL: URL) -> URL? {
        HearItAPIClient.resolveURL(audioDownloadPath, relativeTo: baseURL)
    }
}
