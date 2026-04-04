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

    private struct ServerSnapshot {
        let baseURL: URL
        let config: ServerConfig
        let voices: [VoiceChoice]
        let jobs: [AudioJob]
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
    var isSavingBaseURL = false
    var settingsMessage: InlineMessage?
    var libraryFilter: LibraryFilter = .all
    var playerPresentation: PlayerPresentation?
    var jobPendingDeletion: AudioJob?

    let authManager: AuthManager
    @ObservationIgnored private var apiClient: any HearItAPIProviding
    @ObservationIgnored private let localAudioStore: LocalNarrationAudioStore
    @ObservationIgnored private let previewMode: Bool
    @ObservationIgnored private var hasBootstrapped = false
    @ObservationIgnored private var pollingTask: Task<Void, Never>?
    @ObservationIgnored private var narrationDownloadTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var jobsRequestGeneration = 0
    @ObservationIgnored private var serverStateRequestGeneration = 0

    init(
        settings: AppSettings = AppSettings(),
        apiClient: any HearItAPIProviding = HearItAPIClient(),
        localAudioStore: LocalNarrationAudioStore = LocalNarrationAudioStore(),
        player: AudioPlayerController = AudioPlayerController(),
        authManager: AuthManager = AuthManager(),
        previewMode: Bool = false
    ) {
        self.settings = settings
        self.localAudioStore = localAudioStore
        self.player = player
        self.authManager = authManager
        self.previewMode = previewMode

        var configuredAPIClient = apiClient
        configuredAPIClient.tokenProvider = { [authManager] in
            await authManager.accessToken
        }
        self.apiClient = configuredAPIClient
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
        settingsMessage = nil
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
        invalidatePreviewIfNeededForCurrentURL()
        homeMessage = InlineMessage(text: "Pasted a URL from your clipboard.", kind: .success)
    }

    func invalidatePreviewIfNeededForCurrentURL() {
        let normalizedInput = urlInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard previewArticle?.url != normalizedInput else { return }
        previewArticle = nil
        previewMessage = nil
    }

    @discardableResult
    func saveBaseURL(_ draftValue: String) async -> Bool {
        let normalizedBaseURL = AppSettings.normalizeBaseURLString(draftValue)
        guard let baseURL = Self.baseURL(from: normalizedBaseURL) else {
            settingsMessage = InlineMessage(text: "Enter a valid http or https base URL.", kind: .error)
            return false
        }

        isSavingBaseURL = true
        defer { isSavingBaseURL = false }
        settingsMessage = InlineMessage(text: "Checking connection…", kind: .neutral)

        let requestGeneration = nextServerStateRequestGeneration()
        invalidateJobsRequests()

        do {
            let snapshot = try await fetchServerSnapshot(baseURL: baseURL, reportJobErrors: true)
            guard isLatestServerStateRequest(requestGeneration) else { return false }

            settings.apiBaseURLString = normalizedBaseURL
            applyServerSnapshot(snapshot)
            homeMessage = InlineMessage(
                text: "Connected to \(snapshot.baseURL.host ?? snapshot.baseURL.absoluteString).",
                kind: .success
            )
            settingsMessage = nil
            return true
        } catch HearItAPIClient.APIError.unauthorized {
            guard isLatestServerStateRequest(requestGeneration) else { return false }
            await signOut()
            return false
        } catch {
            guard isLatestServerStateRequest(requestGeneration) else { return false }
            settingsMessage = InlineMessage(text: error.localizedDescription, kind: .error)
            return false
        }
    }

    @discardableResult
    func refreshServerState(showLoadingState: Bool) async -> Bool {
        guard !previewMode else { return false }
        guard let baseURL = settings.apiBaseURL else {
            connectionState = .needsConfiguration
            serverConfig = nil
            availableVoices = []
            previewArticle = nil
            settingsMessage = nil
            homeMessage = InlineMessage(
                text: "Set your Hear It API URL in Settings before testing on iPhone.",
                kind: .neutral
            )
            return false
        }

        let requestGeneration = nextServerStateRequestGeneration()
        invalidateJobsRequests()

        if showLoadingState {
            connectionState = .loading
        }

        do {
            let snapshot = try await fetchServerSnapshot(baseURL: baseURL, reportJobErrors: true)
            guard isLatestServerStateRequest(requestGeneration) else { return false }

            applyServerSnapshot(snapshot)
            settingsMessage = nil

            if showLoadingState {
                homeMessage = InlineMessage(
                    text: "Connected to \(snapshot.baseURL.host ?? snapshot.baseURL.absoluteString).",
                    kind: .success
                )
            }
            return true
        } catch HearItAPIClient.APIError.unauthorized {
            guard isLatestServerStateRequest(requestGeneration) else { return false }
            await signOut()
            return false
        } catch {
            guard isLatestServerStateRequest(requestGeneration) else { return false }
            connectionState = .failed(error.localizedDescription)
            serverConfig = nil
            availableVoices = []
            if showLoadingState {
                homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
            }
            return false
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
        invalidatePreviewIfNeededForCurrentURL()
        previewMessage = InlineMessage(text: "Reviewing article…", kind: .neutral)

        do {
            previewArticle = try await apiClient.extractArticle(articleURL: articleURL, baseURL: baseURL)
            previewMessage = InlineMessage(text: "Article preview ready.", kind: .success)
        } catch {
            previewArticle = nil
            previewMessage = InlineMessage(text: error.localizedDescription, kind: .error)
        }

        isRefreshingPreview = false
    }

    func createNarration() async {
        guard !previewMode else { return }
        guard let baseURL = settings.apiBaseURL else {
            homeMessage = InlineMessage(
                text: "Set your API URL in Settings before creating audio.",
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
        homeMessage = InlineMessage(text: "Creating your audio…", kind: .neutral)

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
            invalidateJobsRequests()
            applyUpsert(job)
            urlInput = ""
            voiceSelectionPresented = false
            selectedTab = .library
            homeMessage = InlineMessage(text: "Audio queued successfully.", kind: .success)
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
        let requestGeneration = nextJobsRequestGeneration()

        if !silent {
            isRefreshingLibrary = true
        }

        defer {
            if !silent, isLatestJobsRequest(requestGeneration) {
                isRefreshingLibrary = false
            }
        }

        do {
            let updatedJobs = try await apiClient.fetchJobs(baseURL: baseURL, reportErrors: !silent)
            guard isLatestJobsRequest(requestGeneration) else { return }
            applyJobs(updatedJobs)
            connectionState = .connected
            if !silent {
                homeMessage = InlineMessage(text: "Library refreshed.", kind: .success)
            }
        } catch HearItAPIClient.APIError.unauthorized {
            await signOut()
        } catch {
            guard isLatestJobsRequest(requestGeneration) else { return }
            connectionState = .failed(error.localizedDescription)
            if !silent {
                homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
            }
        }
    }

    func confirmDeleteJob() async {
        guard !previewMode else { return }
        guard let job = jobPendingDeletion else { return }
        guard let baseURL = settings.apiBaseURL else { return }
        invalidateJobsRequests()

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
            try? await localAudioStore.removeCachedNarration(forJobID: job.id)
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

        let knownPlaybackDuration = playbackDuration(for: job)

        settings.lastPresentedJobID = jobID

        if job.status == .failed {
            player.unload()
            return
        }

        if let currentSourceURL = player.loadedSourceURL,
           player.loadedJobID == jobID,
           let baseURL = settings.apiBaseURL,
           job.status == .completed,
           let streamingURL = HearItAPIClient.resolveURL(job.playlistUrl, relativeTo: baseURL),
           currentSourceURL == streamingURL {
            player.updateKnownDuration(knownPlaybackDuration)
            return
        }

        if let playbackURL = localAudioStore.playbackURLIfExists(forJobID: jobID) {
            #if DEBUG
            print("[HearIt][Player] Loading local file: \(playbackURL)")
            #endif
            player.load(url: playbackURL, for: jobID, knownDuration: knownPlaybackDuration)
            return
        }

        #if DEBUG
        print("[HearIt][Player] No local file for \(jobID), status=\(job.status)")
        #endif

        if job.status == .completed {
            ensureNarrationAudioDownloadRequested(for: job)
        }

        guard let baseURL = settings.apiBaseURL,
              let playbackURL = job.playbackURL(relativeTo: baseURL) else {
            #if DEBUG
            print("[HearIt][Player] No playback URL — unloading")
            #endif
            player.unload()
            return
        }

        #if DEBUG
        print("[HearIt][Player] Loading remote URL: \(playbackURL)")
        #endif
        player.load(
            url: playbackURL,
            for: jobID,
            knownDuration: knownPlaybackDuration
        )
    }

    func hasPlayableAudio(for job: AudioJob) -> Bool {
        if hasLocallyCachedAudio(for: job) {
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

    func hasLocallyCachedAudio(for job: AudioJob) -> Bool {
        localAudioStore.playbackURLIfExists(forJobID: job.id) != nil
    }

    func displayedTotalDuration(for job: AudioJob) -> Double? {
        if isStreamingPlayback(for: job) {
            return nil
        }

        return player.duration
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
        guard localAudioStore.playbackURLIfExists(forJobID: job.id) == nil else { return }
        guard let baseURL = settings.apiBaseURL else { return }
        guard !job.audioSegments.isEmpty else { return }

        narrationDownloadTasks[job.id] = Task { [weak self] in
            guard let self else { return }

            defer {
                narrationDownloadTasks[job.id] = nil
            }

            do {
                if let finalAudioURL = HearItAPIClient.resolveURL(job.audioUrl, relativeTo: baseURL) {
                    do {
                        let audioData = try await apiClient.downloadAudioData(from: finalAudioURL)
                        _ = try await localAudioStore.saveAudioFile(forJobID: job.id, audioData: audioData)
                    } catch {
                        guard !job.audioSegments.isEmpty else {
                            throw error
                        }
                        try await cacheNarrationSegments(for: job, baseURL: baseURL)
                    }
                } else {
                    try await cacheNarrationSegments(for: job, baseURL: baseURL)
                }

                await MainActor.run { [weak self] in
                    guard let self else { return }
                    if playerPresentation?.jobID == job.id, !player.isPlaying {
                        preparePlayer(for: job.id)
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
            let previousJob = previousJobs.first(where: { $0.id == currentPresentation.jobID })
            let wasPlayable = previousJob.map(hasPlayableAudio(for:)) ?? false
            preparePlayer(for: currentPresentation.jobID)
            if !wasPlayable,
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

    private func cacheNarrationSegments(for job: AudioJob, baseURL: URL) async throws {
        var cachedSegments: [LocalNarrationAudioStore.StoredSegment] = []
        for (index, segment) in job.audioSegments.enumerated() {
            guard let segmentURL = HearItAPIClient.resolveURL(segment.url, relativeTo: baseURL) else {
                throw CacheError.invalidSegmentURL(segment.url)
            }

            cachedSegments.append(LocalNarrationAudioStore.StoredSegment(
                fileName: "segment-\(index).mp3",
                durationSeconds: segment.durationSeconds,
                audioData: try await apiClient.downloadAudioData(from: segmentURL)
            ))
        }

        _ = try await localAudioStore.savePlaylistBundle(forJobID: job.id, segments: cachedSegments)
    }

    private func fetchServerSnapshot(baseURL: URL, reportJobErrors: Bool) async throws -> ServerSnapshot {
        async let loadedConfig = apiClient.fetchConfig(baseURL: baseURL)
        async let loadedVoices = apiClient.fetchVoices(baseURL: baseURL)
        async let loadedJobs = apiClient.fetchJobs(baseURL: baseURL, reportErrors: reportJobErrors)

        return ServerSnapshot(
            baseURL: baseURL,
            config: try await loadedConfig,
            voices: VoiceChoice.catalog(from: try await loadedVoices),
            jobs: try await loadedJobs
        )
    }

    private func applyServerSnapshot(_ snapshot: ServerSnapshot) {
        serverConfig = snapshot.config
        availableVoices = snapshot.voices
        applyVoiceFallbackIfNeeded()
        applyJobs(snapshot.jobs)
        connectionState = .connected
    }

    private func nextJobsRequestGeneration() -> Int {
        jobsRequestGeneration += 1
        return jobsRequestGeneration
    }

    private func isLatestJobsRequest(_ generation: Int) -> Bool {
        generation == jobsRequestGeneration
    }

    private func invalidateJobsRequests() {
        jobsRequestGeneration += 1
    }

    private func nextServerStateRequestGeneration() -> Int {
        serverStateRequestGeneration += 1
        return serverStateRequestGeneration
    }

    private func isLatestServerStateRequest(_ generation: Int) -> Bool {
        generation == serverStateRequestGeneration
    }

    private static func baseURL(from rawValue: String) -> URL? {
        guard let url = URL(string: rawValue),
              let scheme = url.scheme,
              ["http", "https"].contains(scheme.lowercased()) else {
            return nil
        }

        return url
    }

    private func playbackDuration(for job: AudioJob) -> Double? {
        if let durationSeconds = job.durationSeconds, durationSeconds > 0 {
            return durationSeconds
        }

        guard !job.audioSegments.isEmpty else { return nil }
        return job.audioSegments.reduce(0) { $0 + $1.durationSeconds }
    }

    private enum CacheError: LocalizedError {
        case invalidSegmentURL(String)

        var errorDescription: String? {
            switch self {
            case let .invalidSegmentURL(rawValue):
                "Hear It could not resolve a segment URL for caching: \(rawValue)"
            }
        }
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
