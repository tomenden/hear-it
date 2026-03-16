import Auth
import Foundation
import Observation
import Supabase

@MainActor
@Observable
final class AuthManager {
    enum AuthState: Equatable {
        case loading
        case signedOut
        case signedIn(User)

        static func == (lhs: AuthState, rhs: AuthState) -> Bool {
            switch (lhs, rhs) {
            case (.loading, .loading), (.signedOut, .signedOut):
                return true
            case let (.signedIn(a), .signedIn(b)):
                return a.id == b.id
            default:
                return false
            }
        }
    }

    private(set) var state: AuthState = .loading

    @ObservationIgnored
    private let client: SupabaseClient

    @ObservationIgnored
    private var authStateTask: Task<Void, Never>?

    init() {
        let url = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_URL") as? String ?? ""
        let key = Bundle.main.object(forInfoDictionaryKey: "SUPABASE_ANON_KEY") as? String ?? ""
        // Use a dummy URL if not configured to avoid crashes in previews
        let supabaseURL = URL(string: url) ?? URL(string: "https://placeholder.supabase.co")!
        self.client = SupabaseClient(
            supabaseURL: supabaseURL,
            supabaseKey: key.isEmpty ? "placeholder" : key
        )
    }

    /// For preview/testing
    init(client: SupabaseClient) {
        self.client = client
    }

    func initialize() async {
        // Try to restore existing session
        do {
            let session = try await client.auth.session
            state = .signedIn(session.user)
        } catch {
            state = .signedOut
        }

        // Subscribe to auth state changes
        authStateTask = Task { [weak self] in
            guard let self else { return }
            for await (event, session) in self.client.auth.authStateChanges {
                switch event {
                case .signedIn, .tokenRefreshed:
                    if let session {
                        self.state = .signedIn(session.user)
                    }
                case .signedOut:
                    self.state = .signedOut
                default:
                    break
                }
            }
        }
    }

    func signInWithApple(idToken: String, fullName: String?) async throws {
        try await client.auth.signInWithIdToken(
            credentials: .init(provider: .apple, idToken: idToken)
        )

        // fullName is only provided on first sign-in (account creation)
        if let fullName {
            try? await client.auth.update(
                user: UserAttributes(data: ["full_name": .string(fullName)])
            )
        }
    }

    func signInWithGoogle() async throws {
        try await client.auth.signInWithOAuth(
            provider: .google,
            redirectTo: URL(string: "com.tome.hearit://auth/callback")
        )
    }

    func signOut() async throws {
        try await client.auth.signOut()
        state = .signedOut
    }

    var accessToken: String? {
        get async {
            try? await client.auth.session.accessToken
        }
    }

    func handleOpenURL(_ url: URL) async {
        // Only handle Supabase auth callback URLs
        guard url.scheme == "com.tome.hearit", url.host == "auth" else { return }
        do {
            try await client.auth.session(from: url)
        } catch {
            #if DEBUG
            print("[AuthManager] Failed to handle callback URL: \(error)")
            #endif
        }
    }

    var userEmail: String? {
        if case let .signedIn(user) = state {
            return user.email
        }
        return nil
    }

    deinit {
        authStateTask?.cancel()
    }
}
