import Foundation
import Testing
@testable import HearIt

private final class MockHearItAPIClient: HearItAPIProviding, @unchecked Sendable {
    var tokenProvider: (@Sendable () async -> String?)?
    var fetchConfigHandler: @Sendable (URL) async throws -> ServerConfig = { _ in
        ServerConfig(provider: "openai", audioPublicBaseURL: "/audio", openAIConfigured: true)
    }
    var fetchVoicesHandler: @Sendable (URL) async throws -> [String] = { _ in ["alloy"] }
    var fetchJobsHandler: @Sendable (URL, Bool) async throws -> [AudioJob] = { _, _ in [] }
    var extractArticleHandler: @Sendable (String, URL) async throws -> Article = { articleURL, _ in
        Article(
            url: articleURL,
            title: "Preview",
            byline: nil,
            siteName: nil,
            excerpt: nil,
            textContent: "Body",
            wordCount: 100,
            estimatedMinutes: 1
        )
    }
    var deleteJobHandler: @Sendable (String, URL) async throws -> Void = { _, _ in }
    var createJobHandler: @Sendable (String, String, URL) async throws -> AudioJob = { articleURL, voiceID, _ in
        AudioJob(
            id: UUID().uuidString,
            status: .completed,
            article: Article(
                url: articleURL,
                title: "Created",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: voiceID),
            provider: "openai",
            audioUrl: nil,
            audioDownloadPath: nil,
            audioSegments: [],
            durationSeconds: nil,
            error: nil,
            createdAt: .now,
            updatedAt: .now
        )
    }
    var downloadAudioDataHandler: @Sendable (URL) async throws -> Data = { _ in Data() }

    func fetchConfig(baseURL: URL) async throws -> ServerConfig {
        try await fetchConfigHandler(baseURL)
    }

    func fetchVoices(baseURL: URL) async throws -> [String] {
        try await fetchVoicesHandler(baseURL)
    }

    func fetchJobs(baseURL: URL, reportErrors: Bool) async throws -> [AudioJob] {
        try await fetchJobsHandler(baseURL, reportErrors)
    }

    func extractArticle(articleURL: String, baseURL: URL) async throws -> Article {
        try await extractArticleHandler(articleURL, baseURL)
    }

    func deleteJob(jobID: String, baseURL: URL) async throws {
        try await deleteJobHandler(jobID, baseURL)
    }

    func createJob(articleURL: String, voiceID: String, baseURL: URL) async throws -> AudioJob {
        try await createJobHandler(articleURL, voiceID, baseURL)
    }

    func downloadAudioData(from url: URL) async throws -> Data {
        try await downloadAudioDataHandler(url)
    }
}

private actor JobsResponseSequence {
    private var callCount = 0

    func nextPlan() -> (jobID: String, delay: Duration) {
        callCount += 1
        return callCount == 1
            ? ("old-job", .milliseconds(200))
            : ("new-job", .milliseconds(20))
    }
}

private func makeJob(id: String, title: String? = nil) -> AudioJob {
    AudioJob(
        id: id,
        status: .completed,
        article: Article(
            url: "https://example.com/\(id)",
            title: title ?? id,
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
        audioSegments: [],
        durationSeconds: nil,
        error: nil,
        createdAt: .now,
        updatedAt: .now
    )
}

@MainActor
struct AppModelRefreshTests {
    @Test
    func olderJobsRefreshCannotOverwriteNewerRefresh() async throws {
        let sequence = JobsResponseSequence()
        let apiClient = MockHearItAPIClient()
        apiClient.fetchJobsHandler = { _, _ in
            let plan = await sequence.nextPlan()
            try await Task.sleep(for: plan.delay)
            return [
                AudioJob(
                    id: plan.jobID,
                    status: .completed,
                    article: Article(
                        url: "https://example.com/\(plan.jobID)",
                        title: plan.jobID,
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
                    audioSegments: [],
                    durationSeconds: nil,
                    error: nil,
                    createdAt: .now,
                    updatedAt: .now
                )
            ]
        }

        let defaults = UserDefaults(suiteName: "HearItTests.AppModelRefresh.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"

        let model = AppModel(
            settings: settings,
            apiClient: apiClient,
            localAudioStore: LocalAudioAssetStore(baseDirectory: FileManager.default.temporaryDirectory),
            player: AudioPlayerController(previewMode: true)
        )

        async let firstRefresh: Void = model.refreshJobs(silent: true)
        try await Task.sleep(for: .milliseconds(10))
        async let secondRefresh: Void = model.refreshJobs(silent: true)

        _ = await (firstRefresh, secondRefresh)

        #expect(model.jobs.count == 1)
        #expect(model.jobs.first?.id == "new-job")
    }

    @Test
    func olderServerRefreshCannotOverwriteNewerRefresh() async throws {
        let apiClient = MockHearItAPIClient()
        apiClient.fetchConfigHandler = { baseURL in
            if baseURL.host == "old.example.com" {
                try await Task.sleep(for: .milliseconds(200))
                return ServerConfig(provider: "old", audioPublicBaseURL: "/audio", openAIConfigured: true)
            }

            try await Task.sleep(for: .milliseconds(20))
            return ServerConfig(provider: "new", audioPublicBaseURL: "/audio", openAIConfigured: true)
        }
        apiClient.fetchVoicesHandler = { baseURL in
            if baseURL.host == "old.example.com" {
                try await Task.sleep(for: .milliseconds(200))
                return ["ash"]
            }

            try await Task.sleep(for: .milliseconds(20))
            return ["alloy"]
        }
        apiClient.fetchJobsHandler = { baseURL, _ in
            if baseURL.host == "old.example.com" {
                try await Task.sleep(for: .milliseconds(200))
                return [makeJob(id: "old-job", title: "Old job")]
            }

            try await Task.sleep(for: .milliseconds(20))
            return [makeJob(id: "new-job", title: "New job")]
        }

        let defaults = UserDefaults(suiteName: "HearItTests.AppModelRefresh.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "https://old.example.com"

        let model = AppModel(
            settings: settings,
            apiClient: apiClient,
            localAudioStore: LocalAudioAssetStore(baseDirectory: FileManager.default.temporaryDirectory),
            player: AudioPlayerController(previewMode: true)
        )

        async let oldRefresh: Bool = model.refreshServerState(showLoadingState: true)
        try await Task.sleep(for: .milliseconds(10))
        settings.apiBaseURLString = "https://new.example.com"
        async let newRefresh: Bool = model.refreshServerState(showLoadingState: true)

        _ = await (oldRefresh, newRefresh)

        #expect(model.connectionState == .connected)
        #expect(model.serverConfig?.provider == "new")
        #expect(model.availableVoices.map(\.id) == ["alloy"])
        #expect(model.jobs.count == 1)
        #expect(model.jobs.first?.id == "new-job")
    }

    @Test
    func failedBaseURLSaveDoesNotPersistDraftOrReplaceCurrentConnection() async {
        let apiClient = MockHearItAPIClient()
        apiClient.fetchConfigHandler = { baseURL in
            if baseURL.host == "bad.example.com" {
                throw HearItAPIClient.APIError.server("Could not connect to the server.")
            }

            return ServerConfig(provider: "openai", audioPublicBaseURL: "/audio", openAIConfigured: true)
        }
        apiClient.fetchVoicesHandler = { _ in ["alloy"] }
        apiClient.fetchJobsHandler = { baseURL, _ in
            [makeJob(
                id: baseURL.host == "bad.example.com" ? "bad-job" : "good-job",
                title: baseURL.host == "bad.example.com" ? "Bad job" : "Good job"
            )]
        }

        let defaults = UserDefaults(suiteName: "HearItTests.AppModelRefresh.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "https://good.example.com"
        let model = AppModel(
            settings: settings,
            apiClient: apiClient,
            localAudioStore: LocalAudioAssetStore(baseDirectory: FileManager.default.temporaryDirectory),
            player: AudioPlayerController(previewMode: true)
        )
        let didRefresh = await model.refreshServerState(showLoadingState: false)
        #expect(didRefresh)

        let didSave = await model.saveBaseURL("https://bad.example.com")

        #expect(!didSave)
        #expect(model.connectionState == .connected)
        #expect(model.serverConfig?.provider == "openai")
        #expect(model.jobs.first?.id == "good-job")
        #expect(model.settings.apiBaseURLString == "https://good.example.com")
        #expect(model.settingsMessage?.kind == .error)
        #expect(model.settingsMessage?.text == "Could not connect to the server.")
    }

    @Test
    func unauthorizedBaseURLSavePreservesExistingURLBeforeSigningOut() async {
        let apiClient = MockHearItAPIClient()
        apiClient.fetchConfigHandler = { baseURL in
            if baseURL.host == "local.example.com" {
                throw HearItAPIClient.APIError.unauthorized
            }

            return ServerConfig(provider: "openai", audioPublicBaseURL: "/audio", openAIConfigured: true)
        }
        apiClient.fetchVoicesHandler = { _ in ["alloy"] }
        apiClient.fetchJobsHandler = { _, _ in [makeJob(id: "good-job", title: "Good job")] }

        let defaults = UserDefaults(suiteName: "HearItTests.AppModelRefresh.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "https://good.example.com"
        let model = AppModel(
            settings: settings,
            apiClient: apiClient,
            localAudioStore: LocalAudioAssetStore(baseDirectory: FileManager.default.temporaryDirectory),
            player: AudioPlayerController(previewMode: true)
        )
        let didRefresh = await model.refreshServerState(showLoadingState: false)
        #expect(didRefresh)

        let didSave = await model.saveBaseURL("https://local.example.com")

        #expect(!didSave)
        #expect(model.settings.apiBaseURLString == "https://good.example.com")
        #expect(model.authManager.state == .signedOut)
        #expect(model.jobs.isEmpty)
    }

    @Test
    func unauthorizedBaseURLSaveDoesNotPersistAcrossNewSettingsInstance() async {
        let apiClient = MockHearItAPIClient()
        apiClient.fetchConfigHandler = { baseURL in
            if baseURL.host == "local.example.com" {
                throw HearItAPIClient.APIError.unauthorized
            }

            return ServerConfig(provider: "openai", audioPublicBaseURL: "/audio", openAIConfigured: true)
        }
        apiClient.fetchVoicesHandler = { _ in ["alloy"] }
        apiClient.fetchJobsHandler = { _, _ in [makeJob(id: "good-job", title: "Good job")] }

        let suiteName = "HearItTests.AppModelRefresh.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)

        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "https://good.example.com"
        let model = AppModel(
            settings: settings,
            apiClient: apiClient,
            localAudioStore: LocalAudioAssetStore(baseDirectory: FileManager.default.temporaryDirectory),
            player: AudioPlayerController(previewMode: true)
        )
        let didRefresh = await model.refreshServerState(showLoadingState: false)
        #expect(didRefresh)

        let didSave = await model.saveBaseURL("https://local.example.com")

        #expect(!didSave)

        let reloadedSettings = AppSettings(defaults: defaults)
        #expect(reloadedSettings.apiBaseURLString == "https://good.example.com")
    }

    @Test
    func confirmDeleteJobRemovesPresentedJobClosesPlayerAndClearsLocalCache() async throws {
        let deletedJobID = LockedBox<String?>(nil)
        let deletedBaseURL = LockedBox<URL?>(nil)
        let apiClient = MockHearItAPIClient()
        apiClient.deleteJobHandler = { jobID, baseURL in
            await deletedJobID.set(jobID)
            await deletedBaseURL.set(baseURL)
        }

        let defaults = UserDefaults(suiteName: "HearItTests.AppModelRefresh.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://localhost:3000"
        let store = LocalAudioAssetStore(
            baseDirectory: FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
        )
        let player = AudioPlayerController(previewMode: true)
        let model = AppModel(
            settings: settings,
            apiClient: apiClient,
            localAudioStore: store,
            player: player
        )
        let job = makeJob(id: "delete-me", title: "Delete me")
        _ = try await store.saveAudioFile(forJobID: job.id, audioData: Data("FINAL".utf8))
        model.jobs = [job]
        model.jobPendingDeletion = job
        model.playerPresentation = PlayerPresentation(jobID: job.id)
        model.player.configurePreviewState(
            jobID: job.id,
            duration: 12,
            currentTime: 4,
            isPlaying: true,
            loadedSourceURL: URL(string: "http://localhost:3000/audio/delete-me/final.mp3")
        )

        await model.confirmDeleteJob()

        #expect(await deletedJobID.value == job.id)
        #expect(await deletedBaseURL.value?.absoluteString == "http://localhost:3000")
        #expect(model.jobs.isEmpty)
        #expect(model.jobPendingDeletion == nil)
        #expect(model.playerPresentation == nil)
        #expect(model.player.loadedJobID == nil)
        #expect(model.player.loadedSourceURL == nil)
        #expect(store.playbackURLIfExists(forJobID: job.id) == nil)
    }
}

private actor LockedBox<Value> {
    private(set) var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func set(_ value: Value) {
        self.value = value
    }
}
