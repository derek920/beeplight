import Charts
import SwiftUI

/// The chart's time spans; raw values are what GET /api/burn?range= takes: BURN_RANGES in
/// src/sources/claude-code/usage.js, plus "28d", which is `UsageIndex.daily()` (per day, not per hour).
enum BurnRange: String, CaseIterable {
    case fiveHours = "5h", today, day = "24h", week = "7d", month = "28d"

    var label: String {
        switch self {
        case .fiveHours: return String(localized: "5 hours")
        case .today: return String(localized: "Today")
        case .day: return String(localized: "24 hours")
        case .week: return String(localized: "7 days")
        case .month: return String(localized: "28 days")
        }
    }

    var subtitle: String {
        switch self {
        case .fiveHours: return String(localized: "Tokens per hour on this Mac, last 5 hours · Bars: every minute · Lines: average of the past 30 minutes")
        case .today: return String(localized: "Tokens per hour on this Mac, today from midnight · Bars: every 3 minutes · Lines: average of the past 60 minutes")
        case .day: return String(localized: "Tokens per hour on this Mac, last 24 hours · Bars: every 3 minutes · Lines: average of the past 60 minutes")
        case .week: return String(localized: "Tokens per hour on this Mac, last 7 days · Bars: every hour · Lines: average of the past 6 hours")
        case .month: return String(localized: "Tokens per day on this Mac, last 28 days · Bars: every day · Lines: average of the past 7 days")
        }
    }

    var inputTotal: String {
        switch self {
        case .fiveHours: return String(localized: "Input, 5h")
        case .today: return String(localized: "Input, today")
        case .day: return String(localized: "Input, 24h")
        case .week: return String(localized: "Input, 7d")
        case .month: return String(localized: "Input, 28d")
        }
    }

    var outputTotal: String {
        switch self {
        case .fiveHours: return String(localized: "Output, 5h")
        case .today: return String(localized: "Output, today")
        case .day: return String(localized: "Output, 24h")
        case .week: return String(localized: "Output, 7d")
        case .month: return String(localized: "Output, 28d")
        }
    }

    var costTotal: String {
        switch self {
        case .fiveHours: return String(localized: "Cost, 5h")
        case .today: return String(localized: "Cost, today")
        case .day: return String(localized: "Cost, 24h")
        case .week: return String(localized: "Cost, 7d")
        case .month: return String(localized: "Cost, 28d")
        }
    }

    var average: String {
        switch self {
        case .fiveHours: return String(localized: "30-min average")
        case .today, .day: return String(localized: "60-min average")
        case .week: return String(localized: "6-hour average")
        case .month: return String(localized: "7-day average")
        }
    }
}

/// Tokens per hour on this Mac (GET /api/burn?range=…, see UsageIndex.burn).
struct BurnData: Decodable {
    struct Totals: Decodable {
        var cr, cw, input, out, cost: Double
        enum CodingKeys: String, CodingKey { case cr, cw, input = "in", out, cost }
    }

    var range: String
    var ready: Bool
    var from: Double
    /// End of the axis: the end of the last bar, or midnight tonight for today.
    var to: Double
    var stepMs: Double
    var now: Double
    var cr, cw, input, out, avgIn, avgOut: [Double]
    var costPerHour: Double
    var totals: Totals

    enum CodingKeys: String, CodingKey { case range, ready, from, to, stepMs, now, cr, cw, input = "in", out, avgIn, avgOut, costPerHour, totals }

    func time(_ i: Int) -> Date { Date(timeIntervalSince1970: (from + (Double(i) + 0.5) * stepMs) / 1000) }

    /// Start and end of bucket i's bar, leaving a gap between neighbors.
    func bar(_ i: Int) -> (Date, Date) {
        let t = from + Double(i) * stepMs
        return (Date(timeIntervalSince1970: (t + stepMs * 0.12) / 1000), Date(timeIntervalSince1970: (t + stepMs * 0.88) / 1000))
    }
}

/// Window: stacked input bars (cache read / cache write / uncached) with their running average
/// above, output mirrored below. Fetched every 30 s, and only while the window is on screen.
struct BurnRateView: View {
    @ObservedObject var appearance = Appearance.shared
    @State private var shown = true

    var body: some View {
        Group {
            if shown { content } else { Color.clear }
        }
        .onAppear { shown = true }
        .onDisappear { shown = false }
    }

    private var content: some View {
        BurnPanel()
            .padding(16)
            .frame(minWidth: 860, minHeight: 520)
            .background(ThemedBackdrop().ignoresSafeArea())
            .themedRoot()
            .id(appearance.revision)
    }
}

/// The burn-rate header and charts, with their own polling. `compact` fits them in one card on the
/// board; otherwise the charts get a card of their own under a title, as in the window.
struct BurnPanel: View {
    var compact = false
    @AppStorage("burnRange") private var range = BurnRange.day
    @State private var data: BurnData?

    var body: some View {
        Group {
            if compact {
                VStack(alignment: .leading, spacing: 8) { LimitStrips(); header; charts }
                    .padding(12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .themedCard(accent: Theme.doing)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    LimitStrips()
                    header
                    charts
                        .padding(14)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .themedCard(accent: Theme.doing)
                }
            }
        }
        .task(id: range) {
            // Retry soon while the service is still starting.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(await load() ? 30 : 2))
            }
        }
    }

    private var header: some View { BurnHeader(data: data, range: $range, compact: compact) }

    private var charts: some View {
        VStack(spacing: 0) {
            // Until the new range arrives, keep showing nothing rather than the old one.
            if let data, data.range == range.rawValue {
                InputChart(data: data, range: range, compact: compact).frame(maxHeight: .infinity)
                OutputChart(data: data, range: range, compact: compact).frame(height: compact ? 64 : 150)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func load() async -> Bool {
        let url = Monitor.shared.base.appending(path: "api/burn").appending(queryItems: [URLQueryItem(name: "range", value: range.rawValue)])
        guard let (body, _) = try? await URLSession.shared.data(from: url),
              let d = try? JSONDecoder().decode(BurnData.self, from: body) else { return false }
        // While the first scan of the transcripts is still running the numbers are partial: show
        // them with a note, and ask again soon.
        data = d
        return d.ready
    }
}

/// Month, day, weekday and time, in the user's locale: when the limit is expected to run out.
private let runOutFormat: DateFormatter = {
    let f = DateFormatter()
    f.setLocalizedDateFormatFromTemplate("MMMdEEEHHmm")
    return f
}()

/// Where the weekly limit is heading, as a date instead of a rate (the original cards keep `projectionText`).
private func runOutText(_ w: LimitWindow?) -> (String, Bool) {
    guard let w else { return ("", false) }
    guard let p = w.projection else { return (String(localized: "Sampling; burn rate coming soon"), false) }
    guard let rate = p.ratePerHour, rate > 0 else { return (String(localized: "No new usage lately"), false) }
    if p.beforeReset == true, let eta = p.etaMs {
        let when = runOutFormat.string(from: Date().addingTimeInterval(eta / 1000))
        return (String(localized: "Runs out \(when) (before reset)"), true)
    }
    return (String(localized: "Lasts until reset"), false)
}

/// The limit strips across the top, side by side: the 5-hour window and the weekly one while the
/// account reports a 5-hour window, otherwise the Fable weekly window and the weekly one.
private struct LimitStrips: View {
    var body: some View {
        let L = Monitor.shared.usage?.limits
        HStack(spacing: 8) {
            if let five = L?.fiveHour {
                LimitStrip(name: String(localized: "5-hour limit"), w: five, weekly: false)
            } else if let w = L?.fable {
                LimitStrip(name: "Fable", w: w, weekly: true)
            } else {
                FableUsageStrip(week: Monitor.shared.usage?.sevenDay)
            }
            LimitStrip(name: String(localized: "Weekly limit"), w: L?.sevenDay, weekly: true)
        }
    }
}

/// The account reports no Fable window, so show what Fable used this week on this Mac and its
/// share of everything used this week (API-price estimate, see UsageIndex.costOf).
private struct FableUsageStrip: View {
    let week: UsageTotals?

    var body: some View {
        let f = week?.fable
        let weekCost = week?.cost ?? 0
        let share = f.map { weekCost > 0 ? $0.cost / weekCost : 0 }  // nil: no Fable use at all
        let full = f.map { String(localized: "\(Fmt.tokens($0.tokens)) tokens · ≈\(usdShort($0.cost)) of this week's usage") } ?? String(localized: "No Fable usage this week")
        let short = f.map { "\(Fmt.tokens($0.tokens)) · ≈\(usdShort($0.cost))" } ?? "—"
        // Whatever does not fit is dropped: the wording first, then the text.
        ViewThatFits(in: .horizontal) {
            strip(share, full)
            strip(share, short)
            strip(share, "")
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }

    private func strip(_ share: Double?, _ text: String) -> some View {
        HStack(spacing: 12) {
            Text("Fable").font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary).fixedSize()
            Text(share.map { Fmt.pct($0) } ?? "—")
                .font(.system(size: 17, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(share == nil ? Color.secondary : Theme.doing)
            QuotaBar(value: share ?? 0).frame(minWidth: 40)
            if !text.isEmpty { Text(text).font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.secondary).fixedSize() }
        }
        .lineLimit(1)
        .frame(maxWidth: .infinity)
    }
}

/// One limit window: percentage, bar, reset time and where it is heading.
private struct LimitStrip: View {
    let name: String
    let w: LimitWindow?
    let weekly: Bool

    var body: some View {
        let (proj, hot) = runOutText(w)
        let nowMs = Monitor.shared.minute.timeIntervalSince1970 * 1000
        let reset = w.map { String(localized: "Resets \(Fmt.clock($0.resetsAt, withDay: weekly)) · \(Fmt.dur(($0.resetsAt - nowMs) / 1000)) left") } ?? String(localized: "No limit data yet")
        // Whatever does not fit is dropped, the projection first, then the reset time.
        ViewThatFits(in: .horizontal) {
            strip(reset: reset, proj: proj, hot: hot)
            strip(reset: reset, proj: "", hot: hot)
            strip(reset: "", proj: "", hot: hot)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }

    private func strip(reset: String, proj: String, hot: Bool) -> some View {
        HStack(spacing: 12) {
            Text(name).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary).fixedSize()
            Text(w.map { Fmt.pct($0.utilization) } ?? "—")
                .font(.system(size: 17, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(w.map { quotaColor($0.utilization) } ?? .secondary)
            QuotaBar(value: w?.utilization ?? 0).frame(minWidth: 60)
            if !reset.isEmpty { Text(reset).font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.secondary).fixedSize() }
            if !proj.isEmpty { Text(proj).font(.system(size: 11)).foregroundStyle(hot ? Theme.failed : .secondary).fixedSize() }
        }
        .lineLimit(1)
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct RangePicker: View {
    @Binding var range: BurnRange

    var body: some View {
        Picker("", selection: $range) {
            ForEach(BurnRange.allCases, id: \.self) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }
}

private struct BurnHeader: View {
    let data: BurnData?
    @Binding var range: BurnRange
    var compact = false

    var body: some View {
        let t = data?.range == range.rawValue ? data?.totals : nil
        let rates = t == nil ? nil : data
        let input = t.map { $0.cr + $0.cw + $0.input } ?? 0
        let month = range == .month
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Burn rate").font(.system(size: compact ? 11.5 : 18, weight: compact ? .semibold : .bold))
                        .foregroundStyle(compact ? .secondary : .primary)
                    if !compact { Text(range.subtitle).font(.system(size: 11.5)).foregroundStyle(.secondary) }
                    if data?.ready == false {
                        Text("Reading Claude's history… the numbers are still filling in")
                            .font(.system(size: 11)).foregroundStyle(Theme.waiting)
                    }
                }
                // On the board the legend moves up here, beside the title, in place of the chart's own.
                if compact { InputLegend(range: range) }
                Spacer(minLength: 16)
                RangePicker(range: $range)
            }
            HStack(spacing: 10) {
                BurnStat(value: rates?.avgIn.last.map { Fmt.tokens($0) }, label: month ? String(localized: "Input / day") : String(localized: "Input / hr"), color: Theme.failed, compact: compact)
                BurnStat(value: rates?.avgOut.last.map { Fmt.tokens($0) }, label: month ? String(localized: "Output / day") : String(localized: "Output / hr"), color: Theme.success, compact: compact)
                BurnStat(value: t.map { input > 0 ? String(format: "%.1f%%", $0.cr / input * 100) : "—" }, label: String(localized: "Cache hits"), color: cacheColor, compact: compact)
                if !compact {
                    BurnStat(value: t.map { _ in Fmt.tokens(input) }, label: range.inputTotal, color: cacheColor)
                    BurnStat(value: t.map { Fmt.tokens($0.out) }, label: range.outputTotal, color: Theme.success)
                }
                BurnStat(value: rates.map { "≈" + usdShort($0.costPerHour) }, label: month ? String(localized: "Cost / day") : String(localized: "Cost / hr"), color: Theme.waiting, compact: compact)
                    .help(costHelp)
                BurnStat(value: t.map { "≈" + usdShort($0.cost) }, label: range.costTotal, color: Theme.waiting, compact: compact)
                    .help(costHelp)
            }
        }
    }

    private var costHelp: String {
        String(localized: "Estimated at API list prices. A Claude subscription is not billed this way; use it to compare, not as a bill.")
    }
}

/// Whole dollars below 1k, then 2.84k, 1.20M.
private func usdShort(_ x: Double) -> String {
    if x >= 1_000_000 { return String(format: "$%.2fM", x / 1_000_000) }
    if x >= 1000 { return String(format: "$%.2fk", x / 1000) }
    return String(format: "$%.0f", x)
}

private struct BurnStat: View {
    let value: String?
    let label: String
    let color: Color
    var compact = false

    var body: some View {
        VStack(spacing: 0) {
            Text(value ?? "—")
                .font(.system(size: compact ? 16 : 20, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(value == nil ? Color.secondary : color)
                .contentTransition(.numericText())
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, compact ? 3 : 6)
        .padding(.horizontal, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(value == nil ? Color.primary.opacity(0.05) : color.opacity(0.12)))
    }
}

/// Cache reads are the bulk of the input. The terminal palette is all green, which would make
/// them indistinguishable from the (green) output, so there they are cyan.
@MainActor private var cacheColor: Color {
    Appearance.shared.config.theme == "terminal" ? Color(red: 0.2, green: 0.8, blue: 1) : Theme.doing
}

/// Series names double as legend labels, so they are localized.
private enum Series {
    static var cacheRead: String { String(localized: "Input · cache read") }
    static var cacheWrite: String { String(localized: "Input · cache write") }
    static var uncached: String { String(localized: "Input · uncached") }
    static func inputAvg(_ r: BurnRange) -> String { String(localized: "Input · \(r.average)") }
    static var output: String { String(localized: "Output") }
    static func outputAvg(_ r: BurnRange) -> String { String(localized: "Output · \(r.average)") }
}

/// The input chart's legend as a row of its own, for the board (the window keeps the chart's legend).
private struct InputLegend: View {
    let range: BurnRange

    var body: some View {
        HStack(spacing: 12) {
            item(cacheColor.opacity(0.85), Series.cacheRead)
            item(Theme.waiting, Series.cacheWrite)
            item(Color.primary.opacity(0.8), Series.uncached)
            item(Theme.failed, Series.inputAvg(range))
        }
        .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
    }

    private func item(_ color: Color, _ name: String) -> some View {
        HStack(spacing: 4) { Circle().fill(color).frame(width: 8, height: 8); Text(name) }
    }
}

private struct InputChart: View {
    let data: BurnData
    let range: BurnRange
    var compact = false

    var body: some View {
        Chart {
            ForEach(data.cr.indices, id: \.self) { i in
                let (a, b) = data.bar(i)
                let (cr, cw) = (data.cr[i], data.cr[i] + data.cw[i])
                bar(a, b, 0, cr, Series.cacheRead)
                bar(a, b, cr, cw, Series.cacheWrite)
                bar(a, b, cw, cw + data.input[i], Series.uncached)
            }
            ForEach(data.avgIn.indices, id: \.self) { i in
                LineMark(x: .value("Time", data.time(i)), y: .value("Tokens", data.avgIn[i]))
                    .foregroundStyle(by: .value("Series", Series.inputAvg(range)))
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2.2))
            }
        }
        .chartForegroundStyleScale([
            Series.cacheRead: cacheColor.opacity(0.85),
            Series.cacheWrite: Theme.waiting,
            Series.uncached: Color.primary.opacity(0.8),
            Series.inputAvg(range): Theme.failed,
        ])
        .chartLegend(compact ? .hidden : .visible)
        .chartLegend(position: .top, alignment: .leading, spacing: 14)
        .chartXScale(domain: span(data))
        .chartXAxis { AxisMarks(values: ticks(data, range)) { _ in AxisGridLine() } }
        .chartYAxis { tokenAxis }
    }
}

private struct OutputChart: View {
    let data: BurnData
    let range: BurnRange
    var compact = false

    var body: some View {
        Chart {
            ForEach(data.out.indices, id: \.self) { i in
                let (a, b) = data.bar(i)
                bar(a, b, 0, data.out[i], Series.output)
            }
            ForEach(data.avgOut.indices, id: \.self) { i in
                LineMark(x: .value("Time", data.time(i)), y: .value("Tokens", data.avgOut[i]))
                    .foregroundStyle(by: .value("Series", Series.outputAvg(range)))
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2.2))
            }
        }
        .chartForegroundStyleScale([
            Series.output: Theme.success.opacity(0.8),
            Series.outputAvg(range): Theme.success,
        ])
        .chartLegend(compact ? .hidden : .visible)
        .chartLegend(position: .bottom, alignment: .leading)
        // Output hangs down from the shared zero line, as in a burn-rate plot.
        .chartYScale(domain: .automatic(includesZero: true, reversed: true))
        .chartXScale(domain: span(data))
        .chartXAxis {
            AxisMarks(values: ticks(data, range)) { v in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let d = v.as(Date.self) { Text(tickLabel(d, range)).monospacedDigit() }
                }
            }
        }
        .chartYAxis { tokenAxis }
    }
}

/// Bars are drawn as rectangles: on a continuous time axis BarMark has no band to size against,
/// and stacking by hand keeps the three input parts in a fixed order.
private func bar(_ a: Date, _ b: Date, _ y0: Double, _ y1: Double, _ series: String) -> some ChartContent {
    RectangleMark(xStart: .value("Time", a), xEnd: .value("Time", b), yStart: .value("Tokens", y0), yEnd: .value("Tokens", y1))
        .foregroundStyle(by: .value("Series", series))
}

/// Every hour across 5 hours, every other hour across a day, midnights across a week; none so close
/// to either end that its label would stick out of the card (as in UsageAxis).
private func ticks(_ d: BurnData, _ r: BurnRange) -> [Date] {
    let cal = Calendar.current
    let span = span(d)
    let (unit, every): (Calendar.Component, Int) = r == .month ? (.day, 7) : r == .week ? (.day, 1) : (.hour, r == .fiveHours ? 1 : 2)
    guard var t = cal.dateInterval(of: unit, for: span.lowerBound)?.end else { return [] }
    if unit == .hour { while cal.component(.hour, from: t) % every != 0 { t = cal.date(byAdding: .hour, value: 1, to: t)! } }
    let width = span.upperBound.timeIntervalSince(span.lowerBound)
    var out: [Date] = []
    while t < span.upperBound {
        let x = t.timeIntervalSince(span.lowerBound) / width
        if x > 0.03 && x < 0.97 { out.append(t) }
        t = cal.date(byAdding: unit, value: every, to: t)!
    }
    return out
}

/// Built once: the axis labels are redrawn on every refresh, and a DateFormatter is costly to make.
private func dayFormat(_ template: String) -> DateFormatter {
    let f = DateFormatter()
    f.locale = Fmt.locale
    f.setLocalizedDateFormatFromTemplate(template)
    return f
}
private let weekTickFormat = dayFormat("MMMdEEE")
private let monthTickFormat = dayFormat("MMMd")

private func tickLabel(_ d: Date, _ r: BurnRange) -> String {
    switch r {
    case .week: return weekTickFormat.string(from: d)
    case .month: return monthTickFormat.string(from: d)
    default: return Fmt.clock(d.timeIntervalSince1970 * 1000)
    }
}

private func span(_ d: BurnData) -> ClosedRange<Date> {
    Date(timeIntervalSince1970: d.from / 1000)...Date(timeIntervalSince1970: d.to / 1000)
}

private var tokenAxis: some AxisContent {
    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
        AxisGridLine()
        AxisValueLabel {
            // A fixed width keeps the two charts' plot areas lined up.
            if let n = v.as(Double.self) { Text(Fmt.tokens(n)).monospacedDigit().frame(width: 40, alignment: .trailing) }
        }
    }
}
