import Charts
import SwiftUI

/// The limit details window, opened from a limit card on the board: one limit window's usage at a
/// chosen granularity, the limit's measured utilization through it, and where the usage went. The
/// service builds it on request (GET /api/usage/detail, src/core/usage-detail.js), so it is only
/// fetched while this window is open.

struct UsageDetail: Decodable, Equatable {
    struct Kinds: Decodable, Equatable {
        var tokens: Double
        var input: Double
        var out: Double
        var cw: Double
        var cr: Double
        var cost: Double
        var requests: Int

        enum CodingKeys: String, CodingKey {
            case tokens, input = "in", out, cw, cr, cost, requests
        }
    }

    struct Bucket: Decodable, Equatable, Identifiable {
        var start: Double
        var end: Double
        var kinds: Kinds
        /// The sessions that used the most in it.
        var top: [Top]
        var id: Double { start }

        enum CodingKeys: String, CodingKey {
            case start, end, top
        }

        // The token counts sit next to start and end in the JSON.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            start = try c.decode(Double.self, forKey: .start)
            end = try c.decode(Double.self, forKey: .end)
            top = try c.decode([Top].self, forKey: .top)
            kinds = try Kinds(from: decoder)
        }
    }

    struct Top: Decodable, Equatable {
        var sid: String
        var title: String
        var cost: Double
    }

    struct Point: Decodable, Equatable {
        var t: Double
        var u: Double
    }

    struct Model: Decodable, Equatable {
        var model: String
        var tokens: Double
        var cost: Double
        var requests: Int
    }

    struct Project: Decodable, Equatable {
        var project: String
        var tokens: Double
        var cost: Double
        var sessions: Int
    }

    struct Session: Decodable, Equatable, Identifiable {
        var sid: String
        var title: String
        var project: String
        var live: Bool
        var tokens: Double
        var cost: Double
        var share: Double?
        var id: String { sid }
    }

    /// "5h" or "7d".
    var window: String
    var step: String
    var steps: [String]
    var range: WindowRange
    var now: Double
    var limit: LimitWindow?
    var utilization: [Point]
    var buckets: [Bucket]
    var total: Kinds
    var models: [Model]
    var projects: [Project]
    var sessions: [Session]
}

@MainActor
final class QuotaDetailModel: ObservableObject {
    static let shared = QuotaDetailModel()
    /// "5h" or "7d"; the card that was clicked sets it.
    @Published var window = "5h"
    /// The bucket size picked for each window, kept across launches; the service's default until then.
    @Published var steps: [String: String] = UserDefaults.standard.dictionary(forKey: "quotaDetailSteps") as? [String: String] ?? [:] {
        didSet { UserDefaults.standard.set(steps, forKey: "quotaDetailSteps") }
    }
    @Published private(set) var detail: UsageDetail?
    @Published private(set) var error: String?

    func load() async {
        let window = window
        var url = Monitor.shared.base.appending(path: "api/usage/detail")
        url.append(queryItems: [URLQueryItem(name: "window", value: window)] + (steps[window].map { [URLQueryItem(name: "step", value: $0)] } ?? []))
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            // A size this service no longer offers: fall back to its default.
            if (response as? HTTPURLResponse)?.statusCode == 400, steps[window] != nil {
                steps[window] = nil
                return await load()
            }
            let d = try JSONDecoder().decode(UsageDetail.self, from: data)
            guard d.window == self.window else { return }
            if detail != d { detail = d }
            error = nil
        } catch {
            self.error = String(localized: "Couldn't load: \(error.localizedDescription)")
        }
    }
}

struct QuotaDetailView: View {
    let monitor: Monitor
    @ObservedObject var model = QuotaDetailModel.shared
    @ObservedObject var appearance = Appearance.shared
    /// The time under the pointer in the usage chart.
    @State private var hover: Date?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                controls
                if let d = model.detail, d.window == model.window {
                    content(d)
                } else if let e = model.error {
                    Text(e).font(.system(size: 12)).foregroundStyle(Theme.failed)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(18)
        }
        .frame(minWidth: 780, minHeight: 620)
        .background(ThemedBackdrop().ignoresSafeArea())
        .themedRoot()
        .environment(\.locale, Fmt.locale)
        .id(appearance.revision)
        // Fresh numbers while the window is open; nothing is fetched once it closes.
        .task(id: "\(model.window) \(model.steps[model.window] ?? "")") {
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private var controls: some View {
        HStack(spacing: 12) {
            Picker("", selection: $model.window) {
                Text("5-hour limit").tag("5h")
                Text("Weekly limit").tag("7d")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            Spacer()
            if let d = model.detail, d.window == model.window {
                Picker("", selection: Binding(get: { model.steps[d.window] ?? d.step }, set: { model.steps[d.window] = $0 })) {
                    ForEach(d.steps, id: \.self) { Text(Self.stepName($0)).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .help("Size of each bar")
            }
        }
    }

    static func stepName(_ step: String) -> String {
        switch step {
        case "10m": return String(localized: "10 min")
        case "30m": return String(localized: "30 min")
        case "1h": return String(localized: "1 hour")
        case "6h": return String(localized: "6 hours")
        case "1d": return String(localized: "1 day")
        default: return step
        }
    }

    @ViewBuilder private func content(_ d: UsageDetail) -> some View {
        summary(d)
        card(String(localized: "Limit used"), String(localized: "Readings from Anthropic's servers; the dashed line follows the current rate until the reset")) {
            UtilizationChart(detail: d)
        }
        card(String(localized: "Usage on this Mac"), String(localized: "Weighted by API prices, a rough stand-in for how limits count")) {
            UsageChart(detail: d, hover: $hover)
            hoverLine(d)
        }
        // Side by side at the taller one's height.
        HStack(alignment: .top, spacing: 14) {
            card(String(localized: "Models"), nil) { models(d) }
            card(String(localized: "Token types"), nil) { kinds(d) }
        }
        .fixedSize(horizontal: false, vertical: true)
        HStack(alignment: .top, spacing: 14) {
            card(String(localized: "Projects"), nil) { projects(d) }
            card(String(localized: "Sessions"), String(localized: "Click to jump to one")) { sessions(d) }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func summary(_ d: UsageDetail) -> some View {
        let withDay = d.window == "7d"
        let (proj, hot) = projectionText(d.limit)
        return HStack(alignment: .center, spacing: 12) {
            Text(d.limit.map { Fmt.pct($0.utilization) } ?? "—")
                .font(.system(size: 32, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(d.limit.map { quotaColor($0.utilization) } ?? .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(d.limit.map { String(localized: "Resets \(Fmt.clock($0.resetsAt, withDay: withDay)) · \(Fmt.dur(($0.resetsAt - d.now) / 1000)) left") } ?? String(localized: "No limit data yet"))
                    .font(.system(size: 12).monospacedDigit())
                    .foregroundStyle(.secondary)
                if !proj.isEmpty { Text(proj).font(.system(size: 11.5)).foregroundStyle(hot ? Theme.failed : .secondary) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text("This Mac: \(Fmt.tokens(d.total.tokens)) tokens · \(Fmt.tokens(d.total.out)) output · ≈\(Fmt.usd(d.total.cost))")
                Text("Requests: \(d.total.requests)")
            }
            .font(.system(size: 11.5).monospacedDigit())
            .foregroundStyle(.secondary)
        }
    }

    private func card<Content: View>(_ title: String, _ hint: String?, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                if let hint { Text(hint).font(.system(size: 10.5)).foregroundStyle(.tertiary).lineLimit(1) }
            }
            content()
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .themedCard(accent: Theme.doing)
    }

    /// Under the usage chart: the bar under the pointer, or how to get one.
    @ViewBuilder private func hoverLine(_ d: UsageDetail) -> some View {
        if let b = UsageChart.bucket(at: hover, in: d) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text(Self.span(b, days: d.window == "7d")).font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                    Text("\(Fmt.tokens(b.kinds.tokens)) tokens · \(Fmt.tokens(b.kinds.out)) output · ≈\(Fmt.usd(b.kinds.cost)) · requests: \(b.kinds.requests)")
                        .font(.system(size: 11.5).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                if !b.top.isEmpty {
                    Text("Most used by: \(b.top.map(\.title).joined(separator: ", "))")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            .frame(height: 32, alignment: .topLeading)
        } else {
            Text("Point at a bar to see what went into it")
                .font(.system(size: 11))
                .foregroundStyle(.tertiary)
                .frame(height: 32, alignment: .topLeading)
        }
    }

    /// "21:10–21:20", or "Fri 06:00–12:00" in the weekly window.
    static func span(_ b: UsageDetail.Bucket, days: Bool) -> String {
        "\(Fmt.clock(b.start, withDay: days))–\(Fmt.clock(b.end))"
    }

    private func share(_ cost: Double, _ d: UsageDetail) -> Double { d.total.cost > 0 ? cost / d.total.cost : 0 }

    @ViewBuilder private func models(_ d: UsageDetail) -> some View {
        if d.models.isEmpty { empty }
        ForEach(d.models, id: \.model) { m in
            ShareRow(name: m.model, note: String(localized: "Requests: \(m.requests)"),
                     value: "\(Fmt.tokens(m.tokens)) · \(Fmt.pct(share(m.cost, d)))", fraction: share(m.cost, d), color: Theme.doing)
        }
    }

    @ViewBuilder private func kinds(_ d: UsageDetail) -> some View {
        let t = d.total
        let rows: [(String, Double, Color)] = [
            (String(localized: "Input"), t.input, Theme.doing),
            (String(localized: "Output"), t.out, Theme.success),
            (String(localized: "Cache write"), t.cw, Theme.waiting),
            (String(localized: "Cache read"), t.cr, Theme.doing.opacity(0.5)),
        ]
        if t.tokens <= 0 { empty }
        ForEach(rows, id: \.0) { name, n, color in
            let f = t.tokens > 0 ? n / t.tokens : 0
            ShareRow(name: name, note: nil, value: "\(Fmt.tokens(n)) · \(Fmt.pct(f))", fraction: f, color: color)
        }
    }

    /// The limit share when there is a limit reading, else the API-equivalent amount.
    private func amount(_ cost: Double, _ d: UsageDetail) -> String {
        guard let l = d.limit, d.total.cost > 0 else { return "≈" + Fmt.usd(cost) }
        return "≈" + Fmt.pct(cost / d.total.cost * l.utilization)
    }

    @ViewBuilder private func projects(_ d: UsageDetail) -> some View {
        if d.projects.isEmpty { empty }
        ForEach(d.projects, id: \.project) { p in
            ShareRow(name: p.project.isEmpty ? "—" : p.project, note: String(localized: "Sessions: \(p.sessions)"),
                     value: "\(Fmt.tokens(p.tokens)) · \(amount(p.cost, d))", fraction: share(p.cost, d), color: Theme.doing)
        }
    }

    @ViewBuilder private func sessions(_ d: UsageDetail) -> some View {
        if d.sessions.isEmpty { empty }
        ForEach(d.sessions) { s in
            Button { monitor.focus(s.sid) } label: {
                ShareRow(name: s.title, note: s.project, value: "\(Fmt.tokens(s.tokens)) · \(amount(s.cost, d))",
                         fraction: share(s.cost, d), color: Theme.doing, live: s.live)
            }
            .buttonStyle(.plain)
        }
    }

    private var empty: some View {
        Text("No usage in this window yet").font(.system(size: 12)).foregroundStyle(.tertiary)
    }
}

/// The limit's utilization readings through the window, the trend at the current rate until the
/// reset, and now.
private struct UtilizationChart: View {
    let detail: UsageDetail

    var body: some View {
        let d = detail
        let pts = d.utilization
        let trend = Self.trend(d)
        let peak = (pts.map(\.u) + trend.map(\.u)).max() ?? 0
        // Room above the line; the whole limit once it gets close.
        let top = peak > 0.7 ? 1.0 : max(0.2, min(1, peak * 1.3))
        let color = d.limit.map { quotaColor($0.utilization) } ?? Theme.doing
        Chart {
            ForEach(pts, id: \.t) { p in
                AreaMark(x: .value("Time", date(p.t)), y: .value("Used", p.u), series: .value("Series", "measured"))
                    .foregroundStyle(LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Time", date(p.t)), y: .value("Used", p.u), series: .value("Series", "measured"))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: 2))
            }
            ForEach(trend, id: \.t) { p in
                LineMark(x: .value("Time", date(p.t)), y: .value("Used", p.u), series: .value("Series", "trend"))
                    .foregroundStyle(color.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
            RuleMark(x: .value("Now", date(d.now)))
                .foregroundStyle(Color.primary.opacity(0.25))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 2]))
            if top >= 1 {
                RuleMark(y: .value("Limit", 1.0))
                    .foregroundStyle(Theme.failed.opacity(0.55))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
        }
        .chartXScale(domain: date(d.range.start)...date(d.range.end))
        .chartYScale(domain: 0...top)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                AxisGridLine()
                AxisValueLabel { if let x = v.as(Double.self) { Text(Fmt.pct(x)) } }
            }
        }
        .chartXAxis { timeAxis(d) }
        .frame(height: 150)
        .overlay {
            if pts.isEmpty {
                Text("No readings in this window yet").font(.system(size: 12)).foregroundStyle(.tertiary)
            }
        }
    }

    /// From the last reading at the current rate, until the limit is used up or the window resets.
    static func trend(_ d: UsageDetail) -> [UsageDetail.Point] {
        guard let rate = d.limit?.projection?.ratePerHour, rate > 0, let last = d.utilization.last else { return [] }
        let end = min(d.range.end, last.t + (1 - last.u) / rate * 3_600_000)
        guard end > last.t else { return [] }
        return [last, .init(t: end, u: min(1, last.u + rate * (end - last.t) / 3_600_000))]
    }
}

/// Cost-weighted usage per bucket; the bar under the pointer is highlighted.
private struct UsageChart: View {
    let detail: UsageDetail
    @Binding var hover: Date?

    var body: some View {
        let d = detail
        let selected = Self.bucket(at: hover, in: d)?.id
        Chart {
            // Buckets after now have nothing yet; the axis still spans the whole window.
            ForEach(d.buckets.filter { $0.start <= d.now }) { b in
                let pad = (b.end - b.start) * 0.08
                // A rectangle, not a BarMark: a BarMark with an x range takes y as a category and
                // draws a horizontal strip at it.
                RectangleMark(xStart: .value("Start", date(b.start + pad)), xEnd: .value("End", date(b.end - pad)),
                              yStart: .value("Usage", 0.0), yEnd: .value("Usage", b.kinds.cost))
                    .foregroundStyle(selected == b.id ? Theme.doing : Theme.doing.opacity(selected == nil ? 0.72 : 0.4))
                    .cornerRadius(2)
            }
            RuleMark(x: .value("Now", date(d.now)))
                .foregroundStyle(Color.primary.opacity(0.25))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 2]))
        }
        .chartXScale(domain: date(d.range.start)...date(d.range.end))
        .chartXSelection(value: $hover)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { v in
                AxisGridLine()
                AxisValueLabel { if let x = v.as(Double.self) { Text(Fmt.usd(x)) } }
            }
        }
        .chartXAxis { timeAxis(d) }
        .frame(height: 170)
    }

    static func bucket(at time: Date?, in d: UsageDetail) -> UsageDetail.Bucket? {
        guard let time else { return nil }
        let ms = time.timeIntervalSince1970 * 1000
        return d.buckets.first { $0.start <= ms && ms < $0.end && $0.start <= d.now }
    }
}

private func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

/// Each local hour or midnight strictly inside the range.
private func edges(_ start: Double, _ end: Double, step: Double) -> [Double] {
    let cal = Calendar.current
    var t = date(start)
    var out: [Double] = []
    while true {
        guard let next = step >= 86_400_000
            ? cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: t))
            : cal.dateInterval(of: .hour, for: t)?.end else { break }
        let ms = next.timeIntervalSince1970 * 1000
        if ms >= end { break }
        out.append(ms)
        t = next
    }
    return out
}

private let weekday: DateFormatter = {
    let f = DateFormatter()
    f.locale = Fmt.locale
    f.setLocalizedDateFormatFromTemplate("EEE")
    return f
}()

/// Hours across a 5-hour window, days (named in the middle) across a week. An hour too close to an
/// edge is left out, or its label would be cut off.
private func timeAxis(_ d: UsageDetail) -> some AxisContent {
    let days = d.window == "7d"
    let margin = (d.range.end - d.range.start) * 0.04
    let marks = edges(d.range.start, d.range.end, step: days ? 86_400_000 : 3_600_000)
        .filter { days || ($0 - d.range.start > margin && d.range.end - $0 > margin) }
        .map(date)
    return AxisMarks(values: marks) { v in
        AxisGridLine()
        AxisTick()
        AxisValueLabel(centered: days) {
            if let t = v.as(Date.self) { Text(days ? weekday.string(from: t) : Fmt.clock(t.timeIntervalSince1970 * 1000)) }
        }
    }
}

/// A name, a value and a thin bar for its part of the whole.
private struct ShareRow: View {
    let name: String
    let note: String?
    let value: String
    let fraction: Double
    let color: Color
    var live = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(name).font(.system(size: 12)).lineLimit(1)
                if live { Text("Live").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.success) }
                if let note, !note.isEmpty { Text(note).font(.system(size: 10.5)).foregroundStyle(.tertiary).lineLimit(1) }
                Spacer(minLength: 6)
                Text(value).font(.system(size: 11).monospacedDigit()).foregroundStyle(.secondary)
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.07))
                    Capsule().fill(color).frame(width: max(fraction > 0 ? 3 : 0, g.size.width * min(1, fraction)))
                }
            }
            .frame(height: 3)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}
