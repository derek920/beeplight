import AppKit
import ServiceManagement
import SwiftUI

/// The window that drops down from the menu bar icon.
struct PanelView: View {
    @ObservedObject var monitor: Monitor
    @ObservedObject var appearance = Appearance.shared
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(monitor: monitor)
            Divider().opacity(0.6)
            if monitor.visible.isEmpty {
                EmptyState(connected: monitor.connected)
                    .frame(height: 150)
            } else {
                // Natural height for a few rows; a fixed scrolling area once the list gets long.
                let rows = monitor.waiting.count + monitor.doing.count + min(monitor.done.count, doneLimit)
                if rows > 6 {
                    ScrollView { sections }.frame(height: 480)
                } else {
                    sections
                }
            }
            Divider().opacity(0.6)
            PanelFooter(monitor: monitor) {
                openWindow(id: "board")
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        .frame(width: 400)
        .background { if Theme.palette.backdrop != nil { ThemedBackdrop() } }
        .overlay(alignment: .bottom) { ToastView(text: monitor.toast) }
        .themedRoot()
        .id(appearance.revision)
    }

    private let doneLimit = 6

    private var sections: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelSection(title: String(localized: "Waiting for you"), color: Theme.waiting, items: monitor.waiting, monitor: monitor)
            PanelSection(title: String(localized: "Running"), color: Theme.doing, items: monitor.doing, monitor: monitor)
            PanelSection(title: monitor.unreadDone.isEmpty ? String(localized: "Recently done") : String(localized: "New"), color: Theme.success,
                         items: Array(monitor.done.prefix(max(doneLimit, monitor.unreadDone.count))), monitor: monitor,
                         unread: monitor.unreadDone.count)
        }
        .padding(10)
    }
}

private struct PanelHeader: View {
    @ObservedObject var monitor: Monitor

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Beeplight").font(.system(size: 14, weight: .bold))
                Spacer()
                LiveBadge(connected: monitor.connected, hz: monitor.meta?.hz)
            }
            HStack(spacing: 6) {
                CountPill(value: monitor.waiting.count, label: String(localized: "Waiting"), color: monitor.anyUrgent ? Theme.urgent : Theme.waiting)
                CountPill(value: monitor.doing.count, label: String(localized: "Running"), color: Theme.doing)
                CountPill(value: monitor.done.filter { $0.phase == .success }.count, label: String(localized: "Done"), color: Theme.success)
                CountPill(value: monitor.done.filter { $0.phase == .failed }.count, label: String(localized: "Failed"), color: Theme.failed)
            }
            CompactQuota(monitor: monitor)
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }
}

struct CountPill: View {
    let value: Int
    let label: String
    let color: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text("\(value)")
                .font(.system(size: 15, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(value > 0 ? color : Color.secondary.opacity(0.6))
                .contentTransition(.numericText())
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 8).fill(value > 0 ? color.opacity(0.12) : Color.primary.opacity(0.05)))
    }
}

struct LiveBadge: View {
    let connected: Bool
    let hz: Double?

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(connected ? Theme.success : Theme.failed)
                .frame(width: 7, height: 7)
                .shadow(color: connected ? Theme.success.opacity(0.8) : .clear, radius: 3)
            Text(connected ? String(localized: "Live · \(String(format: "%.1f", hz ?? 0))/s") : String(localized: "Connecting…"))
                .font(.system(size: 11).monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}

private struct PanelSection: View {
    let title: String
    let color: Color
    let items: [TaskItem]
    @ObservedObject var monitor: Monitor
    var unread = 0

    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Circle().fill(color).frame(width: 6, height: 6)
                    Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    if unread > 0 {
                        Text("\(unread) new")
                            .font(.system(size: 10.5, weight: .bold).monospacedDigit())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Theme.doing))
                            .fixedSize()
                        Spacer()
                        Button { monitor.markAllRead() } label: {
                            Label("Mark all read", systemImage: "checkmark.circle").font(.system(size: 11)).lineLimit(1)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(Theme.doing)
                        .fixedSize()
                    } else {
                        Text("\(items.count)").font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 2)
                ForEach(items) { PanelRow(item: $0, monitor: monitor) }
            }
        }
    }
}

private struct PanelRow: View {
    let item: TaskItem
    @ObservedObject var monitor: Monitor
    @State private var hover = false

    var body: some View {
        let urgent = item.isUrgent(now: monitor.now)
        HStack(alignment: .top, spacing: 10) {
            StatusGlyph(phase: item.phase, urgent: urgent, size: 18)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if item.unread == true { UnreadDot(size: 7) }
                    Text(item.title).font(.system(size: 13, weight: item.unread == true ? .bold : .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Fmt.elapsed(item, now: monitor.now))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(urgent ? Theme.urgent : .secondary)
                }
                Text(subtitle)
                    .font(item.isToolDetail ? .system(size: 11, design: .monospaced) : .system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                StateStrip(history: item.history ?? [], now: monitor.now, height: 3)
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 9).fill(hover ? Color.primary.opacity(0.07) : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { monitor.focus(item.id, via: "panel") }
        .contextMenu { ItemMenu(item: item, monitor: monitor) }
        .help(item.goal ?? item.lastPrompt ?? "")
    }

    private var subtitle: String {
        let detail = item.detail ?? ""
        let text = item.phase == .doing ? (detail.isEmpty ? item.label : detail) : (detail.isEmpty ? item.label : "\(item.label) · \(detail)")
        return item.remote.map { "\($0.label) · \(text)" } ?? text
    }
}

struct ItemMenu: View {
    let item: TaskItem
    let monitor: Monitor

    var body: some View {
        Button("\(item.primaryAction)") { monitor.focus(item.id) }
        Button("Summarize title and result again") { monitor.resummarize(item.id) }
        if item.phase == .success || item.phase == .failed {
            Button("Remove from board") { monitor.dismiss(item.id) }
        }
        Divider()
        Button("Copy session ID") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(item.id, forType: .string)
        }
        if let cwd = item.cwd {
            Button("Show project in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: cwd)]) }
        }
    }
}

struct EmptyState: View {
    let connected: Bool

    var body: some View {
        VStack(spacing: 8) {
            if connected {
                Image(systemName: "moon.zzz").font(.system(size: 26)).foregroundStyle(.tertiary)
                Text("No Claude tasks right now").font(.system(size: 12.5)).foregroundStyle(.secondary)
            } else {
                ProgressView().controlSize(.small)
                Text(ServerManager.shared.lastError ?? String(localized: "Connecting to the local Beeplight service…"))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

private struct PanelFooter: View {
    @ObservedObject var monitor: Monitor
    let openBoard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let t = monitor.meta?.today {
                TodayLine(today: t, compact: true)
            }
            HStack(spacing: 8) {
                Button(action: openBoard) { Label("Open board", systemImage: "rectangle.split.3x1") }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                Spacer()
                SettingsMenu(monitor: monitor)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

struct TodayLine: View {
    let today: Today
    var compact = false

    var body: some View {
        HStack(spacing: compact ? 10 : 18) {
            Text("Today").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            stat("checkmark.circle.fill", Theme.success, String(localized: "\(today.done) done"))
            if today.failed > 0 { stat("xmark.circle.fill", Theme.failed, String(localized: "\(today.failed) failed")) }
            // Shorter wording in the compact (menu bar panel) line.
            stat("bolt.fill", Theme.doing, compact
                 ? String(localized: "Worked \(Fmt.dur(today.workMs / 1000))")
                 : String(localized: "Claude worked \(Fmt.dur(today.workMs / 1000))"))
            stat("hand.raised.fill", Theme.waiting, compact
                 ? String(localized: "Waited \(Fmt.dur(today.waitMs / 1000))")
                 : today.longestWaitMs < 1000
                 ? String(localized: "Waited for you \(Fmt.dur(today.waitMs / 1000))")
                 : String(localized: "Waited for you \(Fmt.dur(today.waitMs / 1000)) (longest \(Fmt.dur(today.longestWaitMs / 1000)))"))
        }
        .lineLimit(1)
    }

    private func stat(_ icon: String, _ color: Color, _ text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(color)
            Text(text).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}

struct SettingsMenu: View {
    @ObservedObject var monitor: Monitor
    // Read on appear, not as the initial value: that expression runs on every init (each parent
    // redraw), and `status` is a synchronous XPC round trip that blocks the main thread.
    @State private var loginItem = false

    var body: some View {
        Menu {
            // The SDK here has SettingsLink but not the openSettings action.
            SettingsLink { Text("Appearance…") }
                .simultaneousGesture(TapGesture().onEnded { openSettings(tab: "appearance") })
            SettingsLink { Text("Phone Access…") }
                .simultaneousGesture(TapGesture().onEnded { openSettings(tab: "phone") })
            Divider()
            Toggle("Notify when a task needs you", isOn: $monitor.notifyWaiting)
            Toggle("Notify when a task finishes or fails", isOn: $monitor.notifyDone)
            Toggle("Notify at 80% / 95% of a limit", isOn: $monitor.notifyLimits)
            Toggle("Show SDK sessions", isOn: $monitor.showSDK)
            Toggle("Launch at login", isOn: Binding(get: { loginItem }, set: setLoginItem))
            Divider()
            Button("Open board in browser") { NSWorkspace.shared.open(monitor.base) }
            Button("Open data and logs folder") { NSWorkspace.shared.open(ServerManager.shared.dataDir) }
            Divider()
            Button("Quit Beeplight") { NSApp.terminate(nil) }
        } label: {
            Image(systemName: "gearshape")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .onAppear { loginItem = SMAppService.mainApp.status == .enabled }
    }

    private func openSettings(tab: String) {
        UserDefaults.standard.set(tab, forKey: "settingsTab")
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setLoginItem(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            monitor.show(String(localized: "Couldn't change the setting: \(error.localizedDescription)"))
        }
        loginItem = SMAppService.mainApp.status == .enabled
    }
}
