import Foundation
import Testing
@testable import HearIt

@MainActor
struct AppModelAudioPlaybackTests {
    @Test
    func appSettingsDefaultToRenderProductionBaseURL() {
        let suiteName = "HearItTests.AppSettings.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let settings = AppSettings(defaults: defaults)

        #expect(settings.apiBaseURLString == "https://hear-it.onrender.com")
        #expect(settings.apiBaseURL?.absoluteString == "https://hear-it.onrender.com")
    }

    @Test
    func appSettingsDebugAPIBaseURLOverrideTakesPrecedenceWithoutPersisting() {
        let suiteName = "HearItTests.AppSettings.DebugOverride.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defaults.set("https://hear-it.onrender.com", forKey: "hear-it.api-base-url")

        let settings = AppSettings(
            defaults: defaults,
            environment: ["HEAR_IT_DEBUG_API_BASE_URL": " http://192.168.0.61:3000/ "]
        )

        #expect(settings.apiBaseURLString == "http://192.168.0.61:3000")
        #expect(settings.apiBaseURL?.absoluteString == "http://192.168.0.61:3000")
        #expect(defaults.string(forKey: "hear-it.api-base-url") == "https://hear-it.onrender.com")

        let reloadedSettings = AppSettings(defaults: defaults, environment: [:])
        #expect(reloadedSettings.apiBaseURLString == "https://hear-it.onrender.com")
    }

    @Test
    func streamingJobLoadsRemotePlaylistOncePlaybackIsReady() async throws {
        let model = makeModel()
        let job = makeJob(
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
        model.jobs = [job]

        #expect(model.hasPlayableAudio(for: job))

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == job.id)
        #expect(
            model.player.loadedSourceURL ==
                URL(string: "http://localhost:3000/audio/job-streaming/playlist.m3u8")
        )
        #expect(model.player.duration == 12)
        #expect(model.player.canSeek)
        #expect(model.displayedTotalDuration(for: job) == 60)
        #expect(model.isUsingEstimatedTimelineEnvelope(for: job))
    }

    @Test
    func streamingPlaybackUsesEstimatedArticleDurationAsInitialTimelineEnvelope() {
        let model = makeModel()
        let job = makeJob(
            id: "job-streaming-estimate",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-streaming-estimate/playlist.m3u8",
                availableDurationSeconds: 42,
                liveEdgeUpdatedAt: "2026-04-06T10:00:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-streaming-estimate/segment-0.mp3", durationSeconds: 42),
            ],
            estimatedMinutes: 3
        )
        model.jobs = [job]

        model.preparePlayer(for: job.id)

        #expect(model.displayedTotalDuration(for: job) == 180)
        #expect(model.isUsingEstimatedTimelineEnvelope(for: job))
    }

    @Test
    func displayedTimelineProgressUsesEstimatedEnvelopeForPinnedStreamingSessions() {
        let model = makeModel()
        let job = makeJob(
            id: "job-streaming-envelope-progress",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-streaming-envelope-progress/playlist.m3u8",
                availableDurationSeconds: 68,
                liveEdgeUpdatedAt: "2026-04-06T10:00:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-streaming-envelope-progress/segment-0.mp3", durationSeconds: 68),
            ],
            estimatedMinutes: 3
        )
        model.jobs = [job]
        model.playerPresentation = PlayerPresentation(jobID: job.id)

        model.preparePlayer(for: job.id)
        model.player.configurePreviewState(
            jobID: job.id,
            duration: 68,
            currentTime: 54,
            isPlaying: true,
            loadedSourceURL: URL(string: "http://localhost:3000/audio/job-streaming-envelope-progress/playlist.m3u8")
        )

        #expect(model.displayedTotalDuration(for: job) == 180)
        #expect(model.displayedTimelineProgress(for: job) == 0.3)
    }

    @Test
    func completedPinnedStreamingSessionUsesFinalDurationForDisplayedTimeline() {
        let model = makeModel()
        let job = makeJob(
            id: "job-streaming-final-duration",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-streaming-final-duration/final.mp3",
                durationSeconds: 166,
                fileName: "Pinned stream.mp3",
                retainedStream: .init(
                    playlistUrl: "/audio/job-streaming-final-duration/playlist.m3u8",
                    availableDurationSeconds: 68,
                    liveEdgeUpdatedAt: "2026-04-06T10:00:00Z",
                    isComplete: true
                )
            ),
            durationSeconds: 166,
            estimatedMinutes: 3
        )
        model.jobs = [job]
        model.playerPresentation = PlayerPresentation(jobID: job.id)

        model.player.configurePreviewState(
            jobID: job.id,
            duration: 68,
            currentTime: 54,
            isPlaying: true,
            loadedSourceURL: URL(string: "http://localhost:3000/audio/job-streaming-final-duration/playlist.m3u8")
        )

        #expect(model.isStreamingPlaybackSession(for: job))
        #expect(model.displayedTotalDuration(for: job) == 166)
        #expect(!model.isUsingEstimatedTimelineEnvelope(for: job))
        #expect(model.displayedTimelineProgress(for: job) == 54.0 / 166.0)
    }

    @Test
    func streamingPlaybackTimelineStillGrowsPastShortEstimates() {
        let model = makeModel()
        let job = makeJob(
            id: "job-streaming-short-estimate",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-streaming-short-estimate/playlist.m3u8",
                availableDurationSeconds: 72,
                liveEdgeUpdatedAt: "2026-04-06T10:00:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-streaming-short-estimate/segment-0.mp3", durationSeconds: 72),
            ],
            estimatedMinutes: 1
        )
        model.jobs = [job]

        model.preparePlayer(for: job.id)

        #expect(model.displayedTotalDuration(for: job) == 72)
        #expect(!model.isUsingEstimatedTimelineEnvelope(for: job))
    }

    @Test
    func preparingJobDoesNotLoadAudioUntilStreamIsPlayable() {
        let model = makeModel()
        let job = makeJob(
            id: "job-preparing",
            state: .processing,
            playback: .preparing(availableDurationSeconds: 12),
            playlistUrl: "/audio/job-preparing/playlist.m3u8",
            audioSegments: [
                .init(url: "/audio/job-preparing/segment-0.mp3", durationSeconds: 12),
            ]
        )
        model.jobs = [job]

        #expect(!model.hasPlayableAudio(for: job))

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == nil)
        #expect(model.player.loadedSourceURL == nil)
    }

    @Test
    func finalJobPrefersRemoteMP3ForFreshSessions() async throws {
        let model = makeModel()
        let job = makeJob(
            id: "job-final",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-final/final.mp3",
                durationSeconds: 30,
                fileName: "Completed playback.mp3"
            ),
            durationSeconds: 30
        )
        model.jobs = [job]

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == job.id)
        #expect(
            model.player.loadedSourceURL ==
                URL(string: "http://localhost:3000/audio/job-final/final.mp3")
        )
        #expect(model.player.duration == 30)
        #expect(model.displayedTotalDuration(for: job) == 30)
    }

    @Test
    func finalJobPrefersFinalDurationOverStaleAvailableDurationMetadata() {
        let model = makeModel()
        let job = makeJob(
            id: "job-final-stale-progress",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-final-stale-progress/final.mp3",
                durationSeconds: 30,
                fileName: "Final stale progress.mp3",
                retainedStream: .init(
                    playlistUrl: "/audio/job-final-stale-progress/playlist.m3u8",
                    availableDurationSeconds: 12,
                    liveEdgeUpdatedAt: "2026-04-05T12:30:00Z",
                    isComplete: true
                )
            ),
            durationSeconds: 30
        )
        model.jobs = [job]

        model.preparePlayer(for: job.id)

        #expect(model.player.duration == 30)
        #expect(model.displayedTotalDuration(for: job) == 30)
    }

    @Test
    func freshFinalSessionsMayUseLocalAudioAssetAsASilentOptimization() async throws {
        let store = makeStore()
        _ = try await store.saveAudioFile(
            forJobID: "job-local-final",
            audioData: Data("FINALMP3".utf8)
        )

        let model = makeModel(localAudioStore: store)
        let job = makeJob(
            id: "job-local-final",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-local-final/final.mp3",
                durationSeconds: 30,
                fileName: "Cached playback.mp3"
            ),
            durationSeconds: 30
        )
        model.jobs = [job]

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == job.id)
        #expect(model.player.loadedSourceURL?.isFileURL == true)
        #expect(model.player.loadedSourceURL?.pathExtension == "mp3")
        #expect(model.player.duration == 30)
    }

    @Test
    func failedJobUnloadsPresentedSource() async throws {
        let model = makeModel()
        let job = makeJob(
            id: "job-failed",
            state: .failed,
            playback: .failed(errorMessage: "Speech generation failed"),
            error: "Speech generation failed"
        )
        model.jobs = [job]
        model.player.configurePreviewState(
            jobID: job.id,
            duration: nil,
            currentTime: 8,
            isPlaying: true,
            loadedSourceURL: URL(string: "http://localhost:3000/audio/job-failed/playlist.m3u8")
        )

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == nil)
        #expect(model.player.loadedSourceURL == nil)
    }

    @Test
    func knownDurationSurvivesIndefiniteObservedUpdates() {
        let player = AudioPlayerController(previewMode: true)

        player.updateKnownDuration(30)
        player.updateObservedDuration(.infinity)
        #expect(player.duration == 30)

        player.updateObservedDuration(33)
        #expect(player.duration == 33)

        player.updateObservedDuration(0)
        #expect(player.duration == 33)
    }

    @Test
    func streamingSourcesDoNotLetObservedPlayerDurationShrinkTheKnownTimeline() {
        let player = AudioPlayerController(previewMode: true)

        player.configurePreviewState(
            jobID: "job-streaming-duration",
            duration: 150,
            currentTime: 6,
            isPlaying: true,
            loadedSourceURL: URL(string: "http://localhost:3000/audio/job-streaming-duration/playlist.m3u8")
        )

        player.updateObservedDuration(8)
        #expect(player.duration == 150)

        player.updateObservedDuration(72)
        #expect(player.duration == 150)
    }

    @Test
    func progressIsClampedWhenPlaybackMomentarilyRunsPastTheKnownStreamingDuration() {
        let player = AudioPlayerController(previewMode: true)

        player.configurePreviewState(
            jobID: "job-streaming-progress",
            duration: 72,
            currentTime: 80,
            isPlaying: true,
            loadedSourceURL: URL(string: "http://localhost:3000/audio/job-streaming-progress/playlist.m3u8")
        )

        #expect(player.progress == 1)
    }

    @Test
    func changingURLInputClearsStalePreviewArticle() {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelAudioPlayback.\(UUID().uuidString)")!
        let model = AppModel(
            settings: AppSettings(defaults: defaults),
            player: AudioPlayerController(previewMode: true),
            previewMode: true
        )

        model.previewArticle = Article(
            url: "https://example.com/article-a",
            title: "Article A",
            byline: nil,
            siteName: nil,
            excerpt: nil,
            textContent: "Body",
            wordCount: 100,
            estimatedMinutes: 1
        )
        model.previewMessage = AppModel.InlineMessage(text: "Article preview ready.", kind: .success)
        model.urlInput = "https://example.com/article-b"

        model.invalidatePreviewIfNeededForCurrentURL()

        #expect(model.previewArticle == nil)
        #expect(model.previewMessage == nil)
    }

    @Test
    func advancedPlaybackControlsStayDisabledWhileAudioIsStillProcessing() {
        let model = makeModel()
        let processingJob = makeJob(
            id: "job-processing-controls",
            state: .processing,
            playback: .streaming(
                playlistUrl: "/audio/job-processing-controls/playlist.m3u8",
                availableDurationSeconds: 24,
                liveEdgeUpdatedAt: "2026-04-06T10:00:00Z"
            ),
            audioSegments: [
                .init(url: "/audio/job-processing-controls/segment-0.mp3", durationSeconds: 24),
            ]
        )
        let readyJob = makeJob(
            id: "job-ready-controls",
            state: .ready,
            playback: .final(
                audioUrl: "/audio/job-ready-controls/final.mp3",
                durationSeconds: 120,
                fileName: "Ready controls.mp3"
            ),
            durationSeconds: 120
        )

        #expect(!model.areAdvancedPlaybackControlsEnabled(for: processingJob))
        #expect(model.areAdvancedPlaybackControlsEnabled(for: readyJob))
    }

    @Test
    func debugAutostartCreatesAudioOnceFromLaunchEnvironment() async throws {
        let launchedJob = makeJob(
            id: "job-debug-autostart",
            state: .queued,
            playback: .preparing()
        )
        let apiClient = DebugAutostartMockAPIClient(job: launchedJob)
        let model = makeModel(apiClient: apiClient)

        await model.runDebugAutostartIfNeeded(environment: [
            "HEAR_IT_DEBUG_AUTOCREATE_URL": " https://example.com/openclaw "
        ])

        #expect(apiClient.createdArticleURL == "https://example.com/openclaw")
        #expect(apiClient.createdVoiceID == "alloy")
        #expect(model.playerPresentation?.jobID == launchedJob.id)
        #expect(model.selectedTab == .library)

        await model.runDebugAutostartIfNeeded(environment: [
            "HEAR_IT_DEBUG_AUTOCREATE_URL": "https://example.com/second-run"
        ])

        #expect(apiClient.createdArticleURL == "https://example.com/openclaw")
    }
}

private extension AppModelAudioPlaybackTests {
    final class DebugAutostartMockAPIClient: HearItAPIProviding, @unchecked Sendable {
        var tokenProvider: (@Sendable () async -> String?)?
        var createdArticleURL: String?
        var createdVoiceID: String?
        let job: AudioJob

        init(job: AudioJob) {
            self.job = job
        }

        func fetchConfig(baseURL: URL) async throws -> ServerConfig {
            ServerConfig(provider: "openai", audioPublicBaseURL: "/audio", openAIConfigured: true)
        }

        func fetchVoices(baseURL: URL) async throws -> [String] {
            ["alloy"]
        }

        func fetchJobs(baseURL: URL, reportErrors: Bool) async throws -> [AudioJob] {
            []
        }

        func extractArticle(articleURL: String, baseURL: URL) async throws -> Article {
            fatalError("Unused in AppModelAudioPlaybackTests")
        }

        func deleteJob(jobID: String, baseURL: URL) async throws {
            fatalError("Unused in AppModelAudioPlaybackTests")
        }

        func createJob(articleURL: String, voiceID: String, baseURL: URL) async throws -> AudioJob {
            createdArticleURL = articleURL
            createdVoiceID = voiceID
            return job
        }

        func downloadAudioData(from url: URL) async throws -> Data {
            fatalError("Unused in AppModelAudioPlaybackTests")
        }
    }

    func makeDefaults() -> UserDefaults {
        let suiteName = "HearItTests.AppModelAudioPlayback.\(UUID().uuidString)"
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
        error: String? = nil,
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
            error: error ?? resolvedPlayback.errorMessage,
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
}
