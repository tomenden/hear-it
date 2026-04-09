import Foundation
import Testing
@testable import HearIt

private final class AudioDownloadMockAPIClient: HearItAPIProviding, @unchecked Sendable {
    var tokenProvider: (@Sendable () async -> String?)?
    var downloadedURLs: [URL] = []
    var audioData = Data("DOWNLOADED-FINAL-AUDIO".utf8)
    var fetchJobsHandler: @Sendable (URL, Bool) async throws -> [AudioJob] = { _, _ in [] }

    func fetchConfig(baseURL: URL) async throws -> ServerConfig {
        ServerConfig(provider: "openai", audioPublicBaseURL: "/audio", openAIConfigured: true)
    }

    func fetchVoices(baseURL: URL) async throws -> [String] {
        ["alloy"]
    }

    func fetchJobs(baseURL: URL, reportErrors: Bool) async throws -> [AudioJob] {
        try await fetchJobsHandler(baseURL, reportErrors)
    }

    func extractArticle(articleURL: String, baseURL: URL) async throws -> Article {
        fatalError("Unused in AppModelAudioPlaybackSessionTests")
    }

    func deleteJob(jobID: String, baseURL: URL) async throws {
        fatalError("Unused in AppModelAudioPlaybackSessionTests")
    }

    func createJob(articleURL: String, voiceID: String, baseURL: URL) async throws -> AudioJob {
        fatalError("Unused in AppModelAudioPlaybackSessionTests")
    }

    func downloadAudioData(from url: URL) async throws -> Data {
        downloadedURLs.append(url)
        return audioData
    }
}

@MainActor
struct AppModelAudioPlaybackSessionTests {
    @Test
    func keepsStreamingSessionPinnedWhenFinalAudioArrives() async throws {
        let model = makeModel()
        let streamingJob = makeJob(
            id: "job-streaming",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-streaming/playlist.m3u8",
                availableDurationSeconds: 12,
                liveEdgeUpdatedAt: "2026-04-05T12:30:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-streaming/segment-0.mp3", durationSeconds: 12),
            ]
        )
        let readyJob = makeJob(
            id: streamingJob.id,
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-streaming/final.mp3",
                durationSeconds: 30,
                fileName: "Streaming job.mp3"
            ),
            playlistUrl: "/audio/job-streaming/playlist.m3u8",
            audioSegments: [
                .init(url: "/audio/job-streaming/segment-0.mp3", durationSeconds: 12),
                .init(url: "/audio/job-streaming/segment-1.mp3", durationSeconds: 18),
            ],
            durationSeconds: 30
        )
        let playlistURL = URL(string: "http://localhost:3000/audio/job-streaming/playlist.m3u8")!
        model.jobs = [streamingJob]
        model.playerPresentation = PlayerPresentation(jobID: streamingJob.id)

        model.preparePlayer(for: streamingJob.id)
        model.player.configurePreviewState(
            jobID: streamingJob.id,
            duration: 12,
            currentTime: 8,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.jobs = [readyJob]
        model.preparePlayer(for: readyJob.id)

        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.duration == 12)
        #expect(model.isStreamingPlaybackSession(for: readyJob))
        #expect(!model.areAdvancedPlaybackControlsEnabled(for: readyJob))
    }

    @Test
    func keepsExistingFinalSessionPinnedWhenLocalAudioAssetExists() async throws {
        let store = makeStore()
        _ = try await store.saveAudioFile(
            forJobID: "job-final-session",
            audioData: Data("FINALMP3".utf8)
        )

        let model = makeModel(localAudioStore: store)
        let job = makeJob(
            id: "job-final-session",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-final-session/final.mp3",
                durationSeconds: 30,
                fileName: "Pinned final.mp3"
            ),
            durationSeconds: 30
        )
        let remoteFinalURL = URL(string: "http://localhost:3000/audio/job-final-session/final.mp3")!
        model.jobs = [job]
        model.playerPresentation = PlayerPresentation(jobID: job.id)
        model.player.configurePreviewState(
            jobID: job.id,
            duration: 30,
            currentTime: 9,
            isPlaying: false,
            loadedSourceURL: remoteFinalURL
        )

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedSourceURL == remoteFinalURL)
    }

    @Test
    func downloadsFinalAudioInBackgroundWithoutChangingCurrentPlayerItem() async throws {
        let apiClient = AudioDownloadMockAPIClient()
        let store = makeStore()
        let model = makeModel(localAudioStore: store, apiClient: apiClient)
        let job = makeJob(
            id: "job-background-download",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-background-download/final.mp3",
                durationSeconds: 30,
                fileName: "Background download.mp3"
            ),
            audioSegments: [],
            durationSeconds: 30
        )
        let remoteFinalURL = URL(string: "http://localhost:3000/audio/job-background-download/final.mp3")!
        model.jobs = [job]
        model.playerPresentation = PlayerPresentation(jobID: job.id)
        model.player.configurePreviewState(
            jobID: job.id,
            duration: 30,
            currentTime: 7,
            isPlaying: false,
            loadedSourceURL: remoteFinalURL
        )

        model.preparePlayer(for: job.id)
        try await eventually("local audio asset download") {
            store.playbackURLIfExists(forJobID: job.id) != nil
        }

        #expect(apiClient.downloadedURLs == [remoteFinalURL])
        #expect(model.player.loadedSourceURL == remoteFinalURL)
        #expect(store.playbackURLIfExists(forJobID: job.id)?.isFileURL == true)
    }

    @Test
    func endedStreamingSessionStartsFreshFinalSessionOnReopen() async throws {
        let store = makeStore()
        _ = try await store.saveAudioFile(
            forJobID: "job-ended-stream",
            audioData: Data("FINALMP3".utf8)
        )

        let model = makeModel(localAudioStore: store)
        let streamingJob = makeJob(
            id: "job-ended-stream",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-ended-stream/playlist.m3u8",
                availableDurationSeconds: 12,
                liveEdgeUpdatedAt: "2026-04-05T12:30:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-ended-stream/segment-0.mp3", durationSeconds: 12),
            ]
        )
        let finalJob = makeJob(
            id: streamingJob.id,
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-ended-stream/final.mp3",
                durationSeconds: 30,
                fileName: "Ended stream.mp3"
            ),
            durationSeconds: 30
        )
        let playlistURL = URL(string: "http://localhost:3000/audio/job-ended-stream/playlist.m3u8")!
        model.jobs = [streamingJob]
        model.playerPresentation = PlayerPresentation(jobID: streamingJob.id)

        model.preparePlayer(for: streamingJob.id)
        model.player.configurePreviewState(
            jobID: streamingJob.id,
            duration: 12,
            currentTime: 12,
            isPlaying: false,
            loadedSourceURL: playlistURL
        )

        model.player.endPlaybackSession()
        model.jobs = [finalJob]
        model.preparePlayer(for: finalJob.id)

        #expect(model.player.loadedSourceURL?.isFileURL == true)
        #expect(model.player.loadedSourceURL?.lastPathComponent == "audio-job-ended-stream.mp3")
        #expect(model.player.duration == 30)
    }

    @Test
    func streamingSessionReloadsAndResumesWhenMoreAudioArrivesAfterHittingTheLiveEdge() async throws {
        let model = makeModel()
        let playlistURL = URL(string: "http://localhost:3000/audio/job-live-edge/playlist.m3u8")!
        let initialJob = makeJob(
            id: "job-live-edge",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-live-edge/playlist.m3u8",
                availableDurationSeconds: 8,
                liveEdgeUpdatedAt: "2026-04-05T12:30:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-live-edge/segment-0.mp3", durationSeconds: 8),
            ]
        )
        let updatedJob = makeJob(
            id: initialJob.id,
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-live-edge/playlist.m3u8",
                availableDurationSeconds: 24,
                liveEdgeUpdatedAt: "2026-04-05T12:30:08Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-live-edge/segment-0.mp3", durationSeconds: 8),
                .init(url: "/audio/job-live-edge/segment-1.mp3", durationSeconds: 8),
                .init(url: "/audio/job-live-edge/segment-2.mp3", durationSeconds: 8),
            ]
        )
        model.jobs = [initialJob]
        model.playerPresentation = PlayerPresentation(jobID: initialJob.id)

        model.preparePlayer(for: initialJob.id)
        model.player.configurePreviewState(
            jobID: initialJob.id,
            duration: 8,
            currentTime: 8,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.player.handlePlaybackItemDidReachEnd()

        model.jobs = [updatedJob]
        model.preparePlayer(for: updatedJob.id)

        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.duration == 24)
        #expect(model.player.isPlaying)
    }

    @Test
    func pinnedStreamingSessionKeepsStreamingRulesAfterJobFinalizes() {
        let model = makeModel()
        let playlistURL = URL(string: "http://localhost:3000/audio/job-pinned-stream/playlist.m3u8")!
        let streamingJob = makeJob(
            id: "job-pinned-stream",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-pinned-stream/playlist.m3u8",
                availableDurationSeconds: 68,
                liveEdgeUpdatedAt: "2026-04-05T12:30:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-pinned-stream/segment-0.mp3", durationSeconds: 68),
            ],
            estimatedMinutes: 3
        )
        let finalJob = makeJob(
            id: streamingJob.id,
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-pinned-stream/final.mp3",
                durationSeconds: 166,
                fileName: "Pinned stream.mp3",
                retainedStream: .init(
                    playlistUrl: "/audio/job-pinned-stream/playlist.m3u8",
                    availableDurationSeconds: 166,
                    liveEdgeUpdatedAt: "2026-04-05T12:31:00Z",
                    isComplete: true
                )
            ),
            playlistUrl: "/audio/job-pinned-stream/playlist.m3u8",
            durationSeconds: 166,
            estimatedMinutes: 3
        )
        model.jobs = [streamingJob]
        model.playerPresentation = PlayerPresentation(jobID: streamingJob.id)

        model.preparePlayer(for: streamingJob.id)
        model.player.configurePreviewState(
            jobID: streamingJob.id,
            duration: 68,
            currentTime: 54,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.jobs = [finalJob]
        model.preparePlayer(for: finalJob.id)

        #expect(model.isStreamingPlaybackSession(for: finalJob))
        #expect(!model.areAdvancedPlaybackControlsEnabled(for: finalJob))
        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.duration == 68)
        #expect(model.displayedTotalDuration(for: finalJob) == 166)
        #expect(!model.isUsingEstimatedTimelineEnvelope(for: finalJob))
        #expect(model.displayedTimelineProgress(for: finalJob) == 54.0 / 166.0)
    }

    @Test
    func pendingStreamingContinuationReloadsThePinnedPlaylistAfterFinalization() {
        let model = makeModel()
        let playlistURL = URL(string: "http://localhost:3000/audio/job-pending-stream/playlist.m3u8")!
        let streamingJob = makeJob(
            id: "job-pending-stream",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-pending-stream/playlist.m3u8",
                availableDurationSeconds: 63.475,
                liveEdgeUpdatedAt: "2026-04-05T12:30:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-pending-stream/segment-0.mp3", durationSeconds: 63.475),
            ],
            estimatedMinutes: 3
        )
        let finalJob = makeJob(
            id: streamingJob.id,
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-pending-stream/final.mp3",
                durationSeconds: 154.104,
                fileName: "Pending stream.mp3"
            ),
            playlistUrl: "/audio/job-pending-stream/playlist.m3u8",
            durationSeconds: 154.104,
            estimatedMinutes: 3
        )
        model.jobs = [streamingJob]
        model.playerPresentation = PlayerPresentation(jobID: streamingJob.id)

        model.preparePlayer(for: streamingJob.id)
        model.player.configurePreviewState(
            jobID: streamingJob.id,
            duration: 63.475,
            currentTime: 63.475,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.player.handlePlaybackItemDidReachEnd()
        model.jobs = [finalJob]
        model.preparePlayer(for: finalJob.id)

        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.isPlaying)
        #expect(model.player.duration == 154.104)
        #expect(model.isStreamingPlaybackSession(for: finalJob))
        #expect(!model.areAdvancedPlaybackControlsEnabled(for: finalJob))
    }

    @Test
    func refreshJobsReloadsPendingStreamingContinuationEvenWhenTheJobPayloadIsUnchanged() async {
        let apiClient = AudioDownloadMockAPIClient()
        let playlistURL = URL(string: "http://localhost:3000/audio/job-poll-resume/playlist.m3u8")!
        let finalJob = makeJob(
            id: "job-poll-resume",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-poll-resume/final.mp3",
                durationSeconds: 154.104,
                fileName: "Poll resume.mp3"
            ),
            playlistUrl: "/audio/job-poll-resume/playlist.m3u8",
            durationSeconds: 154.104,
            estimatedMinutes: 3
        )
        apiClient.fetchJobsHandler = { _, _ in [finalJob] }

        let model = makeModel(apiClient: apiClient)
        model.jobs = [finalJob]
        model.playerPresentation = PlayerPresentation(jobID: finalJob.id)
        model.player.configurePreviewState(
            jobID: finalJob.id,
            duration: 63.475,
            currentTime: 63.475,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.player.handlePlaybackItemDidReachEnd()
        await model.refreshJobs(silent: true)

        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.isPlaying)
        #expect(model.player.duration == 154.104)
    }

    @Test
    func refreshJobsReloadsPendingStreamingContinuationEvenWhenOnlyTheMiniPlayerIsVisible() async {
        let apiClient = AudioDownloadMockAPIClient()
        let playlistURL = URL(string: "http://localhost:3000/audio/job-mini-resume/playlist.m3u8")!
        let finalJob = makeJob(
            id: "job-mini-resume",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-mini-resume/final.mp3",
                durationSeconds: 154.104,
                fileName: "Mini resume.mp3"
            ),
            playlistUrl: "/audio/job-mini-resume/playlist.m3u8",
            durationSeconds: 154.104,
            estimatedMinutes: 3
        )
        apiClient.fetchJobsHandler = { _, _ in [finalJob] }

        let model = makeModel(apiClient: apiClient)
        model.jobs = [finalJob]
        model.playerPresentation = nil
        model.player.configurePreviewState(
            jobID: finalJob.id,
            duration: 63.475,
            currentTime: 63.475,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.player.handlePlaybackItemDidReachEnd()
        await model.refreshJobs(silent: true)

        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.isPlaying)
        #expect(model.player.duration == 154.104)
    }

    @Test
    func completedPinnedStreamingSessionReplayUsesFinalAudioOnFirstTap() {
        let model = makeModel()
        let playlistURL = URL(string: "http://localhost:3000/audio/job-stream-finished/playlist.m3u8")!
        let finalJob = makeJob(
            id: "job-stream-finished",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-stream-finished/final.mp3",
                durationSeconds: 146.539,
                fileName: "Stream finished.mp3"
            ),
            playlistUrl: "/audio/job-stream-finished/playlist.m3u8",
            durationSeconds: 146.539,
            estimatedMinutes: 3
        )
        model.jobs = [finalJob]
        model.playerPresentation = PlayerPresentation(jobID: finalJob.id)
        model.player.configurePreviewState(
            jobID: finalJob.id,
            duration: 146.539,
            currentTime: 146.539,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.player.handlePlaybackItemDidReachEnd()
        model.togglePlayback(for: finalJob.id)

        #expect(
            model.player.loadedSourceURL ==
                URL(string: "http://localhost:3000/audio/job-stream-finished/final.mp3")
        )
        #expect(model.player.isPlaying)
        #expect(model.player.currentTime == 0)
        #expect(model.player.duration == 146.539)
    }

    @Test
    func libraryPlayStartsPausedLoadedSessionAndPresentsPlayer() {
        let model = makeModel()
        let job = makeJob(
            id: "job-library-play",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-library-play/final.mp3",
                durationSeconds: 146.539,
                fileName: "Library play.mp3"
            ),
            durationSeconds: 146.539
        )
        let finalURL = URL(string: "http://localhost:3000/audio/job-library-play/final.mp3")!
        model.jobs = [job]
        model.player.configurePreviewState(
            jobID: job.id,
            duration: 146.539,
            currentTime: 12,
            isPlaying: false,
            loadedSourceURL: finalURL
        )

        model.playFromLibrary(for: job.id)

        #expect(model.playerPresentation?.jobID == job.id)
        #expect(model.player.loadedSourceURL == finalURL)
        #expect(model.player.isPlaying)
    }

    @Test
    func togglePlaybackReloadsFinishedFinalSession() {
        let model = makeModel()
        let job = makeJob(
            id: "job-finished-final",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-finished-final/final.mp3",
                durationSeconds: 42,
                fileName: "Finished final.mp3"
            ),
            durationSeconds: 42
        )
        model.jobs = [job]
        model.playerPresentation = PlayerPresentation(jobID: job.id)
        model.player.configurePreviewState(
            jobID: job.id,
            duration: nil,
            currentTime: 0,
            isPlaying: false,
            loadedSourceURL: nil
        )

        model.togglePlayback(for: job.id)

        #expect(model.player.loadedJobID == job.id)
        #expect(
            model.player.loadedSourceURL ==
                URL(string: "http://localhost:3000/audio/job-finished-final/final.mp3")
        )
        #expect(model.player.isPlaying)
        #expect(model.player.duration == 42)
    }

    @Test
    func reopeningEndedSessionAutoplaysWhenTheSourceWasCleared() {
        let model = makeModel()
        let job = makeJob(
            id: "job-reopen-ended",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-reopen-ended/final.mp3",
                durationSeconds: 84,
                fileName: "Reopen ended.mp3"
            ),
            durationSeconds: 84
        )
        model.jobs = [job]
        model.player.configurePreviewState(
            jobID: job.id,
            duration: nil,
            currentTime: 0,
            isPlaying: false,
            loadedSourceURL: nil
        )

        model.openPlayer(for: job.id)

        #expect(model.playerPresentation?.jobID == job.id)
        #expect(
            model.player.loadedSourceURL ==
                URL(string: "http://localhost:3000/audio/job-reopen-ended/final.mp3")
        )
        #expect(model.player.isPlaying)
    }
}

private extension AppModelAudioPlaybackSessionTests {
    func makeDefaults() -> UserDefaults {
        let suiteName = "HearItTests.AppModelAudioPlaybackSession.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    func makeStore() -> LocalAudioAssetStore {
        LocalAudioAssetStore(
            baseDirectory: FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
        )
    }

    func makeModel(
        localAudioStore: LocalAudioAssetStore? = nil,
        apiClient: any HearItAPIProviding = HearItAPIClient()
    ) -> AppModel {
        let settings = AppSettings(defaults: makeDefaults())
        settings.apiBaseURLString = "http://localhost:3000"

        return AppModel(
            settings: settings,
            apiClient: apiClient,
            localAudioStore: localAudioStore ?? makeStore(),
            player: AudioPlayerController(previewMode: true)
        )
    }

    func makeJob(
        id: String,
        state: AudioJob.State,
        playback: AudioPlayback,
        playlistUrl: String? = nil,
        audioUrl: String? = nil,
        audioSegments: [AudioJob.Segment] = [],
        durationSeconds: Double? = nil,
        estimatedMinutes: Int = 1
    ) -> AudioJob {
        let resolvedPlaylistURL = playlistUrl ?? playback.playlistUrl
        let resolvedAudioURL = audioUrl ?? playback.audioUrl
        let resolvedDuration = durationSeconds ?? playback.durationSeconds ?? playback.availableDurationSeconds
        let resolvedPlayback: AudioPlayback = {
            switch playback.mode {
            case .final:
                guard let resolvedAudioURL else { return playback }
                let retainedStream = resolvedPlaylistURL.map {
                    AudioPlayback.StreamSource(
                        playlistUrl: $0,
                        availableDurationSeconds: resolvedDuration ?? 0,
                        liveEdgeUpdatedAt: playback.liveEdgeUpdatedAt,
                        isComplete: state == .ready || playback.isStreamComplete
                    )
                }
                return .final(
                    audioUrl: resolvedAudioURL,
                    durationSeconds: resolvedDuration ?? 0,
                    fileName: playback.fileName ?? "\(id).mp3",
                    retainedStream: retainedStream ?? playback.stream
                )
            case .streaming:
                guard let resolvedPlaylistURL else { return playback }
                return .streaming(
                    playlistUrl: resolvedPlaylistURL,
                    availableDurationSeconds: playback.availableDurationSeconds ?? resolvedDuration ?? 0,
                    liveEdgeUpdatedAt: playback.liveEdgeUpdatedAt,
                    isComplete: playback.isStreamComplete
                )
            case .preparing, .failed:
                return playback
            }
        }()

        return AudioJob(
            id: id,
            status: legacyStatus(from: state),
            article: Article(
                url: "https://example.com/\(id)",
                title: id,
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: estimatedMinutes
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: resolvedAudioURL,
            audioDownloadPath: nil,
            playlistUrl: resolvedPlaylistURL,
            audioSegments: audioSegments,
            durationSeconds: resolvedDuration,
            error: resolvedPlayback.errorMessage,
            createdAt: .now,
            updatedAt: .now,
            liveEdgeUpdatedAt: resolvedPlayback.liveEdgeUpdatedAt,
            playback: resolvedPlayback,
            progress: AudioJob.Progress(
                chunksTotal: state == .ready ? audioSegments.count : nil,
                chunksReady: audioSegments.count,
                availableDurationSeconds: resolvedPlayback.availableDurationSeconds
                    ?? resolvedDuration
                    ?? audioSegments.reduce(0) { $0 + $1.durationSeconds }
            )
        )
    }

    func legacyStatus(from state: AudioJob.State) -> AudioJob.Status {
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

    func eventually(
        _ description: String,
        timeout: Duration = .seconds(1),
        pollInterval: Duration = .milliseconds(20),
        condition: @escaping @Sendable () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if condition() {
                return
            }
            try await Task.sleep(for: pollInterval)
        }

        Issue.record("Timed out waiting for \(description)")
    }
}
