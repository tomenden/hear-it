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
        playback: .preparing(),
        progress: AudioJob.Progress(
            chunksTotal: 14,
            chunksReady: 1,
            availableDurationSeconds: 12
        ),
        createdAtOffset: -1_400,
        updatedAtOffset: -20
    )

    static let readyJob = makeJob(
        id: "job-preview-ready",
        title: "The Case for an Audio Inbox",
        siteName: "Tomorrow Product",
        byline: "Ava Thompson",
        excerpt: "Treating audio like a saved queue unlocks a calmer reading habit across the whole day.",
        wordCount: 1_580,
        estimatedMinutes: 10,
        status: .completed,
        voice: "sage",
        playback: .ready(
            audioUrl: "http://127.0.0.1:3000/audio/job-preview-ready/final.mp3",
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
        readyJob,
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
            audioSegments: [],
            durationSeconds: playback.durationSeconds ?? progress.availableDurationSeconds,
            error: playback.errorMessage,
            createdAt: .now.addingTimeInterval(createdAtOffset),
            updatedAt: .now.addingTimeInterval(updatedAtOffset),
            playback: playback,
            progress: progress
        )
    }
}
