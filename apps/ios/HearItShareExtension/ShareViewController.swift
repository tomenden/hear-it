import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        extractURL()
    }

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
                        presentShareView(for: url)
                    } else {
                        presentShareView(invalidURL: true)
                    }
                } catch {
                    cancel()
                }
            }
            return
        }

        cancel()
    }

    private func presentShareView(for url: URL) {
        let shareView = ShareExtensionView(url: url) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        embedHostingController(rootView: shareView)
    }

    private func presentShareView(invalidURL: Bool) {
        let shareView = ShareExtensionView(url: nil) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        embedHostingController(rootView: shareView)
    }

    private func embedHostingController(rootView: some View) {
        let hostingController = UIHostingController(rootView: rootView)
        hostingController.view.backgroundColor = .clear

        addChild(hostingController)
        view.addSubview(hostingController.view)
        hostingController.view.frame = view.bounds
        hostingController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        hostingController.didMove(toParent: self)
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "HearItShareExtension", code: 0))
    }
}
