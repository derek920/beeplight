import SwiftUI

// Theme, preset and character packs: plain data, decoded leniently. Shared with the iPhone app (a
// separate, closed-source project that can compile this file), so only SwiftUI here, no AppKit;
// turning a PackColor into a Color is up to each app. The format is described in docs/packs.md.
//
// A pack file is { "format": 1, "id": ..., "kind": "themes" | "presets" | "characters" | "agents" |
// "pools", "<kind>": [items] }. The built-in ones are public/themes.json, presets.json,
// characters.json and agents.json. Agent marks draw with SVGPath, so they also need Figure.swift.

enum Packs {
    /// Files with a newer format than this are skipped; within a format, new fields are optional.
    static let format = 1

    /// The items of one kind in a pack file; [] if it is missing, unreadable or of a newer format.
    /// Items that fail to decode are skipped one by one, so one bad entry never empties the file.
    static func load<Item: PackItem>(_ type: Item.Type, from url: URL) -> [Item] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return decode(type, from: data)
    }

    static func decode<Item: PackItem>(_ type: Item.Type, from data: Data) -> [Item] {
        guard let file = try? JSONDecoder().decode(PackFile<Item>.self, from: data), file.format <= format else { return [] }
        var seen = Set<String>()
        return file.items.filter { seen.insert($0.id).inserted }
    }

    /// The items this person may use: free ones, and the ones their purchases unlock.
    static func available<Item: PackItem>(_ items: [Item], _ entitlements: EntitlementProvider) -> [Item] {
        items.filter { $0.requires.map(entitlements.owns) ?? true }
    }
}

/// Text in several languages: { "en": ..., "zh-Hans": ... }.
typealias LocalizedText = [String: String]

extension Dictionary where Key == String, Value == String {
    /// In `lang`, else English.
    func localized(_ lang: String) -> String? { self[lang] ?? self["en"] }
}

// MARK: - purchases

/// Decides which items that need a purchase (`requires`) are unlocked. The open-source apps have no
/// purchases (NoPurchases), so such items stay hidden there; every built-in item is free. The
/// iPhone app supplies its own.
protocol EntitlementProvider {
    func owns(_ entitlement: String) -> Bool
}

struct NoPurchases: EntitlementProvider {
    func owns(_ entitlement: String) -> Bool { false }
}

/// What every pack item has.
protocol PackItem: Decodable {
    /// The kind of pack the item comes in, which is also the key of the item list in the file.
    static var kind: String { get }
    var id: String { get }
    /// The entitlement that unlocks it; nil = free.
    var requires: String? { get }
}

extension Figure: PackItem {
    static let kind = "characters"
}

/// A coding agent's mark, drawn before task titles (public/agents.json). Filled SVG paths in a
/// `box`, in `color`; `id` is the task's `agent`. Drawing uses SVGPath from Figure.swift.
struct AgentMark: PackItem {
    static let kind = "agents"
    let id: String
    let requires: String?
    let name: LocalizedText
    let color: PackColor
    let box: [Double]
    let paths: [String]

    /// Paths scaled to fit a square of `size`, centered.
    func path(size: CGFloat) -> Path {
        let w = box.first ?? 16, h = box.count > 1 ? box[1] : w
        let s = size / max(w, h)
        let t = CGAffineTransform(translationX: (size - w * s) / 2, y: (size - h * s) / 2).scaledBy(x: s, y: s)
        var p = Path()
        for d in paths { p.addPath(SVGPath.parse(d), transform: t) }
        return p
    }
}

private struct PackFile<Item: PackItem>: Decodable {
    let format: Int
    let items: [Item]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        format = try c.decodeIfPresent(Int.self, forKey: AnyKey("format")) ?? 1
        items = try c.decode([Lenient<Item>].self, forKey: AnyKey(Item.kind)).compactMap(\.value)
    }
}

private struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

private struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }
    init(_ s: String) { stringValue = s }
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { nil }
}

// MARK: - themes

/// A color as packs write it: "#RRGGBB", "system:<name>" (a system color that follows light and
/// dark), or "primary" (the label color), each optionally with "@<opacity>", e.g. "#B14CFF@0.35".
struct PackColor: Decodable, Equatable {
    enum Base: Equatable {
        case rgb(Double, Double, Double)
        case system(String)
        case primary
    }

    /// System colors a pack may name. Every app maps each one to its platform's color.
    static let systemNames: Set<String> = ["orange", "blue", "green", "red", "yellow", "purple", "pink", "teal", "gray", "controlBackground", "windowBackground"]

    let base: Base
    let opacity: Double

    init?(_ text: String) {
        let parts = text.split(separator: "@", maxSplits: 1).map(String.init)
        guard let spec = parts.first else { return nil }
        if parts.count == 2 {
            guard let o = Double(parts[1]), o > 0, o <= 1 else { return nil }
            opacity = o
        } else {
            opacity = 1
        }
        if spec == "primary" {
            base = .primary
        } else if spec.hasPrefix("system:") {
            let name = String(spec.dropFirst(7))
            guard Self.systemNames.contains(name) else { return nil }
            base = .system(name)
        } else if spec.hasPrefix("#"), spec.count == 7, let v = UInt32(spec.dropFirst(), radix: 16) {
            base = .rgb(Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255)
        } else {
            return nil
        }
    }

    init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let color = PackColor(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad color \(text)"))
        }
        self = color
    }
}

/// Colors and finish of the board, the menu bar panel and the island.
struct ThemePack: PackItem {
    static let kind = "themes"
    static let requiredColors = ["waiting", "doing", "success", "failed", "urgent", "column", "card", "cardStroke"]
    static let fonts: Set<String> = ["default", "rounded", "monospaced", "serif"]
    static let schemes: Set<String> = ["system", "light", "dark"]
    /// Finishes the apps know how to draw; others are ignored.
    static let knownEffects: Set<String> = ["grid", "scanlines", "brackets", "bracketLabels"]

    let id: String
    let name: LocalizedText
    let requires: String?
    let rarity: String?
    let series: String?
    /// "system" follows the Mac's light or dark; "light" and "dark" fix it.
    let scheme: String
    let font: String
    let corner: Double
    /// Glow radius around state-colored marks; 0 = none.
    let glow: Double
    /// The required ones, plus optional "text" (else the system label color) and "backdrop"
    /// (else the window material).
    let colors: [String: PackColor]
    let effects: Set<String>

    private enum Keys: String, CodingKey { case id, name, requires, rarity, series, scheme, font, corner, glow, colors, effects }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(LocalizedText.self, forKey: .name)
        requires = try c.decodeIfPresent(String.self, forKey: .requires)
        rarity = try c.decodeIfPresent(String.self, forKey: .rarity)
        series = try c.decodeIfPresent(String.self, forKey: .series)
        let scheme = try c.decodeIfPresent(String.self, forKey: .scheme) ?? "system"
        self.scheme = Self.schemes.contains(scheme) ? scheme : "system"
        let font = try c.decodeIfPresent(String.self, forKey: .font) ?? "default"
        self.font = Self.fonts.contains(font) ? font : "default"
        corner = try c.decodeIfPresent(Double.self, forKey: .corner) ?? 12
        glow = try c.decodeIfPresent(Double.self, forKey: .glow) ?? 0
        colors = try c.decode([String: PackColor].self, forKey: .colors)
        effects = Set(try c.decodeIfPresent([String].self, forKey: .effects) ?? []).intersection(Self.knownEffects)
        if let missing = Self.requiredColors.first(where: { colors[$0] == nil }) {
            throw DecodingError.keyNotFound(Keys.colors, .init(codingPath: decoder.codingPath, debugDescription: "theme \(id) has no \(missing) color"))
        }
    }
}

// MARK: - presets

/// A theme, a menu bar style, the island and motion picked together. Values an app does not know
/// fall back to its defaults one by one.
struct PresetPack: PackItem {
    static let kind = "presets"

    let id: String
    let name: LocalizedText
    let blurb: LocalizedText
    let requires: String?
    let theme: String
    let menuBar: String
    let island: String
    let motion: String
}

// MARK: - draw pools (the iPhone app's paid characters)

/// What a paid draw can give and how likely each item is. App Store Review Guideline 3.1.1 requires
/// showing these odds before the purchase, so they are part of the pack and the app shows them.
struct PoolPack: PackItem {
    static let kind = "pools"

    let id: String
    let name: LocalizedText
    let requires: String?
    let entries: [Entry]

    struct Entry: Decodable {
        /// A character id.
        let item: String
        /// Probability, 0…1; a pool's odds add up to 1.
        let odds: Double
    }

    var oddsAreValid: Bool {
        !entries.isEmpty && entries.allSatisfy { $0.odds > 0 } && abs(entries.reduce(0) { $0 + $1.odds } - 1) < 1e-6
    }
}
