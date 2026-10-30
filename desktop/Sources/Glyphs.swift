import AppKit
import SwiftUI

/// Animated status mark: spinning ring (doing), pulsing raised hand (waiting), check / cross (done).
struct StatusGlyph: View {
    let phase: Phase
    var urgent = false
    var size: CGFloat = 18

    var body: some View {
        Group {
            switch phase {
            case .doing:
                Spinner(color: Theme.doing, size: size)
            case .waiting:
                let symbol = urgent ? "exclamationmark.triangle.fill" : "hand.raised.fill"
                let color = Theme.color(.waiting, urgent: urgent)
                let glow = urgent ? 5 : max(2, Theme.palette.glow * 0.5)
                if Theme.breathing {
                    PulsingSymbol(name: symbol, pointSize: size * 0.78, color: NSColor(color), glow: glow)
                } else {
                    Image(systemName: symbol)
                        .font(.system(size: size * 0.78, weight: .semibold))
                        .foregroundStyle(color)
                        .shadow(color: color.opacity(0.5), radius: glow)
                }
            case .success:
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: size * 0.86, weight: .semibold))
                    .foregroundStyle(Theme.palette.backdrop == nil ? Color.white : Color.black, Theme.success)
                    .stateGlow(Theme.success)
            case .failed:
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: size * 0.86, weight: .semibold))
                    .foregroundStyle(Theme.palette.backdrop == nil ? Color.white : Color.black, Theme.failed)
                    .stateGlow(Theme.failed)
            }
        }
        .frame(width: size, height: size)
    }
}

struct Spinner: View {
    let color: Color
    var size: CGFloat = 18

    var body: some View {
        let line = max(1.6, size / 7.5)
        if Theme.animated {
            ZStack {
                Circle().stroke(color.opacity(0.18), lineWidth: line).padding(line / 2).stateGlow(color)
                SpinningArc(color: NSColor(color), line: line, period: Theme.motion == .soft ? 2.2 : 1.1, glow: Theme.palette.glow)
            }
            .frame(width: size, height: size)
        } else {
            ring(line, angle: -90).frame(width: size, height: size)
        }
    }

    private func ring(_ line: CGFloat, angle: Double) -> some View {
        ZStack {
            Circle().stroke(color.opacity(0.18), lineWidth: line)
            Circle()
                .trim(from: 0, to: 0.68)
                .stroke(
                    AngularGradient(colors: [color.opacity(0.05), color], center: .center, startAngle: .degrees(0), endAngle: .degrees(245)),
                    style: StrokeStyle(lineWidth: line, lineCap: .round)
                )
                .rotationEffect(.degrees(angle))
        }
        .padding(line / 2)
        .stateGlow(color)
    }
}

// Endless animations run in Core Animation, not SwiftUI. A SwiftUI animation (TimelineView,
// symbolEffect) lays out and redraws its whole window on every frame: with a few tasks running
// the board did that ~100 times a second, about a quarter of a CPU core, even when covered.

/// The moving arc of `Spinner`, turned by the render server.
private struct SpinningArc: NSViewRepresentable {
    let color: NSColor
    let line: CGFloat
    let period: Double
    let glow: CGFloat

    func makeNSView(context: Context) -> ArcView { ArcView() }
    func updateNSView(_ view: ArcView, context: Context) { view.update(color: color, line: line, period: period, glow: glow) }

    final class ArcView: NSView {
        private let mirror = CALayer()
        private let gradient = CAGradientLayer()
        private let arc = CAShapeLayer()
        private var color = NSColor.clear, line: CGFloat = 2, period = 1.1, glow: CGFloat = 0

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            // A conic gradient sweeps counterclockwise here; mirrored, the arc runs and turns clockwise.
            mirror.sublayerTransform = CATransform3DMakeScale(1, -1, 1)
            mirror.shadowOffset = .zero
            gradient.type = .conic
            gradient.startPoint = CGPoint(x: 0.5, y: 0.5)
            gradient.endPoint = CGPoint(x: 1, y: 0.5)
            // Faint tail, solid head; past the head it fades back so the tail's round cap stays faint.
            gradient.locations = [0, 0.68, 0.74, 0.96]
            arc.fillColor = nil
            arc.strokeColor = NSColor.black.cgColor
            arc.lineCap = .round
            gradient.mask = arc
            mirror.addSublayer(gradient)
            layer?.addSublayer(mirror)
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func update(color: NSColor, line: CGFloat, period: Double, glow: CGFloat) {
            if period != self.period { gradient.removeAnimation(forKey: "spin") }
            (self.color, self.line, self.period, self.glow) = (color, line, period, glow)
            needsLayout = true
            spin()
        }

        override func layout() {
            super.layout()
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            for l in [mirror, gradient, arc] { l.frame = bounds }
            let path = CGMutablePath()
            path.addArc(center: CGPoint(x: bounds.midX, y: bounds.midY), radius: (min(bounds.width, bounds.height) - line) / 2,
                        startAngle: 0, endAngle: 0.68 * 2 * .pi, clockwise: false)
            arc.path = path
            arc.lineWidth = line
            effectiveAppearance.performAsCurrentDrawingAppearance {
                let faint = color.withAlphaComponent(color.alphaComponent * 0.05).cgColor
                gradient.colors = [faint, color.cgColor, color.cgColor, faint]
                mirror.shadowColor = color.withAlphaComponent(color.alphaComponent * 0.75).cgColor
            }
            mirror.shadowOpacity = glow > 0 ? 1 : 0
            mirror.shadowRadius = glow * 0.5
            CATransaction.commit()
        }

        override func viewDidChangeBackingProperties() {
            super.viewDidChangeBackingProperties()
            let scale = window?.backingScaleFactor ?? 2
            for l in [mirror, gradient, arc] { l.contentsScale = scale }
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            spin()
        }

        private func spin() {
            guard window != nil, gradient.animation(forKey: "spin") == nil else { return }
            let a = CABasicAnimation(keyPath: "transform.rotation.z")
            a.fromValue = 0
            a.toValue = 2 * Double.pi
            a.duration = period
            a.repeatCount = .infinity
            a.isRemovedOnCompletion = false
            gradient.add(a, forKey: "spin")
        }
    }
}

/// The waiting hand, pulsed by AppKit's symbol effect instead of SwiftUI's.
private struct PulsingSymbol: NSViewRepresentable {
    let name: String
    let pointSize: CGFloat
    let color: NSColor
    let glow: CGFloat

    func makeNSView(context: Context) -> SymbolView { SymbolView() }

    func updateNSView(_ view: SymbolView, context: Context) {
        if view.name != name || view.pointSize != pointSize {
            (view.name, view.pointSize) = (name, pointSize)
            view.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: pointSize, weight: .semibold))
            view.removeAllSymbolEffects()
            view.addSymbolEffect(.pulse, options: .repeating)
        }
        view.contentTintColor = color
        view.layer?.shadowOffset = .zero
        view.layer?.shadowRadius = glow
        view.layer?.shadowOpacity = 1
        view.effectiveAppearance.performAsCurrentDrawingAppearance {
            view.layer?.shadowColor = color.withAlphaComponent(color.alphaComponent * 0.5).cgColor
        }
    }

    final class SymbolView: NSImageView {
        var name = "", pointSize: CGFloat = 0

        override init(frame: NSRect) {
            super.init(frame: frame)
            wantsLayer = true
            imageScaling = .scaleNone
            imageAlignment = .alignCenter
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

/// The state word on cards: filled capsule, outlined capsule (HUD) or "[Running]" (terminal).
struct StateLabel: View {
    let text: String
    let color: Color

    var body: some View {
        let p = Theme.palette
        if p.bracketLabels {
            Text("[\(text)]")
                .font(.system(size: 11.5, weight: .bold))
                .foregroundStyle(color)
                .stateGlow(color)
        } else if p.brackets {
            Text(text)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(color)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .overlay(Capsule().strokeBorder(color.opacity(0.7), lineWidth: 1))
                .stateGlow(color)
        } else {
            Text(text)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(color)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Capsule().fill(color.opacity(0.14)))
        }
    }
}

/// The last `window` of a session's state trajectory as a thin colored bar (right edge = now).
struct StateStrip: View {
    let history: [Seg]
    let now: Date
    var window: TimeInterval = 1800
    var height: CGFloat = 5

    var body: some View {
        Canvas { ctx, size in
            let end = now.timeIntervalSince1970 * 1000
            let start = end - window * 1000
            let bg = Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: Theme.palette.brackets ? 0 : size.height / 2)
            ctx.fill(bg, with: .color(Color.primary.opacity(0.08)))
            ctx.clip(to: bg)
            for (i, seg) in history.enumerated() {
                let t0 = max(seg.t, start)
                let t1 = i + 1 < history.count ? history[i + 1].t : end
                guard t1 > start, t1 > t0 else { continue }
                let x = (t0 - start) / (end - start) * size.width
                // Keep short waits visible: a 10 s wait on a 30 min scale is otherwise sub-pixel.
                let w = max(2, (t1 - t0) / (end - start) * size.width)
                ctx.fill(Path(CGRect(x: x, y: 0, width: w, height: size.height)), with: .color(Theme.segment(seg.k)))
            }
        }
        .frame(height: height)
    }
}

/// Small labelled capsule used for project / host / tags.
struct Chip: View {
    let text: String
    var tint: Color? = nil

    var body: some View {
        Text(text)
            .font(.system(size: 10.5, weight: .medium))
            .lineLimit(1)
            .foregroundStyle(tint ?? .secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(RoundedRectangle(cornerRadius: min(5, Theme.palette.corner)).fill((tint ?? .primary).opacity(0.09)))
    }
}

struct ToastView: View {
    let text: String?

    var body: some View {
        if let text {
            Text(text)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(Capsule().fill(Color.black.opacity(0.78)))
                .padding(.bottom, 14)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// Small "new" dot for unread finishes.
struct UnreadDot: View {
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(Theme.doing)
            .frame(width: size, height: size)
            .shadow(color: Theme.doing.opacity(0.6), radius: 2.5)
            .help("New, not viewed yet. It counts as read once you open the task, stay on its terminal tab for a moment, or send it a new message")
    }
}

// MARK: - menu bar

struct MenuBarCounts: Equatable {
    var waiting = 0
    var doing = 0
    var newDone = 0
    var newFailed = 0
    var urgent = false
    var limitLabel: String?
    var limitValue: Double?

    var isQuiet: Bool { waiting == 0 && doing == 0 && newDone == 0 && newFailed == 0 && limitValue == nil }

    static let sample = MenuBarCounts(waiting: 1, doing: 2, newDone: 1)
}

/// Renders the menu bar badge. Colored states are bitmaps; the quiet state is a template symbol.
@MainActor
enum MenuBarRenderer {
    static func idle(hasTasks: Bool) -> NSImage {
        let name = hasTasks ? "checkmark.circle" : "circle.dotted"
        let base = NSImage(systemSymbolName: name, accessibilityDescription: "Beeplight") ?? NSImage()
        let img = base.withSymbolConfiguration(.init(pointSize: 14, weight: .medium)) ?? base
        img.isTemplate = true
        return img
    }

    /// The idle character, colored by the remaining limit.
    static func face(_ character: String, _ pose: EyePose, energy: Energy) -> NSImage {
        let renderer = ImageRenderer(content: CharacterView(character: character, pose: pose, energy: energy, height: 19.5).padding(.horizontal, 2))
        renderer.scale = 2
        guard let cg = renderer.cgImage else { return idle(hasTasks: false) }
        let img = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / 2, height: CGFloat(cg.height) / 2))
        img.isTemplate = false
        img.accessibilityDescription = "Beeplight"
        return img
    }

    /// `ink` is the text color for styles drawn straight on the bar; nil follows the menu bar.
    static func render(_ c: MenuBarCounts, style: MenuBarStyle, spin: Double, palette: Palette = Theme.palette, ink: Color? = nil) -> NSImage {
        let renderer = ImageRenderer(content: MenuBarBadge(c: c, style: style, spin: spin, p: palette, ink: ink ?? (MenuBarLook.isDark ? .white : .black)))
        renderer.scale = 2
        guard let cg = renderer.cgImage else { return idle(hasTasks: true) }
        let img = NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / 2, height: CGFloat(cg.height) / 2))
        img.isTemplate = false
        return img
    }
}

/// The menu bar's own light/dark look. It follows the wallpaper, so a light-mode Mac with a dark
/// wallpaper has a dark menu bar: the app reports Aqua while the status item's window reports
/// VibrantDark. Black ink chosen from the app's appearance was invisible there.
@MainActor
enum MenuBarLook {
    private static weak var window: NSWindow?
    private static var watch: NSKeyValueObservation?

    private static var statusWindow: NSWindow? {
        if window == nil { window = NSApp.windows.first { String(describing: type(of: $0)) == "NSStatusBarWindow" } }
        return window
    }

    static var isDark: Bool {
        let a = statusWindow?.effectiveAppearance ?? NSApp.effectiveAppearance
        return [.darkAqua, .vibrantDark].contains(a.bestMatch(from: [.aqua, .darkAqua, .vibrantLight, .vibrantDark]))
    }

    /// Calls `changed` when the menu bar flips (new wallpaper, appearance setting). The window only
    /// exists once the menu bar item is up, so this is retried until it is.
    static func observe(_ changed: @escaping @MainActor () -> Void) {
        guard watch == nil, let w = statusWindow else { return }
        watch = w.observe(\.effectiveAppearance) { _, _ in Task { @MainActor in changed() } }
    }
}

/// All six menu bar styles. `ink` is the text color on a bare menu bar (white on a dark bar).
struct MenuBarBadge: View {
    let c: MenuBarCounts
    let style: MenuBarStyle
    let spin: Double
    let p: Palette
    var ink: Color = .white

    var body: some View {
        HStack(spacing: 4) {
            if let l = c.limitLabel, let v = c.limitValue { limitCapsule(l, v) }
            switch style {
            case .capsules: capsules
            case .traffic: traffic
            case .radar: radar
            case .energy: energy
            case .terminal: terminal
            case .dot: dot
            }
        }
        .padding(.vertical, 1)
    }

    private var waitColor: Color { c.urgent ? p.urgent : p.waiting }

    // Capsules: one filled capsule per state with an icon and a number.
    private var capsules: some View {
        HStack(spacing: 3) {
            if c.waiting > 0 { capsule(c.urgent ? "exclamationmark.triangle.fill" : "hand.raised.fill", c.waiting, waitColor) }
            if c.newFailed > 0 { capsule("xmark", c.newFailed, p.failed) }
            if c.newDone > 0 { capsule("checkmark", c.newDone, p.success) }
            if c.doing > 0 {
                HStack(spacing: 3) {
                    miniSpinner(.white, 8.5)
                    Text("\(c.doing)").font(.system(size: 11, weight: .bold).monospacedDigit())
                }
                .padding(.horizontal, 5)
                .frame(height: 16)
                .background(Capsule().fill(p.doing))
            }
        }
        .foregroundStyle(.white)
    }

    // Traffic light: three lamps — needs you / working / new finish — lit when that state exists.
    private var traffic: some View {
        HStack(spacing: 4) {
            lamp(c.waiting > 0, waitColor)
            lamp(c.doing > 0, p.doing, pulse: c.doing > 0)
            lamp(c.newDone + c.newFailed > 0, c.newFailed > 0 ? p.failed : p.success)
        }
        .padding(.horizontal, 5)
        .frame(height: 16)
        .background(Capsule().fill(ink.opacity(0.12)))
    }

    // Radar: a ring split by state, a sweep while anything runs, the total in the middle.
    private var radar: some View {
        let parts: [(Int, Color)] = [(c.waiting, waitColor), (c.doing, p.doing), (c.newFailed, p.failed), (c.newDone, p.success)]
        let total = max(1, parts.reduce(0) { $0 + $1.0 })
        var start = 0.0
        let arcs: [(Double, Double, Color)] = parts.compactMap { n, color in
            guard n > 0 else { return nil }
            defer { start += Double(n) / Double(total) }
            return (start, start + Double(n) / Double(total), color)
        }
        return HStack(spacing: 3) {
            ZStack {
                Circle().stroke(ink.opacity(0.18), lineWidth: 2)
                ForEach(Array(arcs.enumerated()), id: \.offset) { _, a in
                    Circle()
                        .trim(from: a.0 + 0.015, to: max(a.0 + 0.02, a.1 - 0.015))
                        .stroke(a.2, style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .shadow(color: a.2.opacity(p.glow > 0 ? 0.9 : 0), radius: 1.5)
                }
                if c.doing > 0 {
                    // Sweep line with a fading trail.
                    Circle()
                        .trim(from: 0, to: 0.22)
                        .stroke(AngularGradient(colors: [p.doing.opacity(0), p.doing.opacity(0.85)], center: .center), lineWidth: 5)
                        .rotationEffect(.degrees(spin * 360 - 90))
                        .padding(3.5)
                }
                Text("\(c.waiting + c.doing + c.newDone + c.newFailed)")
                    .font(.system(size: 7.5, weight: .heavy, design: .rounded).monospacedDigit())
                    .foregroundStyle(ink)
            }
            .frame(width: 17, height: 17)
            if c.waiting > 0 {
                Image(systemName: "hand.raised.fill").font(.system(size: 9, weight: .bold)).foregroundStyle(waitColor)
            }
        }
    }

    // Energy bar: one cell per task, colored by state; running cells shimmer.
    private var energy: some View {
        let cells: [Color] = Array(repeating: waitColor, count: c.waiting) + Array(repeating: p.failed, count: c.newFailed)
            + Array(repeating: p.success, count: c.newDone) + Array(repeating: p.doing, count: c.doing)
        let shown = Array(cells.prefix(8))
        return HStack(spacing: 4) {
            HStack(spacing: 1.5) {
                ForEach(Array(shown.enumerated()), id: \.offset) { i, color in
                    let running = i >= shown.count - min(c.doing, shown.count)
                    let phase = (spin + Double(i) * 0.18).truncatingRemainder(dividingBy: 1)
                    RoundedRectangle(cornerRadius: 1)
                        .fill(color.opacity(running ? 0.55 + 0.45 * abs(sin(phase * .pi)) : 1))
                        .frame(width: 4, height: 10)
                }
                if shown.isEmpty { RoundedRectangle(cornerRadius: 1).fill(ink.opacity(0.25)).frame(width: 4, height: 10) }
            }
            .padding(2)
            .overlay(RoundedRectangle(cornerRadius: 2.5).stroke(ink.opacity(0.45), lineWidth: 1))
            Text("\(c.waiting + c.doing + c.newDone + c.newFailed)")
                .font(.system(size: 10.5, weight: .bold, design: .monospaced))
                .foregroundStyle(ink)
        }
    }

    // Terminal text: "W1 D2 ✓1▌" in a little console.
    private var terminal: some View {
        HStack(spacing: 5) {
            if c.waiting > 0 { Text("W\(c.waiting)").foregroundStyle(waitColor) }
            if c.doing > 0 { Text("D\(c.doing)").foregroundStyle(p.doing) }
            if c.newFailed > 0 { Text("✗\(c.newFailed)").foregroundStyle(p.failed) }
            if c.newDone > 0 { Text("✓\(c.newDone)").foregroundStyle(p.success) }
            Text(spin < 0.5 || c.doing == 0 ? "▌" : " ").foregroundStyle(hex(0x46FF7A))
        }
        .font(.system(size: 10.5, weight: .bold, design: .monospaced))
        .padding(.horizontal, 6)
        .frame(height: 16)
        .background(RoundedRectangle(cornerRadius: 3).fill(Color.black.opacity(0.88)))
        .overlay(RoundedRectangle(cornerRadius: 3).stroke(hex(0x1E7A32), lineWidth: 1))
    }

    // Dot: one dot in the most pressing state's color, with its count.
    private var dot: some View {
        let (n, color): (Int, Color) = c.waiting > 0 ? (c.waiting, waitColor)
            : c.newFailed > 0 ? (c.newFailed, p.failed)
            : c.newDone > 0 ? (c.newDone, p.success)
            : (c.doing, p.doing)
        let pulse = c.waiting > 0 ? 0.6 + 0.4 * abs(sin(spin * .pi)) : 1
        return HStack(spacing: 3) {
            Circle().fill(color).frame(width: 8, height: 8).opacity(pulse).shadow(color: color.opacity(0.8), radius: 2)
            Text("\(n)").font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundStyle(ink)
        }
    }

    // MARK: parts

    private func capsule(_ symbol: String, _ n: Int, _ color: Color) -> some View {
        HStack(spacing: 2) {
            Image(systemName: symbol).font(.system(size: 8.5, weight: .heavy))
            Text("\(n)").font(.system(size: 11, weight: .bold).monospacedDigit())
        }
        .padding(.horizontal, 5)
        .frame(height: 16)
        .background(Capsule().fill(color))
    }

    private func lamp(_ on: Bool, _ color: Color, pulse: Bool = false) -> some View {
        Circle()
            .fill(on ? color : ink.opacity(0.22))
            .frame(width: 8, height: 8)
            .opacity(on && pulse ? 0.65 + 0.35 * abs(sin(spin * .pi)) : 1)
            .shadow(color: on ? color.opacity(0.9) : .clear, radius: on ? 2.5 : 0)
    }

    private func miniSpinner(_ color: Color, _ size: CGFloat) -> some View {
        ZStack {
            Circle().stroke(color.opacity(0.35), lineWidth: 1.8)
            Circle()
                .trim(from: 0, to: 0.62)
                .stroke(color, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
                .rotationEffect(.degrees(spin * 360))
        }
        .frame(width: size, height: size)
    }

    private func limitCapsule(_ label: String, _ v: Double) -> some View {
        HStack(spacing: 2) {
            Image(systemName: "gauge.with.dots.needle.67percent").font(.system(size: 9, weight: .bold))
            Text("\(label) \(Fmt.pct(v))").font(.system(size: 10.5, weight: .bold).monospacedDigit())
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 5)
        .frame(height: 16)
        .background(Capsule().fill(v >= 0.95 ? p.failed : p.waiting.opacity(0.9)))
    }
}

struct MenuBarLabel: View {
    @ObservedObject var menuBar: MenuBarImage
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Image(nsImage: menuBar.image)
            // Always rendered, so it is where views outside a scene (the island) get openWindow from.
            .onAppear { WindowOpener.board = { openWindow(id: "board") } }
    }
}
