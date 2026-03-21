import UIKit
import UniformTypeIdentifiers

/// Share Extension entry point.
///
/// When a user taps "Share" in Safari, Chrome, WhatsApp or any app that shares
/// web URLs, this view controller is instantiated. It extracts the URL from the
/// share context and opens the main Hear It app, which will display the voice
/// selector so the user can immediately create a narration.
final class ShareViewController: UIViewController {

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        extractURL()
    }

    // MARK: - URL Extraction

    private func extractURL() {
        guard
            let item = extensionContext?.inputItems.first as? NSExtensionItem,
            let attachments = item.attachments
        else {
            cancel()
            return
        }

        let urlType = UTType.url.identifier

        for attachment in attachments {
            guard attachment.hasItemConformingToTypeIdentifier(urlType) else { continue }

            Task { @MainActor in
                do {
                    let data = try await attachment.loadItem(forTypeIdentifier: urlType)
                    let url: URL?
                    if let u = data as? URL {
                        url = u
                    } else if let s = data as? String {
                        url = URL(string: s)
                    } else {
                        url = nil
                    }

                    if let url, ["http", "https"].contains(url.scheme?.lowercased()) {
                        openMainApp(with: url)
                    } else {
                        cancel()
                    }
                } catch {
                    cancel()
                }
            }
            return
        }

        cancel()
    }

    // MARK: - Open Main App

    private func openMainApp(with sharedURL: URL) {
        // Build com.tome.hearit://share?url=<encoded-url>
        // The "share" host signals to the main app that this came from
        // the Share Extension and should open the voice selector directly.
        var components = URLComponents()
        components.scheme = "com.tome.hearit"
        components.host = "share"
        components.queryItems = [URLQueryItem(name: "url", value: sharedURL.absoluteString)]

        guard let appURL = components.url else {
            cancel()
            return
        }

        // Share Extensions don't have direct access to UIApplication.shared.
        // Use the responder chain to find the UIApplication and open the URL.
        guard let application = UIApplication.value(forKeyPath: #keyPath(UIApplication.shared)) as? UIApplication else {
            cancel()
            return
        }
        application.open(appURL)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            self?.done()
        }
    }

    // MARK: - Extension Context Helpers

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "HearItShareExtension", code: 0))
    }

    private func done() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
