import AVFoundation
import SwiftUI

struct VoiceSelectionView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var previewPlayer: AVPlayer?
    @State private var playingVoiceID: String?
    @State private var endObserver: NSObjectProtocol?

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.Gradients.page
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: AppTheme.Layout.sectionSpacing) {
                        articlePreview
                        voiceList

                        Button {
                            Task {
                                await model.createNarration()
                            }
                        } label: {
                            Label(model.isCreatingNarration ? "Creating…" : "Create Narration", systemImage: "headphones")
                                .font(.headline)
                                .frame(maxWidth: .infinity, minHeight: 54)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(AppTheme.Colors.accentGreen)
                        .disabled(model.isCreatingNarration)
                    }
                    .padding(AppTheme.Layout.screenPadding)
                }
            }
            .navigationTitle("Choose a Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") {
                        dismiss()
                    }
                }
            }
        }
    }

    private var articlePreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Article to narrate")
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.Colors.textTertiary)
                .textCase(.uppercase)

            Text(model.previewArticle?.displayTitle ?? "Paste a URL on Home to preview it here.")
                .font(.headline)
                .foregroundStyle(AppTheme.Colors.textPrimary)

            Text(model.previewArticle?.sourceLine ?? "No article preview loaded yet.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.Colors.textSecondary)

            Text(model.previewArticle?.summary ?? "Hear It can preview extraction quality before you create narration.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.Colors.textSecondary)

            HStack {
                Button {
                    Task {
                        await model.reviewArticle()
                    }
                } label: {
                    Label(model.isRefreshingPreview ? "Reviewing…" : "Review Article", systemImage: "doc.text.magnifyingglass")
                }
                .buttonStyle(.bordered)
                .tint(AppTheme.Colors.textPrimary)
                .disabled(model.isRefreshingPreview)

                if let message = model.previewMessage {
                    Text(message.text)
                        .font(.caption)
                        .foregroundStyle(messageColor(message.kind))
                }
            }
        }
        .padding(22)
        .background(cardBackground)
    }

    private var voiceList: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Select a voice")
                .font(.title3)
                .bold()
                .foregroundStyle(AppTheme.Colors.textPrimary)

            ForEach(model.availableVoices.isEmpty ? [model.selectedVoice] : model.availableVoices) { voice in
                let isSelected = model.selectedVoice.id == voice.id
                let isPlaying = playingVoiceID == voice.id

                HStack(spacing: 12) {
                    Button {
                        model.chooseVoice(voice)
                        stopPreview()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(voice.displayName)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(isSelected ? AppTheme.Colors.accentGreen : AppTheme.Colors.textPrimary)

                            Text(voice.tone)
                                .font(.system(size: 13))
                                .lineSpacing(13 * 0.4)
                                .foregroundStyle(AppTheme.Colors.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if isSelected {
                        ZStack {
                            Circle()
                                .fill(AppTheme.Colors.accentGreen)
                                .frame(width: 28, height: 28)
                            Image(systemName: "checkmark")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                        }
                    } else {
                        Button {
                            togglePreview(for: voice)
                        } label: {
                            ZStack {
                                Circle()
                                    .fill(isPlaying ? AppTheme.Colors.accentGreen.opacity(0.2) : AppTheme.Colors.muted)
                                    .frame(width: 28, height: 28)
                                Image(systemName: isPlaying ? "stop.fill" : "play.fill")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundStyle(isPlaying ? AppTheme.Colors.accentGreen : AppTheme.Colors.textSecondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 14)
                .padding(.horizontal, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(voiceBackground(isSelected: isSelected))
            }
        }
        .onDisappear {
            stopPreview()
        }
    }

    private func togglePreview(for voice: some Identifiable<String>) {
        if playingVoiceID == voice.id {
            stopPreview()
            return
        }

        stopPreview()

        let resourceName = "voice-preview--\(voice.id)"
        guard let url = Bundle.main.url(forResource: resourceName, withExtension: "mp3", subdirectory: "VoicePreviews") else {
            return
        }

        let player = AVPlayer(url: url)
        previewPlayer = player
        playingVoiceID = voice.id

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { [weak player] _ in
            guard player != nil else { return }
            Task { @MainActor in
                stopPreview()
            }
        }

        player.play()
    }

    private func stopPreview() {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = nil
        previewPlayer?.pause()
        previewPlayer = nil
        playingVoiceID = nil
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: AppTheme.Layout.cornerRadius)
            .fill(AppTheme.Colors.card)
            .shadow(color: .black.opacity(0.06), radius: 18, y: 8)
    }

    private func voiceBackground(isSelected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(AppTheme.Colors.card)
            .overlay {
                RoundedRectangle(cornerRadius: 16)
                    .stroke(isSelected ? AppTheme.Colors.accentGreen : Color.clear, lineWidth: 2)
            }
            .shadow(color: .black.opacity(0.04), radius: 12, y: 6)
    }

    private func messageColor(_ kind: AppModel.InlineMessage.Kind) -> Color {
        AppTheme.color(for: kind)
    }
}

#Preview("Voice Selection") {
    VoiceSelectionView(model: AppModel.previewVoiceSelection())
}
