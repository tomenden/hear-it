import SwiftUI

struct ShareExtensionView: View {
    let url: URL?
    let onDismiss: () -> Void

    @State private var state: SubmitState = .loading

    enum SubmitState {
        case loading
        case success
        case error(String)
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()

            VStack(spacing: 12) {
                switch state {
                case .loading:
                    ProgressView()
                        .tint(.white)
                    Text("Creating audio...")
                        .foregroundStyle(.white)
                        .font(.headline)
                case .success:
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.green)
                    Text("Creating your audio")
                        .foregroundStyle(.white)
                        .font(.headline)
                    Text("Open Hear It to listen")
                        .foregroundStyle(.white.opacity(0.8))
                        .font(.subheadline)
                case .error(let message):
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 48))
                        .foregroundStyle(.yellow)
                    Text(message)
                        .foregroundStyle(.white)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(32)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
        .task {
            await submitAudio()
        }
    }

    private func submitAudio() async {
        // Handle invalid URL
        guard let url else {
            state = .error("This link can't\nbe converted.")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
            return
        }

        // Read voice from shared UserDefaults
        let sharedDefaults = UserDefaults(suiteName: "group.com.tome.hearit")
        let voiceID = sharedDefaults?.string(forKey: "hear-it.selected-voice-id") ?? "alloy"
        let configuredBaseURL = (sharedDefaults?.string(forKey: "hear-it.api-base-url") ?? "https://hear-it.onrender.com")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))

        // Read auth token from shared Keychain
        guard let token = SharedKeychain.loadToken() else {
            state = .error("Please open Hear It\nand sign in")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
            return
        }

        // Build request
        guard let apiURL = URL(string: "\(configuredBaseURL)/api/jobs") else {
            state = .error("Invalid server URL.\nOpen Hear It settings.")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
            return
        }
        var request = URLRequest(url: apiURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15

        let body: [String: Any] = [
            "url": url.absoluteString,
            "speechOptions": ["voice": voiceID],
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        // Submit
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let httpResponse = response as? HTTPURLResponse

            if httpResponse?.statusCode == 401 {
                state = .error("Please open Hear It\nand sign in")
                try? await Task.sleep(for: .seconds(2))
                onDismiss()
                return
            }

            guard let statusCode = httpResponse?.statusCode,
                  (200...299).contains(statusCode) else {
                state = .error("Couldn't connect.\nTry again.")
                try? await Task.sleep(for: .seconds(2))
                onDismiss()
                return
            }

            state = .success
            try? await Task.sleep(for: .seconds(1.5))
            onDismiss()
        } catch let error as URLError where error.code == .timedOut {
            state = .error("Server is starting up.\nPlease try again.")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
        } catch {
            state = .error("Couldn't connect.\nTry again.")
            try? await Task.sleep(for: .seconds(2))
            onDismiss()
        }
    }
}
