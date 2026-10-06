import AppKit
import SwiftUI

@main
struct FactoryMenuApp: App {
    @State private var model: AppModel

    init() {
        // No Dock icon when run as a bare executable (the .app sets LSUIElement).
        NSApplication.shared.setActivationPolicy(.accessory)
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            // Debug: render the menu with live API data into a PNG, then exit. Starts nothing.
            let model = AppModel(autoStart: false, poll: false)
            _model = State(initialValue: model)
            let path = args[i + 1]
            Task { @MainActor in
                await model.refresh()
                Snapshot.write(MenuView(scrolls: false).environment(model), to: path)
                exit(0)
            }
        } else {
            _model = State(initialValue: AppModel())
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuView().environment(model)
        } label: {
            HStack(spacing: 2) {
                Image(systemName: model.menuBarSymbol)
                if !model.attention.isEmpty { Text("\(model.attention.count)") }
            }
        }
        .menuBarExtraStyle(.window)

        WindowGroup("Run history", id: "history", for: String.self) { $runId in
            if let runId { HistoryView(runId: runId).environment(model) }
        }
    }
}

@MainActor
enum Snapshot {
    static func write(_ view: some View, to path: String) {
        let renderer = ImageRenderer(content: view.background(Color(nsColor: .windowBackgroundColor)))
        renderer.scale = 2
        guard let image = renderer.nsImage, let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("snapshot failed\n".utf8))
            return
        }
        try? png.write(to: URL(fileURLWithPath: path))
    }
}
