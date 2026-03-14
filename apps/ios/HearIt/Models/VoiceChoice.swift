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
        "sage": VoiceMetadata(
            displayName: "Sage",
            tone: "Warm and conversational for softer narration.",
            symbolName: "leaf.fill"
        ),
        "verse": VoiceMetadata(
            displayName: "Verse",
            tone: "Brighter and more energetic for quick reads.",
            symbolName: "sparkles"
        )
    ]
}
