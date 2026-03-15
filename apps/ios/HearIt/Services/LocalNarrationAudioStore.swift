import Foundation

struct LocalNarrationAudioStore: Sendable {
    private let baseDirectory: URL

    init(fileManager: FileManager = .default, baseDirectory: URL? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            self.baseDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        }
    }

    func audioFileURL(forJobID jobID: String) -> URL {
        narrationsDirectory.appendingPathComponent("narration-\(sanitize(jobID)).mp3")
    }

    func audioFileURLIfExists(forJobID jobID: String) -> URL? {
        let fileURL = audioFileURL(forJobID: jobID)
        return FileManager.default.fileExists(atPath: fileURL.path) ? fileURL : nil
    }

    func save(_ audioData: Data, forJobID jobID: String) async throws -> URL {
        let fileURL = audioFileURL(forJobID: jobID)
        let directoryURL = narrationsDirectory

        return try await Task.detached(priority: .utility) {
            let fileManager = FileManager.default
            try fileManager.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true,
                attributes: nil
            )
            try audioData.write(to: fileURL, options: .atomic)
            return fileURL
        }.value
    }

    func removeAudio(forJobID jobID: String) async throws {
        let fileURL = audioFileURL(forJobID: jobID)

        try await Task.detached(priority: .utility) {
            let fileManager = FileManager.default
            guard fileManager.fileExists(atPath: fileURL.path) else { return }
            try fileManager.removeItem(at: fileURL)
        }.value
    }

    private var narrationsDirectory: URL {
        baseDirectory.appendingPathComponent("Narrations", isDirectory: true)
    }

    private func sanitize(_ rawValue: String) -> String {
        let sanitized = rawValue
            .lowercased()
            .map { character in
                character.isLetter || character.isNumber ? character : "-"
            }

        return String(sanitized)
            .replacingOccurrences(of: "--+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}
