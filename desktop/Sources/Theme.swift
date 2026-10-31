import AppKit
import SwiftUI

/// Current theme's colors and motion level (set by `Appearance`; read everywhere on the main thread).
enum Theme {
    static var palette = Themes.palette(Themes.native)
    static var motion = Motion.full

    static var waiting: Color { palette.waiting }
    static var doing: Color { palette.doing }
    static var success: Color { palette.success }
    static var failed: Color { palette.failed }
    static var urgent: Color { palette.urgent }
    static var card: Color { palette.card }
    static var column: Color { palette.column }

    static var animated: Bool { motion != .off }
    static var breathing: Bool { motion == .full }

    static func color(_ phase: Phase, urgent: Bool = false) -> Color {
        switch phase {
        case .waiting: return urgent ? Self.urgent : waiting
        case .doing: return doing
        case .success: return success
        case .failed: return failed
        }
    }

    /// Colors for trajectory segments: active phases are vivid, finished ones recede.
    static func segment(_ key: String) -> Color {
        switch key {
        case "doing": return doing
        case "waiting": return waiting
        case "waiting:q": return waiting.opacity(0.55)
        case "done:failed": return failed.opacity(0.7)
        default: return success.opacity(0.35)
        }
    }
}

enum Fmt {
    static func dur(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return String(localized: "\(s) sec") }
        let m = s / 60
        if m < 60 { return String(localized: "\(m) min") }
        let h = m / 60
        if h < 24 { return m % 60 > 0 ? String(localized: "\(h) hr \(m % 60) min") : String(localized: "\(h) hr") }
        return h % 24 > 0 ? String(localized: "\(h / 24) d \(h % 24) hr") : String(localized: "\(h / 24) d")
    }

    static func tokens(_ n: Double) -> String {
        if n >= 1e9 { return String(format: "%.2fB", n / 1e9) }
        if n >= 1e6 { return String(format: n >= 1e8 ? "%.0fM" : "%.1fM", n / 1e6) }
        if n >= 1e3 { return String(format: n >= 1e5 ? "%.0fK" : "%.1fK", n / 1e3) }
        return String(Int(n))
    }

    static func pct(_ x: Double?) -> String {
        guard let x else { return "—" }
        return x >= 0.1 ? "\(Int((x * 100).rounded()))%" : String(format: "%.1f%%", x * 100)
    }

    static func usd(_ x: Double) -> String {
        x >= 100 ? String(format: "$%.0f", x) : String(format: x >= 10 ? "$%.1f" : "$%.2f", x)
    }

    /// The app's UI language (not the system region), so dates read like the rest of the app.
    static let locale = Locale(identifier: Bundle.main.preferredLocalizations.first ?? "en")

    /// "14:05", or with the weekday, e.g. "Wed 14:05".
    static func clock(_ ms: Double, withDay: Bool = false) -> String {
        (withDay ? dayClock : plainClock).string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    // Creating a DateFormatter is costly and `clock` runs in view bodies; these are used on the main thread only.
    private static let plainClock = formatter("HHmm")
    private static let dayClock = formatter("EEEHHmm")

    private static func formatter(_ template: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = locale
        f.setLocalizedDateFormatFromTemplate(template)
        return f
    }

    static func elapsed(_ item: TaskItem, now: Date) -> String {
        guard let start = item.phaseStart else { return "" }
        let d = now.timeIntervalSince(start)
        switch item.phase {
        case .waiting: return String(localized: "Waiting \(dur(d))")
        case .doing: return String(localized: "Running \(dur(d))")
        default: return d < 10 ? String(localized: "Just now") : String(localized: "\(dur(d)) ago")
        }
    }
}

/// Window background that lets the desktop show through.
struct VisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .underWindowBackground

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
    }
}
