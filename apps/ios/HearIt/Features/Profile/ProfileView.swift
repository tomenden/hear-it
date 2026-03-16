import SwiftUI

struct ProfileView: View {
    @Bindable var model: AppModel
    @State private var isSigningOut = false

    private var auth: AuthManager { model.authManager }

    var body: some View {
        ZStack {
            AppTheme.Gradients.page
                .ignoresSafeArea()

            VStack {
                Spacer()

                VStack(spacing: 32) {
                    avatarView
                    userInfoView
                    logoutButton
                }
                .padding(.horizontal, 24)

                Spacer()
            }
            .padding(.bottom, 24)
        }
    }

    // MARK: - Avatar

    private var avatarView: some View {
        Group {
            if let avatarURL = auth.userAvatarURL {
                AsyncImage(url: avatarURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFill()
                            .frame(width: 120, height: 120)
                            .clipShape(Circle())
                    default:
                        gradientAvatar
                    }
                }
            } else {
                gradientAvatar
            }
        }
    }

    private var gradientAvatar: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            AppTheme.Colors.accentGreenDark,
                            AppTheme.Colors.accentGreen
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .frame(width: 120, height: 120)

            Image(systemName: "person.fill")
                .font(.system(size: 48))
                .foregroundStyle(.white)
        }
    }

    // MARK: - User Info

    private var userInfoView: some View {
        VStack(spacing: 8) {
            if let name = auth.userName {
                Text(name)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(AppTheme.Colors.textPrimary)
                    .multilineTextAlignment(.center)
            }

            if let email = auth.userEmail {
                Text(email)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.Colors.textSecondary)
                    .multilineTextAlignment(.center)
            }
        }
    }

    // MARK: - Logout

    private var logoutButton: some View {
        Button {
            isSigningOut = true
            Task {
                await model.signOut()
                isSigningOut = false
            }
        } label: {
            HStack(spacing: 10) {
                if isSigningOut {
                    ProgressView()
                        .tint(AppTheme.Colors.accentRed)
                } else {
                    Image(systemName: "arrow.right.square")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(AppTheme.Colors.accentRed)

                    Text("Log Out")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(AppTheme.Colors.accentRed)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 52)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(AppTheme.Colors.card)
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(AppTheme.Colors.border, lineWidth: 1)
                    }
                    .shadow(color: Color(hex: "#1A1918").opacity(0.03), radius: 8, y: 2)
            )
        }
        .buttonStyle(.plain)
        .disabled(isSigningOut)
    }
}

#Preview("Profile") {
    ProfileView(model: AppModel.previewProfile())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: 80)
        }
}
