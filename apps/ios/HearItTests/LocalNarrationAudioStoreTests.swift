import Foundation
import Testing
@testable import HearIt

struct LocalNarrationAudioStoreTests {
    @Test
    func savesStandaloneNarrationAudioFilesForDirectPlayback() async throws {
        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = LocalNarrationAudioStore(baseDirectory: tempDirectory)

        let savedURL = try await store.saveAudioFile(
            forJobID: "job/final",
            audioData: Data("FINALMP3".utf8)
        )

        #expect(savedURL.lastPathComponent == "narration-job-final.mp3")
        #expect(FileManager.default.fileExists(atPath: savedURL.path))
        #expect(try Data(contentsOf: savedURL) == Data("FINALMP3".utf8))
        #expect(store.playbackURLIfExists(forJobID: "job/final") == savedURL)
    }

    @Test
    func savesAndRemovesNarrationPlaylistBundlesInTheConfiguredDirectory() async throws {
        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = LocalNarrationAudioStore(baseDirectory: tempDirectory)
        let savedURL = try await store.savePlaylistBundle(
            forJobID: "job/123",
            segments: [
                .init(fileName: "segment-0.mp3", durationSeconds: 12, audioData: Data("ID3SEG0".utf8)),
                .init(fileName: "segment-1.mp3", durationSeconds: 18, audioData: Data("ID3SEG1".utf8)),
            ]
        )

        #expect(savedURL.lastPathComponent == "playlist.m3u8")
        #expect(FileManager.default.fileExists(atPath: savedURL.path))
        #expect(
            try String(contentsOf: savedURL, encoding: .utf8) ==
                """
                #EXTM3U
                #EXT-X-VERSION:3
                #EXT-X-TARGETDURATION:18
                #EXT-X-MEDIA-SEQUENCE:0
                #EXT-X-PLAYLIST-TYPE:VOD
                #EXTINF:12.000,
                segment-0.mp3
                #EXTINF:18.000,
                segment-1.mp3
                #EXT-X-ENDLIST
                """
        )
        let legacyAudioURL = tempDirectory
            .appendingPathComponent("Narrations", isDirectory: true)
            .appendingPathComponent("narration-job-123.mp3")
        #expect(FileManager.default.fileExists(atPath: legacyAudioURL.path))
        #expect(store.playbackURLIfExists(forJobID: "job/123") == legacyAudioURL)
        #expect(
            try Data(contentsOf: savedURL.deletingLastPathComponent().appendingPathComponent("segment-0.mp3")) ==
                Data("ID3SEG0".utf8)
        )
        #expect(
            try Data(contentsOf: legacyAudioURL) ==
                Data("ID3SEG0ID3SEG1".utf8)
        )

        try await store.removeCachedNarration(forJobID: "job/123")

        #expect(store.playbackURLIfExists(forJobID: "job/123") == nil)
    }

    @Test
    func playbackURLMigratesExistingPlaylistBundleToCombinedMP3() throws {
        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = LocalNarrationAudioStore(baseDirectory: tempDirectory)
        let narrationsDirectory = tempDirectory.appendingPathComponent("Narrations", isDirectory: true)
        let jobDirectory = narrationsDirectory.appendingPathComponent("job-456", isDirectory: true)
        let playlistURL = jobDirectory.appendingPathComponent("playlist.m3u8")
        let segment0URL = jobDirectory.appendingPathComponent("segment-0.mp3")
        let segment1URL = jobDirectory.appendingPathComponent("segment-1.mp3")
        let expectedLegacyURL = narrationsDirectory.appendingPathComponent("narration-job-456.mp3")

        try FileManager.default.createDirectory(at: jobDirectory, withIntermediateDirectories: true)
        try Data("AAA".utf8).write(to: segment0URL)
        try Data("BBB".utf8).write(to: segment1URL)
        try """
            #EXTM3U
            #EXT-X-VERSION:3
            #EXT-X-TARGETDURATION:1
            #EXT-X-MEDIA-SEQUENCE:0
            #EXT-X-PLAYLIST-TYPE:VOD
            #EXTINF:1.000,
            segment-0.mp3
            #EXTINF:1.000,
            segment-1.mp3
            #EXT-X-ENDLIST
            """
            .write(to: playlistURL, atomically: true, encoding: .utf8)

        let playbackURL = store.playbackURLIfExists(forJobID: "job-456")

        #expect(playbackURL == expectedLegacyURL)
        #expect(FileManager.default.fileExists(atPath: expectedLegacyURL.path))
        #expect(try Data(contentsOf: expectedLegacyURL) == Data("AAABBB".utf8))
    }
}
