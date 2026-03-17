import Foundation

struct LocalNarrationAudioStore: Sendable {
    struct StoredSegment: Sendable {
        let fileName: String
        let durationSeconds: Double
        let audioData: Data
    }

    private let baseDirectory: URL

    init(fileManager: FileManager = .default, baseDirectory: URL? = nil) {
        if let baseDirectory {
            self.baseDirectory = baseDirectory
        } else {
            self.baseDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        }
    }

    func playbackURLIfExists(forJobID jobID: String) -> URL? {
        let playlistURL = playlistFileURL(forJobID: jobID)
        if FileManager.default.fileExists(atPath: playlistURL.path) {
            return playlistURL
        }

        let legacyFileURL = legacyAudioFileURL(forJobID: jobID)
        return FileManager.default.fileExists(atPath: legacyFileURL.path) ? legacyFileURL : nil
    }

    func savePlaylistBundle(
        forJobID jobID: String,
        segments: [StoredSegment]
    ) async throws -> URL {
        let directoryURL = jobDirectoryURL(forJobID: jobID)
        let playlistURL = playlistFileURL(forJobID: jobID)
        return try await Task.detached(priority: .utility) {
            let fileManager = FileManager.default
            try fileManager.createDirectory(
                at: directoryURL,
                withIntermediateDirectories: true,
                attributes: nil
            )

            for segment in segments {
                try segment.audioData.write(
                    to: directoryURL.appendingPathComponent(segment.fileName),
                    options: .atomic
                )
            }

            try Self.buildPlaylist(for: segments)
                .write(to: playlistURL, atomically: true, encoding: .utf8)
            return playlistURL
        }.value
    }

    func removeCachedNarration(forJobID jobID: String) async throws {
        let directoryURL = jobDirectoryURL(forJobID: jobID)
        let legacyFileURL = legacyAudioFileURL(forJobID: jobID)

        try await Task.detached(priority: .utility) {
            let fileManager = FileManager.default
            if fileManager.fileExists(atPath: directoryURL.path) {
                try fileManager.removeItem(at: directoryURL)
            }
            if fileManager.fileExists(atPath: legacyFileURL.path) {
                try fileManager.removeItem(at: legacyFileURL)
            }
        }.value
    }

    private var narrationsDirectory: URL {
        baseDirectory.appendingPathComponent("Narrations", isDirectory: true)
    }

    private func jobDirectoryURL(forJobID jobID: String) -> URL {
        narrationsDirectory.appendingPathComponent(sanitize(jobID), isDirectory: true)
    }

    private func playlistFileURL(forJobID jobID: String) -> URL {
        jobDirectoryURL(forJobID: jobID).appendingPathComponent("playlist.m3u8")
    }

    private func legacyAudioFileURL(forJobID jobID: String) -> URL {
        narrationsDirectory.appendingPathComponent("narration-\(sanitize(jobID)).mp3")
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

    private static func buildPlaylist(for segments: [StoredSegment]) -> String {
        let targetDuration = max(1, segments.map { Int(ceil($0.durationSeconds)) }.max() ?? 1)
        var lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:\(targetDuration)",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:VOD",
        ]

        for segment in segments {
            lines.append("#EXTINF:\(String(format: "%.3f", segment.durationSeconds)),")
            lines.append(segment.fileName)
        }

        lines.append("#EXT-X-ENDLIST")
        return lines.joined(separator: "\n")
    }
}
