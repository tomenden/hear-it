import Observation
import Sentry
import SwiftUI

@MainActor
@Observable
final class AppModel {
    struct InlineMessage: Equatable {
        enum Kind {
            case neutral
            case success
            case error
        }

        let text: String
        let kind: Kind
    }

    enum ConnectionState: Equatable {
        case needsConfiguration
        case loading
        case connected
        case failed(String)
    }

    var selectedTab: RootTab = .home
    var settings: AppSettings
    var player: AudioPlayerController
    var connectionState: ConnectionState = .needsConfiguration
    var serverConfig: ServerConfig?
    var availableVoices: [VoiceChoice] = []
    var jobs: [AudioJob] = []
    var urlInput = ""
    var previewArticle: Article?
    var homeMessage: InlineMessage?
    var previewMessage: InlineMessage?
    var voiceSelectionPresented = false
    var settingsPresented = false
    var isCreatingNarration = false
    var isRefreshingPreview = false
    var isRefreshingLibrary = false
    var libraryFilter: LibraryFilter = .all
    var playerPresentation: PlayerPresentation?
    var jobPendingDeletion: AudioJob?

    let authManager: AuthManager
    @ObservationIgnored private var apiClient: HearItAPIClient
    @ObservationIgnored private let localAudioStore: LocalNarrationAudioStore
    @ObservationIgnored private let previewMode: Bool
    @ObservationIgnored private var hasBootstrapped = false
    @ObservationIgnored private var pollingTask: Task<Void, Never>?
    @ObservationIgnored private var narrationDownloadTasks: [String: Task<Void, Never>] = [:]

    init(
        settings: AppSettings = AppSettings(),
        apiClient: HearItAPIClient = HearItAPIClient(),
        localAudioStore: LocalNarrationAudioStore = LocalNarrationAudioStore(),
        player: AudioPlayerController = AudioPlayerController(),
        authManager: AuthManager = AuthManager(),
        previewMode: Bool = false
    ) {
        self.settings = settings
        self.apiClient = apiClient
        self.localAudioStore = localAudioStore
        self.player = player
        self.authManager = authManager
        self.previewMode = previewMode

        self.apiClient.tokenProvider = { [authManager] in
            await authManager.accessToken
        }
    }

    var selectedVoice: VoiceChoice {
        if let match = availableVoices.first(where: { $0.id == settings.selectedVoiceID }) {
            return match
        }

        return VoiceChoice(id: settings.selectedVoiceID.isEmpty ? "alloy" : settings.selectedVoiceID)
    }

    var filteredJobs: [AudioJob] {
        jobs.filter { libraryFilter.matches($0.status) }
    }

    var totalMinutes: Int {
        jobs.reduce(0) { $0 + $1.article.estimatedMinutes }
    }

    var completedJobCount: Int {
        jobs.filter { $0.status == .completed }.count
    }

    func bootstrap() async {
        guard !previewMode else { return }
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        await refreshServerState(showLoadingState: true)
        startPolling()
    }

    func handleScenePhaseChange(_ phase: ScenePhase) {
        guard !previewMode else { return }
        switch phase {
        case .active:
            startPolling()
            Task {
                await refreshJobs(silent: true)
            }
        case .inactive, .background:
            stopPolling()
        @unknown default:
            stopPolling()
        }
    }

    func handleIncomingURL(_ url: URL) {
        if let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
           let sharedURL = components.queryItems?.first(where: { $0.name == "url" })?.value {
            urlInput = sharedURL
            selectedTab = .home
            homeMessage = InlineMessage(text: "Imported a shared article URL.", kind: .success)
            return
        }

        if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            urlInput = url.absoluteString
            selectedTab = .home
            homeMessage = InlineMessage(text: "Imported a shared article URL.", kind: .success)
        }
    }

    func signOut() async {
        do {
            try await authManager.signOut()
        } catch {
            // Best effort
        }
        jobs = []
        previewArticle = nil
        urlInput = ""
        playerPresentation = nil
        player.unload()
        stopPolling()
        hasBootstrapped = false
    }

    func openSettings() {
        settingsPresented = true
    }

    func openVoiceSelection() {
        voiceSelectionPresented = true
    }

    func chooseVoice(_ voice: VoiceChoice) {
        settings.selectedVoiceID = voice.id
    }

    func updatePastedURL(_ pastedValue: String) {
        let cleaned = pastedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        urlInput = cleaned
        homeMessage = InlineMessage(text: "Pasted a URL from your clipboard.", kind: .success)
    }

    func saveBaseURL(_ draftValue: String) async {
        settings.apiBaseURLString = draftValue
        settingsPresented = false
        await refreshServerState(showLoadingState: true)
    }

    func refreshServerState(showLoadingState: Bool) async {
        guard !previewMode else { return }
        guard let baseURL = settings.apiBaseURL else {
            connectionState = .needsConfiguration
            serverConfig = nil
            availableVoices = []
            previewArticle = nil
            homeMessage = InlineMessage(
                text: "Set your Hear It API URL in Settings before testing on iPhone.",
                kind: .neutral
            )
            return
        }

        if showLoadingState {
            connectionState = .loading
        }

        do {
            async let loadedConfig = apiClient.fetchConfig(baseURL: baseURL)
            async let loadedVoices = apiClient.fetchVoices(baseURL: baseURL)
            async let loadedJobs = apiClient.fetchJobs(baseURL: baseURL)

            serverConfig = try await loadedConfig
            availableVoices = VoiceChoice.catalog(from: try await loadedVoices)
            applyVoiceFallbackIfNeeded()
            applyJobs(try await loadedJobs)
            connectionState = .connected

            if showLoadingState {
                homeMessage = InlineMessage(
                    text: "Connected to \(baseURL.host ?? baseURL.absoluteString).",
                    kind: .success
                )
            }
        } catch HearItAPIClient.APIError.unauthorized {
            await signOut()
        } catch {
            connectionState = .failed(error.localizedDescription)
            if showLoadingState {
                homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
            }
        }
    }

    func reviewArticle() async {
        guard !previewMode else { return }
        guard let baseURL = settings.apiBaseURL else {
            previewMessage = InlineMessage(
                text: "Set your API URL first so Hear It can preview an article.",
                kind: .error
            )
            return
        }

        let articleURL = urlInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard URL(string: articleURL) != nil else {
            previewMessage = InlineMessage(text: "Enter a valid article URL first.", kind: .error)
            return
        }

        isRefreshingPreview = true
        previewMessage = InlineMessage(text: "Reviewing article…", kind: .neutral)

        do {
            previewArticle = try await apiClient.extractArticle(articleURL: articleURL, baseURL: baseURL)
            previewMessage = InlineMessage(text: "Article preview ready.", kind: .success)
        } catch {
            previewMessage = InlineMessage(text: error.localizedDescription, kind: .error)
        }

        isRefreshingPreview = false
    }

    func createNarration() async {
        guard !previewMode else { return }
        guard let baseURL = settings.apiBaseURL else {
            homeMessage = InlineMessage(
                text: "Set your API URL in Settings before creating a narration.",
                kind: .error
            )
            settingsPresented = true
            return
        }

        let articleURL = urlInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard URL(string: articleURL) != nil else {
            homeMessage = InlineMessage(text: "Enter a valid article URL first.", kind: .error)
            return
        }

        isCreatingNarration = true
        homeMessage = InlineMessage(text: "Creating your narration…", kind: .neutral)

        let breadcrumb = Breadcrumb(level: .info, category: "narration")
        breadcrumb.message = "Create narration"
        breadcrumb.data = ["url": articleURL, "voice": selectedVoice.id]
        SentrySDK.addBreadcrumb(breadcrumb)

        do {
            let job = try await apiClient.createJob(
                articleURL: articleURL,
                voiceID: selectedVoice.id,
                baseURL: baseURL
            )
            previewArticle = job.article
            applyUpsert(job)
            urlInput = ""
            voiceSelectionPresented = false
            selectedTab = .library
            homeMessage = InlineMessage(text: "Narration queued successfully.", kind: .success)
            openPlayer(for: job.id)
            trackFirstNarrationCreated()
        } catch HearItAPIClient.APIError.unauthorized {
            await signOut()
        } catch {
            SentrySDK.capture(error: error) { scope in
                scope.setTag(value: "create_narration", key: "action")
                scope.setExtra(value: articleURL, key: "articleURL")
            }
            homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
        }

        isCreatingNarration = false
    }

    func refreshJobs(silent: Bool = false) async {
        guard !previewMode else { return }
        guard let baseURL = settings.apiBaseURL else { return }

        if !silent {
            isRefreshingLibrary = true
        }

        defer {
            isRefreshingLibrary = false
        }

        do {
            applyJobs(try await apiClient.fetchJobs(baseURL: baseURL, reportErrors: !silent))
            if !silent {
                homeMessage = InlineMessage(text: "Library refreshed.", kind: .success)
            }
        } catch HearItAPIClient.APIError.unauthorized {
            await signOut()
        } catch {
            if !silent {
                homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
            }
        }
    }

    func confirmDeleteJob() async {
        guard !previewMode else { return }
        guard let job = jobPendingDeletion else { return }
        guard let baseURL = settings.apiBaseURL else { return }

        narrationDownloadTasks[job.id]?.cancel()
        narrationDownloadTasks[job.id] = nil

        // If the player is showing this job, close it
        if playerPresentation?.jobID == job.id {
            closePlayer()
            player.unload()
        }

        let crumb = Breadcrumb(level: .info, category: "narration")
        crumb.message = "Delete narration"
        crumb.data = ["jobID": job.id]
        SentrySDK.addBreadcrumb(crumb)

        do {
            try await apiClient.deleteJob(jobID: job.id, baseURL: baseURL)
            try? await localAudioStore.removeAudio(forJobID: job.id)
            jobs.removeAll(where: { $0.id == job.id })
            Analytics.track("narration_deleted", properties: ["job_id": job.id])
        } catch HearItAPIClient.APIError.unauthorized {
            await signOut()
        } catch {
            SentrySDK.capture(error: error) { scope in
                scope.setTag(value: "delete_narration", key: "action")
                scope.setExtra(value: job.id, key: "jobID")
            }
            homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
        }

        jobPendingDeletion = nil
    }

    func closePlayer() {
        playerPresentation = nil
    }

    func preparePlayer(for jobID: String) {
        guard !previewMode else { return }
        guard let job = job(with: jobID) else {
            player.unload()
            return
        }

        settings.lastPresentedJobID = jobID

        if player.loadedJobID == jobID,
           player.isPlaying,
           let currentSource = player.loadedSourceURL,
           !currentSource.isFileURL,
           localAudioStore.audioFileURLIfExists(forJobID: jobID) == nil {
            return
        }

        if job.status == .failed {
            player.unload()
            return
        }

        if let playbackURL = localAudioStore.audioFileURLIfExists(forJobID: jobID) {
            player.load(url: playbackURL, for: jobID, knownDuration: job.durationSeconds)
            return
        }

        if job.status == .completed {
            ensureNarrationAudioDownloadRequested(for: job)
        }

        guard let baseURL = settings.apiBaseURL,
              let playbackURL = job.playbackURL(relativeTo: baseURL) else {
            player.unload()
            return
        }

        player.load(
            url: playbackURL,
            for: jobID,
            knownDuration: job.durationSeconds
        )
    }

    func hasPlayableAudio(for job: AudioJob) -> Bool {
        if localAudioStore.audioFileURLIfExists(forJobID: job.id) != nil {
            return true
        }

        if job.status == .failed {
            return false
        }

        if let baseURL = settings.apiBaseURL,
           job.playbackURL(relativeTo: baseURL) != nil {
            return true
        }

        if previewMode {
            return job.status == .completed || job.playlistUrl != nil
        }

        return false
    }

    func isStreamingPlayback(for job: AudioJob) -> Bool {
        guard let baseURL = settings.apiBaseURL else { return false }
        guard let playbackURL = job.playbackURL(relativeTo: baseURL) else { return false }
        return !playbackURL.isFileURL && job.status == .processing
    }

    private func shouldAutoPlay(jobID: String) -> Bool {
        player.loadedJobID != jobID
    }

    func openPlayer(for jobID: String) {
        let crumb = Breadcrumb(level: .info, category: "player")
        crumb.message = "Open player"
        crumb.data = ["jobID": jobID]
        SentrySDK.addBreadcrumb(crumb)

        let shouldAutoPlay = shouldAutoPlay(jobID: jobID)
        settings.lastPresentedJobID = jobID
        playerPresentation = PlayerPresentation(jobID: jobID)
        preparePlayer(for: jobID)
        if shouldAutoPlay,
           let job = job(with: jobID),
           hasPlayableAudio(for: job) {
            player.togglePlayback()
            Analytics.track("narration_played", properties: [
                "job_id": jobID,
                "duration_listened": 0,
                "pct_completed": 0,
            ])
            trackFirstNarrationCompleted()
        }
    }

    func isDownloadingAudio(for job: AudioJob) -> Bool {
        return narrationDownloadTasks[job.id] != nil
    }

    private func ensureNarrationAudioDownloadRequested(for job: AudioJob) {
        guard !previewMode else { return }
        guard job.status == .completed else { return }
        guard narrationDownloadTasks[job.id] == nil else { return }
        guard localAudioStore.audioFileURLIfExists(forJobID: job.id) == nil else { return }
        guard let baseURL = settings.apiBaseURL,
              let downloadURL = job.narrationDownloadURL(relativeTo: baseURL) else { return }

        narrationDownloadTasks[job.id] = Task { [weak self] in
            guard let self else { return }

            defer {
                narrationDownloadTasks[job.id] = nil
            }

            do {
                let audioData = try await apiClient.downloadNarrationAudio(from: downloadURL)
                _ = try await localAudioStore.save(audioData, forJobID: job.id)

                await MainActor.run { [weak self] in
                    guard let self else { return }
                    if playerPresentation?.jobID == job.id {
                        preparePlayer(for: job.id)
                        if !player.isPlaying {
                            player.togglePlayback()
                            Analytics.track("narration_played", properties: [
                                "job_id": job.id,
                                "duration_listened": 0,
                                "pct_completed": 0,
                            ])
                            trackFirstNarrationCompleted()
                        }
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                SentrySDK.capture(error: error) { scope in
                    scope.setTag(value: "download_narration_audio", key: "action")
                    scope.setExtra(value: job.id, key: "jobID")
                }
            }
        }
    }

    private func synchronizeNarrationDownloads(with updatedJobs: [AudioJob]) {
        let activeJobIDs = Set(updatedJobs.map(\.id))
        let staleJobIDs = narrationDownloadTasks.keys.filter { !activeJobIDs.contains($0) }

        for jobID in staleJobIDs {
            narrationDownloadTasks[jobID]?.cancel()
            narrationDownloadTasks[jobID] = nil
        }

        for job in updatedJobs where job.status == .completed {
            ensureNarrationAudioDownloadRequested(for: job)
        }
    }

    private func preparePresentedPlayerIfNeeded(for updatedJobs: [AudioJob], previousJobs: [AudioJob]) {
        if let currentPresentation = playerPresentation {
            let wasCompleted = previousJobs.first(where: { $0.id == currentPresentation.jobID })?.status == .completed
            preparePlayer(for: currentPresentation.jobID)
            if !wasCompleted,
               let currentJob = updatedJobs.first(where: { $0.id == currentPresentation.jobID }),
               hasPlayableAudio(for: currentJob),
               !player.isPlaying {
                player.togglePlayback()
            }
            return
        }

        if let lastPresentedJobID = settings.lastPresentedJobID,
           updatedJobs.contains(where: { $0.id == lastPresentedJobID }) {
            return
        }

        settings.lastPresentedJobID = updatedJobs.first?.id
    }

    func job(with jobID: String) -> AudioJob? {
        jobs.first(where: { $0.id == jobID })
    }

    private func startPolling() {
        guard pollingTask == nil else { return }

        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard let self else { return }
                await self.refreshJobs(silent: true)
            }
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
    }

    private func applyVoiceFallbackIfNeeded() {
        guard !availableVoices.isEmpty else { return }

        if availableVoices.contains(where: { $0.id == settings.selectedVoiceID }) {
            return
        }

        settings.selectedVoiceID = availableVoices[0].id
    }

    private func applyJobs(_ updatedJobs: [AudioJob]) {
        let previousJobs = jobs
        synchronizeNarrationDownloads(with: updatedJobs)

        guard jobs != updatedJobs else { return }
        jobs = updatedJobs
        preparePresentedPlayerIfNeeded(for: updatedJobs, previousJobs: previousJobs)
    }

    private func applyUpsert(_ job: AudioJob) {
        jobs.removeAll(where: { $0.id == job.id })
        jobs.insert(job, at: 0)
        settings.lastPresentedJobID = job.id
        ensureNarrationAudioDownloadRequested(for: job)
    }

    private func trackFirstNarrationCreated() {
        let key = "analytics_first_narration_created"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        Analytics.track("first_narration_created")
    }

    private func trackFirstNarrationCompleted() {
        let key = "analytics_first_narration_completed"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        Analytics.track("first_narration_completed")
    }
}
