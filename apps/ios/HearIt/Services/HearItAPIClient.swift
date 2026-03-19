import Foundation
import Sentry

struct HearItAPIClient {
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder
    var tokenProvider: (@Sendable () async -> String?)?

    init(session: URLSession = .shared) {
        self.session = session
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    func fetchConfig(baseURL: URL) async throws -> ServerConfig {
        try await request(path: "/api/config", baseURL: baseURL)
    }

    func fetchVoices(baseURL: URL) async throws -> [String] {
        let response: VoicesResponse = try await request(path: "/api/voices", baseURL: baseURL)
        return response.voices
    }

    func fetchJobs(baseURL: URL, reportErrors: Bool = true) async throws -> [AudioJob] {
        let response: JobsResponse = try await request(path: "/api/jobs", baseURL: baseURL, reportToSentry: reportErrors)
        return response.jobs
    }

    func extractArticle(articleURL: String, baseURL: URL) async throws -> Article {
        let response: ArticleResponse = try await request(
            path: "/api/extract",
            method: .post,
            body: CreateJobBody(url: articleURL, speechOptions: nil),
            baseURL: baseURL
        )
        return response.article
    }

    func deleteJob(jobID: String, baseURL: URL) async throws {
        let _: OkResponse = try await request(
            path: "/api/jobs/\(jobID)",
            method: .delete,
            baseURL: baseURL
        )
    }

    func createJob(articleURL: String, voiceID: String, language: String?, baseURL: URL) async throws -> AudioJob {
        let response: JobResponse = try await request(
            path: "/api/jobs",
            method: .post,
            body: CreateJobBody(
                url: articleURL,
                speechOptions: CreateJobBody.SpeechOptions(voice: voiceID, language: language)
            ),
            baseURL: baseURL
        )
        return response.job
    }

    func downloadAudioData(from url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = HTTPMethod.get.rawValue
        request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")

        if let tokenProvider, let token = await tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        #if DEBUG
        print("[HearIt] GET \(url.absoluteString)")
        #endif

        let (data, response) = try await session.data(for: request)
        let httpResponse = response as? HTTPURLResponse

        #if DEBUG
        print("[HearIt] GET \(url.absoluteString) → \(httpResponse?.statusCode ?? -1) (\(data.count) bytes)")
        #endif

        guard let httpResponse else {
            let apiError = APIError.invalidResponse
            SentrySDK.capture(error: apiError) { scope in
                scope.setContext(value: ["path": url.path, "method": HTTPMethod.get.rawValue], key: "api_request")
            }
            throw apiError
        }

        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let apiError: APIError
            if let decoded = try? decoder.decode(ErrorResponse.self, from: data) {
                apiError = .server(decoded.error)
            } else {
                apiError = .server("The Hear It API returned status \(httpResponse.statusCode).")
            }

            SentrySDK.capture(error: apiError) { scope in
                scope.setContext(value: [
                    "path": url.path,
                    "method": HTTPMethod.get.rawValue,
                    "statusCode": httpResponse.statusCode,
                ], key: "api_request")
            }
            throw apiError
        }

        return data
    }

    func downloadNarrationAudio(from url: URL) async throws -> Data {
        try await downloadAudioData(from: url)
    }

    static func resolveURL(_ rawValue: String?, relativeTo baseURL: URL) -> URL? {
        guard let rawValue, !rawValue.isEmpty else { return nil }

        if let absoluteURL = URL(string: rawValue), absoluteURL.scheme != nil {
            return absoluteURL
        }

        return URL(string: rawValue, relativeTo: baseURL)?.absoluteURL
    }

    private func request<Response: Decodable>(
        path: String,
        method: HTTPMethod = .get,
        body: Encodable? = nil,
        baseURL: URL,
        reportToSentry: Bool = true
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(AnyEncodable(body))
        }

        if let tokenProvider, let token = await tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        #if DEBUG
        print("[HearIt] \(method.rawValue) \(url.absoluteString)")
        #endif

        let (data, response) = try await session.data(for: request)
        let httpResponse = response as? HTTPURLResponse

        #if DEBUG
        print("[HearIt] \(method.rawValue) \(url.absoluteString) → \(httpResponse?.statusCode ?? -1) (\(data.count) bytes)")
        if let bodyPreview = String(data: data.prefix(500), encoding: .utf8) {
            print("[HearIt] body: \(bodyPreview)")
        }
        #endif

        guard let httpResponse else {
            let apiError = APIError.invalidResponse
            if reportToSentry {
                SentrySDK.capture(error: apiError) { scope in
                    scope.setContext(value: ["path": path, "method": method.rawValue], key: "api_request")
                }
            }
            throw apiError
        }

        if httpResponse.statusCode == 401 {
            throw APIError.unauthorized
        }

        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let apiError: APIError
            if let decoded = try? decoder.decode(ErrorResponse.self, from: data) {
                apiError = .server(decoded.error)
            } else {
                apiError = .server("The Hear It API returned status \(httpResponse.statusCode).")
            }
            if reportToSentry {
                SentrySDK.capture(error: apiError) { scope in
                    scope.setContext(value: [
                        "path": path,
                        "method": method.rawValue,
                        "statusCode": httpResponse.statusCode,
                    ], key: "api_request")
                }
            }
            throw apiError
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            #if DEBUG
            print("[HearIt] Decode error for \(Response.self): \(error)")
            #endif
            let apiError = APIError.decodingFailed(detail: String(describing: error))
            if reportToSentry {
                SentrySDK.capture(error: apiError) { scope in
                    scope.setContext(value: ["path": path, "method": method.rawValue], key: "api_request")
                }
            }
            throw apiError
        }
    }
}

extension HearItAPIClient {
    enum HTTPMethod: String {
        case get = "GET"
        case post = "POST"
        case delete = "DELETE"
    }

    enum APIError: LocalizedError {
        case invalidBaseURL
        case invalidResponse
        case unauthorized
        case server(String)
        case decodingFailed(detail: String)

        var errorDescription: String? {
            switch self {
            case .invalidBaseURL:
                "The configured API URL is invalid."
            case .invalidResponse:
                "Hear It received an invalid response from the server."
            case .unauthorized:
                "Your session has expired. Please sign in again."
            case let .server(message):
                message
            case let .decodingFailed(detail):
                "Hear It could not read the server response. (\(detail))"
            }
        }
    }

    private struct VoicesResponse: Decodable {
        let voices: [String]
    }

    private struct JobsResponse: Decodable {
        let jobs: [AudioJob]
    }

    private struct JobResponse: Decodable {
        let job: AudioJob
    }

    private struct ArticleResponse: Decodable {
        let article: Article
    }

    private struct OkResponse: Decodable {
        let ok: Bool
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }

    private struct CreateJobBody: Encodable {
        struct SpeechOptions: Encodable {
            let voice: String
            let language: String?
        }

        let url: String
        let speechOptions: SpeechOptions?
    }

    private struct AnyEncodable: Encodable {
        let wrapped: Encodable

        init(_ wrapped: Encodable) {
            self.wrapped = wrapped
        }

        func encode(to encoder: Encoder) throws {
            try wrapped.encode(to: encoder)
        }
    }
}
