import AppKit
import SwiftUI

// One place for every look-and-feel choice: theme, menu bar style, island, motion.
// Presets set them all at once; each can then be changed on its own.

enum MenuBarStyle: String, CaseIterable, Codable, Identifiable {
    case capsules, traffic, radar, energy, terminal, dot
    var id: String { rawValue }
    var name: String {
        switch self {
        case .capsules: return String(localized: "Capsules")
        case .traffic: return String(localized: "Traffic light")
        case .radar: return String(localized: "Radar")
        case .energy: return String(localized: "Energy bar")
        case .terminal: return String(localized: "Terminal text")
        case .dot: return String(localized: "Dot")
        }
    }
}

enum IslandMode: String, CaseIterable, Codable, Identifiable {
    case off, notch, floating
    var id: String { rawValue }
    var name: String {
        switch self {
        case .off: return String(localized: "Off")
        case .notch: return String(localized: "Notch")
        case .floating: return String(localized: "Floating")
        }
    }
}

enum Motion: String, CaseIterable, Codable, Identifiable {
    case full, soft, off
    var id: String { rawValue }
    var name: String {
        switch self {
        case .full: return String(localized: "Full")
        case .soft: return String(localized: "Gentle")
        case .off: return String(localized: "Off")
        }
    }
}

struct AppearanceConfig: Codable, Equatable {
    /// A theme id from the theme pack (Themes.swift).
    var theme = Themes.native
    var menuBar: MenuBarStyle = .capsules
    var island: IslandMode = .off
    /// Expand the island on hover (otherwise on click).
    var islandHover = true
    /// Pop the island open for a few seconds when a task finishes or needs you.
    var islandLiveActivity = true
    /// Hide the island while no task waits for you or is newly done.
    var islandAutoHide = false
    var motion: Motion = .full
    /// `Characters.eyes`, `Characters.classic`, or a drawn character's id from characters.json.
    var character = Characters.eyes
}

// Settings saved by an older version lack newer keys; those keep their defaults instead of failing
// the whole decode. In an extension, so the memberwise initializer stays.
extension AppearanceConfig {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppearanceConfig()
        theme = try c.decodeIfPresent(String.self, forKey: .theme) ?? d.theme
        menuBar = try c.decodeIfPresent(MenuBarStyle.self, forKey: .menuBar) ?? d.menuBar
        island = try c.decodeIfPresent(IslandMode.self, forKey: .island) ?? d.island
        islandHover = try c.decodeIfPresent(Bool.self, forKey: .islandHover) ?? d.islandHover
        islandLiveActivity = try c.decodeIfPresent(Bool.self, forKey: .islandLiveActivity) ?? d.islandLiveActivity
        islandAutoHide = try c.decodeIfPresent(Bool.self, forKey: .islandAutoHide) ?? d.islandAutoHide
        motion = try c.decodeIfPresent(Motion.self, forKey: .motion) ?? d.motion
        character = try c.decodeIfPresent(String.self, forKey: .character) ?? d.character
    }
}

struct Preset: Identifiable {
    let id: String
    let name: String
    let blurb: String
    let config: AppearanceConfig

    /// From the preset pack (public/presets.json). A value this app does not know falls back to its
    /// default, a theme it does not have to the native one.
    static let all: [Preset] = {
        guard let url = Bundle.main.resourceURL?.appending(path: "server/public/presets.json") else { return [] }
        let lang = Bundle.main.preferredLocalizations.first ?? "en"
        let d = AppearanceConfig()
        return Packs.available(Packs.load(PresetPack.self, from: url), NoPurchases()).map { p in
            Preset(id: p.id, name: p.name.localized(lang) ?? p.id, blurb: p.blurb.localized(lang) ?? "",
                   config: .init(theme: Themes.has(p.theme) ? p.theme : Themes.native,
                                 menuBar: MenuBarStyle(rawValue: p.menuBar) ?? d.menuBar,
                                 island: IslandMode(rawValue: p.island) ?? d.island,
                                 motion: Motion(rawValue: p.motion) ?? d.motion))
        }
    }()

    /// `base` with this preset's theme, menu bar style, island and motion. The character and the
    /// island's toggles are left as they are, so picking a preset never resets them.
    func applied(to base: AppearanceConfig) -> AppearanceConfig {
        var c = base
        c.theme = config.theme
        c.menuBar = config.menuBar
        c.island = config.island
        c.motion = config.motion
        return c
    }
}

@MainActor
final class Appearance: ObservableObject {
    static let shared = Appearance()

    /// Off in snapshot runs, so trying a preset there never changes the user's settings.
    var persist = true

    @Published var config: AppearanceConfig {
        didSet {
            guard config != oldValue else { return }
            Theme.palette = Themes.palette(config.theme)
            Theme.motion = config.motion
            revision += 1
            if persist, let data = try? JSONEncoder().encode(config) { UserDefaults.standard.set(data, forKey: "appearance") }
            onChange?(config, oldValue)
        }
    }
    /// Bumped on every change; root views use it as an identity so the whole tree restyles.
    @Published private(set) var revision = 0
    var onChange: ((AppearanceConfig, AppearanceConfig) -> Void)?

    private init() {
        var saved = UserDefaults.standard.data(forKey: "appearance").flatMap { try? JSONDecoder().decode(AppearanceConfig.self, from: $0) } ?? AppearanceConfig()
        // A theme or character that is no longer there falls back on its own; the rest stays.
        if !Themes.has(saved.theme) { saved.theme = Themes.native }
        if !Characters.all.contains(saved.character) { saved.character = Characters.eyes }
        config = saved
        Theme.palette = Themes.palette(config.theme)
        Theme.motion = config.motion
    }

    var presetID: String? { Preset.all.first { $0.applied(to: config) == config }?.id }

    func apply(_ preset: Preset) { config = preset.applied(to: config) }
}

// MARK: - themed decoration

/// Window backdrop for the current theme: material, or a solid color with grid / glow.
struct ThemedBackdrop: View {
    var material: NSVisualEffectView.Material = .underWindowBackground

    var body: some View {
        let p = Theme.palette
        if let backdrop = p.backdrop {
            ZStack {
                backdrop
                if p.grid { GridPattern(color: p.doing.opacity(0.07), spacing: 26) }
                if Theme.palette.glow >= 8 {
                    // Neon: two soft color pools.
                    RadialGradient(colors: [p.failed.opacity(0.16), .clear], center: .topLeading, startRadius: 10, endRadius: 520)
                    RadialGradient(colors: [p.doing.opacity(0.13), .clear], center: .bottomTrailing, startRadius: 10, endRadius: 560)
                }
            }
        } else {
            VisualEffect(material: material)
        }
    }
}

struct GridPattern: View {
    let color: Color
    var spacing: CGFloat = 24

    var body: some View {
        Canvas { ctx, size in
            var path = Path()
            var x: CGFloat = 0
            while x <= size.width {
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: size.height))
                x += spacing
            }
            var y: CGFloat = 0
            while y <= size.height {
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: size.width, y: y))
                y += spacing
            }
            ctx.stroke(path, with: .color(color), lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}

/// CRT scanlines laid over everything in the terminal theme.
struct Scanlines: View {
    var body: some View {
        Canvas { ctx, size in
            var y: CGFloat = 0
            while y < size.height {
                ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(.black.opacity(0.22)))
                y += 3
            }
        }
        .allowsHitTesting(false)
    }
}

/// HUD-style corner marks.
struct CornerBrackets: View {
    let color: Color
    var length: CGFloat = 10
    var width: CGFloat = 1.5

    var body: some View {
        Canvas { ctx, size in
            let l = min(length, size.width / 3, size.height / 3)
            var p = Path()
            p.move(to: CGPoint(x: 0, y: l)); p.addLine(to: .zero); p.addLine(to: CGPoint(x: l, y: 0))
            p.move(to: CGPoint(x: size.width - l, y: 0)); p.addLine(to: CGPoint(x: size.width, y: 0)); p.addLine(to: CGPoint(x: size.width, y: l))
            p.move(to: CGPoint(x: 0, y: size.height - l)); p.addLine(to: CGPoint(x: 0, y: size.height)); p.addLine(to: CGPoint(x: l, y: size.height))
            p.move(to: CGPoint(x: size.width - l, y: size.height)); p.addLine(to: CGPoint(x: size.width, y: size.height)); p.addLine(to: CGPoint(x: size.width, y: size.height - l))
            ctx.stroke(p, with: .color(color), lineWidth: width)
        }
        .allowsHitTesting(false)
    }
}

/// The theme's color scheme for one view, or the surrounding one when the theme follows the system.
private struct ThemedScheme: ViewModifier {
    @Environment(\.colorScheme) private var surrounding

    func body(content: Content) -> some View {
        content.environment(\.colorScheme, Theme.palette.scheme ?? surrounding)
    }
}

extension View {
    /// Root-level styling for the current theme: color scheme, font design, text color, overlays.
    func themedRoot() -> some View {
        themedStyle().preferredColorScheme(Theme.palette.scheme)
    }

    /// themedRoot() for a view that shares its window, like the Appearance settings tab. The color
    /// scheme is set for this view only: preferredColorScheme applies to the whole window's content,
    /// so with a dark theme the other tabs drew white text on their light background.
    func themedPage() -> some View {
        themedStyle().modifier(ThemedScheme())
    }

    private func themedStyle() -> some View {
        let p = Theme.palette
        return self
            .fontDesign(p.fontDesign)
            .foregroundStyle(p.text.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.primary))
            .overlay { if p.scanlines { Scanlines().ignoresSafeArea() } }
    }

    /// Card finish: fill, stroke, corner, optional glow and HUD brackets.
    func themedCard(accent: Color, emphasized: Bool = false, glowBoost: Bool = false) -> some View {
        let p = Theme.palette
        // The card's shape casts the shadow, not the finished card: a shadow on the whole card is
        // redrawn, blur and all, whenever any text in it changes (elapsed times do every second).
        return self
            .background(
                RoundedRectangle(cornerRadius: p.corner, style: .continuous)
                    .fill(p.card)
                    .shadow(color: p.glow > 0 ? accent.opacity(glowBoost ? 0.55 : 0.28) : .black.opacity(0.07), radius: p.glow > 0 ? p.glow * (glowBoost ? 1.6 : 1) : 3, y: p.glow > 0 ? 0 : 1)
            )
            .overlay(
                RoundedRectangle(cornerRadius: p.corner, style: .continuous)
                    .strokeBorder(emphasized ? accent.opacity(0.75) : (p.glow > 0 ? accent.opacity(0.35) : p.cardStroke), lineWidth: emphasized ? 1.5 : 1)
            )
            .overlay { if p.brackets { CornerBrackets(color: accent.opacity(0.9)).padding(-1) } }
    }

    /// A subtle glow for state-colored marks in glowing themes.
    func stateGlow(_ color: Color) -> some View {
        let r = Theme.palette.glow
        return shadow(color: r > 0 ? color.opacity(0.75) : .clear, radius: r > 0 ? r * 0.5 : 0)
    }
}
