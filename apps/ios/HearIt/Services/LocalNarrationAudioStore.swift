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
        let legacyFileURL = legacyAudioFileURL(forJobID: jobID)
        if FileManager.default.fileExists(atPath: legacyFileURL.path) {
            return legacyFileURL
        }

        let playlistURL = playlistFileURL(forJobID: jobID)
        if FileManager.default.fileExists(atPath: playlistURL.path) {
            do {
                try buildLegacyAudioFileIfNeeded(forJobID: jobID)
                if FileManager.default.fileExists(atPath: legacyFileURL.path) {
                    return legacyFileURL
                }
            } catch {
                #if DEBUG
                print("[HearIt][Player] Failed to build local MP3 fallback for \(jobID): \(error)")
                #endif
            }
        }

        return nil
    }

    func savePlaylistBundle(
        forJobID jobID: String,
        segments: [StoredSegment]
    ) async throws -> URL {
        let directoryURL = jobDirectoryURL(forJobID: jobID)
        let playlistURL = playlistFileURL(forJobID: jobID)
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
            to: legacyAudioFileURL(forJobID: jobID)
        )
        return playlistURL
    }

    func saveAudioFile(forJobID jobID: String, audioData: Data) async throws -> URL {
        let legacyFileURL = legacyAudioFileURL(forJobID: jobID)
        try Task.checkCancellation()
        try FileManager.default.createDirectory(
            at: narrationsDirectory,
            withIntermediateDirectories: true,
            attributes: nil
        )
        try Task.checkCancellation()
        try audioData.write(to: legacyFileURL, options: .atomic)
        return legacyFileURL
    }

    func removeCachedNarration(forJobID jobID: String) async throws {
        let directoryURL = jobDirectoryURL(forJobID: jobID)
        let legacyFileURL = legacyAudioFileURL(forJobID: jobID)
        let fileManager = FileManager.default
        try Task.checkCancellation()
        if fileManager.fileExists(atPath: directoryURL.path) {
            try fileManager.removeItem(at: directoryURL)
        }
        try Task.checkCancellation()
        if fileManager.fileExists(atPath: legacyFileURL.path) {
            try fileManager.removeItem(at: legacyFileURL)
        }
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

    private func segmentFileURLs(forJobID jobID: String) -> [URL] {
        let jobDirectory = jobDirectoryURL(forJobID: jobID)
        let segmentURLs = (try? FileManager.default.contentsOfDirectory(
            at: jobDirectory,
            includingPropertiesForKeys: nil
        )) ?? []

        return segmentURLs
            .filter { $0.lastPathComponent.hasPrefix("segment-") && $0.pathExtension == "mp3" }
            .sorted { lhs, rhs in
                Self.segmentIndex(in: lhs.lastPathComponent) < Self.segmentIndex(in: rhs.lastPathComponent)
            }
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

    private func buildLegacyAudioFileIfNeeded(forJobID jobID: String) throws {
        let legacyFileURL = legacyAudioFileURL(forJobID: jobID)
        guard !FileManager.default.fileExists(atPath: legacyFileURL.path) else { return }

        let segmentURLs = segmentFileURLs(forJobID: jobID)
        guard !segmentURLs.isEmpty else { return }

        try Self.writeCombinedAudioFile(
            segmentData: try segmentURLs.map { try Data(contentsOf: $0) },
            to: legacyFileURL
        )
    }

    private static func segmentIndex(in fileName: String) -> Int {
        let prefix = "segment-"
        let suffix = ".mp3"
        guard fileName.hasPrefix(prefix), fileName.hasSuffix(suffix) else { return .max }
        let start = fileName.index(fileName.startIndex, offsetBy: prefix.count)
        let end = fileName.index(fileName.endIndex, offsetBy: -suffix.count)
        return Int(fileName[start..<end]) ?? .max
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
