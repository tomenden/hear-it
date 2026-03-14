import SwiftUI

struct MiniPlayerView: View {
    @Bindable var model: AppModel

    private var currentJob: AudioJob? {
        guard let jobID = model.player.loadedJobID else { return nil }
        return model.job(with: jobID)
    }

    var body: some View {
        if let job = currentJob {
            Button {
                model.openPlayer(for: job.id)
            } label: {
                HStack(spacing: 12) {
                    coverArt
                    trackInfo(for: job)
                    playPauseButton
                    closeButton
                }
                .padding(.leading, 10)
                .padding(.trailing, 12)
                .padding(.vertical, 10)
                .frame(height: 64)
                .background(
                    RoundedRectangle(cornerRadius: 18)
                        .fill(.white)
                        .overlay {
                            RoundedRectangle(cornerRadius: 18)
                                .stroke(AppTheme.Colors.miniPlayerBorder, lineWidth: 1)
                        }
                        .shadow(color: Color.black.opacity(0.08), radius: 10, y: 6)
                )
                .padding(.horizontal, 14)
            }
            .buttonStyle(.plain)
        }
    }

    private var coverArt: some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(AppTheme.Gradients.artwork)
            .frame(width: 44, height: 44)
            .overlay {
                Image(systemName: "music.note")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }

    private func trackInfo(for job: AudioJob) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(job.article.displayTitle)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AppTheme.Colors.textPrimary)
                .lineLimit(1)

            Text("Tap to return to full player")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(AppTheme.Colors.miniPlayerSubtitle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var playPauseButton: some View {
        Button {
            model.player.togglePlayback()
        } label: {
            Circle()
                .fill(AppTheme.Colors.miniPlayerGreen)
                .frame(width: 36, height: 36)
                .overlay {
                    Image(systemName: model.player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                }
        }
        .buttonStyle(.plain)
    }

    private var closeButton: some View {
        Button {
            model.player.unload()
        } label: {
            Circle()
                .fill(AppTheme.Colors.miniPlayerClose)
                .frame(width: 30, height: 30)
                .overlay {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(AppTheme.Colors.miniPlayerCloseIcon)
                }
        }
        .buttonStyle(.plain)
    }
}
