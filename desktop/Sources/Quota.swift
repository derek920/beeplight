import SwiftUI

/// Plan limits (server utilization) next to this machine's token usage in the same windows.

func quotaColor(_ u: Double) -> Color {
    u >= 0.8 ? Theme.failed : u >= 0.5 ? Theme.waiting : Theme.success
}

struct QuotaBar: View {
    let value: Double
    var height: CGFloat = 7

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule()
                    .fill(quotaColor(value).gradient)
                    .frame(width: max(value > 0 ? height : 0, g.size.width * min(1, value)))
            }
        }
        .frame(height: height)
        .animation(.easeOut(duration: 0.6), value: value)
    }
}

/// Cost-weighted usage per bucket across the window; buckets after now are left empty.
struct UsageBars: View {
    let values: [Double]
    let range: WindowRange?
    let now: Date

    var body: some View {
        let top = max(values.max() ?? 0, 1e-9)
        let nowMs = now.timeIntervalSince1970 * 1000
        let step = range.map { ($0.end - $0.start) / Double(max(values.count, 1)) } ?? 0
        GeometryReader { g in
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(values.indices, id: \.self) { i in
                    let future = range.map { $0.start + Double(i) * step > nowMs } ?? false
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(future ? Color.clear : Theme.doing.opacity(0.72))
                        .frame(height: values[i] > 0 ? max(3, CGFloat(values[i] / top) * g.size.height) : 0)
                        .frame(maxWidth: .infinity)
                        .help("≈\(Fmt.usd(values[i]))")
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .bottom)
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Color.primary.opacity(0.1)).frame(height: 1) }
    }
}

/// Time marks under the bars: each hour of a 5-hour window, each day of a week (named in the
/// middle of the day, ticks at midnight). Same marks as axisHTML() in public/app.js.
struct UsageAxis: View {
    let range: WindowRange
    let days: Bool

    var body: some View {
        let (ticks, labels) = Self.marks(range, days: days)
        GeometryReader { g in
            ForEach(ticks, id: \.self) { x in
                Rectangle().fill(Color.primary.opacity(0.2)).frame(width: 1, height: 3).position(x: x * g.size.width, y: 1.5)
            }
            ForEach(labels, id: \.0) { x, label in
                Text(label).font(.system(size: 9.5).monospacedDigit()).foregroundStyle(.tertiary).fixedSize()
                    .position(x: x * g.size.width, y: 10)
            }
        }
        .frame(height: 16)
    }

    /// Positions from 0 to 1 across the window.
    static func marks(_ r: WindowRange, days: Bool) -> (ticks: [Double], labels: [(Double, String)]) {
        let cal = Calendar.current
        let start = Date(timeIntervalSince1970: r.start / 1000)
        let end = Date(timeIntervalSince1970: r.end / 1000)
        let span = end.timeIntervalSince(start)
        guard span > 0 else { return ([], []) }
        func at(_ d: Date) -> Double { d.timeIntervalSince(start) / span }
        var ticks: [Double] = []
        var labels: [(Double, String)] = []
        if days {
            let f = DateFormatter()
            f.locale = Fmt.locale
            f.setLocalizedDateFormatFromTemplate("EEE")
            var day = cal.startOfDay(for: start)
            while day < end, let next = cal.date(byAdding: .day, value: 1, to: day) {
                let (a, b) = (max(day, start), min(next, end))
                // Only days mostly in the window get a name; a sliver at either end stays blank.
                if b.timeIntervalSince(a) >= 12 * 3600 { labels.append((at(a + b.timeIntervalSince(a) / 2), f.string(from: a))) }
                if next < end { ticks.append(at(next)) }
                day = next
            }
        } else {
            var hour = cal.dateInterval(of: .hour, for: start)?.end ?? end
            while hour < end {
                let x = at(hour)
                // Any closer to an edge and the label sticks out of the card.
                if x > 0.04 && x < 0.96 {
                    ticks.append(x)
                    labels.append((x, Fmt.clock(hour.timeIntervalSince1970 * 1000)))
                }
                hour += 3600
            }
        }
        return (ticks, labels)
    }
}

func projectionText(_ w: LimitWindow?) -> (String, Bool) {
    guard let w else { return ("", false) }
    guard let p = w.projection else { return (String(localized: "Sampling; burn rate coming soon"), false) }
    guard let rate = p.ratePerHour, rate > 0 else { return (String(localized: "No new usage lately"), false) }
    let speed = String(localized: "+\(Fmt.pct(rate)) per hour")
    if p.beforeReset == true, let eta = p.etaMs { return (String(localized: "\(speed), runs out in about \(Fmt.dur(eta / 1000)) (before reset)"), true) }
    return (String(localized: "\(speed), lasts until reset"), false)
}

struct QuotaCard: View {
    let title: String
    let window: LimitWindow?
    let local: UsageTotals?
    let range: WindowRange?
    let buckets: [Double]
    let now: Date
    var withDay = false

    var body: some View {
        let nowMs = now.timeIntervalSince1970 * 1000
        let (proj, hot) = projectionText(window)
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(window.map { Fmt.pct($0.utilization) } ?? "—")
                    .font(.system(size: 26, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(window.map { quotaColor($0.utilization) } ?? .secondary)
                    .contentTransition(.numericText())
                Text(window.map { String(localized: "Resets \(Fmt.clock($0.resetsAt, withDay: withDay)) · \(Fmt.dur(($0.resetsAt - nowMs) / 1000)) left") } ?? String(localized: "No limit data yet"))
                    .font(.system(size: 11.5).monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            QuotaBar(value: window?.utilization ?? 0)
            if !proj.isEmpty {
                Text(proj).font(.system(size: 11)).foregroundStyle(hot ? Theme.failed : .secondary)
            }
            if let local {
                Text("This Mac: \(Fmt.tokens(local.tokens)) tokens · \(Fmt.tokens(local.out)) output · ≈\(Fmt.usd(local.cost))")
                    .font(.system(size: 11).monospacedDigit())
                    .foregroundStyle(.tertiary)
                    .help("Usage in this window from this Mac's transcripts (subagents included), not counting claude.ai on the web or other devices. Amounts are API-equivalent prices used only as weights, not a bill.")
            }
            Spacer(minLength: 4)
            VStack(spacing: 0) {
                UsageBars(values: buckets, range: range, now: now).frame(height: 30)
                if let range { UsageAxis(range: range, days: withDay) }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .themedCard(accent: window.map { quotaColor($0.utilization) } ?? Theme.doing)
    }
}

struct TopSessionsCard: View {
    let rows: [TopSession]
    let weekly: Double?
    let note: String
    let onTap: (String) -> Void
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Text("Top sessions this week").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
                Text("Share of weekly limit (est.)").font(.system(size: 10.5)).foregroundStyle(.tertiary)
            }
            if rows.isEmpty {
                Text("No usage this week yet").font(.system(size: 12)).foregroundStyle(.tertiary)
            }
            ForEach(Array(rows.prefix(5).enumerated()), id: \.element.id) { i, r in
                TopRow(rank: i + 1, row: r, weekly: weekly).onTapGesture { onTap(r.sid) }
            }
            Spacer(minLength: 2)
            HStack(spacing: 6) {
                Text(note).font(.system(size: 10.5)).foregroundStyle(.tertiary)
                Button("Refresh limits", action: onRefresh).buttonStyle(.link).font(.system(size: 10.5))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .themedCard(accent: Theme.doing)
    }
}

private struct TopRow: View {
    let rank: Int
    let row: TopSession
    let weekly: Double?
    @State private var hover = false

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Text("\(rank)").font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary).frame(width: 12)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(row.title).font(.system(size: 12)).lineLimit(1)
                    if row.live == true { Text("Live").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.success) }
                    Spacer(minLength: 4)
                    Text(Fmt.tokens(row.tokens)).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
                    Text(row.share.map { "≈" + Fmt.pct($0) } ?? Fmt.usd(row.cost))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .frame(width: 44, alignment: .trailing)
                }
                QuotaBar(value: (row.share ?? 0) / max(weekly ?? 0, 1e-9), height: 3)
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Color.primary.opacity(0.06) : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .help("\(row.project ?? "") · requests: \(row.requests ?? 0) · about \(Fmt.usd(row.cost)) at API prices")
    }
}

struct QuotaRow: View {
    @ObservedObject var monitor: Monitor

    var body: some View {
        let u = monitor.meta?.usage
        HStack(alignment: .top, spacing: 14) {
            QuotaCard(title: String(localized: "5-hour limit"), window: u?.limits?.fiveHour, local: u?.fiveHour, range: u?.windows?.fiveHour,
                      buckets: u?.buckets5h ?? [], now: monitor.now)
            QuotaCard(title: String(localized: "Weekly limit"), window: u?.limits?.sevenDay, local: u?.sevenDay, range: u?.windows?.sevenDay,
                      buckets: u?.buckets7d ?? [], now: monitor.now, withDay: true)
            TopSessionsCard(rows: u?.top ?? [], weekly: u?.limits?.sevenDay?.utilization, note: monitor.limitsNote,
                            onTap: { monitor.focus($0) }, onRefresh: { monitor.refreshLimits() })
        }
        .frame(height: 176)
    }
}

/// Two thin bars for the menu bar panel.
struct CompactQuota: View {
    @ObservedObject var monitor: Monitor

    var body: some View {
        let L = monitor.meta?.usage?.limits
        VStack(spacing: 5) {
            line(String(localized: "5h"), L?.fiveHour, withDay: false)
            line(String(localized: "Week"), L?.sevenDay, withDay: true)
        }
    }

    private func line(_ label: String, _ w: LimitWindow?, withDay: Bool) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
            QuotaBar(value: w?.utilization ?? 0, height: 5)
            Text(Fmt.pct(w?.utilization))
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(w.map { quotaColor($0.utilization) } ?? .secondary)
                .frame(width: 34, alignment: .trailing)
            Text(w.map { String(localized: "Resets \(Fmt.clock($0.resetsAt, withDay: withDay))") } ?? "—")
                .font(.system(size: 10.5).monospacedDigit())
                .foregroundStyle(.tertiary)
                .frame(width: 104, alignment: .trailing)
        }
    }
}
