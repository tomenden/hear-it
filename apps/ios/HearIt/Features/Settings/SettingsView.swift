import SwiftUI

struct SettingsView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var draftBaseURL = ""

    var body: some View {
        ZStack {
            AppTheme.Gradients.page
                .ignoresSafeArea()

            VStack(spacing: 20) {
                header

                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        apiSection
                        testingSection
                        accountSection
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
            }
        }
        .task {
            draftBaseURL = model.settings.apiBaseURLString
        }
    }

    private var header: some View {
        HStack {
            pillHeaderButton(title: "Cancel") {
                dismiss()
            }

            Spacer()

            Text("Settings")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AppTheme.Colors.textPrimary)

            Spacer()

            pillHeaderButton(title: "Save") {
                Task {
                    await model.saveBaseURL(draftBaseURL)
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 8)
    }

    private var apiSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Hear It API")

            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Base URL")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(AppTheme.Colors.textPrimary)

                    ZStack(alignment: .leading) {
                        if draftBaseURL.isEmpty {
                            Text("http://192.168.1.12:3000")
                                .font(.system(size: 14))
                                .foregroundStyle(AppTheme.Colors.textTertiary)
                                .padding(.horizontal, 16)
                                .allowsHitTesting(false)
                        }

                        TextField("", text: $draftBaseURL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .foregroundStyle(AppTheme.Colors.textPrimary)
                            .tint(AppTheme.Colors.accentGreen)
                            .padding(.horizontal, 16)
                    }
                    .frame(height: AppTheme.Layout.controlHeight)
                    .background(
                        RoundedRectangle(cornerRadius: 14)
                            .fill(AppTheme.Colors.elevated)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(AppTheme.Colors.border, lineWidth: 1)
                    }
                }

                if let config = model.serverConfig {
                    Divider()
                        .overlay(AppTheme.Colors.border)

                    HStack(spacing: 16) {
                        infoRow(title: "Provider", value: config.provider.capitalized)
                        infoRow(title: "Mode", value: config.modeLabel)
                    }
                }
            }
            .padding(20)
            .background(cardBackground)
        }
    }

    private var testingSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Device testing")

            VStack(alignment: .leading, spacing: 14) {
                Text("When you run Hear It on your iPhone, point this URL at the Hear It API running on your Mac using the Mac’s LAN IP address or `.local` hostname.")
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.Colors.textSecondary)
                    .lineSpacing(4)

                Divider()
                    .overlay(AppTheme.Colors.border)

                Text("Example: http://192.168.1.12:3000")
                    .font(.system(size: 13, weight: .medium, design: .monospaced))
                    .foregroundStyle(AppTheme.Colors.textSecondary)
            }
            .padding(20)
            .background(cardBackground)
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Account")

            VStack(alignment: .leading, spacing: 14) {
                if let email = model.authManager.userEmail {
                    HStack(spacing: 12) {
                        Image(systemName: "person.circle.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(AppTheme.Colors.accentGreen)

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Signed in as")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(AppTheme.Colors.textTertiary)
                                .textCase(.uppercase)
                            Text(email)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(AppTheme.Colors.textPrimary)
                        }
                    }

                    Divider()
                        .overlay(AppTheme.Colors.border)
                }

                Button {
                    Task { await model.signOut() }
                } label: {
                    HStack {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .font(.system(size: 15, weight: .medium))
                        Text("Sign Out")
                            .font(.system(size: 16, weight: .medium))
                    }
                    .foregroundStyle(AppTheme.Colors.accentRed)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
            }
            .padding(20)
            .background(cardBackground)
        }
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(AppTheme.Colors.textTertiary)
    }

    private func infoRow(title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(AppTheme.Colors.textTertiary)
                .textCase(.uppercase)

            Text(value)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.Colors.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pillHeaderButton(title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(AppTheme.Colors.textPrimary)
                .padding(.horizontal, 18)
                .frame(height: 40)
                .background(
                    Capsule()
                        .fill(AppTheme.Colors.card)
                        .shadow(color: .black.opacity(0.04), radius: 8, y: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 22)
            .fill(AppTheme.Colors.card)
            .shadow(color: .black.opacity(0.05), radius: 12, y: 2)
    }
}

#Preview("Settings") {
    SettingsView(model: AppModel.previewSettings())
}
