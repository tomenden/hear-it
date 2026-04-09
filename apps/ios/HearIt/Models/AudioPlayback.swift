import Foundation

struct AudioPlayback: Codable, Hashable {
    enum PreferredMode: String, Codable, Hashable {
        case none
        case stream
        case final
    }

    enum Mode: String, Codable, Hashable {
        case preparing
        case streaming
        case final
        case failed
    }

    struct StreamSource: Codable, Hashable {
        let playlistUrl: String
        let availableDurationSeconds: Double
        let liveEdgeUpdatedAt: String?
        let isComplete: Bool
    }

    struct FinalSource: Codable, Hashable {
        let audioUrl: String
        let durationSeconds: Double
        let fileName: String
    }

    let preferredModeForNewSessions: PreferredMode
    let isPlayable: Bool
    let stream: StreamSource?
    let final: FinalSource?
    let errorMessage: String?

    static func preparing(
        availableDurationSeconds: Double = 0,
        liveEdgeUpdatedAt: String? = nil
    ) -> AudioPlayback {
        let retainedStream =
            availableDurationSeconds > 0 || liveEdgeUpdatedAt != nil
            ? StreamSource(
                playlistUrl: "",
                availableDurationSeconds: availableDurationSeconds,
                liveEdgeUpdatedAt: liveEdgeUpdatedAt,
                isComplete: false
            )
            : nil

        return AudioPlayback(
            preferredModeForNewSessions: .none,
            isPlayable: false,
            stream: retainedStream,
            final: nil,
            errorMessage: nil
        )
    }

    static func streaming(
        playlistUrl: String,
        availableDurationSeconds: Double,
        liveEdgeUpdatedAt: String?,
        isComplete: Bool = false
    ) -> AudioPlayback {
        return AudioPlayback(
            preferredModeForNewSessions: .stream,
            isPlayable: true,
            stream: StreamSource(
                playlistUrl: playlistUrl,
                availableDurationSeconds: availableDurationSeconds,
                liveEdgeUpdatedAt: liveEdgeUpdatedAt,
                isComplete: isComplete
            ),
            final: nil,
            errorMessage: nil
        )
    }

    static func final(
        audioUrl: String,
        durationSeconds: Double,
        fileName: String,
        retainedStream: StreamSource? = nil
    ) -> AudioPlayback {
        return AudioPlayback(
            preferredModeForNewSessions: .final,
            isPlayable: true,
            stream: retainedStream,
            final: FinalSource(
                audioUrl: audioUrl,
                durationSeconds: durationSeconds,
                fileName: fileName
            ),
            errorMessage: nil
        )
    }

    static func failed(errorMessage: String) -> AudioPlayback {
        return AudioPlayback(
            preferredModeForNewSessions: .none,
            isPlayable: false,
            stream: nil,
            final: nil,
            errorMessage: errorMessage
        )
    }

    var hasStreamingSource: Bool {
        playlistUrl != nil
    }

    var hasFinalSource: Bool {
        final != nil
    }

    var prefersStreamingForNewSessions: Bool {
        preferredModeForNewSessions == .stream && hasStreamingSource
    }

    var prefersFinalForNewSessions: Bool {
        preferredModeForNewSessions == .final && final != nil
    }

    var mode: Mode {
        if errorMessage != nil {
            return .failed
        }

        if prefersFinalForNewSessions {
            return .final
        }

        if prefersStreamingForNewSessions {
            return .streaming
        }

        if hasFinalSource {
            return .final
        }

        if hasStreamingSource, isPlayable {
            return .streaming
        }

        return .preparing
    }

    var availableDurationSeconds: Double? {
        stream?.availableDurationSeconds
    }

    var liveEdgeUpdatedAt: String? {
        stream?.liveEdgeUpdatedAt
    }

    var playlistUrl: String? {
        guard let playlistUrl = stream?.playlistUrl, !playlistUrl.isEmpty else {
            return nil
        }
        return playlistUrl
    }

    var audioUrl: String? {
        final?.audioUrl
    }

    var durationSeconds: Double? {
        final?.durationSeconds
    }

    var fileName: String? {
        final?.fileName
    }

    var isStreamComplete: Bool {
        stream?.isComplete == true
    }

    init(
        preferredModeForNewSessions: PreferredMode,
        isPlayable: Bool,
        stream: StreamSource?,
        final: FinalSource?,
        errorMessage: String?
    ) {
        self.preferredModeForNewSessions = preferredModeForNewSessions
        self.isPlayable = isPlayable
        self.stream = stream
        self.final = final
        self.errorMessage = errorMessage
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        if container.contains(.preferredModeForNewSessions) {
            let decodedStream = try container.decodeIfPresent(StreamSource.self, forKey: .stream)
            let decodedFinal = try container.decodeIfPresent(FinalSource.self, forKey: .final)
            let inferredPreferredMode =
                try container.decodeIfPresent(PreferredMode.self, forKey: .preferredModeForNewSessions)
                ?? (decodedFinal != nil ? .final : decodedStream != nil ? .stream : .none)

            preferredModeForNewSessions = inferredPreferredMode
            isPlayable =
                try container.decodeIfPresent(Bool.self, forKey: .isPlayable)
                ?? (decodedStream != nil || decodedFinal != nil)
            stream = decodedStream
            final = decodedFinal
            errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
            return
        }

        let legacyMode = try container.decode(LegacyMode.self, forKey: .mode)
        switch legacyMode {
        case .preparing:
            self = .preparing()
        case .streaming:
            self = .streaming(
                playlistUrl: try container.decode(String.self, forKey: .playlistUrl),
                availableDurationSeconds: try container.decode(Double.self, forKey: .availableDurationSeconds),
                liveEdgeUpdatedAt: try container.decode(String.self, forKey: .liveEdgeUpdatedAt)
            )
        case .final:
            self = .final(
                audioUrl: try container.decode(String.self, forKey: .audioUrl),
                durationSeconds: try container.decode(Double.self, forKey: .durationSeconds),
                fileName: try container.decode(String.self, forKey: .fileName)
            )
        case .failed:
            self = .failed(
                errorMessage: try container.decode(String.self, forKey: .errorMessage)
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(preferredModeForNewSessions, forKey: .preferredModeForNewSessions)
        try container.encode(isPlayable, forKey: .isPlayable)
        try container.encodeIfPresent(stream, forKey: .stream)
        try container.encodeIfPresent(final, forKey: .final)
        try container.encodeIfPresent(errorMessage, forKey: .errorMessage)
    }
}

private extension AudioPlayback {
    enum CodingKeys: String, CodingKey {
        case preferredModeForNewSessions
        case isPlayable
        case stream
        case final
        case errorMessage

        // Legacy payload support
        case mode
        case availableDurationSeconds
        case liveEdgeUpdatedAt
        case playlistUrl
        case audioUrl
        case durationSeconds
        case fileName
    }

    enum LegacyMode: String, Codable {
        case preparing
        case streaming
        case final
        case failed
    }
}
