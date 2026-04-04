import Foundation
import Testing
@testable import HearIt

@MainActor
struct AppModelNarrationPlaybackTests {
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
    func processingJobWithPlaylistIsPlayableAndLoadsRemoteSource() async throws {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelNarrationPlayback.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let model = AppModel(
            settings: settings,
            localAudioStore: LocalNarrationAudioStore(baseDirectory: tempDirectory),
            player: AudioPlayerController(previewMode: true)
        )
        let job = AudioJob(
            id: "job-processing",
            status: .processing,
            article: Article(
                url: "https://example.com/article",
                title: "Incremental playback",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: nil,
            audioDownloadPath: nil,
            playlistUrl: "/audio/job-processing/playlist.m3u8",
            audioSegments: [
                AudioJob.Segment(url: "/audio/job-processing/segment-0.mp3", durationSeconds: 12)
            ],
            durationSeconds: nil,
            error: nil,
            createdAt: .now,
            updatedAt: .now
        )
        model.jobs = [job]

        #expect(model.hasPlayableAudio(for: job))

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == job.id)
        #expect(
            model.player.loadedSourceURL ==
                URL(string: "http://localhost:3000/audio/job-processing/playlist.m3u8")
        )
        #expect(model.player.duration == 12)
        #expect(model.player.canSeek)
        #expect(model.displayedTotalDuration(for: job) == nil)
    }

    @Test
    func completedJobKeepsRemotePlaylistForCurrentSessionButUpdatesKnownDuration() async throws {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelNarrationPlayback.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let playlistURL = URL(string: "http://localhost:3000/audio/job-completed/playlist.m3u8")!
        let model = AppModel(
            settings: settings,
            localAudioStore: LocalNarrationAudioStore(baseDirectory: tempDirectory),
            player: AudioPlayerController(previewMode: true)
        )

        let job = AudioJob(
            id: "job-completed",
            status: .completed,
            article: Article(
                url: "https://example.com/article",
                title: "Completed playback",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: "/audio/job-completed/final.mp3",
            audioDownloadPath: nil,
            playlistUrl: "/audio/job-completed/playlist.m3u8",
            audioSegments: [
                AudioJob.Segment(url: "/audio/job-completed/segment-0.mp3", durationSeconds: 12),
                AudioJob.Segment(url: "/audio/job-completed/segment-1.mp3", durationSeconds: 18),
            ],
            durationSeconds: 30,
            error: nil,
            createdAt: .now,
            updatedAt: .now
        )

        model.jobs = [job]
        model.player.configurePreviewState(
            jobID: job.id,
            duration: nil,
            currentTime: 8,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.duration == 30)
        #expect(model.displayedTotalDuration(for: job) == 30)
    }

    @Test
    func completedJobPrefersFinalRemoteMP3ForFreshSessions() async throws {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelNarrationPlayback.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let model = AppModel(
            settings: settings,
            localAudioStore: LocalNarrationAudioStore(baseDirectory: tempDirectory),
            player: AudioPlayerController(previewMode: true)
        )

        let job = AudioJob(
            id: "job-completed-fresh",
            status: .completed,
            article: Article(
                url: "https://example.com/article",
                title: "Completed playback",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: "/audio/job-completed-fresh/final.mp3",
            audioDownloadPath: nil,
            playlistUrl: "/audio/job-completed-fresh/playlist.m3u8",
            audioSegments: [
                AudioJob.Segment(url: "/audio/job-completed-fresh/segment-0.mp3", durationSeconds: 12),
                AudioJob.Segment(url: "/audio/job-completed-fresh/segment-1.mp3", durationSeconds: 18),
            ],
            durationSeconds: 30,
            error: nil,
            createdAt: .now,
            updatedAt: .now
        )

        model.jobs = [job]
        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == job.id)
        #expect(
            model.player.loadedSourceURL ==
                URL(string: "http://localhost:3000/audio/job-completed-fresh/final.mp3")
        )
        #expect(model.player.duration == 30)
    }

    @Test
    func repeatedPreparePlayerRefreshesKnownDurationForSameRemotePlaylistURL() async throws {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelNarrationPlayback.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let playlistURL = URL(string: "http://localhost:3000/audio/job-processing/playlist.m3u8")!
        let model = AppModel(
            settings: settings,
            localAudioStore: LocalNarrationAudioStore(baseDirectory: tempDirectory),
            player: AudioPlayerController(previewMode: true)
        )

        let initialJob = AudioJob(
            id: "job-processing",
            status: .processing,
            article: Article(
                url: "https://example.com/article",
                title: "Incremental playback",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: nil,
            audioDownloadPath: nil,
            playlistUrl: "/audio/job-processing/playlist.m3u8",
            audioSegments: [
                AudioJob.Segment(url: "/audio/job-processing/segment-0.mp3", durationSeconds: 12)
            ],
            durationSeconds: 12,
            error: nil,
            createdAt: .now,
            updatedAt: .now
        )
        let updatedJob = AudioJob(
            id: initialJob.id,
            status: .completed,
            article: initialJob.article,
            speechOptions: initialJob.speechOptions,
            provider: initialJob.provider,
            audioUrl: "/audio/job-processing/final.mp3",
            audioDownloadPath: nil,
            playlistUrl: initialJob.playlistUrl,
            audioSegments: [
                AudioJob.Segment(url: "/audio/job-processing/segment-0.mp3", durationSeconds: 12),
                AudioJob.Segment(url: "/audio/job-processing/segment-1.mp3", durationSeconds: 18),
            ],
            durationSeconds: 30,
            error: nil,
            createdAt: initialJob.createdAt,
            updatedAt: .now
        )

        model.jobs = [initialJob]
        model.player.configurePreviewState(
            jobID: initialJob.id,
            duration: 12,
            currentTime: 8,
            isPlaying: true,
            loadedSourceURL: playlistURL
        )

        model.jobs = [updatedJob]
        model.preparePlayer(for: updatedJob.id)

        #expect(model.player.loadedSourceURL == playlistURL)
        #expect(model.player.duration == 30)
    }

    @Test
    func failedJobUnloadsPresentedRemoteStream() async throws {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelNarrationPlayback.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let model = AppModel(
            settings: settings,
            localAudioStore: LocalNarrationAudioStore(baseDirectory: tempDirectory),
            player: AudioPlayerController(previewMode: true)
        )

        let job = AudioJob(
            id: "job-failed",
            status: .failed,
            article: Article(
                url: "https://example.com/article",
                title: "Failed playback",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: nil,
            audioDownloadPath: nil,
            playlistUrl: "/audio/job-failed/playlist.m3u8",
            audioSegments: [
                AudioJob.Segment(url: "/audio/job-failed/segment-0.mp3", durationSeconds: 12)
            ],
            durationSeconds: nil,
            error: "Speech generation failed",
            createdAt: .now,
            updatedAt: .now
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
    func completedJobWithCachedPlaylistLoadsCombinedLocalMP3() async throws {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelNarrationPlayback.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = LocalNarrationAudioStore(baseDirectory: tempDirectory)
        _ = try await store.savePlaylistBundle(
            forJobID: "job-local-cache",
            segments: [
                .init(fileName: "segment-0.mp3", durationSeconds: 12, audioData: Data("SEG0".utf8)),
                .init(fileName: "segment-1.mp3", durationSeconds: 18, audioData: Data("SEG1".utf8)),
            ]
        )

        let model = AppModel(
            settings: settings,
            localAudioStore: store,
            player: AudioPlayerController(previewMode: true)
        )
        let job = AudioJob(
            id: "job-local-cache",
            status: .completed,
            article: Article(
                url: "https://example.com/article",
                title: "Cached playback",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: nil,
            audioDownloadPath: nil,
            playlistUrl: "/audio/job-local-cache/playlist.m3u8",
            audioSegments: [
                AudioJob.Segment(url: "/audio/job-local-cache/segment-0.mp3", durationSeconds: 12),
                AudioJob.Segment(url: "/audio/job-local-cache/segment-1.mp3", durationSeconds: 18),
            ],
            durationSeconds: 30,
            error: nil,
            createdAt: .now,
            updatedAt: .now
        )
        model.jobs = [job]

        model.preparePlayer(for: job.id)

        #expect(model.player.loadedJobID == job.id)
        #expect(model.player.loadedSourceURL?.pathExtension == "mp3")
        #expect(model.player.duration == 30)
    }

    @Test
    func changingURLInputClearsStalePreviewArticle() {
        let defaults = UserDefaults(suiteName: "HearItTests.AppModelNarrationPlayback.\(UUID().uuidString)")!
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
