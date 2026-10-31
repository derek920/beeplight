import AppKit
import SwiftUI

@main
struct BeeplightApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let monitor = Monitor.shared

    init() {
        // Before Monitor and Appearance read their settings.
        LegacyMigration.run()
        // A new status item starts leftmost, where a crowded menu bar hides it behind the notch.
        // Start near the right instead (points from the screen's right edge); ⌘-drag overrides it.
        let slot = "NSStatusItem Preferred Position Item-0"
        if UserDefaults.standard.object(forKey: slot) == nil {
            UserDefaults.standard.set(400.0, forKey: slot)
        }
    }

    var body: some Scene {
        Window("Beeplight", id: "board") {
            BoardView(monitor: monitor)
        }
        .defaultSize(width: 1240, height: 880)

        // Opened from a limit card on the board.
        Window("Limit details", id: "quota") {
            QuotaDetailView(monitor: monitor)
        }
        .defaultSize(width: 860, height: 760)

        MenuBarExtra {
            PanelView(monitor: monitor)
        } label: {
            MenuBarLabel(monitor: monitor)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsRoot()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var sigterm: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `kill` / logout scripts send SIGTERM; quit normally so the bundled service is stopped too.
        signal(SIGTERM, SIG_IGN)
        sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        sigterm?.setEventHandler { NSApp.terminate(nil) }
        sigterm?.resume()

        ServerManager.shared.start()
        Notifier.shared.setup()
        Notifier.shared.onFocus = { id in Task { @MainActor in Monitor.shared.focus(id, via: "notification") } }
        Task { @MainActor in
            let appearance = Appearance.shared
            appearance.onChange = { new, old in
                Monitor.shared.refreshImage()
                if new.character != old.character { Monitor.shared.syncCharacter() }
                IslandController.shared.apply(new)
            }
            Monitor.shared.onTransition = { IslandController.shared.flash($0) }
            Monitor.shared.start()
            DebugSnapshot.run(monitor: .shared)
            IslandController.shared.apply(appearance.config)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        ServerManager.shared.stop()
    }

    // Closing the board keeps the app alive in the menu bar.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
