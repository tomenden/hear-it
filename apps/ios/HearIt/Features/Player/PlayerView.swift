import SwiftUI

struct PlayerView: View {
    @Bindable var model: AppModel
    let presentation: PlayerPresentation

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var seekProgress = 0.0
    @State private var isEditingSeek = false
    @State private var volume = 1.0

    private let playbackRates = [0.75, 1.0, 1.25, 1.5]

    private struct ProcessingPresentation {
        let title: String
        let message: String
        let systemImage: String?
        let isError: Bool
    }

    private var currentJob: AudioJob? {
        model.job(with: presentation.jobID)
    }

    private var hasPlayableAudio: Bool {
        guard let currentJob else { return false }
        return model.hasPlayableAudio(for: currentJob)
    }

    var body: some View {
        ZStack {
            AppTheme.Gradients.page
                .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 24) {
                    header
                    playerContent
                }
                .padding(AppTheme.Layout.screenPadding)
            }
        }
        .task(id: presentation.jobID) {
            model.preparePlayer(for: presentation.jobID)
            if let job = currentJob {
                seekProgress = model.displayedTimelineProgress(for: job)
            }
            volume = model.player.volume
        }
        .onChange(of: model.player.volume) { _, newValue in
            volume = newValue
        }
    }

    @ViewBuilder
    private var playerContent: some View {
        if let job = currentJob {
            if job.status != .failed, hasPlayableAudio {
                readyView(for: job)
            } else {
                processingView(for: job)
            }
        } else {
            ContentUnavailableView(
                "No audio selected",
                systemImage: "waveform",
                description: Text("Choose audio from your library.")
            )
            .padding(.top, 100)
        }
    }

    private var header: some View {
        HStack {
            Button("Close", systemImage: "chevron.down") {
                model.closePlayer()
                dismiss()
            }
            .buttonStyle(.bordered)
            .tint(AppTheme.Colors.textPrimary)

            Spacer()

            Text("Now Playing")
                .font(.headline)
                .foregroundStyle(AppTheme.Colors.textPrimary)

            Spacer()

            if let job = model.job(with: presentation.jobID),
               let url = URL(string: job.article.url) {
                Button("Source", systemImage: "safari") {
                    openURL(url)
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.Colors.textPrimary)
            } else {
                Color.clear
                    .frame(width: 90, height: 1)
            }
        }
    }

    private func readyView(for job: AudioJob) -> some View {
        let advancedControlsEnabled = model.areAdvancedPlaybackControlsEnabled(for: job)

        return VStack(spacing: 24) {
            RoundedRectangle(cornerRadius: 28)
                .fill(AppTheme.Gradients.artwork)
                .frame(maxWidth: .infinity)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    VStack(spacing: 12) {
                        Image(systemName: "waveform.and.mic")
                            .font(.system(size: 54, weight: .bold))
                            .foregroundStyle(.white)
                            .accessibilityHidden(true)

                        Text("HEAR IT")
                            .font(.title2.weight(.bold))
                            .foregroundStyle(.white)
                    }
                }
                .shadow(color: AppTheme.Colors.accentCoral.opacity(0.24), radius: 28, y: 12)

            VStack(spacing: 6) {
                Text(job.article.displayTitle)
                    .font(.title2)
                    .bold()
                    .multilineTextAlignment(.center)
                    .foregroundStyle(AppTheme.Colors.textPrimary)

                Text(job.article.sourceLine)
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.Colors.textSecondary)
                    .multilineTextAlignment(.center)

                Text("Voice: \(job.speechOptions.voice.capitalized)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.Colors.accentCoral)
            }

            VStack(spacing: 12) {
                Slider(
                    value: seekBinding(for: job),
                    in: 0 ... 1,
                    onEditingChanged: { editing in
                        if editing {
                            isEditingSeek = true
                            seekProgress = model.displayedTimelineProgress(for: job)
                        } else {
                            isEditingSeek = false
                            model.seekDisplayedTimeline(for: job, toProgress: seekProgress)
                        }
                    }
                )
                .tint(AppTheme.Colors.accentGreen)
                .disabled(!model.player.canSeek)

                HStack {
                    Text(Self.formatTime(model.player.currentTime))
                    Spacer()
                    Text(displayedDurationLabel(for: job))
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(AppTheme.Colors.textSecondary)
            }

            HStack(spacing: 20) {
                Button("Restart", systemImage: "backward.end.fill") {
                    model.player.restart()
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.Colors.textPrimary)

                Button(model.player.isPlaying ? "Pause" : "Play", systemImage: model.player.isPlaying ? "pause.fill" : "play.fill") {
                    model.togglePlayback(for: job.id)
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.Colors.accentGreen)

                Button("15 Seconds", systemImage: "goforward.15") {
                    model.player.skipForward()
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.Colors.textPrimary)
                .disabled(!advancedControlsEnabled)
            }
            .labelStyle(.titleAndIcon)

            HStack(spacing: 8) {
                ForEach(playbackRates, id: \.self) { rate in
                    Button("\(rate.formatted())x") {
                        model.player.updatePlaybackRate(rate)
                    }
                    .buttonStyle(.bordered)
                    .tint(model.player.playbackRate == rate ? AppTheme.Colors.accentGreen : AppTheme.Colors.textPrimary)
                    .disabled(!advancedControlsEnabled)
                }
            }

            VStack(spacing: 8) {
                let isStreamingSession = model.isStreamingPlaybackSession(for: job)
                if isStreamingSession {
                    VStack(spacing: 6) {
                        Label("Playing the audio available so far", systemImage: "dot.radiowaves.left.and.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AppTheme.Colors.accentGreen)

                        Text("More audio is still being generated. If you scrub ahead, playback stays within what is ready right now.")
                            .font(.caption)
                            .foregroundStyle(AppTheme.Colors.textSecondary)
                            .multilineTextAlignment(.center)

                        if !advancedControlsEnabled {
                            Text("Playback speed and quick-skip unlock when the full audio is ready.")
                                .font(.caption)
                                .foregroundStyle(AppTheme.Colors.textSecondary)
                                .multilineTextAlignment(.center)
                        }
                    }
                } else {
                    Label("Ready", systemImage: "checkmark.circle")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.Colors.accentGreen)
                }

                HStack {
                    Image(systemName: "speaker.fill")
                        .foregroundStyle(AppTheme.Colors.textTertiary)
                        .accessibilityHidden(true)

                    Slider(value: $volume, in: 0 ... 1)
                    .tint(AppTheme.Colors.accentGreen)
                    .onChange(of: volume) { _, newValue in
                        model.player.updateVolume(newValue)
                    }

                    Image(systemName: "speaker.wave.2.fill")
                        .foregroundStyle(AppTheme.Colors.textTertiary)
                        .accessibilityHidden(true)
                }

                Text("Volume")
                    .font(.caption)
                    .foregroundStyle(AppTheme.Colors.textSecondary)
            }
        }
    }

    private func displayedDurationLabel(for job: AudioJob) -> String {
        let formattedDuration = Self.formatTime(model.displayedTotalDuration(for: job))
        if model.isUsingEstimatedTimelineEnvelope(for: job) {
            return "~\(formattedDuration)"
        }
        return formattedDuration
    }

    private func seekBinding(for job: AudioJob) -> Binding<Double> {
        Binding(
            get: {
                if isEditingSeek {
                    return seekProgress
                }
                return model.displayedTimelineProgress(for: job)
            },
            set: { newValue in
                seekProgress = newValue
            }
        )
    }

    @State private var waveformPhase: CGFloat = 0
    @State private var progressOffset: CGFloat = 0

    private func processingView(for job: AudioJob) -> some View {
        let presentation = processingPresentation(for: job)
        let barCount = 15
        let barWidth: CGFloat = 4
        let barSpacing: CGFloat = 5
        let baseHeights: [CGFloat] = [28, 40, 56, 36, 64, 48, 72, 32, 60, 44, 68, 24, 52, 38, 56]

        return VStack(spacing: 20) {
            // Radial gradient glow
            Ellipse()
                .fill(
                    RadialGradient(
                        colors: presentation.isError
                            ? [AppTheme.Colors.error.opacity(0.094), AppTheme.Colors.error.opacity(0)]
                            : [AppTheme.Colors.accentGreen.opacity(0.094), AppTheme.Colors.accentGreen.opacity(0)],
                        center: .center,
                        startRadius: 0,
                        endRadius: 70
                    )
                )
                .frame(width: 140, height: 140)

            // Waveform bars
            if let systemImage = presentation.systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 42, weight: .bold))
                    .foregroundStyle(presentation.isError ? AppTheme.Colors.error : AppTheme.Colors.accentGreen)
            } else {
                HStack(spacing: barSpacing) {
                    ForEach(0..<barCount, id: \.self) { index in
                        let isLight = index % 2 != 0
                        let phase = waveformPhase + CGFloat(index) * 0.4
                        let scale = reduceMotion ? 1.0 : (0.5 + 0.5 * sin(phase))
                        let height = baseHeights[index % baseHeights.count] * scale

                        RoundedRectangle(cornerRadius: 100)
                            .fill(isLight ? AppTheme.Colors.accentGreenLight : AppTheme.Colors.accentGreen)
                            .frame(width: barWidth, height: max(8, height))
                    }
                }
                .frame(height: 72)
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) {
                        waveformPhase = .pi * 2
                    }
                }
            }

            // Status text
            VStack(spacing: 10) {
                Text(presentation.title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(presentation.isError ? AppTheme.Colors.error : AppTheme.Colors.textPrimary)

                Text(job.article.displayTitle)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(AppTheme.Colors.textSecondary)
                    .multilineTextAlignment(.center)

                // Voice label with mic icon
                Label("Voice: \(job.speechOptions.voice.capitalized)", systemImage: "mic.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(AppTheme.Colors.textSecondary)
            }

            // Custom progress bar
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(AppTheme.Colors.muted)
                    .frame(width: 200, height: 4)

                if presentation.isError {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(AppTheme.Colors.error)
                        .frame(width: 200, height: 4)
                } else {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(AppTheme.Colors.accentGreen)
                        .frame(width: 80, height: 4)
                        .offset(x: reduceMotion ? 60 : progressOffset)
                        .onAppear {
                            guard !reduceMotion else { return }
                            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                                progressOffset = 120
                            }
                        }
                }
            }
            .frame(width: 200, height: 4)
            .clipped()

            // Tertiary hint
            Text(presentation.message)
                .font(.system(size: 12))
                .foregroundStyle(presentation.isError ? AppTheme.Colors.error : AppTheme.Colors.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 80)
    }

    private func processingPresentation(for job: AudioJob) -> ProcessingPresentation {
        switch job.playback.mode {
        case .failed:
            return ProcessingPresentation(
                title: "Audio failed",
                message: job.playback.errorMessage ?? job.statusMessage,
                systemImage: "exclamationmark.triangle.fill",
                isError: true
            )
        case .final:
            return ProcessingPresentation(
                title: "Final audio is almost ready",
                message: "The final file is still settling. Try again in a moment.",
                systemImage: "waveform.badge.clock",
                isError: false
            )
        case .preparing:
            return ProcessingPresentation(
                title: "Preparing audio",
                message: "We are building the opening buffer so playback can start smoothly.",
                systemImage: nil,
                isError: false
            )
        case .streaming:
            return ProcessingPresentation(
                title: "Generating audio",
                message: "More audio is on the way. Playback opens once there is enough ready to listen without interruption.",
                systemImage: nil,
                isError: false
            )
        }
    }

    private static func formatTime(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite else { return "?" }
        let totalSeconds = max(0, Int(seconds.rounded()))
        let minutes = totalSeconds / 60
        let remainder = totalSeconds % 60
        return "\(minutes):\(String(format: "%02d", remainder))"
    }
}

#Preview("Player Preparing") {
    let model = AppModel.previewPlayerPreparing()
    return PlayerView(
        model: model,
        presentation: PlayerPresentation(jobID: PlaybackStateSamples.preparingJob.id)
    )
}

#Preview("Player Streaming") {
    let model = AppModel.previewPlayerProcessing()
    return PlayerView(
        model: model,
        presentation: PlayerPresentation(jobID: PlaybackStateSamples.streamingJob.id)
    )
}

#Preview("Player Ready") {
    let model = AppModel.previewPlayerReady()
    return PlayerView(
        model: model,
        presentation: PlayerPresentation(jobID: PlaybackStateSamples.finalJob.id)
    )
}

#Preview("Player Failed") {
    let model = AppModel.previewPlayerFailed()
    return PlayerView(
        model: model,
        presentation: PlayerPresentation(jobID: PlaybackStateSamples.failedJob.id)
    )
}
