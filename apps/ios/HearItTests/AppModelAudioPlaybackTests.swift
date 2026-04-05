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
        #expect(model.displayedTotalDuration(for: job) == 12)
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
            playback: AudioPlayback(
                mode: .final,
                isPlayable: true,
                availableDurationSeconds: 12,
                liveEdgeUpdatedAt: "2026-04-05T12:30:00Z",
                playlistUrl: nil,
                audioUrl: "/audio/job-final-stale-progress/final.mp3",
                durationSeconds: 30,
                fileName: "Final stale progress.mp3",
                errorMessage: nil
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
}

private extension AppModelAudioPlaybackTests {
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
        error: String? = nil
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
            error: error ?? playback.errorMessage,
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
}
