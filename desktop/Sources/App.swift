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
            // Not while rendering snapshots: it would ask for Bluetooth permission.
            if DebugSnapshot.dir == nil { BluetoothBridge.shared.start() }
            DebugSnapshot.run(monitor: .shared)
            IslandController.shared.apply(appearance.config)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        StillRunningNotice.terminating = true
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        ServerManager.shared.stop()
    }

    // Closing the board keeps the app alive in the menu bar; `StillRunningNotice` says so.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

/// Closing the board leaves the menu bar icon, the island and the service running, which looks
/// like the close button failed to quit the app. The first close says where it went and how to
/// quit, and offers to quit right there. Shown once.
@MainActor
enum StillRunningNotice {
    private static let shownKey = "stillRunningNoticeShown"
    static var terminating = false

    /// Runs `then` right away, or once the notice is dismissed.
    static func showOnce(then: @escaping () -> Void) {
        guard DebugSnapshot.dir == nil, !UserDefaults.standard.bool(forKey: shownKey) else { return then() }
        // Called from the board's onDisappear; let the window finish closing first. A timer, not
        // DispatchQueue.main: a modal run inside a main-queue block holds back every other
        // main-queue job (the SIGTERM handler, @MainActor tasks) until the alert is dismissed.
        Timer.scheduledTimer(withTimeInterval: 0, repeats: false) { _ in
            MainActor.assumeIsolated {
                present()
                then()
            }
        }
    }

    private static func present() {
        guard !terminating else { return }
        UserDefaults.standard.set(true, forKey: shownKey)
        let alert = NSAlert()
        alert.messageText = String(localized: "Beeplight is still running")
        alert.informativeText = Appearance.shared.config.island == .off
            ? String(localized: "It stays in the menu bar to tell you when a task needs you. Click the menu bar icon to open the board again. To quit, choose Quit Beeplight from the ⚙ menu.")
            : String(localized: "It stays in the menu bar to tell you when a task needs you. Click the menu bar icon to open the board again. To quit, choose Quit Beeplight from the ⚙ menu, or right-click the island.")
        alert.addButton(withTitle: String(localized: "OK"))
        alert.addButton(withTitle: String(localized: "Quit Beeplight"))
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn { NSApp.terminate(nil) }
    }
}
