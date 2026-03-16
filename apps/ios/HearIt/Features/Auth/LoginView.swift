import SwiftUI

struct LoginView: View {
    let authManager: AuthManager

    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            AppTheme.Gradients.page
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Branding
                VStack(spacing: 16) {
                    Image(systemName: "headphones.circle.fill")
                        .font(.system(size: 72))
                        .foregroundStyle(AppTheme.Colors.accentGreen)

                    Text("Hear It")
                        .font(.system(size: 36, weight: .bold))
                        .foregroundStyle(AppTheme.Colors.textPrimary)

                    Text("Turn any article into audio")
                        .font(.system(size: 17))
                        .foregroundStyle(AppTheme.Colors.textSecondary)
                }

                Spacer()

                // Sign-in buttons
                VStack(spacing: 14) {
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.system(size: 14))
                            .foregroundStyle(AppTheme.Colors.error)
                            .multilineTextAlignment(.center)
                            .padding(.bottom, 8)
                    }

                    googleSignInButton
                }
                .padding(.horizontal, AppTheme.Layout.screenPadding)
                .padding(.bottom, 48)
                .disabled(isLoading)
            }
        }
    }

    private var googleSignInButton: some View {
        Button {
            Task { await signInWithGoogle() }
        } label: {
            HStack(spacing: 10) {
                Text("G")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(AppTheme.Colors.textPrimary)
                Text("Sign in with Google")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AppTheme.Colors.textPrimary)
            }
            .frame(maxWidth: .infinity)
            .frame(height: AppTheme.Layout.controlHeight)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(AppTheme.Colors.card)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 14)
                    .stroke(AppTheme.Colors.border, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
    }

    private func signInWithGoogle() async {
        isLoading = true
        errorMessage = nil
        do {
            try await authManager.signInWithGoogle()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
