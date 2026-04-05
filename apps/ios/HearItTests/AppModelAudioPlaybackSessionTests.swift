import Foundation
import Testing
@testable import HearIt

private final class AudioDownloadMockAPIClient: HearItAPIProviding, @unchecked Sendable {
    var tokenProvider: (@Sendable () async -> String?)?
    var downloadedURLs: [URL] = []
    var audioData = Data("DOWNLOADED-FINAL-AUDIO".utf8)

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
        #expect(model.player.duration == 30)
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
        durationSeconds: Double? = nil
    ) -> AudioJob {
        AudioJob(
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
            audioUrl: audioUrl ?? playback.audioUrl,
            audioDownloadPath: nil,
            playlistUrl: playlistUrl ?? playback.playlistUrl,
            audioSegments: audioSegments,
            durationSeconds: durationSeconds ?? playback.durationSeconds ?? playback.availableDurationSeconds,
            error: playback.errorMessage,
            createdAt: .now,
            updatedAt: .now,
            liveEdgeUpdatedAt: playback.liveEdgeUpdatedAt,
            playback: playback,
            progress: AudioJob.Progress(
                chunksTotal: state == .ready ? audioSegments.count : nil,
                chunksReady: audioSegments.count,
                availableDurationSeconds: playback.availableDurationSeconds
                    ?? durationSeconds
                    ?? playback.durationSeconds
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
