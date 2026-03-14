import Foundation

struct PlayerPresentation: Identifiable, Hashable {
    let jobID: String

    var id: String { jobID }
}
