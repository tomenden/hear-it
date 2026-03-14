import SwiftUI

struct HomeView: View {
    @Bindable var model: AppModel

    var body: some View {
        ZStack {
            AppTheme.Gradients.page
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.Layout.sectionSpacing) {
                    header
                    inputCard
                    narrationButton
                    featureList
                }
                .padding(.horizontal, AppTheme.Layout.screenPadding)
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Text("Hear It")
                    .font(.system(size: 32, weight: .bold))
                    .tracking(-1)
                    .foregroundStyle(AppTheme.Colors.textPrimary)

                Spacer()

                Button {
                    model.openSettings()
                } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(AppTheme.Colors.accentGreen)
                        .frame(width: 40, height: 40)
                        .background(
                            Circle()
                                .fill(AppTheme.Colors.card)
                                .shadow(color: .black.opacity(0.05), radius: 8, y: 2)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open settings")
            }

            Text("Turn any article into audio")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.Colors.textSecondary)

            Text("Paste a link below and let AI narrate it for you — hands-free reading, anywhere.")
                .font(.system(size: 14))
                .foregroundStyle(AppTheme.Colors.textTertiary)
                .lineSpacing(4)
        }
    }

    private var inputCard: some View {
        VStack(alignment: .leading, spacing: AppTheme.Layout.cardSpacing) {
            HStack(spacing: 8) {
                Image(systemName: "link")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.Colors.accentGreen)

                Text("Article URL")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.Colors.textPrimary)
            }

            ZStack(alignment: .leading) {
                if model.urlInput.isEmpty {
                    Text("Paste an article link here…")
                        .font(.system(size: 14))
                        .foregroundStyle(AppTheme.Colors.textTertiary)
                        .padding(.horizontal, 16)
                        .allowsHitTesting(false)
                }

                TextField("", text: $model.urlInput)
                    .font(.system(size: 14))
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.plain)
                    .foregroundStyle(AppTheme.Colors.textPrimary)
                    .tint(AppTheme.Colors.accentGreen)
                    .padding(.horizontal, 16)
            }
            .frame(minHeight: AppTheme.Layout.controlHeight)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(AppTheme.Colors.page)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(AppTheme.Colors.border, lineWidth: 1)
            }

            HStack(spacing: 12) {
                miniPillButton(title: "Paste from clipboard", systemImage: "doc.on.clipboard") {
                    model.updatePastedURL(UIPasteboard.general.string ?? "")
                }

                miniPillButton(title: model.selectedVoice.displayName, systemImage: "waveform") {
                    model.openVoiceSelection()
                }
            }
        }
        .padding(24)
        .background(cardBackground)
    }

    private var narrationButton: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                Task {
                    await model.createNarration()
                }
            } label: {
                Label(model.isCreatingNarration ? "Creating…" : "Start Narrating", systemImage: "play.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, minHeight: 56)
            }
            .buttonStyle(.plain)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(AppTheme.Colors.accentGreen)
                    .shadow(color: AppTheme.Colors.accentGreen.opacity(0.12), radius: 8, y: 2)
            )
            .disabled(model.isCreatingNarration)

            if let message = model.homeMessage {
                Text(message.text)
                    .font(.system(size: 14))
                    .foregroundStyle(messageColor(message.kind))
                    .padding(.horizontal, 2)
            }
        }
    }

    private var featureList: some View {
        VStack(alignment: .leading, spacing: 14) {
            FeatureHighlightRow(
                title: "Natural AI Voices",
                subtitle: "Powered by OpenAI — sounds like a real narrator.",
                color: AppTheme.Colors.accentGreenLight,
                icon: "waveform.badge.mic"
            )

            FeatureHighlightRow(
                title: "Listen Anywhere",
                subtitle: "Save articles to your library for offline listening.",
                color: AppTheme.Colors.featureCoralBg,
                icon: "headphones"
            )

            FeatureHighlightRow(
                title: "Instant Conversion",
                subtitle: "Paste a URL and get audio in under 30 seconds.",
                color: AppTheme.Colors.featureWarmBg,
                icon: "bolt.fill"
            )
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 16)
            .fill(AppTheme.Colors.card)
            .shadow(color: .black.opacity(0.05), radius: 12, y: 2)
    }

    private func miniPillButton(title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(AppTheme.Colors.textSecondary)
                .frame(maxWidth: .infinity)
                .frame(height: 36)
                .background(
                    Capsule()
                        .fill(AppTheme.Colors.muted)
                )
        }
        .buttonStyle(.plain)
    }

    private func messageColor(_ kind: AppModel.InlineMessage.Kind) -> Color {
        AppTheme.color(for: kind)
    }
}

#Preview("Home") {
    NavigationStack {
        HomeView(model: AppModel.previewHome())
    }
}

private struct FeatureHighlightRow: View {
    let title: String
    let subtitle: String
    let color: Color
    let icon: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(AppTheme.Colors.textPrimary)
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(color)
                )
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.Colors.textPrimary)

                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(AppTheme.Colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
