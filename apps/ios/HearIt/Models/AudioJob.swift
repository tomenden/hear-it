import Foundation

struct AudioJob: Codable, Hashable, Identifiable {
    enum State: String, Codable, CaseIterable {
        case queued
        case processing
        case ready
        case failed

        var label: String {
            switch self {
            case .queued:
                "Queued"
            case .processing:
                "Processing"
            case .ready:
                "Ready"
            case .failed:
                "Failed"
            }
        }
    }

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

    struct Progress: Codable, Hashable {
        let chunksTotal: Int?
        let chunksReady: Int
        let availableDurationSeconds: Double
    }

    let id: String
    let state: State
    let playback: AudioPlayback
    let progress: Progress
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

    var status: Status {
        switch state {
        case .queued:
            .queued
        case .processing:
            .processing
        case .ready:
            .completed
        case .failed:
            .failed
        }
    }

    var statusMessage: String {
        switch state {
        case .queued:
            "Waiting in line to create your audio."
        case .processing:
            "Generating audio now. This usually finishes in under a minute for shorter reads."
        case .ready:
            "Ready to play."
        case .failed:
            error ?? "Audio creation failed."
        }
    }

    init(
        id: String,
        status: Status,
        article: Article,
        speechOptions: SpeechOptions,
        provider: String,
        audioUrl: String?,
        audioDownloadPath: String?,
        playlistUrl: String?,
        audioSegments: [Segment],
        durationSeconds: Double?,
        error: String?,
        createdAt: Date,
        updatedAt: Date,
        liveEdgeUpdatedAt: String? = nil,
        playback: AudioPlayback? = nil,
        progress: Progress? = nil
    ) {
        self.id = id
        self.state = Self.state(from: status)
        self.article = article
        self.speechOptions = speechOptions
        self.provider = provider
        self.audioUrl = audioUrl
        self.audioDownloadPath = audioDownloadPath
        self.playlistUrl = playlistUrl
        self.audioSegments = audioSegments
        self.durationSeconds = durationSeconds
        self.error = error
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.playback = playback ?? Self.makePlayback(
            state: self.state,
            title: article.displayTitle,
            audioUrl: audioUrl,
            playlistUrl: playlistUrl,
            liveEdgeUpdatedAt: liveEdgeUpdatedAt,
            durationSeconds: durationSeconds,
            error: error,
            audioSegments: audioSegments
        )
        self.progress = progress ?? Self.makeProgress(
            state: self.state,
            playback: self.playback,
            audioSegments: audioSegments,
            durationSeconds: durationSeconds
        )
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        let article = try container.decode(Article.self, forKey: .article)
        let audioSegments = try container.decodeIfPresent([Segment].self, forKey: .audioSegments) ?? []
        let explicitState = try container.decodeIfPresent(State.self, forKey: .state)
        let legacyStatus = try container.decodeIfPresent(Status.self, forKey: .status)
        let resolvedState = explicitState ?? legacyStatus.map(Self.state(from:))
        guard let resolvedState else {
            throw DecodingError.keyNotFound(
                CodingKeys.state,
                DecodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "Missing audio job state."
                )
            )
        }

        let explicitPlayback = try container.decodeIfPresent(AudioPlayback.self, forKey: .playback)
        let explicitProgress = try container.decodeIfPresent(Progress.self, forKey: .progress)
        let durationSeconds = try container.decodeIfPresent(Double.self, forKey: .durationSeconds)
        let audioUrl = try container.decodeIfPresent(String.self, forKey: .audioUrl)
        let audioDownloadPath = try container.decodeIfPresent(String.self, forKey: .audioDownloadPath)
        let playlistUrl = try container.decodeIfPresent(String.self, forKey: .playlistUrl)
        let liveEdgeUpdatedAt = try container.decodeIfPresent(String.self, forKey: .liveEdgeUpdatedAt)
        let error = try container.decodeIfPresent(String.self, forKey: .error)
        let speechOptions = try container.decode(SpeechOptions.self, forKey: .speechOptions)
        let provider = try container.decode(String.self, forKey: .provider)
        let createdAt = try container.decode(Date.self, forKey: .createdAt)
        let updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        let resolvedPlayback = explicitPlayback ?? Self.makePlayback(
            state: resolvedState,
            title: article.displayTitle,
            audioUrl: audioUrl,
            playlistUrl: playlistUrl,
            liveEdgeUpdatedAt: liveEdgeUpdatedAt,
            durationSeconds: durationSeconds,
            error: error,
            audioSegments: audioSegments
        )
        let resolvedProgress = explicitProgress ?? Self.makeProgress(
            state: resolvedState,
            playback: resolvedPlayback,
            audioSegments: audioSegments,
            durationSeconds: durationSeconds
        )

        self.init(
            id: id,
            status: Self.status(from: resolvedState),
            article: article,
            speechOptions: speechOptions,
            provider: provider,
            audioUrl: audioUrl ?? resolvedPlayback.audioUrl,
            audioDownloadPath: audioDownloadPath,
            playlistUrl: playlistUrl ?? resolvedPlayback.playlistUrl,
            audioSegments: audioSegments,
            durationSeconds: durationSeconds ?? resolvedPlayback.durationSeconds,
            error: error ?? resolvedPlayback.errorMessage,
            createdAt: createdAt,
            updatedAt: updatedAt,
            liveEdgeUpdatedAt: liveEdgeUpdatedAt ?? resolvedPlayback.liveEdgeUpdatedAt,
            playback: resolvedPlayback,
            progress: resolvedProgress
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(state, forKey: .state)
        try container.encode(status, forKey: .status)
        try container.encode(playback, forKey: .playback)
        try container.encode(progress, forKey: .progress)
        try container.encode(article, forKey: .article)
        try container.encode(speechOptions, forKey: .speechOptions)
        try container.encode(provider, forKey: .provider)
        try container.encodeIfPresent(audioUrl, forKey: .audioUrl)
        try container.encodeIfPresent(audioDownloadPath, forKey: .audioDownloadPath)
        try container.encodeIfPresent(playlistUrl, forKey: .playlistUrl)
        try container.encode(audioSegments, forKey: .audioSegments)
        try container.encodeIfPresent(durationSeconds, forKey: .durationSeconds)
        try container.encodeIfPresent(error, forKey: .error)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }

    func playbackURL(relativeTo baseURL: URL) -> URL? {
        switch playback.mode {
        case .final:
            return HearItAPIClient.resolveURL(playback.audioUrl, relativeTo: baseURL)
        case .streaming:
            return HearItAPIClient.resolveURL(playback.playlistUrl, relativeTo: baseURL)
        case .preparing, .failed:
            return nil
        }
    }

    func audioDownloadURL(relativeTo baseURL: URL) -> URL? {
        HearItAPIClient.resolveURL(audioDownloadPath, relativeTo: baseURL)
    }
}

private extension AudioJob {
    enum CodingKeys: String, CodingKey {
        case id
        case state
        case status
        case playback
        case progress
        case article
        case speechOptions
        case provider
        case audioUrl
        case audioDownloadPath
        case playlistUrl
        case liveEdgeUpdatedAt
        case audioSegments
        case durationSeconds
        case error
        case createdAt
        case updatedAt
    }

    static func state(from status: Status) -> State {
        switch status {
        case .queued:
            .queued
        case .processing:
            .processing
        case .completed:
            .ready
        case .failed:
            .failed
        }
    }

    static func status(from state: State) -> Status {
        switch state {
        case .queued:
            .queued
        case .processing:
            .processing
        case .ready:
            .completed
        case .failed:
            .failed
        }
    }

    static func makePlayback(
        state: State,
        title: String,
        audioUrl: String?,
        playlistUrl: String?,
        liveEdgeUpdatedAt: String?,
        durationSeconds: Double?,
        error: String?,
        audioSegments: [Segment]
    ) -> AudioPlayback {
        switch state {
        case .failed:
            return .failed(errorMessage: error ?? "Audio generation failed.")
        case .ready:
            if let audioUrl {
                return .final(
                    audioUrl: audioUrl,
                    durationSeconds: durationSeconds ?? defaultDurationSeconds(from: audioSegments),
                    fileName: sanitizedFileName(from: title)
                )
            }

            return .preparing()
        case .processing:
            if let playlistUrl, let liveEdgeUpdatedAt {
                return .streaming(
                    playlistUrl: playlistUrl,
                    availableDurationSeconds: defaultAvailableDurationSeconds(
                        state: state,
                        durationSeconds: durationSeconds,
                        audioSegments: audioSegments
                    ),
                    liveEdgeUpdatedAt: liveEdgeUpdatedAt
                )
            }

            return .preparing(
                availableDurationSeconds: defaultAvailableDurationSeconds(
                    state: state,
                    durationSeconds: durationSeconds,
                    audioSegments: audioSegments
                )
            )
        case .queued:
            return .preparing()
        }
    }

    static func makeProgress(
        state: State,
        playback: AudioPlayback,
        audioSegments: [Segment],
        durationSeconds: Double?
    ) -> Progress {
        let chunksReady = audioSegments.count
        let chunksTotal: Int? = state == .ready ? chunksReady : nil
        let availableDurationSeconds = playback.availableDurationSeconds
            ?? durationSeconds
            ?? defaultDurationSeconds(from: audioSegments)

        return Progress(
            chunksTotal: chunksTotal,
            chunksReady: chunksReady,
            availableDurationSeconds: availableDurationSeconds
        )
    }

    static func defaultDurationSeconds(from audioSegments: [Segment]) -> Double {
        audioSegments.reduce(0) { $0 + $1.durationSeconds }
    }

    static func defaultAvailableDurationSeconds(
        state: State,
        durationSeconds: Double?,
        audioSegments: [Segment]
    ) -> Double {
        if state == .queued {
            return 0
        }

        return durationSeconds ?? defaultDurationSeconds(from: audioSegments)
    }

    static func sanitizedFileName(from title: String) -> String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeBaseName = (trimmedTitle.isEmpty ? "audio" : trimmedTitle)
            .replacingOccurrences(of: "[<>:\"/\\\\|?*\\u{0000}-\\u{001F}]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return "\(safeBaseName.isEmpty ? "audio" : safeBaseName).mp3"
    }
}
