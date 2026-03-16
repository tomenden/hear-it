import Foundation
import Testing
@testable import HearIt

struct LocalNarrationAudioStoreTests {
    @Test
    func savesAndRemovesNarrationAudioInTheConfiguredDirectory() async throws {
        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = LocalNarrationAudioStore(baseDirectory: tempDirectory)
        let audioData = Data("ID3FAKEAUDIO".utf8)

        let savedURL = try await store.save(audioData, forJobID: "job/123")

        #expect(savedURL.lastPathComponent == "narration-job-123.mp3")
        #expect(FileManager.default.fileExists(atPath: savedURL.path))
        #expect(store.audioFileURLIfExists(forJobID: "job/123") == savedURL)
        #expect(try Data(contentsOf: savedURL) == audioData)

        try await store.removeAudio(forJobID: "job/123")

        #expect(store.audioFileURLIfExists(forJobID: "job/123") == nil)
    }
}
