import SwiftUI

struct RootView: View {
    @Bindable var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    private var shouldShowMiniPlayer: Bool {
        model.player.loadedJobID != nil && model.playerPresentation == nil
    }

    var body: some View {
        ZStack {
            switch model.selectedTab {
            case .home:
                NavigationStack {
                    HomeView(model: model)
                }
            case .library:
                NavigationStack {
                    LibraryView(model: model)
                }
            }
        }
        .overlay(alignment: .top) {
            Group {
                if shouldShowMiniPlayer {
                    MiniPlayerView(model: model)
                        .transition(AnyTransition.move(edge: .top).combined(with: AnyTransition.opacity))
                        .padding(EdgeInsets(top: 8, leading: 0, bottom: 0, trailing: 0))
                }
            }
            .animation(.spring(duration: 0.3), value: shouldShowMiniPlayer)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            AppTabBar(selectedTab: $model.selectedTab)
        }
        .sheet(isPresented: $model.voiceSelectionPresented) {
            VoiceSelectionView(model: model)
        }
        .sheet(isPresented: $model.settingsPresented) {
            SettingsView(model: model)
        }
        .fullScreenCover(item: $model.playerPresentation) { presentation in
            PlayerView(model: model, presentation: presentation)
        }
        .task {
            await model.bootstrap()
        }
        .onChange(of: scenePhase, initial: true) { _, newPhase in
            model.handleScenePhaseChange(newPhase)
        }
        .onOpenURL { url in
            model.handleIncomingURL(url)
        }
    }
}

#Preview("Root") {
    RootView(model: AppModel.previewRoot())
}

private struct AppTabBar: View {
    @Binding var selectedTab: RootTab

    var body: some View {
        HStack(spacing: 0) {
            tabButton(title: "HOME", systemImage: "house.fill", tab: .home)
            tabButton(title: "LIBRARY", systemImage: "books.vertical.fill", tab: .library)
        }
        .padding(4)
        .frame(maxWidth: .infinity)
        .frame(height: 62)
        .background(
            RoundedRectangle(cornerRadius: 36)
                .fill(AppTheme.Colors.card)
                .overlay {
                    RoundedRectangle(cornerRadius: 36)
                        .stroke(AppTheme.Colors.border, lineWidth: 1)
                }
                .shadow(color: .black.opacity(0.06), radius: 12, y: 2)
        )
        .padding(.horizontal, 21)
        .padding(.top, 12)
        .padding(.bottom, 21)
    }

    private func tabButton(title: String, systemImage: String, tab: RootTab) -> some View {
        let isSelected = selectedTab == tab

        return Button {
            selectedTab = tab
        } label: {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.system(size: 18, weight: .semibold))

                Text(title)
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(0.5)
            }
            .foregroundStyle(isSelected ? Color.white : AppTheme.Colors.textInactive)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                RoundedRectangle(cornerRadius: 26)
                    .fill(isSelected ? AppTheme.Colors.accentGreen : Color.clear)
            }
        }
        .buttonStyle(.plain)
    }
}
