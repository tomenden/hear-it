import Foundation

enum PreviewSamples {
    static let serverConfig = ServerConfig(
        provider: "openai",
        audioPublicBaseURL: nil,
        openAIConfigured: true
    )

    static let voices: [VoiceChoice] = [
        VoiceChoice(id: "alloy"),
        VoiceChoice(id: "sage"),
        VoiceChoice(id: "ash"),
        VoiceChoice(id: "verse")
    ]

    static let previewArticle = Article(
        url: "https://hearit.app/articles/designing-for-ears",
        title: "Designing for Ears: Why Audio-First Reading Feels Different",
        byline: "Maya Collins",
        siteName: "Hear It Journal",
        excerpt: "Audio-first products change how people pace, remember, and return to long-form stories.",
        textContent: """
        Audio-first products create a different relationship with long-form information. Instead of asking for a fixed block of visual attention, they fit around walks, commutes, and chores. That shift changes what matters in the experience: pacing, confidence, and returning to the right moment without friction.
        """,
        wordCount: 948,
        estimatedMinutes: 6
    )

    static let queuedJob = makeJob(
        id: "job-preview-queued",
        title: "What Product Teams Get Wrong About Background Listening",
        siteName: "Signal Weekly",
        byline: "Nina Park",
        excerpt: "Designing for passive listening means respecting interruptions instead of pretending they do not happen.",
        wordCount: 1120,
        estimatedMinutes: 7,
        status: .queued,
        voice: "alloy",
        createdAtOffset: -1_400,
        updatedAtOffset: -1_200
    )

    static let processingJob = makeJob(
        id: "job-preview-processing",
        title: "The Quiet UI Pattern Showing Up in Modern Reader Apps",
        siteName: "Interface Notes",
        byline: "Jonas Reed",
        excerpt: "Calm visual systems give audio experiences room to feel more premium, not less expressive.",
        wordCount: 1340,
        estimatedMinutes: 8,
        status: .processing,
        voice: "sage",
        createdAtOffset: -3_600,
        updatedAtOffset: -240
    )

    static let readyJob = makeJob(
        id: "job-preview-ready",
        title: "The Case for an Audio Inbox",
        siteName: "Tomorrow Product",
        byline: "Ava Thompson",
        excerpt: "Treating narration like a saved queue unlocks a calmer reading habit across the whole day.",
        wordCount: 1580,
        estimatedMinutes: 10,
        status: .completed,
        voice: "sage",
        audioURL: "http://127.0.0.1:3000/audio/preview-ready.mp3",
        durationSeconds: 603,
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
        error: "The article loaded, but the speech provider timed out before rendering audio.",
        createdAtOffset: -15_800,
        updatedAtOffset: -15_200
    )

    static let libraryJobs = [
        readyJob,
        processingJob,
        queuedJob,
        failedJob
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
        audioURL: String? = nil,
        durationSeconds: Double? = nil,
        error: String? = nil,
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
            audioUrl: audioURL,
            playlistUrl: nil,
            audioSegments: [],
            durationSeconds: durationSeconds,
            error: error,
            createdAt: .now.addingTimeInterval(createdAtOffset),
            updatedAt: .now.addingTimeInterval(updatedAtOffset)
        )
    }
}
