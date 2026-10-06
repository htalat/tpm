import Foundation

public struct PlannedNotification: Sendable, Equatable {
    public var id: String
    public var title: String
    public var body: String
    public var url: String?
}

/// Decides which macOS notifications to show by comparing two consecutive
/// snapshots of the runs. Pure, so it is unit tested. Each (run, event) pair
/// notifies at most once per app session (`seen`), and nothing is announced
/// for the very first snapshot (no flood of old news at launch).
public struct NotificationPlanner: Sendable {
    public private(set) var seen: Set<String> = []
    private var primed = false

    public init() {}

    public mutating func plan(_ runs: [AgentRun]) -> [PlannedNotification] {
        var out: [PlannedNotification] = []
        for run in runs {
            for event in Self.events(for: run) where !seen.contains(event.id) {
                seen.insert(event.id)
                if primed { out.append(event) }
            }
        }
        primed = true
        return out
    }

    static func events(for run: AgentRun) -> [PlannedNotification] {
        let name = "#\(run.number) \(run.title)"
        var events: [PlannedNotification] = []
        if let a = run.attention {
            let title: String
            switch a.kind {
            case "approve": title = "Approval needed"
            case "failed": title = "Agent run failed"
            case "blocked": title = "Run blocked"
            default: title = "Needs a human"
            }
            events.append(.init(id: "\(run.id):attention:\(a.kind):\(run.headSha ?? "")", title: title, body: "\(name) — \(a.reason)", url: run.prUrl ?? run.url))
        }
        if run.decision == "merged" {
            events.append(.init(id: "\(run.id):merged", title: "Merged by the factory", body: name, url: run.prUrl ?? run.url))
        }
        return events
    }
}
