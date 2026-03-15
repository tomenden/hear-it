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
        .sheet(item: $model.jobPendingDeletion) { job in
            DeleteConfirmationSheet(job: job) {
                Task { await model.confirmDeleteJob() }
            } onCancel: {
                model.jobPendingDeletion = nil
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
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

                        // Delete button
                        Button {
                            model.jobPendingDeletion = job
                        } label: {
                            Circle()
                                .fill(AppTheme.Colors.accentRedLight)
                                .frame(width: 36, height: 36)
                                .overlay(
                                    Image(systemName: "trash")
                                        .font(.system(size: 14))
                                        .foregroundStyle(AppTheme.Colors.accentRed)
                                )
                        }

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

private struct DeleteConfirmationSheet: View {
    let job: AudioJob
    let onDelete: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            // Trash icon
            Circle()
                .fill(AppTheme.Colors.accentRedLight)
                .frame(width: 56, height: 56)
                .overlay(
                    Image(systemName: "trash")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(AppTheme.Colors.accentRed)
                )

            Text("Delete Narration?")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(AppTheme.Colors.textPrimary)

            Text("This narration will be permanently removed from your library. This action cannot be undone.")
                .font(.system(size: 14))
                .foregroundStyle(AppTheme.Colors.textSecondary)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)

            // Context card showing which narration
            HStack(spacing: 12) {
                Image(systemName: "waveform")
                    .font(.system(size: 18))
                    .foregroundStyle(AppTheme.Colors.textTertiary)

                VStack(alignment: .leading, spacing: 2) {
                    Text(job.article.displayTitle)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(AppTheme.Colors.textPrimary)
                        .lineLimit(1)

                    Text("\(job.article.estimatedMinutes) min · Added \(job.createdAt.formatted(.dateTime.month(.abbreviated).day()))")
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.Colors.textTertiary)
                }

                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 12)
                    .fill(AppTheme.Colors.page)
            )

            Divider()

            // Buttons
            VStack(spacing: 10) {
                Button(action: onDelete) {
                    HStack(spacing: 8) {
                        Image(systemName: "trash")
                            .font(.system(size: 14))
                        Text("Delete Narration")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(AppTheme.Colors.accentRed, in: RoundedRectangle(cornerRadius: 14))
                }

                Button(action: onCancel) {
                    Text("Cancel")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(AppTheme.Colors.textPrimary)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(AppTheme.Colors.page, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 32)
        .padding(.bottom, 28)
    }
}

#Preview("Library") {
    NavigationStack {
        LibraryView(model: AppModel.previewLibrary())
    }
}
