import SwiftUI

struct LibraryView: View {
    @Bindable var model: AppModel

    var body: some View {
        ZStack {
            AppTheme.Gradients.page
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: AppTheme.Layout.sectionSpacing) {
                    header
                    filterPicker
                    statsRow
                    narrationList
                }
                .padding(AppTheme.Layout.screenPadding)
            }
            .refreshable {
                await model.refreshJobs()
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "slider.horizontal.3") {
                    model.openSettings()
                }
            }
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                Text("My Library")
                    .font(.system(.largeTitle, design: .rounded))
                    .bold()
                    .foregroundStyle(AppTheme.Colors.textPrimary)

                Text("Recent narrations")
                    .font(.subheadline)
                    .foregroundStyle(AppTheme.Colors.textSecondary)
            }

            Spacer()

            Button("Refresh", systemImage: "arrow.clockwise") {
                Task {
                    await model.refreshJobs()
                }
            }
            .buttonStyle(.bordered)
            .tint(AppTheme.Colors.textPrimary)
            .disabled(model.isRefreshingLibrary)
        }
    }

    private var filterPicker: some View {
        Picker("Filter", selection: $model.libraryFilter) {
            ForEach(LibraryFilter.allCases) { filter in
                Text(filter.rawValue).tag(filter)
            }
        }
        .pickerStyle(.segmented)
    }

    private var statsRow: some View {
        HStack(spacing: 12) {
            LibraryStatCard(title: "All Jobs", value: "\(model.jobs.count)")
            LibraryStatCard(title: "Ready", value: "\(model.completedJobCount)")
            LibraryStatCard(title: "Minutes", value: "\(model.totalMinutes)")
        }
    }

    private static let thumbnailThemes: [(bg: Color, fg: Color, icon: String)] = [
        (AppTheme.Colors.accentGreenLight, AppTheme.Colors.accentGreen, "headphones"),
        (AppTheme.Colors.libraryCoralBg, AppTheme.Colors.accentCoral, "book.fill"),
        (AppTheme.Colors.libraryWarmBg, AppTheme.Colors.accentWarm, "bolt.fill"),
    ]

    @ViewBuilder
    private var narrationList: some View {
        if model.filteredJobs.isEmpty {
            ContentUnavailableView(
                "No narrations here yet",
                systemImage: "books.vertical",
                description: Text("Create a narration from Home and it will show up in your library.")
            )
            .frame(maxWidth: .infinity)
            .padding(.top, 24)
        } else {
            VStack(spacing: 12) {
                ForEach(Array(model.filteredJobs.enumerated()), id: \.element.id) { index, job in
                    let theme = Self.thumbnailThemes[index % Self.thumbnailThemes.count]

                    HStack(spacing: 14) {
                        // Thumbnail
                        RoundedRectangle(cornerRadius: 12)
                            .fill(theme.bg)
                            .frame(width: 56, height: 56)
                            .overlay(
                                Image(systemName: theme.icon)
                                    .font(.system(size: 22, weight: .semibold))
                                    .foregroundStyle(theme.fg)
                            )

                        // Info
                        VStack(alignment: .leading, spacing: 4) {
                            Text(job.article.displayTitle)
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(AppTheme.Colors.textPrimary)
                                .lineLimit(2)

                            Text([job.article.siteName, "\(job.article.estimatedMinutes) min", job.speechOptions.voice.capitalized]
                                .compactMap { $0 }
                                .joined(separator: " · "))
                            .font(.system(size: 12))
                            .foregroundStyle(AppTheme.Colors.textTertiary)

                            Text(job.createdAt.formatted(.relative(presentation: .named)))
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(AppTheme.Colors.textInactive)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        // Play button
                        Button {
                            model.openPlayer(for: job.id)
                        } label: {
                            Circle()
                                .fill(AppTheme.Colors.accentGreen)
                                .frame(width: 40, height: 40)
                                .overlay(
                                    Image(systemName: "play.fill")
                                        .font(.system(size: 18))
                                        .foregroundStyle(.white)
                                        .offset(x: 1)
                                )
                        }
                    }
                    .padding(16)
                    .background(cardBackground)
                }
            }
        }
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: AppTheme.Layout.cornerRadius)
            .fill(AppTheme.Colors.card)
            .shadow(color: .black.opacity(0.06), radius: 18, y: 8)
    }

}

private struct LibraryStatCard: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppTheme.Colors.textTertiary)
                .textCase(.uppercase)

            Text(value)
                .font(.title3)
                .bold()
                .foregroundStyle(AppTheme.Colors.textPrimary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(AppTheme.Colors.card)
                .shadow(color: .black.opacity(0.05), radius: 14, y: 6)
        )
    }
}

#Preview("Library") {
    NavigationStack {
        LibraryView(model: AppModel.previewLibrary())
    }
}
