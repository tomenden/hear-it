import Foundation

struct AudioPlayback: Codable, Hashable {
    enum Mode: String, Codable, Hashable {
        case preparing
        case streaming
        case final
        case failed
    }

    let mode: Mode
    let isPlayable: Bool
    let availableDurationSeconds: Double?
    let liveEdgeUpdatedAt: String?
    let playlistUrl: String?
    let audioUrl: String?
    let durationSeconds: Double?
    let fileName: String?
    let errorMessage: String?

    static func preparing(
        availableDurationSeconds: Double = 0,
        liveEdgeUpdatedAt: String? = nil
    ) -> AudioPlayback {
        AudioPlayback(
            mode: .preparing,
            isPlayable: false,
            availableDurationSeconds: availableDurationSeconds,
            liveEdgeUpdatedAt: liveEdgeUpdatedAt,
            playlistUrl: nil,
            audioUrl: nil,
            durationSeconds: nil,
            fileName: nil,
            errorMessage: nil
        )
    }

    static func streaming(
        playlistUrl: String,
        availableDurationSeconds: Double,
        liveEdgeUpdatedAt: String
    ) -> AudioPlayback {
        AudioPlayback(
            mode: .streaming,
            isPlayable: true,
            availableDurationSeconds: availableDurationSeconds,
            liveEdgeUpdatedAt: liveEdgeUpdatedAt,
            playlistUrl: playlistUrl,
            audioUrl: nil,
            durationSeconds: nil,
            fileName: nil,
            errorMessage: nil
        )
    }

    static func final(
        audioUrl: String,
        durationSeconds: Double,
        fileName: String
    ) -> AudioPlayback {
        AudioPlayback(
            mode: .final,
            isPlayable: true,
            availableDurationSeconds: nil,
            liveEdgeUpdatedAt: nil,
            playlistUrl: nil,
            audioUrl: audioUrl,
            durationSeconds: durationSeconds,
            fileName: fileName,
            errorMessage: nil
        )
    }

    static func failed(errorMessage: String) -> AudioPlayback {
        AudioPlayback(
            mode: .failed,
            isPlayable: false,
            availableDurationSeconds: nil,
            liveEdgeUpdatedAt: nil,
            playlistUrl: nil,
            audioUrl: nil,
            durationSeconds: nil,
            fileName: nil,
            errorMessage: errorMessage
        )
    }
}
