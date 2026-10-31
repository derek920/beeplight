import AppKit
import SwiftUI

/// Main window: three columns (Waiting / Doing / Done) of task cards.
struct BoardView: View {
    let monitor: Monitor
    @ObservedObject var appearance = Appearance.shared
    @Namespace private var ns
    @State private var doneFilter = "all"

    var body: some View {
        VStack(spacing: 0) {
            BoardHeader(monitor: monitor)
            QuotaRow(monitor: monitor)
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
            if monitor.visible.isEmpty {
                EmptyState(connected: monitor.connected)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                HStack(alignment: .top, spacing: 14) {
                    BoardColumn(title: "Waiting", hint: String(localized: "Needs your attention"), color: Theme.waiting, items: monitor.waiting,
                                empty: String(localized: "Nothing is waiting for you"), ns: ns, monitor: monitor)
                    BoardColumn(title: "Doing", hint: String(localized: "Claude is working"), color: Theme.doing, items: monitor.doing,
                                empty: String(localized: "Nothing is running"), ns: ns, monitor: monitor)
                    BoardColumn(title: "Done", hint: String(localized: "Turn ended"), color: Theme.success, items: filteredDone,
                                empty: String(localized: "Nothing finished yet"), ns: ns, monitor: monitor, unread: monitor.unreadDone.count) {
                        if !monitor.unreadDone.isEmpty {
                            Button { monitor.markAllRead() } label: {
                                Label("Mark all read", systemImage: "checkmark.circle")
                                    .font(.system(size: 11.5, weight: .medium))
                                    .lineLimit(1)
                            }
                            .buttonStyle(.borderless)
                            .foregroundStyle(Theme.doing)
                            .fixedSize()
                            .help("Mark every new finish as read")
                        }
                        // A compact menu, so the header never has to wrap.
                        Picker("", selection: $doneFilter) {
                            Text("All").tag("all")
                            Text("Succeeded").tag("success")
                            Text("Failed").tag("failed")
                        }
                        .pickerStyle(.menu)
                        .labelsHidden()
                        .controlSize(.small)
                        .fixedSize()
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            FooterLine(monitor: monitor)
        }
        .frame(minWidth: 1040, minHeight: 680)
        .background(ThemedBackdrop().ignoresSafeArea())
        .themedRoot()
        .id(appearance.revision)
        .overlay(alignment: .bottom) { ToastView(text: monitor.toast) }
        .onAppear {
            // Show in the Dock and ⌘-Tab while the board is open; menu bar only otherwise.
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
        }
        .onDisappear { NSApp.setActivationPolicy(.accessory) }
    }

    private var filteredDone: [TaskItem] {
        switch doneFilter {
        case "success": return monitor.done.filter { $0.phase == .success }
        case "failed": return monitor.done.filter { $0.phase == .failed }
        default: return monitor.done
        }
    }
}

private struct BoardHeader: View {
    let monitor: Monitor

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 14) {
                AppMark(size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Beeplight").font(.system(size: 18, weight: .bold))
                    Text("Every Claude Code session and agent on this Mac · Click a card to jump to its window")
                        .font(.system(size: 11.5)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 20)
                HStack(spacing: 8) {
                    BigStat(value: monitor.waiting.count, label: String(localized: "Waiting"), color: monitor.anyUrgent ? Theme.urgent : Theme.waiting)
                    BigStat(value: monitor.doing.count, label: String(localized: "Running"), color: Theme.doing)
                    BigStat(value: monitor.done.filter { $0.phase == .success }.count, label: String(localized: "Done"), color: Theme.success)
                    BigStat(value: monitor.done.filter { $0.phase == .failed }.count, label: String(localized: "Failed"), color: Theme.failed)
                }
                Spacer(minLength: 20)
                VStack(alignment: .trailing, spacing: 6) {
                    LiveBadge(monitor: monitor)
                    SettingsMenu(monitor: monitor)
                }
            }
            TodayBanner(monitor: monitor)
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 14)
    }
}

/// Today's totals change every second while Claude works, so only this view reads them.
private struct TodayBanner: View {
    let monitor: Monitor

    var body: some View {
        if let t = monitor.today {
            TodayLine(today: t)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color.primary.opacity(0.05)))
        }
    }
}

private struct BigStat: View {
    let value: Int
    let label: String
    let color: Color

    var body: some View {
        VStack(spacing: 0) {
            Text("\(value)")
                .font(.system(size: 22, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(value > 0 ? color : Color.secondary.opacity(0.5))
                .contentTransition(.numericText())
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .frame(width: 66)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(value > 0 ? color.opacity(0.11) : Color.primary.opacity(0.04)))
        .animation(.snappy, value: value)
    }
}

/// The app's mark: a three-color status ring.
struct AppMark: View {
    var size: CGFloat = 28

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26)
                .fill(LinearGradient(colors: [Color(white: 0.16), Color(white: 0.07)], startPoint: .top, endPoint: .bottom))
            ForEach(Array([(Theme.waiting, 0.0), (Theme.doing, 0.345), (Theme.success, 0.69)].enumerated()), id: \.offset) { _, part in
                Circle()
                    .trim(from: part.1 + 0.03, to: part.1 + 0.28)
                    .stroke(part.0, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(size * 0.22)
            }
            Circle().fill(.white).frame(width: size * 0.16, height: size * 0.16)
        }
        .frame(width: size, height: size)
    }
}

private struct BoardColumn<Accessory: View>: View {
    let title: String
    let hint: String
    let color: Color
    let items: [TaskItem]
    let empty: String
    let ns: Namespace.ID
    let monitor: Monitor
    let unread: Int
    var accessory: Accessory

    init(title: String, hint: String, color: Color, items: [TaskItem], empty: String, ns: Namespace.ID,
         monitor: Monitor, unread: Int = 0, @ViewBuilder accessory: () -> Accessory = { EmptyView() }) {
        self.title = title
        self.hint = hint
        self.color = color
        self.items = items
        self.empty = empty
        self.ns = ns
        self.monitor = monitor
        self.unread = unread
        self.accessory = accessory()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(color).frame(width: 9, height: 9).shadow(color: color.opacity(0.6), radius: 3)
                Text(title).font(.system(size: 14, weight: .bold)).fixedSize()
                // The hint is the first thing to go when the header gets tight.
                if unread == 0 {
                    Text(hint).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1).layoutPriority(-1)
                }
                Text("\(items.count)")
                    .font(.system(size: 11, weight: .semibold).monospacedDigit())
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.primary.opacity(0.07)))
                    .contentTransition(.numericText())
                    .fixedSize()
                if unread > 0 {
                    HStack(spacing: 4) {
                        Circle().fill(.white).frame(width: 5, height: 5)
                        Text("\(unread) new").font(.system(size: 11, weight: .bold).monospacedDigit())
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1.5)
                    .background(Capsule().fill(Theme.doing))
                    .fixedSize()
                    .help("\(unread) finished, not viewed yet")
                }
                Spacer(minLength: 4)
                accessory
            }
            .padding(.horizontal, 4)
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(items) { item in
                        TaskCard(item: item, monitor: monitor)
                            .matchedGeometryEffect(id: item.id, in: ns)
                            .transition(.scale(scale: 0.96).combined(with: .opacity))
                    }
                    if items.isEmpty {
                        Text(empty)
                            .font(.system(size: 12.5))
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 30)
                    }
                }
                .padding(2)
            }
            .scrollIndicators(.never)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: Theme.palette.corner + 4, style: .continuous).fill(Theme.column))
    }
}

struct TaskCard: View {
    let item: TaskItem
    let monitor: Monitor
    @State private var hover = false

    var body: some View {
        let urgent = monitor.isUrgent(item)
        let color = Theme.color(item.phase, urgent: urgent)

        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if item.unread == true { UnreadDot() }
                StatusGlyph(phase: item.phase, urgent: urgent, size: 16)
                StateLabel(text: item.label, color: color)
                if item.summarizing == true {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("Summarizing").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                    }
                }
                Spacer()
                Ticking(monitor) { now in
                    Text(Fmt.elapsed(item, now: now))
                        .font(.system(size: 11.5).monospacedDigit())
                        .foregroundStyle(urgent ? Theme.urgent : .secondary)
                }
            }

            Text(item.title)
                .font(.system(size: 14.5, weight: .semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if let goal = item.goal, !goal.isEmpty {
                Text(goal)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let detail = item.detail, !detail.isEmpty {
                Text(detail)
                    .font(item.isToolDetail ? .system(size: 11.5, design: .monospaced) : .system(size: 12))
                    .foregroundStyle(item.pending == true ? Color.secondary : Color.primary)
                    .lineLimit(3)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.1)))
            }
            if let agents = item.subagents, !agents.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(agents.prefix(4)) { a in
                        HStack(spacing: 6) {
                            if a.running {
                                Spinner(color: Theme.doing, size: 10)
                            } else {
                                Image(systemName: "checkmark").font(.system(size: 8, weight: .bold)).foregroundStyle(.tertiary).frame(width: 10)
                            }
                            Text(a.type ?? "agent").font(.system(size: 11, weight: .semibold))
                            Text(a.activity ?? a.description ?? "").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    if agents.count > 4 {
                        Text("… and \(agents.count - 4) more").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                    }
                }
            }

            if let u = item.usage {
                HStack(spacing: 5) {
                    Image(systemName: "chart.bar.fill").font(.system(size: 9)).foregroundStyle(.tertiary)
                    Text(usageText(u)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                }
                .help("Requests: \(u.total.requests), output tokens: \(Fmt.tokens(u.total.out)), about \(Fmt.usd(u.total.cost)) at API prices. The share of a limit is estimated from API-equivalent cost as a part of this Mac's usage; other devices aren't counted.")
            }

            VStack(alignment: .leading, spacing: 4) {
                Ticking(monitor) { now in
                    StateStrip(history: item.history ?? [], now: now, height: 5)
                    HStack {
                        Text("Last 30 min")
                        Spacer()
                        let s = item.turnStats(now: now)
                        if s.work >= 1 || s.wait >= 1 {
                            Text(s.wait >= 1 ? String(localized: "This turn: ran \(Fmt.dur(s.work)) · waited \(Fmt.dur(s.wait))") : String(localized: "This turn: ran \(Fmt.dur(s.work))"))
                        }
                    }
                    .font(.system(size: 10.5).monospacedDigit())
                    .foregroundStyle(.tertiary)
                }
            }

            HStack(spacing: 5) {
                if let r = item.remote { Chip(text: r.label, tint: r.online ? Theme.doing : nil).help("Runs on another device; synced through your relay") }
                Chip(text: item.project ?? "—").help(item.cwd ?? "")
                Chip(text: item.hostText)
                if item.stopped == true { Chip(text: String(localized: "Suspended"), tint: Theme.waiting).help("The process is suspended (Ctrl+Z); type fg in its terminal to resume") }
                if item.ended == true, item.endReason == "switched" { Chip(text: String(localized: "Switched to a new session")) } else if item.ended == true, item.endReason != "background" { Chip(text: String(localized: "Closed")) }
                Spacer(minLength: 4)
                // Another device's task is read-only here.
                if item.remote == nil {
                    if hover {
                        IconButton(symbol: "arrow.clockwise", help: String(localized: "Summarize title and result again")) { monitor.resummarize(item.id) }
                        if item.phase == .success || item.phase == .failed {
                            IconButton(symbol: "xmark", help: String(localized: "Remove from board (it comes back on new activity)")) { monitor.dismiss(item.id) }
                        }
                    }
                    Button { monitor.focus(item.id) } label: {
                        Label(item.primaryAction, systemImage: "arrow.up.forward.app").font(.system(size: 11.5, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    // The chips give way first; the action label is never cut.
                    .fixedSize()
                }
            }
        }
        .padding(12)
        .padding(.leading, 4)
        .overlay(alignment: .leading) {
            UnevenRoundedRectangle(topLeadingRadius: Theme.palette.corner, bottomLeadingRadius: Theme.palette.corner, style: .continuous)
                .fill(color)
                .frame(width: Theme.palette.brackets ? 2 : 4)
                .stateGlow(color)
        }
        .themedCard(accent: urgent ? color : item.unread == true ? Theme.doing : color,
                    emphasized: urgent || item.unread == true, glowBoost: hover)
        .background {
            // An urgent card's glow breathes; only glowing themes show it.
            if urgent, Theme.breathing, Theme.palette.glow > 0 {
                BreathingGlow(color: color, corner: Theme.palette.corner, radius: Theme.palette.glow * 1.6)
            }
        }
        .opacity(item.ended == true ? 0.82 : 1)
        .scaleEffect(hover ? 1.012 : 1)
        .animation(.easeOut(duration: 0.15), value: hover)
        .contentShape(RoundedRectangle(cornerRadius: 12))
        .onHover { hover = $0 }
        .onTapGesture { monitor.focus(item.id, via: "board") }
        .contextMenu { ItemMenu(item: item, monitor: monitor) }
        .help(item.lastPrompt.map { String(localized: "Last request: \($0)") } ?? "")
    }
}

private func usageText(_ u: SessionUsage) -> String {
    var parts = [String(localized: "Session: \(Fmt.tokens(u.total.tokens)) tokens")]
    if let s = u.fiveHour.share, u.fiveHour.tokens > 0 { parts.append(String(localized: "5h ≈\(Fmt.pct(s))")) }
    if let s = u.sevenDay.share, u.sevenDay.tokens > 0 { parts.append(String(localized: "wk ≈\(Fmt.pct(s))")) }
    return parts.joined(separator: " · ")
}

private struct IconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 10.5, weight: .semibold)).frame(width: 18, height: 18)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .help(help)
    }
}

@MainActor
private struct FooterLine: View {
    let monitor: Monitor

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text).font(.system(size: 11)).foregroundStyle(.tertiary)
            Spacer(minLength: 16)
            CpuLine(monitor: monitor)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 10)
    }

    private var text: String {
        var parts: [String] = []
        if monitor.idleCount > 0 { parts.append(String(localized: "Empty sessions hidden: \(monitor.idleCount)")) }
        if monitor.staleCount > 0 { parts.append(String(localized: "Sessions quiet for 12+ hr hidden: \(monitor.staleCount)")) }
        if let s = monitor.summarizer {
            var t = String(localized: "Haiku summaries: \(s.ok) done")
            if s.inflight + s.queued > 0 { t += String(localized: ", \(s.inflight) running, \(s.queued) queued") }
            if s.failed > 0 { t += String(localized: ", \(s.failed) failed") }
            parts.append(t)
        }
        if let me = monitor.limits?.monitorSelf, let calls = me.calls, calls > 0 {
            parts.append(String(localized: "Beeplight's Haiku calls today: \(calls) ≈\(Fmt.usd(me.cost ?? 0))"))
        }
        return parts.joined(separator: " · ")
    }
}
