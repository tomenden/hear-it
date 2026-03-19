import Foundation

struct VoiceChoice: Hashable, Identifiable {
    let id: String

    var displayName: String {
        metadata.displayName
    }

    var tone: String {
        metadata.tone
    }

    var symbolName: String {
        metadata.symbolName
    }

    static func catalog(from voices: [String]) -> [VoiceChoice] {
        voices.map(VoiceChoice.init(id:))
    }

    private var metadata: VoiceMetadata {
        Self.catalogMetadata[id.lowercased(), default: VoiceMetadata(
            displayName: id.capitalized,
            tone: "OpenAI-supported narration voice.",
            symbolName: "waveform"
        )]
    }

    private struct VoiceMetadata {
        let displayName: String
        let tone: String
        let symbolName: String
    }

    private static let catalogMetadata: [String: VoiceMetadata] = [
        "alloy": VoiceMetadata(
            displayName: "Alloy",
            tone: "Balanced and calm for long-form listening.",
            symbolName: "circle.lefthalf.filled"
        ),
        "ash": VoiceMetadata(
            displayName: "Ash",
            tone: "Clear and measured with a steady delivery.",
            symbolName: "sun.haze.fill"
        ),
        "coral": VoiceMetadata(
            displayName: "Coral",
            tone: "Warm and expressive with natural multilingual flow.",
            symbolName: "bubble.left.and.bubble.right.fill"
        ),
        "nova": VoiceMetadata(
            displayName: "Nova",
            tone: "Smooth and versatile, ideal for multilingual content.",
            symbolName: "globe"
        ),
        "sage": VoiceMetadata(
            displayName: "Sage",
            tone: "Warm and conversational for softer narration.",
            symbolName: "leaf.fill"
        ),
        "shimmer": VoiceMetadata(
            displayName: "Shimmer",
            tone: "Bright and clear with excellent multilingual articulation.",
            symbolName: "star.fill"
        ),
        "verse": VoiceMetadata(
            displayName: "Verse",
            tone: "Brighter and more energetic for quick reads.",
            symbolName: "sparkles"
        )
    ]
}
