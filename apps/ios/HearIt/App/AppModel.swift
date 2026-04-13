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
    var isCreatingAudio = false
    var isRefreshingPreview = false
    var isRefreshingLibrary = false
    var isSavingBaseURL = false
    var settingsMessage: InlineMessage?
    var libraryFilter: LibraryFilter = .all
    var playerPresentation: PlayerPresentation?
    var jobPendingDeletion: AudioJob?

    let authManager: AuthManager
    @ObservationIgnored private var apiClient: any HearItAPIProviding
    @ObservationIgnored private let localAudioStore: LocalAudioAssetStore
    @ObservationIgnored private let previewMode: Bool
    @ObservationIgnored private var hasBootstrapped = false
    @ObservationIgnored private var pollingTask: Task<Void, Never>?
    @ObservationIgnored private var localAudioAssetTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var jobsRequestGeneration = 0
    @ObservationIgnored private var serverStateRequestGeneration = 0
    @ObservationIgnored private var hasRunDebugAutostart = false
    @ObservationIgnored private var debugAutomationTask: Task<Void, Never>?
    @ObservationIgnored private var hasStartedDebugAutomation = false

    init(
        settings: AppSettings = AppSettings(),
        apiClient: any HearItAPIProviding = HearItAPIClient(),
        localAudioStore: LocalAudioAssetStore = LocalAudioAssetStore(),
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

        return VoiceChoice(id: settings.selectedVoiceID.isEmpty ? "marin" : settings.selectedVoiceID)
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

    func runDebugAutostartIfNeeded(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) async {
        #if DEBUG
        guard !previewMode else { return }
        guard !hasRunDebugAutostart else { return }
        guard let articleURL = Self.debugAutostartURL(from: environment) else { return }

        hasRunDebugAutostart = true
        urlInput = articleURL
        invalidatePreviewIfNeededForCurrentURL()
        await createAudio()
        #else
        _ = environment
        #endif
    }

    func runDebugAutomationIfNeeded(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) {
        #if DEBUG
        guard !previewMode else { return }
        guard !hasStartedDebugAutomation else { return }
        guard let scenario = Self.debugAutomationScenario(from: environment) else { return }

        hasStartedDebugAutomation = true
        debugAutomationTask = Task { @MainActor [weak self] in
            await self?.performDebugAutomation(named: scenario)
        }
        #else
        _ = environment
        #endif
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
        #if DEBUG
        print("[HearIt][Auth] AppModel.signOut currentBaseURL=\(settings.apiBaseURLString)")
        #endif
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

    func createAudio() async {
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

        isCreatingAudio = true
        defer { isCreatingAudio = false }
        homeMessage = InlineMessage(text: "Creating your audio…", kind: .neutral)

        let breadcrumb = Breadcrumb(level: .info, category: "audio")
        breadcrumb.message = "Create audio"
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
            // Don't open player — user taps the job in library when ready
            trackFirstAudioCreated()
        } catch HearItAPIClient.APIError.unauthorized {
            await signOut()
        } catch {
            if isIgnorableCancellation(error) {
                homeMessage = nil
                return
            }
            SentrySDK.capture(error: error) { scope in
                scope.setTag(value: "create_audio", key: "action")
                scope.setExtra(value: articleURL, key: "articleURL")
            }
            homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
        }
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

        localAudioAssetTasks[job.id]?.cancel()
        localAudioAssetTasks[job.id] = nil

        // If the player is showing this job, close it
        if playerPresentation?.jobID == job.id {
            closePlayer()
            player.unload()
        }

        let crumb = Breadcrumb(level: .info, category: "audio")
        crumb.message = "Delete audio"
        crumb.data = ["jobID": job.id]
        SentrySDK.addBreadcrumb(crumb)

        do {
            try await apiClient.deleteJob(jobID: job.id, baseURL: baseURL)
            try? await localAudioStore.removeCachedAudio(forJobID: job.id)
            jobs.removeAll(where: { $0.id == job.id })
            Analytics.track("audio_deleted", properties: ["job_id": job.id])
        } catch HearItAPIClient.APIError.unauthorized {
            await signOut()
        } catch {
            SentrySDK.capture(error: error) { scope in
                scope.setTag(value: "delete_audio", key: "action")
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

        let knownDuration = playbackDuration(for: job)
        settings.lastPresentedJobID = jobID

        if job.playback.hasFinalSource {
            ensureLocalAudioAssetRequested(for: job)
        }

        if job.playback.mode == .failed {
            player.unload()
            return
        }

        if player.refreshPinnedSession(for: jobID, knownDuration: knownDuration) {
            return
        }

        guard job.playback.mode == .ready else {
            player.unload()
            return
        }

        if let playbackURL = localAudioStore.playbackURLIfExists(forJobID: jobID) {
            #if DEBUG
            print("[HearIt][Player] Loading local file: \(playbackURL)")
            #endif
            player.load(url: playbackURL, for: jobID, knownDuration: knownDuration)
            return
        }

        #if DEBUG
        print("[HearIt][Player] No local file for \(jobID), status=\(job.status)")
        #endif

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
        player.load(url: playbackURL, for: jobID, knownDuration: knownDuration)
    }

    func hasPlayableAudio(for job: AudioJob) -> Bool {
        if job.playback.mode == .failed {
            return false
        }

        if job.playback.isPlayable {
            return true
        }

        if job.playback.hasFinalSource, hasLocallyCachedAudio(for: job) {
            return true
        }

        return false
    }

    func hasLocallyCachedAudio(for job: AudioJob) -> Bool {
        localAudioStore.playbackURLIfExists(forJobID: job.id) != nil
    }

    func displayedTotalDuration(for job: AudioJob) -> Double? {
        if let finalDuration = job.playback.final?.durationSeconds,
           finalDuration > 0 {
            return finalDuration
        }
        return player.duration ?? playbackDuration(for: job)
    }

    func displayedTimelineProgress(for job: AudioJob) -> Double {
        guard let displayedDuration = displayedTotalDuration(for: job),
              displayedDuration > 0 else {
            return player.progress
        }

        return min(max(player.currentTime / displayedDuration, 0), 1)
    }

    func seekDisplayedTimeline(for job: AudioJob, toProgress progress: Double) {
        player.seek(toProgress: min(max(progress, 0), 1))
    }

    func areAdvancedPlaybackControlsEnabled(for job: AudioJob) -> Bool {
        job.playback.mode == .ready
    }

    func togglePlayback(for jobID: String) {
        guard let job = job(with: jobID) else { return }

        if player.loadedJobID != jobID || player.loadedSourceURL == nil {
            preparePlayer(for: jobID)
            ensurePlaybackIsActive(for: jobID, job: job)
            return
        }

        player.togglePlayback()
    }

    func playFromLibrary(for jobID: String) {
        openPlayer(for: jobID)
        guard let job = job(with: jobID) else { return }
        ensurePlaybackIsActive(for: jobID, job: job)
    }

    private func shouldAutoPlay(jobID: String) -> Bool {
        player.loadedJobID != jobID || player.loadedSourceURL == nil
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
           let job = job(with: jobID) {
            ensurePlaybackIsActive(for: jobID, job: job)
        }
    }

    func isDownloadingAudio(for job: AudioJob) -> Bool {
        return localAudioAssetTasks[job.id] != nil
    }

    private func ensureLocalAudioAssetRequested(for job: AudioJob) {
        guard !previewMode else { return }
        guard job.playback.hasFinalSource else { return }
        guard localAudioAssetTasks[job.id] == nil else { return }
        guard localAudioStore.playbackURLIfExists(forJobID: job.id) == nil else { return }
        guard let baseURL = settings.apiBaseURL else { return }
        let finalAudioURL = HearItAPIClient.resolveURL(job.playback.final?.audioUrl ?? job.audioUrl, relativeTo: baseURL)
        guard finalAudioURL != nil || !job.audioSegments.isEmpty else { return }

        localAudioAssetTasks[job.id] = Task { [weak self] in
            guard let self else { return }

            defer {
                localAudioAssetTasks[job.id] = nil
            }

            do {
                if let finalAudioURL {
                    do {
                        let audioData = try await apiClient.downloadAudioData(from: finalAudioURL)
                        _ = try await localAudioStore.saveAudioFile(forJobID: job.id, audioData: audioData)
                    } catch {
                        guard !job.audioSegments.isEmpty else {
                            throw error
                        }
                        try await persistSegmentBundleFallback(for: job, baseURL: baseURL)
                    }
                } else {
                    try await persistSegmentBundleFallback(for: job, baseURL: baseURL)
                }
            } catch is CancellationError {
                return
            } catch {
                SentrySDK.capture(error: error) { scope in
                    scope.setTag(value: "persist_local_audio_asset", key: "action")
                    scope.setExtra(value: job.id, key: "jobID")
                }
            }
        }
    }

    private func ensurePlaybackIsActive(for jobID: String, job: AudioJob) {
        guard !player.isPlaying,
              player.loadedJobID == jobID,
              player.loadedSourceURL != nil,
              hasPlayableAudio(for: job) else {
            return
        }

        player.togglePlayback()
        Analytics.track("audio_played", properties: [
            "job_id": jobID,
            "duration_listened": 0,
            "pct_completed": 0,
        ])
        trackFirstAudioCompleted()
    }

    private func synchronizeLocalAudioAssets(with updatedJobs: [AudioJob]) {
        let activeJobIDs = Set(updatedJobs.map(\.id))
        let staleJobIDs = localAudioAssetTasks.keys.filter { !activeJobIDs.contains($0) }

        for jobID in staleJobIDs {
            localAudioAssetTasks[jobID]?.cancel()
            localAudioAssetTasks[jobID] = nil
        }

        for job in updatedJobs where job.playback.hasFinalSource {
            ensureLocalAudioAssetRequested(for: job)
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
        synchronizeLocalAudioAssets(with: updatedJobs)

        let jobsChanged = jobs != updatedJobs
        if jobsChanged {
            jobs = updatedJobs
        }

        guard jobsChanged else { return }
        preparePresentedPlayerIfNeeded(for: updatedJobs, previousJobs: previousJobs)
    }

    private func applyUpsert(_ job: AudioJob) {
        jobs.removeAll(where: { $0.id == job.id })
        jobs.insert(job, at: 0)
        settings.lastPresentedJobID = job.id
        ensureLocalAudioAssetRequested(for: job)
    }

    private func persistSegmentBundleFallback(for job: AudioJob, baseURL: URL) async throws {
        var cachedSegments: [LocalAudioAssetStore.StoredSegment] = []
        for (index, segment) in job.audioSegments.enumerated() {
            guard let segmentURL = HearItAPIClient.resolveURL(segment.url, relativeTo: baseURL) else {
                throw CacheError.invalidSegmentURL(segment.url)
            }

            cachedSegments.append(LocalAudioAssetStore.StoredSegment(
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

    private static func debugAutostartURL(from environment: [String: String]) -> String? {
        let rawValue = environment["HEAR_IT_DEBUG_AUTOCREATE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let rawValue, !rawValue.isEmpty else { return nil }
        guard let url = URL(string: rawValue),
              let scheme = url.scheme,
              ["http", "https"].contains(scheme.lowercased()) else {
            return nil
        }

        return url.absoluteString
    }

    private static func debugAutomationScenario(from environment: [String: String]) -> String? {
        let scenario = environment["HEAR_IT_DEBUG_AUTOMATION"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let scenario, !scenario.isEmpty else { return nil }
        return scenario
    }

    private func isIgnorableCancellation(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    private func performDebugAutomation(named scenario: String) async {
        #if DEBUG
        switch scenario {
        case "seek-and-reopen":
            await performDebugSeekAndReopenAutomation()
        default:
            print("[HearIt][Debug] Unknown automation scenario: \(scenario)")
        }
        #else
        _ = scenario
        #endif
    }

    private func performDebugSeekAndReopenAutomation() async {
        #if DEBUG
        guard let jobID = await waitForDebugCondition(timeout: .seconds(30), pollInterval: .milliseconds(250), value: {
            self.playerPresentation?.jobID ?? self.settings.lastPresentedJobID
        }) else {
            print("[HearIt][Debug] Automation timed out waiting for a presented job")
            return
        }

        let didReachPlayback = await waitForDebugCondition(timeout: .seconds(90), pollInterval: .milliseconds(250)) {
            if let job = self.job(with: jobID) {
                return job.state == .ready && job.playback.hasFinalSource
            }
            return false
        }

        guard didReachPlayback else {
            print("[HearIt][Debug] Automation timed out waiting for playback")
            return
        }

        guard let readyJob = job(with: jobID),
              let duration = displayedTotalDuration(for: readyJob),
              duration > 0 else {
            print("[HearIt][Debug] Automation could not resolve duration")
            return
        }

        let seekTarget = min(max(duration * 0.35, 15), duration * 0.7)
        let seekProgress = seekTarget / duration
        player.seek(toProgress: seekProgress)
        print("[HearIt][Debug] Automation sought playback to \(seekTarget)s (\(seekProgress))")

        closePlayer()
        print("[HearIt][Debug] Automation closed player")
        try? await Task.sleep(for: .seconds(1))
        openPlayer(for: jobID)
        print("[HearIt][Debug] Automation reopened playback session")
        #endif
    }

    private func waitForDebugCondition<T>(
        timeout: Duration,
        pollInterval: Duration,
        value: @escaping @MainActor () -> T?
    ) async -> T? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if let resolved = value() {
                return resolved
            }
            try? await Task.sleep(for: pollInterval)
        }
        return nil
    }

    private func waitForDebugCondition(
        timeout: Duration,
        pollInterval: Duration,
        predicate: @escaping @MainActor () -> Bool
    ) async -> Bool {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if predicate() {
                return true
            }
            try? await Task.sleep(for: pollInterval)
        }
        return false
    }

    private func playbackDuration(for job: AudioJob) -> Double? {
        if let durationSeconds = job.playback.final?.durationSeconds, durationSeconds > 0 {
            return durationSeconds
        }

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

    private func trackFirstAudioCreated() {
        let key = "analytics_first_audio_created"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        Analytics.track("first_audio_created")
    }

    private func trackFirstAudioCompleted() {
        let key = "analytics_first_audio_completed"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        Analytics.track("first_audio_completed")
    }
}
