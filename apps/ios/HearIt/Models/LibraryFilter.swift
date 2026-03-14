import Foundation

enum LibraryFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case ready = "Ready"
    case inProgress = "In Progress"
    case failed = "Failed"

    var id: Self { self }

    func matches(_ status: AudioJob.Status) -> Bool {
        switch self {
        case .all:
            true
        case .ready:
            status == .completed
        case .inProgress:
            status == .queued || status == .processing
        case .failed:
            status == .failed
        }
    }
}
