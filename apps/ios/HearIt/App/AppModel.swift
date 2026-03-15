import Observation
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

    @ObservationIgnored private let apiClient: HearItAPIClient
    @ObservationIgnored private let previewMode: Bool
    @ObservationIgnored private var hasBootstrapped = false
    @ObservationIgnored private var pollingTask: Task<Void, Never>?

    init(
        settings: AppSettings = AppSettings(),
        apiClient: HearItAPIClient = HearItAPIClient(),
        player: AudioPlayerController = AudioPlayerController(),
        previewMode: Bool = false
    ) {
        self.settings = settings
        self.apiClient = apiClient
        self.player = player
        self.previewMode = previewMode
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
        } catch {
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
            applyJobs(try await apiClient.fetchJobs(baseURL: baseURL))
            if !silent {
                homeMessage = InlineMessage(text: "Library refreshed.", kind: .success)
            }
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

        // If the player is showing this job, close it
        if playerPresentation?.jobID == job.id {
            closePlayer()
            player.unload()
        }

        do {
            try await apiClient.deleteJob(jobID: job.id, baseURL: baseURL)
            jobs.removeAll(where: { $0.id == job.id })
        } catch {
            homeMessage = InlineMessage(text: error.localizedDescription, kind: .error)
        }

        jobPendingDeletion = nil
    }

    func openPlayer(for jobID: String) {
        let shouldAutoPlay = player.loadedJobID != jobID
        settings.lastPresentedJobID = jobID
        playerPresentation = PlayerPresentation(jobID: jobID)
        preparePlayer(for: jobID)
        if shouldAutoPlay, job(with: jobID)?.status == .completed {
            player.togglePlayback()
        }
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

        guard let baseURL = settings.apiBaseURL,
              let playbackURL = job.playbackURL(relativeTo: baseURL) else {
            player.unload()
            return
        }

        if job.status == .completed {
            player.load(url: playbackURL, for: jobID)
        } else {
            player.unload()
        }
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
        guard jobs != updatedJobs else { return }
        jobs = updatedJobs

        if let currentPresentation = playerPresentation {
            preparePlayer(for: currentPresentation.jobID)
            return
        }

        if let lastPresentedJobID = settings.lastPresentedJobID,
           jobs.contains(where: { $0.id == lastPresentedJobID }) {
            return
        }

        settings.lastPresentedJobID = jobs.first?.id
    }

    private func applyUpsert(_ job: AudioJob) {
        jobs.removeAll(where: { $0.id == job.id })
        jobs.insert(job, at: 0)
        settings.lastPresentedJobID = job.id
    }
}
