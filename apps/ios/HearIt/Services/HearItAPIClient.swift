import Foundation

struct HearItAPIClient {
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder

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

    func fetchJobs(baseURL: URL) async throws -> [AudioJob] {
        let response: JobsResponse = try await request(path: "/api/jobs", baseURL: baseURL)
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

    func createJob(articleURL: String, voiceID: String, baseURL: URL) async throws -> AudioJob {
        let response: JobResponse = try await request(
            path: "/api/jobs",
            method: .post,
            body: CreateJobBody(
                url: articleURL,
                speechOptions: CreateJobBody.SpeechOptions(voice: voiceID)
            ),
            baseURL: baseURL
        )
        return response.job
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
        baseURL: URL
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
            throw APIError.invalidResponse
        }

        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            if let apiError = try? decoder.decode(ErrorResponse.self, from: data) {
                throw APIError.server(apiError.error)
            }

            throw APIError.server("The Hear It API returned status \(httpResponse.statusCode).")
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            #if DEBUG
            print("[HearIt] Decode error for \(Response.self): \(error)")
            #endif
            throw APIError.decodingFailed(detail: String(describing: error))
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
        case server(String)
        case decodingFailed(detail: String)

        var errorDescription: String? {
            switch self {
            case .invalidBaseURL:
                "The configured API URL is invalid."
            case .invalidResponse:
                "Hear It received an invalid response from the server."
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
