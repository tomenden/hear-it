import Foundation

enum PlaybackStateSamples {
    static let preparingJob = makeJob(
        id: "job-preview-preparing",
        title: "How Readers Settle Into Audio Before the First Paragraph Lands",
        siteName: "Signal Weekly",
        byline: "Nina Park",
        excerpt: "A calm startup matters because listeners notice the first ten seconds more than almost anything else.",
        wordCount: 1_120,
        estimatedMinutes: 7,
        status: .processing,
        voice: "alloy",
        playback: .preparing(
            availableDurationSeconds: 12,
            liveEdgeUpdatedAt: isoTimestamp(offset: -20)
        ),
        progress: AudioJob.Progress(
            chunksTotal: 14,
            chunksReady: 1,
            availableDurationSeconds: 12
        ),
        createdAtOffset: -1_400,
        updatedAtOffset: -20
    )

    static let streamingJob = makeJob(
        id: "job-preview-streaming",
        title: "The Quiet UI Pattern Showing Up in Modern Reader Apps",
        siteName: "Interface Notes",
        byline: "Jonas Reed",
        excerpt: "Calm visual systems give audio experiences room to feel more premium, not less expressive.",
        wordCount: 1_340,
        estimatedMinutes: 8,
        status: .processing,
        voice: "sage",
        playback: .streaming(
            playlistUrl: "http://127.0.0.1:3000/audio/job-preview-streaming/playlist.m3u8",
            availableDurationSeconds: 136,
            liveEdgeUpdatedAt: isoTimestamp(offset: -8)
        ),
        progress: AudioJob.Progress(
            chunksTotal: 18,
            chunksReady: 5,
            availableDurationSeconds: 136
        ),
        createdAtOffset: -3_600,
        updatedAtOffset: -8
    )

    static let finalJob = makeJob(
        id: "job-preview-final",
        title: "The Case for an Audio Inbox",
        siteName: "Tomorrow Product",
        byline: "Ava Thompson",
        excerpt: "Treating audio like a saved queue unlocks a calmer reading habit across the whole day.",
        wordCount: 1_580,
        estimatedMinutes: 10,
        status: .completed,
        voice: "sage",
        playback: .final(
            audioUrl: "http://127.0.0.1:3000/audio/job-preview-final/final.mp3",
            durationSeconds: 603,
            fileName: "the-case-for-an-audio-inbox.mp3"
        ),
        progress: AudioJob.Progress(
            chunksTotal: 18,
            chunksReady: 18,
            availableDurationSeconds: 603
        ),
        createdAtOffset: -7_200,
        updatedAtOffset: -6_900
    )

    static let failedJob = makeJob(
        id: "job-preview-failed",
        title: "Why Small Commutes Are the Best Use Case for Spoken Articles",
        siteName: "City Reads",
        byline: "Leo Bennett",
        excerpt: "Short listening windows create strong repeat behavior when the handoff back into the app is gentle.",
        wordCount: 890,
        estimatedMinutes: 5,
        status: .failed,
        voice: "ash",
        playback: .failed(errorMessage: "The speech provider timed out before the opening audio buffer was ready."),
        progress: AudioJob.Progress(
            chunksTotal: 11,
            chunksReady: 0,
            availableDurationSeconds: 0
        ),
        createdAtOffset: -15_800,
        updatedAtOffset: -15_200
    )

    static let libraryJobs = [
        finalJob,
        streamingJob,
        preparingJob,
        failedJob,
    ]

    private static func makeJob(
        id: String,
        title: String,
        siteName: String,
        byline: String,
        excerpt: String,
        wordCount: Int,
        estimatedMinutes: Int,
        status: AudioJob.Status,
        voice: String,
        playback: AudioPlayback,
        progress: AudioJob.Progress,
        createdAtOffset: TimeInterval,
        updatedAtOffset: TimeInterval
    ) -> AudioJob {
        let article = Article(
            url: "https://example.com/articles/\(id)",
            title: title,
            byline: byline,
            siteName: siteName,
            excerpt: excerpt,
            textContent: excerpt + " " + String(repeating: "Hear It preview content. ", count: 14),
            wordCount: wordCount,
            estimatedMinutes: estimatedMinutes
        )

        return AudioJob(
            id: id,
            status: status,
            article: article,
            speechOptions: AudioJob.SpeechOptions(voice: voice),
            provider: "openai",
            audioUrl: playback.audioUrl,
            audioDownloadPath: nil,
            playlistUrl: playback.playlistUrl,
            audioSegments: [],
            durationSeconds: playback.durationSeconds ?? progress.availableDurationSeconds,
            error: playback.errorMessage,
            createdAt: .now.addingTimeInterval(createdAtOffset),
            updatedAt: .now.addingTimeInterval(updatedAtOffset),
            liveEdgeUpdatedAt: playback.liveEdgeUpdatedAt,
            playback: playback,
            progress: progress
        )
    }

    private static func isoTimestamp(offset: TimeInterval) -> String {
        ISO8601DateFormatter().string(from: .now.addingTimeInterval(offset))
    }
}
