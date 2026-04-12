import Foundation

struct AudioPlayback: Codable, Hashable {
    enum Mode: String, Codable, Hashable {
        case preparing
        case ready
        case failed
    }

    struct FinalSource: Codable, Hashable {
        let audioUrl: String
        let durationSeconds: Double
        let fileName: String
    }

    let isPlayable: Bool
    let final: FinalSource?
    let errorMessage: String?

    static func preparing() -> AudioPlayback {
        AudioPlayback(
            isPlayable: false,
            final: nil,
            errorMessage: nil
        )
    }

    static func ready(
        audioUrl: String,
        durationSeconds: Double,
        fileName: String
    ) -> AudioPlayback {
        AudioPlayback(
            isPlayable: true,
            final: FinalSource(
                audioUrl: audioUrl,
                durationSeconds: durationSeconds,
                fileName: fileName
            ),
            errorMessage: nil
        )
    }

    static func failed(errorMessage: String) -> AudioPlayback {
        AudioPlayback(
            isPlayable: false,
            final: nil,
            errorMessage: errorMessage
        )
    }

    var hasFinalSource: Bool {
        final != nil
    }

    var mode: Mode {
        if errorMessage != nil { return .failed }
        if hasFinalSource { return .ready }
        return .preparing
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

    init(
        isPlayable: Bool,
        final: FinalSource?,
        errorMessage: String?
    ) {
        self.isPlayable = isPlayable
        self.final = final
        self.errorMessage = errorMessage
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        // New format or legacy format with preferredModeForNewSessions
        if container.contains(.isPlayable) || container.contains(.preferredModeForNewSessions) {
            let decodedFinal = try container.decodeIfPresent(FinalSource.self, forKey: .final)
            isPlayable = try container.decodeIfPresent(Bool.self, forKey: .isPlayable) ?? (decodedFinal != nil)
            final = decodedFinal
            errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
            return
        }

        // Very old legacy format with mode key
        let legacyMode = try container.decode(LegacyMode.self, forKey: .mode)
        switch legacyMode {
        case .preparing, .streaming:
            self = .preparing()
        case .final:
            self = .ready(
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
        try container.encode(isPlayable, forKey: .isPlayable)
        try container.encodeIfPresent(final, forKey: .final)
        try container.encodeIfPresent(errorMessage, forKey: .errorMessage)
    }
}

private extension AudioPlayback {
    enum CodingKeys: String, CodingKey {
        case isPlayable
        case final
        case errorMessage

        // Legacy payload support
        case preferredModeForNewSessions
        case mode
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
