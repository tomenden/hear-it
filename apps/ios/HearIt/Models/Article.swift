import Foundation

struct Article: Codable, Hashable, Identifiable {
    let url: String
    let title: String?
    let byline: String?
    let siteName: String?
    let excerpt: String?
    let textContent: String
    let wordCount: Int
    let estimatedMinutes: Int

    var id: String { url }

    var displayTitle: String {
        title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? title!
            : "Untitled article"
    }

    var summary: String {
        if let excerpt, !excerpt.isEmpty {
            return excerpt
        }

        return String(textContent.prefix(180))
    }

    var sourceLine: String {
        [siteName, byline, "\(estimatedMinutes) min listen"]
            .compactMap { $0 }
            .joined(separator: "  •  ")
    }
}
