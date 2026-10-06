import Foundation

/// One factory component, run as `node --import tsx <script> [args]` in the repo.
public struct Component: Sendable, Hashable, Identifiable {
    public var id: String { name }
    public var name: String
    public var script: String
    public var args: [String]

    public static let all: [Component] = [
        .init(name: "api", script: "apps/api/src/main.ts", args: []),
        .init(name: "orchestrator", script: "apps/orchestrator/src/main.ts", args: []),
        .init(name: "sync", script: "apps/agent-runner/src/main.ts", args: ["sync"]),
        .init(name: "worker", script: "apps/agent-runner/src/main.ts", args: ["worker"]),
    ]
}

public enum ComponentState: Sendable, Equatable {
    case stopped
    case running(pid: Int32)
    case restarting(attempt: Int)
    case failed(String)

    public var isRunning: Bool { if case .running = self { return true } else { return false } }
}

/// Starts, watches and stops the factory processes. Crashed components are
/// restarted with backoff (the factory is built to be killed at any moment,
/// so a restart is always safe). Stopping sends SIGTERM, then SIGKILL.
public final class Supervisor: @unchecked Sendable {
    public let repo: URL
    public let logDir: URL
    private let lock = NSLock()
    private var processes: [String: Process] = [:]
    private var wanted = false
    private var restarts: [String: [Date]] = [:]
    private var states: [String: ComponentState] = [:]
    private var env: [String: String]?
    private var node: String?
    public var onChange: (@Sendable () -> Void)?

    public init(repo: URL) {
        self.repo = repo
        self.logDir = repo.appendingPathComponent("data/logs")
    }

    public func state(_ c: Component) -> ComponentState {
        lock.withLock { states[c.name] ?? .stopped }
    }

    public var anyRunning: Bool { lock.withLock { processes.values.contains { $0.isRunning } } }

    /// GUI apps get a minimal PATH. The workers need the user's node, git, gh,
    /// claude, so take PATH (and node) from a login shell once.
    public static func loginShellEnvironment() throws -> (env: [String: String], node: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
        p.arguments = ["-lc", "printf '%s\\n%s' \"$PATH\" \"$(command -v node)\""]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        try p.run()
        p.waitUntilExit()
        let lines = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count >= 2, !lines[1].isEmpty else { throw NSError(domain: "Supervisor", code: 1, userInfo: [NSLocalizedDescriptionKey: "node not found in the login shell PATH"]) }
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = String(lines[0])
        return (env, String(lines[1]))
    }

    public func start() throws {
        let (env, node) = try (self.env.map { ($0, self.node!) }) ?? Self.loginShellEnvironment()
        lock.withLock {
            self.env = env
            self.node = node
            wanted = true
        }
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        for c in Component.all where !(lock.withLock { processes[c.name]?.isRunning ?? false }) {
            launch(c)
        }
    }

    private func launch(_ c: Component) {
        let (env, node) = lock.withLock { (self.env ?? [:], self.node ?? "node") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--import", "tsx", repo.appendingPathComponent(c.script).path] + c.args
        p.currentDirectoryURL = repo
        p.environment = env.merging(["WORKER_NAME": "menubar-\(c.name)"]) { _, new in new }
        let logURL = logDir.appendingPathComponent("menubar-\(c.name).log")
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let fh = try? FileHandle(forWritingTo: logURL) {
            fh.seekToEndOfFile()
            p.standardOutput = fh
            p.standardError = fh
        }
        p.terminationHandler = { [weak self] proc in self?.exited(c, proc) }
        do {
            try p.run()
            lock.withLock {
                processes[c.name] = p
                states[c.name] = .running(pid: p.processIdentifier)
            }
        } catch {
            lock.withLock { states[c.name] = .failed(error.localizedDescription) }
        }
        onChange?()
    }

    private func exited(_ c: Component, _ p: Process) {
        let (restart, attempt): (Bool, Int) = lock.withLock {
            guard processes[c.name] === p else { return (false, 0) }
            processes[c.name] = nil
            guard wanted else {
                states[c.name] = .stopped
                return (false, 0)
            }
            // At most 5 restarts per minute per component.
            let recent = (restarts[c.name] ?? []).filter { $0 > Date().addingTimeInterval(-60) } + [Date()]
            restarts[c.name] = recent
            if recent.count > 5 {
                states[c.name] = .failed("exited \(p.terminationStatus); too many restarts (see menubar-\(c.name).log)")
                return (false, 0)
            }
            states[c.name] = .restarting(attempt: recent.count)
            return (true, recent.count)
        }
        onChange?()
        guard restart else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + Double(attempt) * 2) { [weak self] in
            guard let self, self.lock.withLock({ self.wanted }) else { return }
            self.launch(c)
        }
    }

    /// SIGTERM everything, wait up to `grace`, then SIGKILL what is left.
    public func stop(grace: TimeInterval = 20) {
        let procs: [Process] = lock.withLock {
            wanted = false
            return Array(processes.values)
        }
        for p in procs where p.isRunning { p.terminate() }
        let deadline = Date().addingTimeInterval(grace)
        while procs.contains(where: { $0.isRunning }) && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
        for p in procs where p.isRunning { kill(p.processIdentifier, SIGKILL) }
        lock.withLock {
            processes.removeAll()
            for c in Component.all { states[c.name] = .stopped }
        }
        onChange?()
    }

    public func restart() throws {
        stop()
        try start()
    }
}
