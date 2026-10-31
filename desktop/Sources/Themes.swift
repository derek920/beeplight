import AppKit
import SwiftUI

// The themes the app offers, read from the theme pack (public/themes.json, which the app bundles
// with the service's files; format in docs/packs.md), and the Palette each one becomes. Adding a
// theme is a change to that file only.

/// Colors and finish of one theme.
struct Palette {
    var waiting: Color
    var doing: Color
    var success: Color
    var failed: Color
    var urgent: Color
    /// nil = system label colors.
    var text: Color?
    /// nil = window material; otherwise a solid backdrop.
    var backdrop: Color?
    var column: Color
    var card: Color
    var cardStroke: Color
    /// Glow radius around state-colored elements; 0 = none.
    var glow: CGFloat
    var corner: CGFloat
    var fontDesign: Font.Design
    var scheme: ColorScheme?
    var grid = false
    var scanlines = false
    var brackets = false
    /// Labels as "[Running]" instead of filled capsules.
    var bracketLabels = false
}

extension Palette {
    init(_ t: ThemePack) {
        func color(_ key: String) -> Color { t.colors[key]?.color ?? .primary }
        self.init(
            waiting: color("waiting"), doing: color("doing"), success: color("success"), failed: color("failed"),
            urgent: color("urgent"), text: t.colors["text"]?.color, backdrop: t.colors["backdrop"]?.color,
            column: color("column"), card: color("card"), cardStroke: color("cardStroke"),
            glow: t.glow, corner: t.corner, fontDesign: Self.designs[t.font] ?? .default,
            scheme: t.scheme == "dark" ? .dark : t.scheme == "light" ? .light : nil,
            grid: t.effects.contains("grid"), scanlines: t.effects.contains("scanlines"),
            brackets: t.effects.contains("brackets"), bracketLabels: t.effects.contains("bracketLabels"))
    }

    private static let designs: [String: Font.Design] = ["default": .default, "rounded": .rounded, "monospaced": .monospaced, "serif": .serif]

    /// The native look, for when the theme pack cannot be read, so there is always a theme.
    static let fallback = Palette(
        waiting: Color(nsColor: .systemOrange), doing: Color(nsColor: .systemBlue), success: Color(nsColor: .systemGreen),
        failed: Color(nsColor: .systemRed), urgent: Color(red: 1, green: 0.30, blue: 0.24), text: nil, backdrop: nil,
        column: Color.primary.opacity(0.045), card: Color(nsColor: .controlBackgroundColor).opacity(0.92),
        cardStroke: Color.primary.opacity(0.07), glow: 0, corner: 12, fontDesign: .default, scheme: nil)
}

extension PackColor {
    var color: Color {
        let c: Color
        switch base {
        case let .rgb(r, g, b): c = Color(red: r, green: g, blue: b)
        case .primary: c = .primary
        case let .system(name): c = Color(nsColor: Self.appKit[name] ?? .labelColor)
        }
        return opacity < 1 ? c.opacity(opacity) : c
    }

    /// PackColor.systemNames on the Mac.
    private static let appKit: [String: NSColor] = [
        "orange": .systemOrange, "blue": .systemBlue, "green": .systemGreen, "red": .systemRed, "yellow": .systemYellow,
        "purple": .systemPurple, "pink": .systemPink, "teal": .systemTeal, "gray": .systemGray,
        "controlBackground": .controlBackgroundColor, "windowBackground": .windowBackgroundColor,
    ]
}

enum Themes {
    /// The default, and what an unknown or missing theme falls back to.
    static let native = "native"

    /// The open-source app has no purchases, so a theme that needs one is not offered.
    static let all: [ThemePack] = Packs.available(load(), NoPurchases())

    private static let palettes: [String: Palette] = Dictionary(uniqueKeysWithValues: all.map { ($0.id, Palette($0)) })

    static func load(from url: URL? = Bundle.main.resourceURL?.appending(path: "server/public/themes.json")) -> [ThemePack] {
        url.map { Packs.load(ThemePack.self, from: $0) } ?? []
    }

    static func has(_ id: String) -> Bool { palettes[id] != nil }

    static func palette(_ id: String) -> Palette { palettes[id] ?? palettes[native] ?? .fallback }

    static func name(_ id: String) -> String {
        all.first { $0.id == id }?.name.localized(Bundle.main.preferredLocalizations.first ?? "en") ?? id
    }
}

func hex(_ v: UInt32) -> Color {
    Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}
