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
}
