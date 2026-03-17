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

    @Test
    func prefersPlaylistURLForIncrementalPlayback() {
        let baseURL = URL(string: "http://localhost:3000")!
        let job = AudioJob(
            id: "job-1",
            status: .processing,
            article: Article(
                url: "https://example.com/article",
                title: "Incremental playback",
                byline: nil,
                siteName: nil,
                excerpt: nil,
                textContent: "Body",
                wordCount: 100,
                estimatedMinutes: 1
            ),
            speechOptions: AudioJob.SpeechOptions(voice: "alloy"),
            provider: "openai",
            audioUrl: "/audio/final.mp3",
            audioDownloadPath: nil,
            playlistUrl: "/audio/job-1/playlist.m3u8",
            audioSegments: [],
            durationSeconds: nil,
            error: nil,
            createdAt: .now,
            updatedAt: .now
        )

        #expect(
            job.playbackURL(relativeTo: baseURL) ==
                URL(string: "http://localhost:3000/audio/job-1/playlist.m3u8")
        )
    }
}
