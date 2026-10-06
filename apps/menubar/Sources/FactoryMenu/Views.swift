import FactoryKit
import SwiftUI

struct MenuView: View {
    /// ImageRenderer cannot draw ScrollView content; snapshots render the list flat.
    var scrolls = true
    @Environment(AppModel.self) private var model
    @State private var listHeight: CGFloat = 0
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if let err = model.lastError {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange).lineLimit(3)
            }
            Divider()
            if !model.apiReachable {
                Text(model.anyRunning ? "Waiting for the factory API…" : "The factory is stopped.")
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 12)
            } else if model.runs.isEmpty {
                Text("No agent runs yet. Add tpm:agent:ready to an issue.")
                    .foregroundStyle(.secondary).padding(.vertical, 12)
            } else {
                if scrolls {
                    // A ScrollView in a menu bar window only gets its minimum
                    // height: measure the list and size the ScrollView to it.
                    ScrollView {
                        runList.background(
                            GeometryReader { g in Color.clear.preference(key: ListHeightKey.self, value: g.size.height) }
                        )
                    }
                    .frame(height: min(max(listHeight, 40), 560))
                    .onPreferenceChange(ListHeightKey.self) { listHeight = $0 }
                } else {
                    runList
                }
            }
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 460)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Software factory").font(.headline)
                Spacer()
                if model.anyRunning {
                    Button("Restart") { model.restartFactory() }
                    Button("Stop") { model.stopFactory() }
                } else {
                    Button("Start") { model.startFactory() }.keyboardShortcut(.defaultAction)
                }
            }
            HStack(spacing: 10) {
                ForEach(Component.all) { c in
                    HStack(spacing: 4) {
                        Circle().fill(color(model.componentStates[c.name] ?? .stopped)).frame(width: 7, height: 7)
                        Text(c.name).font(.caption)
                    }
                    .help(describe(model.componentStates[c.name] ?? .stopped))
                }
            }
            if model.apiReachable {
                let o = model.overview
                Text("\(o.active) running · \(o.attention) need you · \(o.mergedLast24h) merged, \(o.failedLast24h) failed (24h) · $\(String(format: "%.2f", o.costLast24hUsd))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var runList: some View {
        VStack(alignment: .leading, spacing: 12) {
            section("Needs you", model.attention)
            section("Running", model.active)
            section("Recent", model.recent)
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ runs: [AgentRun]) -> some View {
        if !runs.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.leading, 2)
                ForEach(runs) { RunRow(run: $0) }
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Logs") { model.openLogs() }
            if let t = model.lastRefresh {
                Text("updated \(t.formatted(date: .omitted, time: .standard))").font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Button("Quit") { model.quit() }.keyboardShortcut("q")
        }
        .buttonStyle(.borderless)
    }

    private func color(_ s: ComponentState) -> Color {
        switch s {
        case .running: return .green
        case .restarting: return .yellow
        case .failed: return .red
        case .stopped: return .gray
        }
    }

    private func describe(_ s: ComponentState) -> String {
        switch s {
        case .running(let pid): return "running (pid \(pid))"
        case .restarting(let n): return "restarting (attempt \(n))"
        case .failed(let m): return "failed: \(m)"
        case .stopped: return "stopped"
        }
    }
}

struct RunRow: View {
    let run: AgentRun
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: icon).font(.body).foregroundStyle(tint).frame(width: 18)
                VStack(alignment: .leading, spacing: 3) {
                    Text("#\(run.number) \(run.title)").font(.body.weight(.semibold)).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(run.statusLine).font(.callout).foregroundStyle(.primary.opacity(0.75)).lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(run.repo)
                        if run.round > 1 { Text("· round \(run.round)") }
                        if run.costUsd > 0 { Text("· $\(String(format: "%.2f", run.costUsd))") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
            if run.isActive { ProgressView(value: run.progress).controlSize(.small).padding(.leading, 26) }
            HStack(spacing: 8) {
                Spacer()
                if model.busy.contains(run.id) { ProgressView().controlSize(.mini) }
                if run.attention?.kind == "approve" {
                    Button("Approve & merge") { model.perform(.approve, run) }.buttonStyle(.borderedProminent)
                }
                if ["failed", "human", "blocked"].contains(run.attention?.kind ?? "") || (!run.isActive && run.attention == nil && run.decision == "failed") {
                    Button("Retry") { model.perform(.retry, run) }
                }
                if model.needsYou(run) && !run.isActive {
                    Button("Dismiss") { model.dismiss(run) }
                }
                if run.isActive && run.attention?.kind != "approve" {
                    Button("Cancel") { model.perform(.cancel, run) }
                }
                Menu {
                    Button("Open issue") { model.open(run.url) }
                    if let pr = run.prUrl { Button("Open pull request") { model.open(pr) } }
                    Button("History") { openWindow(id: "history", value: run.id) }
                } label: { Image(systemName: "ellipsis.circle") }
                    .menuStyle(.borderlessButton).fixedSize()
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(tint.opacity(model.needsYou(run) ? 0.6 : 0), lineWidth: 1))
    }

    private var icon: String {
        switch run.attention?.kind {
        case "approve": return "checkmark.seal"
        case "failed": return "xmark.octagon.fill"
        case "blocked": return "hand.raised.fill"
        case "human": return "person.fill.questionmark"
        default: break
        }
        if run.isActive { return "gearshape.2" }
        return ["merged", "done"].contains(run.decision ?? "") ? "checkmark.circle.fill" : "circle.dashed"
    }

    private var tint: Color {
        switch run.attention?.kind {
        case "approve": return .blue
        case "failed", "blocked": return .red
        case "human": return .orange
        default: return ["merged", "done"].contains(run.decision ?? "") ? .green : .secondary
        }
    }
}

/// Durable history of one run (from the engine's task_history).
struct HistoryView: View {
    let runId: String
    @Environment(AppModel.self) private var model
    @State private var detail: RunDetail?
    @State private var error: String?

    var body: some View {
        Group {
            if let d = detail {
                VStack(alignment: .leading, spacing: 8) {
                    Text("#\(d.run.number) \(d.run.title)").font(.headline)
                    Text("round \(d.run.round) · \(d.run.status.lowercased()) · $\(String(format: "%.2f", d.run.costUsd))")
                        .font(.caption).foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        ForEach(d.run.steps, id: \.key) { s in
                            Text(s.key).font(.caption2).padding(.horizontal, 5).padding(.vertical, 2)
                                .background(Capsule().fill(stepColor(s.status).opacity(0.25)))
                        }
                    }
                    Table(d.history) {
                        TableColumn("Time") { e in Text(String(e.timestamp.dropFirst(11).prefix(8))).monospacedDigit() }.width(70)
                        TableColumn("Event", value: \.event_type).width(150)
                        TableColumn("Step") { e in Text(e.stepKey ?? "") }.width(110)
                        TableColumn("State") { e in Text([e.previous_state, e.new_state].compactMap { $0 }.joined(separator: " → ")) }.width(160)
                        TableColumn("Details") { e in
                            Text((e.payload ?? [:]).filter { $0.key != "stepKey" }.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.display)" }.joined(separator: " "))
                                .lineLimit(1).help((e.payload ?? [:]).map { "\($0.key): \($0.value.display)" }.joined(separator: "\n"))
                        }
                    }
                }
            } else if let error {
                Text(error).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .padding()
        .frame(minWidth: 760, minHeight: 420)
        .task(id: runId) {
            do { detail = try await model.api.detail(runId) } catch { self.error = error.localizedDescription }
        }
    }

    private func stepColor(_ s: String) -> Color {
        switch s {
        case "COMPLETED": return .green
        case "SKIPPED": return .gray
        case "FAILED", "CANCELLED": return .red
        case "RUNNING", "READY", "RETRYING", "WAITING": return .blue
        default: return .secondary
        }
    }
}

private struct ListHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
