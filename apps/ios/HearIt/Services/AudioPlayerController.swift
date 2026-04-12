import AVFoundation
import Foundation
import Observation

@MainActor
@Observable
final class AudioPlayerController {
    var currentTime: Double = 0
    var duration: Double?
    var isPlaying = false
    var playbackRate = 1.0
    var volume = 1.0 {
        didSet {
            player.volume = Float(volume)
        }
    }
    var loadedJobID: String?
    var loadedSourceURL: URL?

    @ObservationIgnored private let player = AVPlayer()
    @ObservationIgnored private let previewMode: Bool
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var playbackEndedObserver: NSObjectProtocol?
    @ObservationIgnored private var seekOnReadyTask: Task<Void, Never>?
    @ObservationIgnored private var isSeeking = false
    #if DEBUG
    @ObservationIgnored private var lastObservedCurrentTime: Double?
    @ObservationIgnored private var lastObservedDuration: Double?
    #endif

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
                self?.handlePlaybackItemDidReachEnd()
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
        guard loadedJobID != jobID || loadedSourceURL != url else {
            // Already loaded — keep the seek range in sync as processing playlists grow.
            if let knownDuration, knownDuration > 0 {
                duration = knownDuration
            }
            return
        }

        seekOnReadyTask?.cancel()
        let targetTime = savedPosition(for: jobID)   // read once — before the task races with the time observer
        loadedJobID = jobID
        loadedSourceURL = url
        currentTime = targetTime
        duration = knownDuration
        isPlaying = false
        isSeeking = true
        #if DEBUG
        lastObservedCurrentTime = nil
        lastObservedDuration = knownDuration
        print("[HearIt][Player] load — job=\(jobID) source=\(url.lastPathComponent) knownDuration=\(knownDuration.map { String(format: "%.3f", $0) } ?? "nil") targetTime=\(String(format: "%.3f", targetTime))")
        #endif
        guard !previewMode else { return }

        let item = AVPlayerItem(url: url)
        player.replaceCurrentItem(with: item)
        seekOnReadyTask = Task { [weak self] in
            await self?.seekWhenReady(item: item, to: targetTime)
        }
    }

    func unload() {
        seekOnReadyTask?.cancel()
        loadedJobID = nil
        loadedSourceURL = nil
        currentTime = 0
        duration = nil
        isPlaying = false
        #if DEBUG
        lastObservedCurrentTime = nil
        lastObservedDuration = nil
        print("[HearIt][Player] unload")
        #endif
        guard !previewMode else { return }
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    func updateKnownDuration(_ knownDuration: Double?) {
        guard let knownDuration, knownDuration > 0 else { return }
        #if DEBUG
        if let previous = duration, abs(previous - knownDuration) > 0.5 {
            print("[HearIt][Player] updateKnownDuration — \(String(format: "%.3f", previous)) -> \(String(format: "%.3f", knownDuration)) source=\(loadedSourceURL?.lastPathComponent ?? "nil")")
        }
        #endif
        duration = knownDuration
    }

    func updateObservedDuration(_ observedDuration: Double) {
        guard observedDuration.isFinite, observedDuration > 0 else { return }
        duration = observedDuration
    }

    func refreshPinnedSession(for jobID: String, knownDuration: Double?) -> Bool {
        guard loadedJobID == jobID, loadedSourceURL != nil else { return false }
        if let knownDuration, knownDuration > 0 {
            #if DEBUG
            if let previous = duration, abs(previous - knownDuration) > 0.5 {
                print("[HearIt][Player] refreshPinnedSession — \(String(format: "%.3f", previous)) -> \(String(format: "%.3f", knownDuration)) source=\(loadedSourceURL?.lastPathComponent ?? "nil")")
            }
            #endif
            duration = knownDuration
        }
        return true
    }

    func endPlaybackSession() {
        if let jobID = loadedJobID {
            clearPosition(for: jobID)
        }
        unload()
    }

    func handlePlaybackItemDidReachEnd() {
        #if DEBUG
        print("[HearIt][Player] didReachEnd — currentTime=\(String(format: "%.3f", currentTime)) duration=\(duration.map { String(format: "%.3f", $0) } ?? "nil") source=\(loadedSourceURL?.lastPathComponent ?? "nil")")
        #endif
        endPlaybackSession()
    }

    func clearSavedPositionForLoadedJob() {
        guard let jobID = loadedJobID else { return }
        clearPosition(for: jobID)
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
        #if DEBUG
        print("[HearIt][Player] playImmediately — item=\(player.currentItem?.status.rawValue ?? -1) timeControlStatus=\(player.timeControlStatus.rawValue)")
        #endif
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
        guard let duration else { return }
        let nextTime = min(duration, currentTime + 15)
        guard !previewMode else {
            currentTime = nextTime
            return
        }
        player.seek(to: CMTime(seconds: nextTime, preferredTimescale: 600))
        currentTime = nextTime
        if let jobID = loadedJobID {
            savePosition(nextTime, for: jobID)
        }
    }

    func seek(toProgress progress: Double) {
        guard let duration, duration > 0 else { return }

        let clamped = min(max(progress, 0), 1)
        let newTime = duration * clamped
        seek(toTime: newTime)
    }

    func seek(toTime time: Double) {
        let clampedTime = max(time, 0)
        guard !previewMode else {
            currentTime = clampedTime
            return
        }
        player.seek(to: CMTime(seconds: clampedTime, preferredTimescale: 600))
        currentTime = clampedTime
        if let jobID = loadedJobID {
            if clampedTime > 0 {
                savePosition(clampedTime, for: jobID)
            } else {
                clearPosition(for: jobID)
            }
        }
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
        guard let duration, duration > 0 else { return 0 }
        return min(max(currentTime / duration, 0), 1)
    }

    var canSeek: Bool {
        guard let duration else { return false }
        return duration > 0
    }

    func configurePreviewState(
        jobID: String?,
        duration: Double?,
        currentTime: Double,
        isPlaying: Bool,
        playbackRate: Double = 1.0,
        volume: Double = 1.0,
        loadedSourceURL: URL? = nil
    ) {
        loadedJobID = jobID
        self.loadedSourceURL = loadedSourceURL
        self.duration = duration
        self.currentTime = min(max(currentTime, 0), duration ?? currentTime)
        self.isPlaying = isPlaying
        self.playbackRate = playbackRate
        self.volume = volume
    }

    // MARK: - Saved position

    private static func positionKey(for jobID: String) -> String {
        "hear-it.playback-position.\(jobID)"
    }

    private func savedPosition(for jobID: String) -> Double {
        UserDefaults.standard.double(forKey: Self.positionKey(for: jobID))
    }

    private func savePosition(_ time: Double, for jobID: String) {
        UserDefaults.standard.set(time, forKey: Self.positionKey(for: jobID))
    }

    private func clearPosition(for jobID: String) {
        UserDefaults.standard.removeObject(forKey: Self.positionKey(for: jobID))
    }

    /// Waits for the AVPlayerItem to become ready, then seeks to the target offset.
    /// Using a polling task because HLS items reject seeks issued before status == .readyToPlay.
    private func seekWhenReady(item: AVPlayerItem, to targetTime: Double) async {
        defer { isSeeking = false }
        #if DEBUG
        print("[HearIt][Player] seekWhenReady start — targetTime=\(targetTime) url=\(item.asset)")
        #endif
        while !Task.isCancelled {
            guard item === player.currentItem else {
                #if DEBUG
                print("[HearIt][Player] seekWhenReady — item replaced, bailing")
                #endif
                return
            }
            if item.status == .readyToPlay {
                #if DEBUG
                print("[HearIt][Player] seekWhenReady — item ready, seeking to \(targetTime)")
                #endif
                if targetTime > 0 {
                    let cmTime = CMTime(seconds: targetTime, preferredTimescale: 600)
                    _ = await player.seek(to: cmTime, toleranceBefore: .zero, toleranceAfter: .zero)
                }
                return
            }
            if item.status == .failed {
                #if DEBUG
                print("[HearIt][Player] seekWhenReady — item FAILED: \(item.error?.localizedDescription ?? "unknown")")
                #endif
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        #if DEBUG
        print("[HearIt][Player] seekWhenReady — cancelled")
        #endif
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

                let time = player.currentTime().seconds
                #if DEBUG
                if let lastObservedCurrentTime,
                   !isSeeking,
                   time.isFinite {
                    let delta = time - lastObservedCurrentTime
                    if delta > 0.5 || delta < -0.25 {
                        print("[HearIt][Player] timeJump — from=\(String(format: "%.3f", lastObservedCurrentTime)) to=\(String(format: "%.3f", time)) delta=\(String(format: "%.3f", delta)) itemDuration=\(String(format: "%.3f", player.currentItem?.duration.seconds ?? 0)) source=\(loadedSourceURL?.lastPathComponent ?? "nil") status=\(player.timeControlStatus.rawValue)")
                    }
                }
                #endif
                currentTime = time.isFinite ? time : 0
                let itemDuration = player.currentItem?.duration.seconds ?? 0
                #if DEBUG
                if itemDuration.isFinite,
                   itemDuration > 0,
                   let lastObservedDuration,
                   abs(itemDuration - lastObservedDuration) > 0.5 {
                    print("[HearIt][Player] observedDurationChanged — \(String(format: "%.3f", lastObservedDuration)) -> \(String(format: "%.3f", itemDuration)) source=\(loadedSourceURL?.lastPathComponent ?? "nil")")
                }
                lastObservedCurrentTime = currentTime
                if itemDuration.isFinite, itemDuration > 0 {
                    lastObservedDuration = itemDuration
                }
                #endif
                updateObservedDuration(itemDuration)
                isPlaying = player.timeControlStatus == .playing
                // Persist position so we can resume after the app is closed.
                // Skip while seeking to avoid corrupting the saved position.
                if let jobID = loadedJobID, currentTime > 0, !isSeeking {
                    savePosition(currentTime, for: jobID)
                }
            }
        }
    }
}
