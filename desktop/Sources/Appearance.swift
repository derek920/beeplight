import AppKit
import SwiftUI

// One place for every look-and-feel choice: theme, menu bar style, island, motion.
// Presets set them all at once; each can then be changed on its own.

enum ThemeID: String, CaseIterable, Codable, Identifiable {
    case native, neon, terminal, hologram, minimal
    var id: String { rawValue }
    var name: String {
        switch self {
        case .native: return String(localized: "Native")
        case .neon: return String(localized: "Neon")
        case .terminal: return String(localized: "Terminal")
        case .hologram: return String(localized: "Hologram")
        case .minimal: return String(localized: "Minimal")
        }
    }
}

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
    var theme: ThemeID = .native
    var menuBar: MenuBarStyle = .capsules
    var island: IslandMode = .off
    /// Expand the island on hover (otherwise on click).
    var islandHover = true
    /// Pop the island open for a few seconds when a task finishes or needs you.
    var islandLiveActivity = true
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
        theme = try c.decodeIfPresent(ThemeID.self, forKey: .theme) ?? d.theme
        menuBar = try c.decodeIfPresent(MenuBarStyle.self, forKey: .menuBar) ?? d.menuBar
        island = try c.decodeIfPresent(IslandMode.self, forKey: .island) ?? d.island
        islandHover = try c.decodeIfPresent(Bool.self, forKey: .islandHover) ?? d.islandHover
        islandLiveActivity = try c.decodeIfPresent(Bool.self, forKey: .islandLiveActivity) ?? d.islandLiveActivity
        motion = try c.decodeIfPresent(Motion.self, forKey: .motion) ?? d.motion
        character = try c.decodeIfPresent(String.self, forKey: .character) ?? d.character
    }
}

struct Preset: Identifiable {
    let id: String
    let name: String
    let blurb: String
    let config: AppearanceConfig

    static let all: [Preset] = [
        Preset(id: "native", name: String(localized: "Native macOS"), blurb: String(localized: "System colors, quiet and solid"),
               config: .init(theme: .native, menuBar: .capsules, island: .off, motion: .full)),
        Preset(id: "neon", name: String(localized: "Neon"), blurb: String(localized: "Dark neon glow, radar menu bar"),
               config: .init(theme: .neon, menuBar: .radar, island: .notch, motion: .full)),
        Preset(id: "terminal", name: String(localized: "Terminal"), blurb: String(localized: "Green mono text, scanlines"),
               config: .init(theme: .terminal, menuBar: .terminal, island: .notch, motion: .soft)),
        Preset(id: "hologram", name: String(localized: "Hologram"), blurb: String(localized: "Blue grid, HUD corners"),
               config: .init(theme: .hologram, menuBar: .energy, island: .floating, motion: .full)),
        Preset(id: "minimal", name: String(localized: "Minimal"), blurb: String(localized: "Muted and still, one dot"),
               config: .init(theme: .minimal, menuBar: .dot, island: .off, motion: .off)),
    ]

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

    static func of(_ id: ThemeID) -> Palette {
        switch id {
        case .native:
            return Palette(
                waiting: Color(nsColor: .systemOrange), doing: Color(nsColor: .systemBlue), success: Color(nsColor: .systemGreen),
                failed: Color(nsColor: .systemRed), urgent: Color(red: 1, green: 0.30, blue: 0.24), text: nil, backdrop: nil,
                column: Color.primary.opacity(0.045), card: Color(nsColor: .controlBackgroundColor).opacity(0.92),
                cardStroke: Color.primary.opacity(0.07), glow: 0, corner: 12, fontDesign: .default, scheme: nil)
        case .neon:
            return Palette(
                waiting: hex(0xFFB020), doing: hex(0x00E5FF), success: hex(0x39FF88), failed: hex(0xFF3B7F), urgent: hex(0xFF2E63),
                text: hex(0xEDEBFF), backdrop: hex(0x07060E), column: hex(0x120F24).opacity(0.75), card: hex(0x14112A),
                cardStroke: hex(0xB14CFF).opacity(0.35), glow: 10, corner: 14, fontDesign: .rounded, scheme: .dark)
        case .terminal:
            return Palette(
                waiting: hex(0xFFB000), doing: hex(0x33FF66), success: hex(0x9DFFB8), failed: hex(0xFF5555), urgent: hex(0xFF3B3B),
                text: hex(0x46FF7A), backdrop: hex(0x010401), column: hex(0x031003), card: hex(0x020A02),
                cardStroke: hex(0x1E7A32).opacity(0.8), glow: 4, corner: 3, fontDesign: .monospaced, scheme: .dark,
                scanlines: true, bracketLabels: true)
        case .hologram:
            return Palette(
                waiting: hex(0xFFC24D), doing: hex(0x4DD9FF), success: hex(0x5CFFB0), failed: hex(0xFF5C7A), urgent: hex(0xFF4060),
                text: hex(0xD6F6FF), backdrop: hex(0x020B18), column: hex(0x06203A).opacity(0.55), card: hex(0x04162C).opacity(0.88),
                cardStroke: hex(0x4DD9FF).opacity(0.28), glow: 6, corner: 4, fontDesign: .monospaced, scheme: .dark,
                grid: true, brackets: true)
        case .minimal:
            return Palette(
                waiting: hex(0xC2843B), doing: hex(0x6B7C93), success: hex(0x6E9C7E), failed: hex(0xB56565), urgent: hex(0xC95B4E),
                text: nil, backdrop: nil, column: Color.primary.opacity(0.03), card: Color(nsColor: .controlBackgroundColor),
                cardStroke: Color.primary.opacity(0.08), glow: 0, corner: 10, fontDesign: .default, scheme: nil)
        }
    }
}

func hex(_ v: UInt32) -> Color {
    Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

@MainActor
final class Appearance: ObservableObject {
    static let shared = Appearance()

    /// Off in snapshot runs, so trying a preset there never changes the user's settings.
    var persist = true

    @Published var config: AppearanceConfig {
        didSet {
            guard config != oldValue else { return }
            Theme.palette = Palette.of(config.theme)
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
        let saved = UserDefaults.standard.data(forKey: "appearance").flatMap { try? JSONDecoder().decode(AppearanceConfig.self, from: $0) }
        config = saved ?? AppearanceConfig()
        Theme.palette = Palette.of(config.theme)
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

extension View {
    /// Root-level styling for the current theme: color scheme, font design, text color, overlays.
    func themedRoot() -> some View {
        let p = Theme.palette
        return self
            .fontDesign(p.fontDesign)
            .foregroundStyle(p.text.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.primary))
            .preferredColorScheme(p.scheme)
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
