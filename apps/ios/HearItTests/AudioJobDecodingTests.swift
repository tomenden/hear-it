import Foundation
import Testing
@testable import HearIt

@Suite("AudioJob decoding")
struct AudioJobDecodingTests {
    @Test
    func decodesQueuedStateAndPreparingPlayback() throws {
        let job = try decodeJob(
            state: "queued",
            playback: """
            {
              "mode": "preparing",
              "isPlayable": false,
              "availableDurationSeconds": 0,
              "liveEdgeUpdatedAt": null
            }
            """,
            progress: """
            {
              "chunksTotal": null,
              "chunksReady": 0,
              "availableDurationSeconds": 0
            }
            """
        )

        #expect(job.state == .queued)
        #expect(job.playback.mode == .preparing)
        #expect(job.playback.isPlayable == false)
        #expect(job.playback.availableDurationSeconds == 0)
        #expect(job.playback.liveEdgeUpdatedAt == nil)
        #expect(job.playbackURL(relativeTo: URL(string: "https://fallback.example.com")!) == nil)
        #expect(job.progress.chunksTotal == nil)
        #expect(job.progress.chunksReady == 0)
        #expect(job.progress.availableDurationSeconds == 0)
    }

    @Test
    func decodesProcessingStateAndStreamingPlayback() throws {
        let job = try decodeJob(
            state: "processing",
            audioUrl: nil,
            playlistUrl: nil,
            playback: """
            {
              "mode": "streaming",
              "isPlayable": true,
              "playlistUrl": "https://example.com/audio/job-1/live.m3u8",
              "availableDurationSeconds": 26,
              "liveEdgeUpdatedAt": "2026-04-05T12:30:00Z"
            }
            """,
            progress: """
            {
              "chunksTotal": 8,
              "chunksReady": 3,
              "availableDurationSeconds": 26
            }
            """
        )

        #expect(job.state == .processing)
        #expect(job.playback.mode == .streaming)
        #expect(job.playback.isPlayable == true)
        #expect(job.playback.playlistUrl == "https://example.com/audio/job-1/live.m3u8")
        #expect(job.playback.availableDurationSeconds == 26)
        #expect(
            job.playbackURL(relativeTo: URL(string: "https://fallback.example.com")!) ==
                URL(string: "https://example.com/audio/job-1/live.m3u8")
        )
        #expect(job.progress.chunksTotal == 8)
        #expect(job.progress.chunksReady == 3)
        #expect(job.progress.availableDurationSeconds == 26)
    }

    @Test
    func decodesReadyStateAndFinalPlayback() throws {
        let job = try decodeJob(
            state: "ready",
            audioUrl: nil,
            playlistUrl: nil,
            playback: """
            {
              "mode": "final",
              "isPlayable": true,
              "audioUrl": "https://cdn.example.com/audio/job-1/final.mp3",
              "durationSeconds": 42,
              "fileName": "Server supplied final audio.mp3"
            }
            """,
            progress: """
            {
              "chunksTotal": 12,
              "chunksReady": 12,
              "availableDurationSeconds": 42
            }
            """
        )

        #expect(job.state == .ready)
        #expect(job.status == .completed)
        #expect(job.playback.mode == .final)
        #expect(job.playback.isPlayable == true)
        #expect(job.playback.audioUrl == "https://cdn.example.com/audio/job-1/final.mp3")
        #expect(job.playback.durationSeconds == 42)
        #expect(job.playback.fileName == "Server supplied final audio.mp3")
        #expect(
            job.playbackURL(relativeTo: URL(string: "https://fallback.example.com")!) ==
                URL(string: "https://cdn.example.com/audio/job-1/final.mp3")
        )
        #expect(job.progress.chunksTotal == 12)
        #expect(job.progress.chunksReady == 12)
        #expect(job.progress.availableDurationSeconds == 42)
    }

    @Test
    func decodesFailedStateAndFailedPlayback() throws {
        let job = try decodeJob(
            state: "failed",
            playback: """
            {
              "mode": "failed",
              "isPlayable": false,
              "errorMessage": "Playback failed."
            }
            """,
            progress: """
            {
              "chunksTotal": null,
              "chunksReady": 0,
              "availableDurationSeconds": 0
            }
            """,
            error: "Generation failed."
        )

        #expect(job.state == .failed)
        #expect(job.playback.mode == .failed)
        #expect(job.playback.isPlayable == false)
        #expect(job.playback.errorMessage == "Playback failed.")
    }

    @Test
    func decodesLegacyStatusPayloadForMigration() throws {
        let payload = """
        {
          "id": "job-legacy",
          "status": "processing",
          "article": {
            "url": "https://example.com/articles/legacy",
            "title": "Legacy example",
            "byline": "Tome",
            "siteName": "Hear It",
            "excerpt": "A short excerpt.",
            "textContent": "Body",
            "wordCount": 120,
            "estimatedMinutes": 1
          },
          "speechOptions": {
            "voice": "alloy"
          },
          "provider": "openai",
          "audioUrl": null,
          "audioDownloadPath": null,
          "playlistUrl": "https://example.com/audio/job-legacy/live.m3u8",
          "liveEdgeUpdatedAt": "2026-04-05T12:30:00Z",
          "audioSegments": [
            {
              "url": "https://cdn.example.com/audio/job-legacy/segment-1.mp3",
              "durationSeconds": 13
            }
          ],
          "durationSeconds": 26,
          "error": null,
          "createdAt": "2026-04-05T12:00:00Z",
          "updatedAt": "2026-04-05T12:05:00Z"
        }
        """

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let job = try decoder.decode(AudioJob.self, from: Data(payload.utf8))

        #expect(job.state == .processing)
        #expect(job.status == .processing)
        #expect(job.playback.mode == .streaming)
        #expect(job.playback.playlistUrl == "https://example.com/audio/job-legacy/live.m3u8")
        #expect(job.progress.availableDurationSeconds == 26)
    }
}

private func decodeJob(
    state: String,
    status: String? = nil,
    audioUrl: String? = "https://cdn.example.com/audio/job-1/final.mp3",
    playlistUrl: String? = "https://example.com/audio/job-1/live.m3u8",
    playback: String,
    progress: String,
    error: String? = nil
) throws -> AudioJob {
    let payload = """
    {
      "id": "job-1",
      "title": "Example article",
      "state": "\(state)",
      "status": \(jsonString(status)),
      "article": {
        "url": "https://example.com/articles/1",
        "title": "Example article",
        "byline": "Tome",
        "siteName": "Hear It",
        "excerpt": "A short excerpt.",
        "textContent": "Body",
        "wordCount": 120,
        "estimatedMinutes": 1
      },
      "speechOptions": {
        "voice": "alloy"
      },
      "provider": "openai",
      "audioUrl": \(jsonString(audioUrl)),
      "audioDownloadPath": null,
      "playlistUrl": \(jsonString(playlistUrl)),
      "audioSegments": [
        {
          "url": "https://cdn.example.com/audio/job-1/segment-1.mp3",
          "durationSeconds": 13
        }
      ],
      "durationSeconds": 42,
      "error": \(jsonString(error)),
      "createdAt": "2026-04-05T12:00:00Z",
      "updatedAt": "2026-04-05T12:05:00Z",
      "playback": \(playback),
      "progress": \(progress)
    }
    """

    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return try decoder.decode(AudioJob.self, from: Data(payload.utf8))
}

private func jsonString(_ value: String?) -> String {
    guard let value else { return "null" }
    let escaped = value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(escaped)\""
}
