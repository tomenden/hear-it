import Foundation

struct LocalAudioAssetStore: Sendable {
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
        let currentFileURL = currentAudioFileURL(forJobID: jobID)
        return FileManager.default.fileExists(atPath: currentFileURL.path) ? currentFileURL : nil
    }

    func savePlaylistBundle(
        forJobID jobID: String,
        segments: [StoredSegment]
    ) async throws -> URL {
        let directoryURL = currentJobDirectoryURL(forJobID: jobID)
        let playlistURL = currentPlaylistFileURL(forJobID: jobID)
        let fileManager = FileManager.default
        try Task.checkCancellation()
        try fileManager.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: nil
        )

        for segment in segments {
            try Task.checkCancellation()
            try segment.audioData.write(
                to: directoryURL.appendingPathComponent(segment.fileName),
                options: .atomic
            )
        }

        try Task.checkCancellation()
        try Self.buildPlaylist(for: segments)
            .write(to: playlistURL, atomically: true, encoding: .utf8)
        try Task.checkCancellation()
        try Self.writeCombinedAudioFile(
            segmentData: segments.map(\.audioData),
            to: currentAudioFileURL(forJobID: jobID)
        )
        return playlistURL
    }

    func saveAudioFile(forJobID jobID: String, audioData: Data) async throws -> URL {
        let currentFileURL = currentAudioFileURL(forJobID: jobID)
        try Task.checkCancellation()
        try FileManager.default.createDirectory(
            at: audioAssetsDirectory,
            withIntermediateDirectories: true,
            attributes: nil
        )
        try Task.checkCancellation()
        try audioData.write(to: currentFileURL, options: .atomic)
        return currentFileURL
    }

    func removeCachedAudio(forJobID jobID: String) async throws {
        let fileManager = FileManager.default
        try Task.checkCancellation()
        for url in [
            currentJobDirectoryURL(forJobID: jobID),
            currentAudioFileURL(forJobID: jobID),
        ] {
            if fileManager.fileExists(atPath: url.path) {
                try fileManager.removeItem(at: url)
            }
            try Task.checkCancellation()
        }
    }

    private var audioAssetsDirectory: URL {
        baseDirectory.appendingPathComponent("AudioAssets", isDirectory: true)
    }

    private func currentJobDirectoryURL(forJobID jobID: String) -> URL {
        audioAssetsDirectory.appendingPathComponent(sanitize(jobID), isDirectory: true)
    }

    private func currentPlaylistFileURL(forJobID jobID: String) -> URL {
        currentJobDirectoryURL(forJobID: jobID).appendingPathComponent("playlist.m3u8")
    }

    private func currentAudioFileURL(forJobID jobID: String) -> URL {
        audioAssetsDirectory.appendingPathComponent("audio-\(sanitize(jobID)).mp3")
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

    private static func writeCombinedAudioFile(segmentData: [Data], to destinationURL: URL) throws {
        try FileManager.default.createDirectory(
            at: destinationURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )

        if FileManager.default.fileExists(atPath: destinationURL.path) {
            try FileManager.default.removeItem(at: destinationURL)
        }
        FileManager.default.createFile(atPath: destinationURL.path, contents: nil)

        let handle = try FileHandle(forWritingTo: destinationURL)
        defer { try? handle.close() }

        for segment in segmentData {
            try handle.write(contentsOf: segment)
        }
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
