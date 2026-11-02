import AppKit
import SwiftUI

// Background services: dev servers and watchers an agent left running (src/core/background.js).
// They are a kind of their own: not tasks, so they never move between columns and never notify;
// the board and the panel list them with their state, ports and how long they've been up.

/// The strip under the board's columns.
struct BackgroundStrip: View {
    let monitor: Monitor

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "server.rack").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                Text("Background services").font(.system(size: 13, weight: .bold)).fixedSize()
                Text("\(monitor.services.count)")
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.primary.opacity(0.07)))
                    .fixedSize()
                Text("Servers and watchers left running. They never notify.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .layoutPriority(-1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(monitor.services) { ServiceTile(item: $0, monitor: monitor) }
                }
                .padding(2)
            }
            .scrollIndicators(.never)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: Theme.palette.corner + 4, style: .continuous).fill(Theme.column))
    }
}

private struct ServiceTile: View {
    let item: ServiceItem
    let monitor: Monitor
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                ServiceDot(command: item.command)
                AgentMarkView(agent: item.agent, size: 11)
                Text(item.command.title).font(.system(size: 12.5, weight: .semibold)).lineLimit(1)
            }
            HStack(spacing: 6) {
                PortLinks(ports: item.command.ports ?? [])
                ServiceState(command: item.command, monitor: monitor)
            }
            Text(item.project.map { "\($0) · \(item.taskTitle)" } ?? item.taskTitle)
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .frame(width: 250, alignment: .leading)
        .themedCard(accent: ServiceDot.color(item.command))
        .opacity(item.command.isRunning ? 1 : 0.7)
        .scaleEffect(hover ? 1.01 : 1)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { monitor.focus(item.taskID, via: "board") }
        .help(serviceHelp(item))
    }
}

/// The panel's section, after its task lists.
struct PanelServices: View {
    let monitor: Monitor

    var body: some View {
        if !monitor.services.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: "server.rack").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                    Text("Background services").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    Text("\(monitor.services.count)").font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 2)
                ForEach(monitor.services) { PanelServiceRow(item: $0, monitor: monitor) }
            }
        }
    }
}

private struct PanelServiceRow: View {
    let item: ServiceItem
    let monitor: Monitor
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            ServiceDot(command: item.command).frame(width: 18)
            AgentMarkView(agent: item.agent, size: 11)
            Text(item.command.title).font(.system(size: 12.5, weight: .medium)).lineLimit(1)
            PortLinks(ports: item.command.ports ?? [])
            Spacer(minLength: 4)
            ServiceState(command: item.command, monitor: monitor)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .opacity(item.command.isRunning ? 1 : 0.7)
        .background(RoundedRectangle(cornerRadius: 9).fill(hover ? Color.primary.opacity(0.07) : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { monitor.focus(item.taskID, via: "panel") }
        .help(serviceHelp(item))
    }
}

private struct ServiceDot: View {
    let command: BackgroundCommand

    static func color(_ c: BackgroundCommand) -> Color {
        switch c.state {
        case "running": return Theme.success
        case "failed": return Theme.failed
        default: return Color.secondary
        }
    }

    var body: some View {
        Circle().fill(Self.color(command)).frame(width: 7, height: 7)
    }
}

/// ":5173" for each port, opening http://localhost:<port> in the browser.
private struct PortLinks: View {
    let ports: [Int]

    var body: some View {
        ForEach(ports.prefix(3), id: \.self) { port in
            Button(":\(String(port))") {
                if let url = URL(string: "http://localhost:\(port)") { NSWorkspace.shared.open(url) }
            }
            .buttonStyle(.plain)
            .font(.system(size: 11, weight: .medium).monospacedDigit())
            .foregroundStyle(Theme.doing)
            .help(String(localized: "Open http://localhost:\(String(port))"))
        }
    }
}

/// "Running 12 min", "Exited · 3 min ago", "Failed (exit 1) · 3 min ago". Reads the minute clock
/// only here, so the rows around it don't re-render.
private struct ServiceState: View {
    let command: BackgroundCommand
    let monitor: Monitor

    var body: some View {
        Text(text(now: monitor.minute))
            .font(.system(size: 11).monospacedDigit())
            .foregroundStyle(command.state == "failed" ? Theme.failed : .secondary)
            .lineLimit(1)
            .fixedSize()
    }

    private func text(now: Date) -> String {
        if command.isRunning {
            guard let start = dateFromMs(command.startedAt) else { return String(localized: "Running") }
            return String(localized: "Running \(Fmt.dur(max(60, now.timeIntervalSince(start))))")
        }
        let how: String
        switch command.state {
        case "failed": how = command.exitCode.map { String(localized: "Failed (exit \($0))") } ?? String(localized: "Failed")
        case "stopped": how = String(localized: "Stopped")
        default: how = String(localized: "Exited")
        }
        guard let end = dateFromMs(command.endedAt) else { return how }
        let ago = now.timeIntervalSince(end)
        return "\(how) · \(ago < 60 ? String(localized: "Just now") : String(localized: "\(Fmt.dur(ago)) ago"))"
    }
}

private func serviceHelp(_ item: ServiceItem) -> String {
    [item.command.command, String(localized: "Click to jump to its task")].compactMap { $0 }.joined(separator: "\n")
}
