import SwiftUI

enum AppTheme {
    enum Colors {
        static let page = Color(hex: "#F5F4F1")
        static let card = Color.white
        static let elevated = Color(hex: "#FAFAF8")
        static let muted = Color(hex: "#EDECEA")
        static let border = Color(hex: "#E5E4E1")
        static let borderStrong = Color(hex: "#D1D0CD")
        static let accentGreen = Color(hex: "#3D8A5A")
        static let accentGreenDark = Color(hex: "#4D9B6A")
        static let accentGreenLight = Color(hex: "#C8F0D8")
        static let accentCoral = Color(hex: "#D89575")
        static let accentWarm = Color(hex: "#D4A64A")
        static let textPrimary = Color(hex: "#1A1918")
        static let textSecondary = Color(hex: "#6D6C6A")
        static let textTertiary = Color(hex: "#9C9B99")
        static let textInactive = Color(hex: "#A8A7A5")
        static let accentRed = Color(hex: "#D08068")
        static let accentRedLight = accentRed.opacity(0.08)
        static let error = accentRed

        // Mini player specific
        static let miniPlayerGreen = Color(hex: "#3F8F5E")
        static let miniPlayerBorder = Color(hex: "#E8E8E8")
        static let miniPlayerClose = Color(hex: "#F3F3F3")
        static let miniPlayerCloseIcon = Color(hex: "#8A8A8A")
        static let miniPlayerSubtitle = Color(hex: "#8C8C8C")

        // Feature list backgrounds
        static let featureCoralBg = Color(hex: "#F5E6DC")
        static let featureWarmBg = Color(hex: "#FFF3E0")
        static let libraryCoralBg = Color(hex: "#FDE8DC")
        static let libraryWarmBg = Color(hex: "#FFF3DF")
    }

    /// Shared card background modifier
    static func cardBackground(cornerRadius: CGFloat = Layout.cornerRadius) -> some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(Colors.card)
            .shadow(color: .black.opacity(0.06), radius: 18, y: 8)
    }

    /// Map an inline message kind to its display color
    static func color(for kind: AppModel.InlineMessage.Kind) -> Color {
        switch kind {
        case .neutral: Colors.textSecondary
        case .success: Colors.accentGreen
        case .error: Colors.error
        }
    }

    enum Gradients {
        static let page = LinearGradient(
            colors: [
                Color(hex: "#FBF7F1"),
                Color(hex: "#F5F4F1")
            ],
            startPoint: .top,
            endPoint: .bottom
        )

        static let artwork = LinearGradient(
            colors: [
                Color(hex: "#E8C4A8"),
                Color(hex: "#D89575"),
                Color(hex: "#C47A5A")
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    enum Layout {
        static let screenPadding: CGFloat = 24
        static let sectionSpacing: CGFloat = 24
        static let cardSpacing: CGFloat = 16
        static let controlHeight: CGFloat = 52
        static let cornerRadius: CGFloat = 20
        static let chipRadius: CGFloat = 16
        static let pillRadius: CGFloat = 100
    }
}
