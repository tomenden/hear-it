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
    func keepsExistingReadySessionPinnedWhenLocalAudioAssetExists() async throws {
        let store = makeStore()
        _ = try await store.saveAudioFile(
            forJobID: "job-ready-session",
            audioData: Data("READYMP3".utf8)
        )

        let model = makeModel(localAudioStore: store)
        let job = makeJob(
            id: "job-ready-session",
            state: .ready,
            playback: .ready(
                audioUrl: "/audio/job-ready-session/final.mp3",
                durationSeconds: 30,
                fileName: "Pinned ready.mp3"
            ),
            durationSeconds: 30
        )
        let remoteFinalURL = URL(string: "http://localhost:3000/audio/job-ready-session/final.mp3")!
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
            playback: .ready(
                audioUrl: "/audio/job-background-download/final.mp3",
                durationSeconds: 30,
                fileName: "Background download.mp3"
            ),
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
    func libraryPlayStartsPausedLoadedSessionAndPresentsPlayer() {
        let model = makeModel()
        let job = makeJob(
            id: "job-library-play",
            state: .ready,
            playback: .ready(
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
    func togglePlaybackReloadsFinishedReadySession() {
        let model = makeModel()
        let job = makeJob(
            id: "job-finished-ready",
            state: .ready,
            playback: .ready(
                audioUrl: "/audio/job-finished-ready/final.mp3",
                durationSeconds: 42,
                fileName: "Finished ready.mp3"
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
                URL(string: "http://localhost:3000/audio/job-finished-ready/final.mp3")
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
            playback: .ready(
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
        audioUrl: String? = nil,
        audioSegments: [AudioJob.Segment] = [],
        durationSeconds: Double? = nil
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
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: resolvedAudioURL,
            audioDownloadPath: nil,
            audioSegments: audioSegments,
            durationSeconds: resolvedDuration,
            error: playback.errorMessage,
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
