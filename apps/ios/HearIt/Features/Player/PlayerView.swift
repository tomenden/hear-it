import SwiftUI

struct PlayerView: View {
    @Bindable var model: AppModel
    let presentation: PlayerPresentation

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var seekProgress = 0.0
    @State private var volume = 1.0

    private let playbackRates = [0.75, 1.0, 1.25, 1.5]

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
            seekProgress = model.player.progress
            volume = model.player.volume
        }
        .onChange(of: model.player.progress) { _, newValue in
            seekProgress = newValue
        }
        .onChange(of: model.player.volume) { _, newValue in
            volume = newValue
        }
    }

    @ViewBuilder
    private var playerContent: some View {
        if let job = currentJob {
            if job.status == .completed, hasPlayableAudio {
                readyView(for: job)
            } else {
                processingView(for: job)
            }
        } else {
            ContentUnavailableView(
                "No narration selected",
                systemImage: "waveform",
                description: Text("Choose a narration from your library.")
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
        VStack(spacing: 24) {
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

                Text("Narrated by \(job.speechOptions.voice.capitalized)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppTheme.Colors.accentCoral)
            }

            VStack(spacing: 12) {
                Slider(
                    value: $seekProgress,
                    in: 0 ... 1,
                    onEditingChanged: { editing in
                        if !editing {
                            model.player.seek(toProgress: seekProgress)
                        }
                    }
                )
                .tint(AppTheme.Colors.accentGreen)

                HStack {
                    Text(Self.formatTime(model.player.currentTime))
                    Spacer()
                    Text(Self.formatTime(model.player.duration))
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
                    model.player.togglePlayback()
                }
                .buttonStyle(.borderedProminent)
                .tint(AppTheme.Colors.accentGreen)

                Button("15 Seconds", systemImage: "goforward.15") {
                    model.player.skipForward()
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.Colors.textPrimary)
            }
            .labelStyle(.titleAndIcon)

            HStack(spacing: 8) {
                ForEach(playbackRates, id: \.self) { rate in
                    Button("\(rate.formatted())x") {
                        model.player.updatePlaybackRate(rate)
                    }
                    .buttonStyle(.bordered)
                    .tint(model.player.playbackRate == rate ? AppTheme.Colors.accentGreen : AppTheme.Colors.textPrimary)
                }
            }

            VStack(spacing: 8) {
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

    @State private var waveformPhase: CGFloat = 0
    @State private var progressOffset: CGFloat = 0

    private func processingView(for job: AudioJob) -> some View {
        let isFailed = job.status == .failed
        let isDownloadingToDevice = job.status == .completed && !hasPlayableAudio && model.isDownloadingAudio(for: job)
        let isAudioUnavailable = job.status == .completed && !hasPlayableAudio && !model.isDownloadingAudio(for: job)
        let barCount = 15
        let barWidth: CGFloat = 4
        let barSpacing: CGFloat = 5
        let baseHeights: [CGFloat] = [28, 40, 56, 36, 64, 48, 72, 32, 60, 44, 68, 24, 52, 38, 56]

        return VStack(spacing: 20) {
            // Radial gradient glow
            Ellipse()
                .fill(
                    RadialGradient(
                        colors: (isFailed || isAudioUnavailable)
                            ? [AppTheme.Colors.error.opacity(0.094), AppTheme.Colors.error.opacity(0)]
                            : [AppTheme.Colors.accentGreen.opacity(0.094), AppTheme.Colors.accentGreen.opacity(0)],
                        center: .center,
                        startRadius: 0,
                        endRadius: 70
                    )
                )
                .frame(width: 140, height: 140)

            // Waveform bars
            if isFailed || isAudioUnavailable {
                Image(systemName: isFailed ? "exclamationmark.triangle.fill" : "arrow.trianglehead.2.clockwise")
                    .font(.system(size: 42, weight: .bold))
                    .foregroundStyle(AppTheme.Colors.error)
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
                Text(
                    isFailed
                        ? "Narration failed"
                        : isAudioUnavailable
                            ? "Audio unavailable"
                            : isDownloadingToDevice
                                ? "Downloading narration…"
                                : "Generating narration…"
                )
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle((isFailed || isAudioUnavailable) ? AppTheme.Colors.error : AppTheme.Colors.textPrimary)

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

                if isFailed || isAudioUnavailable {
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
            Text(
                isFailed
                    ? job.statusMessage
                    : isAudioUnavailable
                        ? "Delete this narration and create a new one to listen again."
                        : isDownloadingToDevice
                            ? "Saving this narration to your device."
                            : "This may take a moment"
            )
                .font(.system(size: 12))
                .foregroundStyle((isFailed || isAudioUnavailable) ? AppTheme.Colors.error : AppTheme.Colors.textTertiary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 80)
    }

    private static func formatTime(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "0:00" }
        let totalSeconds = max(0, Int(seconds.rounded()))
        let minutes = totalSeconds / 60
        let remainder = totalSeconds % 60
        return "\(minutes):\(String(format: "%02d", remainder))"
    }
}

#Preview("Player Ready") {
    let model = AppModel.previewPlayerReady()
    return PlayerView(
        model: model,
        presentation: PlayerPresentation(jobID: PreviewSamples.readyJob.id)
    )
}

#Preview("Player Processing") {
    let model = AppModel.previewPlayerProcessing()
    return PlayerView(
        model: model,
        presentation: PlayerPresentation(jobID: PreviewSamples.processingJob.id)
    )
}
