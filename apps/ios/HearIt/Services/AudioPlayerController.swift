import AVFoundation
import Foundation
import Observation

@MainActor
@Observable
final class AudioPlayerController {
    var currentTime: Double = 0
    var duration: Double = 0
    var isPlaying = false
    var playbackRate = 1.0
    var volume = 1.0 {
        didSet {
            player.volume = Float(volume)
        }
    }
    var loadedJobID: String?

    @ObservationIgnored private let player = AVPlayer()
    @ObservationIgnored private let previewMode: Bool
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var playbackEndedObserver: NSObjectProtocol?

    init(previewMode: Bool = false) {
        self.previewMode = previewMode
        player.volume = Float(volume)
        guard !previewMode else { return }

        configureAudioSession()
        installTimeObserver()
        playbackEndedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.isPlaying = false
            }
        }
    }

    isolated deinit {
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
        }

        if let playbackEndedObserver {
            NotificationCenter.default.removeObserver(playbackEndedObserver)
        }
    }

    func load(url: URL, for jobID: String, knownDuration: Double? = nil) {
        guard loadedJobID != jobID || currentAssetURL != url else {
            // Already loaded — just update duration if we have a better value
            if let knownDuration, knownDuration > 0, duration == 0 {
                duration = knownDuration
            }
            return
        }

        loadedJobID = jobID
        currentTime = 0
        duration = knownDuration ?? 0
        isPlaying = false
        guard !previewMode else { return }
        player.replaceCurrentItem(with: AVPlayerItem(url: url))
    }

    func unload() {
        loadedJobID = nil
        currentTime = 0
        duration = 0
        isPlaying = false
        guard !previewMode else { return }
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    func togglePlayback() {
        if previewMode {
            isPlaying.toggle()
            return
        }

        if isPlaying {
            player.pause()
            isPlaying = false
            return
        }

        configureAudioSession()
        player.playImmediately(atRate: Float(playbackRate))
        isPlaying = true
    }

    func restart() {
        if previewMode {
            currentTime = 0
        } else {
            seek(toProgress: 0)
        }
    }

    func skipForward() {
        let nextTime = min(duration, currentTime + 15)
        guard !previewMode else {
            currentTime = nextTime
            return
        }
        player.seek(to: CMTime(seconds: nextTime, preferredTimescale: 600))
        currentTime = nextTime
    }

    func seek(toProgress progress: Double) {
        guard duration > 0 else { return }

        let clamped = min(max(progress, 0), 1)
        let newTime = duration * clamped
        guard !previewMode else {
            currentTime = newTime
            return
        }
        player.seek(to: CMTime(seconds: newTime, preferredTimescale: 600))
        currentTime = newTime
    }

    func updatePlaybackRate(_ nextRate: Double) {
        playbackRate = nextRate
        guard !previewMode else { return }
        if isPlaying {
            player.rate = Float(nextRate)
        }
    }

    func updateVolume(_ nextVolume: Double) {
        volume = min(max(nextVolume, 0), 1)
    }

    var progress: Double {
        guard duration > 0 else { return 0 }
        return currentTime / duration
    }

    func configurePreviewState(
        jobID: String?,
        duration: Double,
        currentTime: Double,
        isPlaying: Bool,
        playbackRate: Double = 1.0,
        volume: Double = 1.0
    ) {
        loadedJobID = jobID
        self.duration = duration
        self.currentTime = min(max(currentTime, 0), duration)
        self.isPlaying = isPlaying
        self.playbackRate = playbackRate
        self.volume = volume
    }

    private var currentAssetURL: URL? {
        (player.currentItem?.asset as? AVURLAsset)?.url
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, policy: .longFormAudio)
        try? session.setActive(true, options: [])
    }

    private func installTimeObserver() {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.25, preferredTimescale: 600),
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }

                currentTime = player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0
                let itemDuration = player.currentItem?.duration.seconds ?? 0
                duration = itemDuration.isFinite ? itemDuration : 0
                isPlaying = player.timeControlStatus == .playing
            }
        }
    }
}
