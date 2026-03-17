import Foundation
import Testing
@testable import HearIt

struct LocalNarrationAudioStoreTests {
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
        #expect(store.playbackURLIfExists(forJobID: "job/123") == savedURL)
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
        #expect(
            try Data(contentsOf: savedURL.deletingLastPathComponent().appendingPathComponent("segment-0.mp3")) ==
                Data("ID3SEG0".utf8)
        )

        try await store.removeCachedNarration(forJobID: "job/123")

        #expect(store.playbackURLIfExists(forJobID: "job/123") == nil)
    }
}
