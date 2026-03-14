import Foundation

@MainActor
extension AppModel {
    static func previewHome() -> AppModel {
        let model = previewBase(name: "home")
        model.homeMessage = InlineMessage(text: "Connected to your local Hear It server.", kind: .success)
        return model
    }

    static func previewLibrary() -> AppModel {
        let model = previewBase(name: "library")
        model.selectedTab = .library
        return model
    }

    static func previewVoiceSelection() -> AppModel {
        let model = previewBase(name: "voice-selection")
        model.previewMessage = InlineMessage(text: "Article preview ready.", kind: .success)
        return model
    }

    static func previewPlayerReady() -> AppModel {
        let model = previewBase(name: "player-ready")
        model.playerPresentation = PlayerPresentation(jobID: PreviewSamples.readyJob.id)
        model.settings.lastPresentedJobID = PreviewSamples.readyJob.id
        model.player.configurePreviewState(
            jobID: PreviewSamples.readyJob.id,
            duration: 603,
            currentTime: 148,
            isPlaying: false,
            playbackRate: 1.0,
            volume: 0.82
        )
        return model
    }

    static func previewPlayerProcessing() -> AppModel {
        let model = previewBase(name: "player-processing")
        model.playerPresentation = PlayerPresentation(jobID: PreviewSamples.processingJob.id)
        model.settings.lastPresentedJobID = PreviewSamples.processingJob.id
        return model
    }

    static func previewSettings() -> AppModel {
        previewBase(name: "settings")
    }

    static func previewRoot() -> AppModel {
        previewBase(name: "root")
    }

    private static func previewBase(name: String) -> AppModel {
        let suiteName = "HearItPreview.\(name)"
        let defaults = UserDefaults(suiteName: suiteName) ?? .standard
        defaults.removePersistentDomain(forName: suiteName)

        let settings = AppSettings(defaults: defaults)
        settings.apiBaseURLString = "http://127.0.0.1:3000"
        settings.selectedVoiceID = "sage"
        settings.lastPresentedJobID = PreviewSamples.readyJob.id

        let model = AppModel(
            settings: settings,
            player: AudioPlayerController(previewMode: true),
            previewMode: true
        )

        model.connectionState = .connected
        model.serverConfig = PreviewSamples.serverConfig
        model.availableVoices = PreviewSamples.voices
        model.jobs = PreviewSamples.libraryJobs
        model.urlInput = PreviewSamples.previewArticle.url
        model.previewArticle = PreviewSamples.previewArticle

        return model
    }
}
