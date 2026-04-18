import Foundation
import MediaPlayer
import Testing
@testable import HearIt

@MainActor
struct AudioPlayerControllerTests {
    @Test
    func initializationDoesNotActivateAudioSessionBeforePlaybackStarts() {
        let system = AudioPlaybackSystemMock()

        _ = AudioPlayerController(previewMode: false, system: system)

        #expect(system.configureSessionCallCount == 1)
        #expect(system.activateSessionCallCount == 0)
        #expect(system.nowPlayingInfoUpdateCount == 0)
        #expect(system.remoteCommandsConfigured)
    }

    @Test
    func startingPlaybackPublishesNowPlayingInfoAndActivatesSession() {
        let system = AudioPlaybackSystemMock()
        let controller = AudioPlayerController(previewMode: false, system: system)
        controller.configurePreviewState(
            jobID: "job-player-tests",
            duration: 42,
            currentTime: 12,
            isPlaying: false,
            playbackRate: 1.25,
            loadedSourceURL: URL(string: "https://example.com/audio/final.mp3")
        )

        controller.togglePlayback()

        #expect(system.activateSessionCallCount == 1)
        #expect(system.nowPlayingInfoUpdateCount >= 1)
        #expect(system.lastNowPlayingInfo?[MPMediaItemPropertyTitle] as? String == "final.mp3")
        #expect(system.lastNowPlayingInfo?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double == 12)
        #expect(system.lastNowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] as? Double == 1.25)
        #expect(system.lastNowPlayingInfo?[MPMediaItemPropertyPlaybackDuration] as? Double == 42)
    }
}

@MainActor
final class AudioPlaybackSystemMock: AudioPlaybackSystem {
    private(set) var configureSessionCallCount = 0
    private(set) var activateSessionCallCount = 0
    private(set) var deactivateSessionCallCount = 0
    private(set) var nowPlayingInfoUpdateCount = 0
    private(set) var clearNowPlayingInfoCallCount = 0
    private(set) var remoteCommandsConfigured = false
    private(set) var lastNowPlayingInfo: [String: Any]?
    private(set) var commandHandlers: AudioPlaybackCommandHandlers?

    func configureSessionForPlayback() {
        configureSessionCallCount += 1
    }

    func activateSessionForPlayback() {
        activateSessionCallCount += 1
    }

    func deactivateSession() {
        deactivateSessionCallCount += 1
    }

    func updateNowPlayingInfo(_ info: [String: Any]) {
        nowPlayingInfoUpdateCount += 1
        lastNowPlayingInfo = info
    }

    func clearNowPlayingInfo() {
        clearNowPlayingInfoCallCount += 1
        lastNowPlayingInfo = nil
    }

    func configureRemoteCommands(_ handlers: AudioPlaybackCommandHandlers) {
        remoteCommandsConfigured = true
        commandHandlers = handlers
    }
}
