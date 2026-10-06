import Foundation

/// Mirrors GET /agent-runs (packages/agent-runner/src/api.ts).
public struct RunsResponse: Codable, Sendable {
    public var runs: [AgentRun]
    public var overview: Overview
    public var repos: [RepoInfo]
}

public struct RepoInfo: Codable, Sendable, Hashable {
    public var name: String
    public var factory: Bool
}

public struct Overview: Codable, Sendable, Equatable {
    public var active: Int
    public var attention: Int
    public var mergedLast24h: Int
    public var failedLast24h: Int
    public var costLast24hUsd: Double

    public static let empty = Overview(active: 0, attention: 0, mergedLast24h: 0, failedLast24h: 0, costLast24hUsd: 0)
}

public struct StepState: Codable, Sendable, Hashable {
    public var key: String
    public var status: String
}

public struct Attention: Codable, Sendable, Hashable {
    /// approve | human | failed | blocked
    public var kind: String
    public var reason: String
}

public struct Watch: Codable, Sendable, Hashable {
    public var kind: String
    public var reason: String
    public var level: String?
    public var checkedAt: String
}

public struct Outcome: Codable, Sendable, Hashable {
    public var kind: String
    public var reason: String
}

public struct AgentRun: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var ref: String
    public var repo: String
    public var number: Int
    public var title: String
    public var url: String
    public var round: Int
    /// Task status: PENDING READY RUNNING WAITING RETRYING BLOCKED PAUSED COMPLETED FAILED CANCELLED
    public var status: String
    public var step: StepState?
    public var steps: [StepState]
    public var prUrl: String?
    public var headSha: String?
    public var watch: Watch?
    public var outcome: Outcome?
    public var decision: String?
    public var attention: Attention?
    public var costUsd: Double
    public var createdAt: String
    public var updatedAt: String
    public var completedAt: String?

    public var isActive: Bool { !["COMPLETED", "FAILED", "CANCELLED"].contains(status) }

    /// One line for the menu: what the run is doing or why it stopped.
    public var statusLine: String {
        if let a = attention { return a.reason }
        if isActive {
            if let s = step {
                if s.key == "review", let w = watch { return "review: \(w.reason)" }
                return "\(s.key): \(s.status.lowercased())"
            }
            return status.lowercased()
        }
        switch decision {
        case "merged": return "merged by the factory"
        case "done": return "merged"
        case "next-round": return "next round: \(outcome?.reason ?? "")"
        default: return outcome?.reason ?? status.lowercased()
        }
    }

    /// Completed steps / all steps, for a small progress bar.
    public var progress: Double {
        guard !steps.isEmpty else { return 0 }
        let done = steps.filter { ["COMPLETED", "SKIPPED"].contains($0.status) }.count
        return Double(done) / Double(steps.count)
    }
}

public struct HistoryEvent: Codable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var event_type: String
    public var previous_state: String?
    public var new_state: String?
    public var timestamp: String
    public var payload: [String: JSONValue]?

    public var stepKey: String? {
        if case .string(let s)? = payload?["stepKey"] { return s }
        return nil
    }
}

public struct RunDetail: Codable, Sendable {
    public var run: AgentRun
    public var history: [HistoryEvent]
}

/// Minimal JSON value for free-form payloads.
public enum JSONValue: Codable, Sendable, Hashable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    public var display: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        case .null: return "null"
        case .array(let a): return "[" + a.map(\.display).joined(separator: ", ") + "]"
        case .object(let o): return "{" + o.keys.sorted().map { "\($0): \(o[$0]!.display)" }.joined(separator: ", ") + "}"
        }
    }
}
