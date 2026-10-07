import XCTest
@testable import FactoryKit

final class FactoryKitTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    /// The fixture is written by the TypeScript integration test from the real API (contract test).
    func testDecodesTheRealRunsResponse() throws {
        let res = try JSONDecoder().decode(RunsResponse.self, from: fixture("runs"))
        let run = try XCTUnwrap(res.runs.first)
        XCTAssertEqual(run.number, 20)
        XCTAssertEqual(run.step, StepState(key: "review", status: "WAITING"))
        XCTAssertEqual(run.attention?.kind, "approve")
        XCTAssertTrue(run.isActive)
        XCTAssertTrue(run.statusLine.hasPrefix("policy: waiting for approval"))
        XCTAssertGreaterThan(run.progress, 0.5)
        XCTAssertEqual(res.overview.attention, 1)
        XCTAssertEqual(res.repos.first?.factory, true)
    }

    func testDecodesRunDetailWithHistory() throws {
        let d = try JSONDecoder().decode(RunDetail.self, from: fixture("detail"))
        XCTAssertFalse(d.history.isEmpty)
        XCTAssertTrue(d.history.contains { $0.eventType == "task.created" })
        XCTAssertNotNil(d.history.first { $0.stepKey == "agent" })
    }

    private func run(_ id: String, attention: String? = nil, decision: String? = nil, status: String = "WAITING", sha: String = "abc") -> AgentRun {
        AgentRun(
            id: id, ref: "github:a/b#1", repo: "a/b", number: 1, title: "T", url: "https://x/issues/1", round: 1,
            status: status, step: nil, steps: [], prUrl: "https://x/pull/2", headSha: sha, watch: nil, outcome: nil,
            decision: decision, attention: attention.map { Attention(kind: $0, reason: "why") }, costUsd: 0,
            createdAt: "", updatedAt: "", completedAt: nil)
    }

    func testNotificationsOnlyForNewEventsAndNotAtLaunch() {
        var planner = NotificationPlanner()
        // First snapshot: existing state is not announced.
        XCTAssertEqual(planner.plan([run("1", attention: "approve")]).count, 0)
        // Same state again: nothing.
        XCTAssertEqual(planner.plan([run("1", attention: "approve")]).count, 0)
        // A new run needs approval, another one merged.
        let n = planner.plan([run("1", attention: "approve"), run("2", attention: "approve"), run("3", decision: "merged", status: "COMPLETED")])
        XCTAssertEqual(n.map(\.title).sorted(), ["Approval needed", "Merged by the factory"])
        XCTAssertEqual(n.first { $0.title == "Approval needed" }?.url, "https://x/pull/2")
        // A new commit on run 2 that needs approval again is a new event.
        XCTAssertEqual(planner.plan([run("2", attention: "approve", sha: "def")]).count, 1)
    }

    func testFailuresNotify() {
        var planner = NotificationPlanner()
        _ = planner.plan([])
        let n = planner.plan([run("9", attention: "failed", status: "FAILED")])
        XCTAssertEqual(n.first?.title, "Agent run failed")
    }

    func testLoginShellProvidesNode() throws {
        let (env, node) = try Supervisor.loginShellEnvironment()
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: node), node)
        XCTAssertTrue(env["PATH"]?.contains("/") == true)
    }
}
