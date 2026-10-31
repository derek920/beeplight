import AppKit
import SwiftUI

/// Debug aid: `Beeplight --snapshot <dir>` writes PNGs of the board, the menu bar panel and
/// the menu bar badge, then quits. It renders our own views, so no Screen Recording permission is needed.
@MainActor
enum DebugSnapshot {
    static let dir: URL? = {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return nil }
        return URL(fileURLWithPath: args[i + 1], isDirectory: true)
    }()

    static func run(monitor: Monitor) {
        guard let dir else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // `--preset <id>` renders with that preset without saving it.
        let args = CommandLine.arguments
        Appearance.shared.persist = false
        if let i = args.firstIndex(of: "--preset"), i + 1 < args.count, let p = Preset.all.first(where: { $0.id == args[i + 1] }) {
            Appearance.shared.apply(p)
        }
        if args.contains("--island-open") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { IslandController.shared.model.pinned = true }
        }
        if args.contains("--island-click") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 6.5) { IslandController.shared.debugClickFirstRow() }
        }
        let settings = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 890, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        settings.title = "settings"
        settings.contentView = NSHostingView(rootView: AppearanceSettingsView())
        settings.orderFront(nil)
        let phone = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 890, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        phone.title = "phone"
        phone.contentView = NSHostingView(rootView: PhoneSettingsView())
        phone.orderFront(nil)
        let general = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 890, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        general.title = "general"
        general.contentView = NSHostingView(rootView: GeneralSettingsView())
        general.orderFront(nil)
        let devices = NSWindow(contentRect: NSRect(x: 240, y: 240, width: 890, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        devices.title = "devices"
        devices.contentView = NSHostingView(rootView: DevicesSettingsView())
        devices.orderFront(nil)
        let advanced = NSWindow(contentRect: NSRect(x: 280, y: 280, width: 890, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        advanced.title = "advanced"
        advanced.contentView = NSHostingView(rootView: AdvancedSettingsView())
        advanced.orderFront(nil)
        // `--quota-week` opens it on the weekly limit.
        QuotaDetailModel.shared.window = args.contains("--quota-week") ? "7d" : "5h"
        let quota = NSWindow(contentRect: NSRect(x: 300, y: 60, width: 860, height: 960), styleMask: [.titled], backing: .buffered, defer: false)
        quota.title = "quota"
        quota.contentView = NSHostingView(rootView: QuotaDetailView(monitor: monitor))
        quota.orderFront(nil)
        // The menu bar panel cannot be opened programmatically; host it in a plain window.
        let panel = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 400, height: 640), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "panel"
        panel.contentView = NSHostingView(rootView: PanelView(monitor: monitor).background(ThemedBackdrop(material: .popover)))
        panel.orderFront(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
            for w in NSApp.windows where w.isVisible && w.frame.width > 200 {
                let name = ["panel", "settings", "island", "phone", "general", "devices", "advanced", "quota"].contains(w.title) ? w.title : "board"
                save(w, to: dir.appending(path: name + ".png"))
            }
            if let tiff = monitor.menuBarImage.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appending(path: "menubar.png"))
            }
            let faces = ImageRenderer(content: FaceSheet())
            faces.scale = 2
            if let cg = faces.cgImage {
                try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: dir.appending(path: "faces.png"))
            }
            NSApp.terminate(nil)
        }
    }

    /// Every energy level, plus a blink, a glance and the happy squint, on dark and light bars.
    private struct FaceSheet: View {
        var body: some View {
            let rows: [(String, EyePose)] = [("rest", EyePose()), ("blink", EyePose(blink: 0.3)), ("look", EyePose(look: 1)), ("happy", EyePose(happy: true)), ("move", EyePose(alt: true)), ("spin", EyePose(spin: 0.25, swing: 1)), ("spin back", EyePose(spin: 0.6, swing: 1))]
            VStack(alignment: .leading, spacing: 10) {
                ForEach([Color.black, Color(white: 0.93)], id: \.self) { bg in
                    HStack(spacing: 18) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                            VStack(spacing: 6) {
                                ForEach([Energy.unknown, .full, .half, .low, .empty], id: \.self) { e in
                                    HStack(spacing: 8) {
                                        ForEach(Characters.all.filter { $0 != Characters.classic }, id: \.self) { c in
                                            CharacterView(character: c, pose: row.1, energy: e, height: 39)
                                        }
                                    }
                                }
                                Text(row.0).font(.caption).foregroundStyle(.gray)
                            }
                        }
                    }
                    .padding(14)
                    .background(bg)
                }
            }
            .padding(8)
            .background(Color.gray.opacity(0.3))
        }
    }

    private static func save(_ window: NSWindow, to url: URL) {
        guard let view = window.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}
