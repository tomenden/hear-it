import Foundation
import Testing
@testable import HearIt

struct HearItURLResolutionTests {
    @Test
    func resolvesRelativeAudioPathsAgainstTheConfiguredServer() {
        let baseURL = URL(string: "http://192.168.1.12:3000")!

        #expect(
            HearItAPIClient.resolveURL("/audio/track.mp3", relativeTo: baseURL) ==
                URL(string: "http://192.168.1.12:3000/audio/track.mp3")
        )
    }

    @Test
    func keepsAbsoluteAudioURLsUnchanged() {
        let baseURL = URL(string: "http://localhost:3000")!
        let absolute = URL(string: "https://cdn.example.com/audio/track.mp3")!

        #expect(
            HearItAPIClient.resolveURL(absolute.absoluteString, relativeTo: baseURL) == absolute
        )
    }
}
