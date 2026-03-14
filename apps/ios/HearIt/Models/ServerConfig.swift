import Foundation

struct ServerConfig: Codable, Hashable {
    let provider: String
    let audioPublicBaseURL: String
    let openAIConfigured: Bool

    enum CodingKeys: String, CodingKey {
        case provider
        case audioPublicBaseURL = "audioPublicBaseUrl"
        case openAIConfigured = "openAiConfigured"
    }

    var modeLabel: String {
        openAIConfigured ? "Live OpenAI" : "Local fake mode"
    }
}
