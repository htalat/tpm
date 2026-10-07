import AppKit
import FactoryKit
import Foundation
import Observation
import UserNotifications

/// App state: polls the factory API every few seconds, supervises the
/// processes, sends notifications, performs actions.
@MainActor
@Observable
final class AppModel {
    var runs: [AgentRun] = []
    var overview = Overview.empty
    var repos: [RepoInfo] = []
    var apiReachable = false
    var lastError: String?
    var busy: Set<String> = []
    var componentStates: [String: ComponentState] = [:]
    var lastRefresh: Date?

    let repo: URL
    let api: APIClient
    let supervisor: Supervisor
    private var planner = NotificationPlanner()
    private var pollTask: Task<Void, Never>?
    private var liveTask: Task<Void, Never>?
    private var refreshPending = false
    /// True while the live event stream is connected (then polling is only a safety net).
    var live = false
    private let notificationsAvailable = Bundle.main.bundleIdentifier != nil

    /// Attention items the user dismissed (per run and reason), stored locally.
    var dismissed: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "dismissed") ?? [])

    init(autoStart: Bool = true, poll: Bool = true) {
        let env = ProcessInfo.processInfo.environment
        let defaults = UserDefaults.standard
        let repoPath = env["FACTORY_REPO"] ?? defaults.string(forKey: "repoPath") ?? (NSHomeDirectory() + "/Developer/tpm-2")
        repo = URL(fileURLWithPath: repoPath)
        api = APIClient(baseURL: URL(string: env["FACTORY_API_URL"] ?? defaults.string(forKey: "apiURL") ?? "http://127.0.0.1:3000")!, token: env["API_TOKEN"])
        supervisor = Supervisor(repo: repo)
        supervisor.onChange = { [weak self] in Task { @MainActor in self?.syncStates() } }
        syncStates()
        if notificationsAvailable {
            UNUserNotificationCenter.current().delegate = NotificationClicks.shared
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        // However the app ends, stop what it started.
        let s = supervisor
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
            s.stop(grace: 10)
        }
        if poll {
            // Safety-net poll; changes normally arrive through the live stream.
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refresh()
                    let live = await MainActor.run { self?.live ?? false }
                    try? await Task.sleep(for: .seconds(live ? 30 : 5))
                }
            }
            liveTask = Task { [weak self] in
                while !Task.isCancelled {
                    guard let api = self?.api else { return }
                    do {
                        try await api.events { _ in await MainActor.run { self?.live = true; self?.scheduleRefresh() } }
                    } catch {}
                    await MainActor.run { self?.live = false }
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
        if autoStart && (defaults.object(forKey: "autoStart") as? Bool ?? true) { startFactory() }
    }

    // MARK: derived

    private func dismissKey(_ r: AgentRun) -> String { "\(r.id):\(r.attention?.kind ?? "")" }
    func needsYou(_ r: AgentRun) -> Bool { r.attention != nil && !dismissed.contains(dismissKey(r)) }
    var attention: [AgentRun] { runs.filter { needsYou($0) } }
    var active: [AgentRun] { runs.filter { $0.isActive && !needsYou($0) } }
    var recent: [AgentRun] { Array(runs.filter { !$0.isActive && !needsYou($0) }.prefix(8)) }

    func dismiss(_ r: AgentRun) {
        dismissed.insert(dismissKey(r))
        UserDefaults.standard.set(Array(dismissed), forKey: "dismissed")
    }
    var allRunning: Bool { Component.all.allSatisfy { componentStates[$0.name]?.isRunning == true } }
    var anyRunning: Bool { Component.all.contains { componentStates[$0.name]?.isRunning == true } }

    var menuBarSymbol: String {
        if !anyRunning { return "hammer" }
        if !attention.isEmpty { return "hammer.circle.fill" }
        if !active.isEmpty { return "gearshape.2.fill" }
        return "hammer.fill"
    }

    // MARK: refresh

    /// Coalesce bursts of events (one transition writes several history rows).
    func scheduleRefresh() {
        guard !refreshPending else { return }
        refreshPending = true
        Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            await MainActor.run { self?.refreshPending = false }
            await self?.refresh()
        }
    }

    func refresh() async {
        do {
            let res = try await api.runs()
            runs = res.runs
            overview = res.overview
            repos = res.repos
            apiReachable = true
            lastError = nil
            lastRefresh = Date()
            for n in planner.plan(res.runs) { notify(n) }
        } catch {
            apiReachable = false
            if anyRunning { lastError = error.localizedDescription }
        }
    }

    private func syncStates() {
        for c in Component.all { componentStates[c.name] = supervisor.state(c) }
    }

    // MARK: actions

    func startFactory() {
        do {
            try supervisor.start()
            lastError = nil
        } catch {
            lastError = "could not start the factory: \(error.localizedDescription)"
        }
        syncStates()
    }

    func stopFactory() {
        let s = supervisor
        Task.detached { s.stop() }
    }

    func restartFactory() {
        let s = supervisor
        Task.detached {
            s.stop()
            try? s.start()
        }
    }

    func perform(_ action: APIClient.Action, _ run: AgentRun) {
        busy.insert(run.id)
        Task {
            defer { busy.remove(run.id) }
            do {
                try await api.perform(action, run: run.id)
                await refresh()
            } catch {
                lastError = "\(action.rawValue) failed: \(error.localizedDescription)"
            }
        }
    }

    func open(_ url: String?) {
        guard let url, let u = URL(string: url) else { return }
        NSWorkspace.shared.open(u)
    }

    func openLogs() {
        NSWorkspace.shared.open(supervisor.logDir)
    }

    func quit() {
        NSApp.terminate(nil) // willTerminate stops the processes
    }

    private func notify(_ n: PlannedNotification) {
        guard notificationsAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = n.title
        content.body = n.body
        if let url = n.url { content.userInfo = ["url": url] }
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: n.id, content: content, trigger: nil))
    }
}

/// Clicking a notification opens its PR or issue.
final class NotificationClicks: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = NotificationClicks()

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        if let s = response.notification.request.content.userInfo["url"] as? String, let url = URL(string: s) {
            NSWorkspace.shared.open(url)
        }
        done()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound])
    }
}
