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
    func preparingJobDoesNotLoadAudio() {
        let model = makeModel()
        let job = makeJob(
            id: "job-preparing",
            state: .processing,
            playback: .preparing()
        )
        model.jobs = [job]

        #expect(!model.hasPlayableAudio(for: job))

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == nil)
        #expect(model.player.loadedSourceURL == nil)
    }

    @Test
    func readyJobPrefersRemoteMP3ForFreshSessions() async throws {
        let model = makeModel()
        let job = makeJob(
            id: "job-ready",
            state: .ready,
            playback: .ready(
                audioUrl: "/audio/job-ready/final.mp3",
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
                URL(string: "http://localhost:3000/audio/job-ready/final.mp3")
        )
        #expect(model.player.duration == 30)
        #expect(model.displayedTotalDuration(for: job) == 30)
    }

    @Test
    func freshReadySessionsMayUseLocalAudioAssetAsASilentOptimization() async throws {
        let store = makeStore()
        _ = try await store.saveAudioFile(
            forJobID: "job-local-ready",
            audioData: Data("READYMP3".utf8)
        )

        let model = makeModel(localAudioStore: store)
        let job = makeJob(
            id: "job-local-ready",
            state: .ready,
            playback: .ready(
                audioUrl: "/audio/job-local-ready/final.mp3",
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
            loadedSourceURL: URL(string: "http://localhost:3000/audio/job-failed/final.mp3")
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
    func advancedPlaybackControlsAreEnabledOnlyForReadyJobs() {
        let model = makeModel()
        let processingJob = makeJob(
            id: "job-processing-controls",
            state: .processing,
            playback: .preparing()
        )
        let readyJob = makeJob(
            id: "job-ready-controls",
            state: .ready,
            playback: .ready(
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
        #expect(model.jobs.contains(where: { $0.id == launchedJob.id }))
        #expect(model.settings.lastPresentedJobID == launchedJob.id)
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
        audioUrl: String? = nil,
        audioSegments: [AudioJob.Segment] = [],
        durationSeconds: Double? = nil,
        error: String? = nil,
        estimatedMinutes: Int = 1
    ) -> AudioJob {
        let resolvedAudioURL = audioUrl ?? playback.audioUrl
        let resolvedDuration = durationSeconds ?? playback.durationSeconds

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
            audioSegments: audioSegments,
            durationSeconds: resolvedDuration,
            error: error ?? playback.errorMessage,
            createdAt: .now,
            updatedAt: .now,
            playback: playback,
            progress: AudioJob.Progress(
                chunksTotal: state == .ready ? audioSegments.count : nil,
                chunksReady: audioSegments.count,
                availableDurationSeconds: resolvedDuration
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
