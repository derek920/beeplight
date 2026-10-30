import AppKit
import SwiftUI

// Effects that run without end (the spinning ring, an urgent card's breathing glow, the waiting
// hand's pulse) are Core Animation layers: built once, then animated by the window server. Done
// in SwiftUI they cost the app a layout and a redraw of their whole window on every frame.

/// Starts an endless animation in phase with the clock, so every view running it moves in step.
private func loop(_ a: CABasicAnimation, on layer: CALayer, key: String, cycle: Double) {
    let now = layer.convertTime(CACurrentMediaTime(), from: nil)
    a.beginTime = now - now.truncatingRemainder(dividingBy: cycle)
    a.repeatCount = .infinity
    a.isRemovedOnCompletion = false
    layer.add(a, forKey: key)
}

/// Base for the effect views: layer-backed, never takes clicks (they belong to the card or row
/// underneath), rebuilt on layout when its style or size changed, animations restarted when it
/// comes back into a window.
class EffectView<Style: Equatable>: NSView {
    var style: Style? {
        didSet { if style != oldValue { needsLayout = true } }
    }
    private var built: (style: Style, size: CGSize)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        guard let style, bounds.width > 0, built.map({ $0.style != style || $0.size != bounds.size }) ?? true else { return }
        built = (style, bounds.size)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        build(style)
        CATransaction.commit()
        animate(style)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil, let style = built?.style { animate(style) }
    }

    func build(_ style: Style) {}
    func animate(_ style: Style) {}
}

// MARK: - spinning ring

/// The animated ring: a faint track, and a 245° arc that fades in toward its head. The arc is built
/// from short segments rather than a gradient, so its direction is plain geometry in the same
/// space as the rotation and the head always leads.
struct SpinnerLayer: NSViewRepresentable {
    let color: Color
    let line: CGFloat
    let glow: CGFloat
    /// Seconds per turn.
    let period: Double

    func makeNSView(context: Context) -> SpinnerView { SpinnerView() }

    func updateNSView(_ view: SpinnerView, context: Context) {
        // Resolved in SwiftUI's environment, so the island's forced dark scheme applies too.
        view.style = .init(color: color.resolve(in: context.environment).cgColor, line: line, glow: glow, period: period)
    }
}

final class SpinnerView: EffectView<SpinnerView.Style> {
    struct Style: Equatable {
        var color: CGColor
        var line: CGFloat
        var glow: CGFloat
        var period: Double
    }

    private let root = CALayer()
    private let arc = CALayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.addSublayer(root)
        root.addSublayer(arc)
    }

    required init?(coder: NSCoder) { nil }

    override func build(_ s: Style) {
        root.frame = bounds
        arc.frame = bounds
        root.sublayers?.filter { $0 !== arc }.forEach { $0.removeFromSuperlayer() }
        arc.sublayers?.forEach { $0.removeFromSuperlayer() }
        root.shadowColor = s.color
        root.shadowOpacity = s.glow > 0 ? 0.75 : 0
        root.shadowRadius = s.glow * 0.5
        root.shadowOffset = .zero

        let c = CGPoint(x: bounds.midX, y: bounds.midY)
        let r = (min(bounds.width, bounds.height) - s.line) / 2
        let track = CAShapeLayer()
        track.path = CGPath(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r), transform: nil)
        track.fillColor = nil
        track.strokeColor = s.color.copy(alpha: s.color.alpha * 0.18)
        track.lineWidth = s.line
        root.insertSublayer(track, below: arc)

        // The layer space is y-up, so decreasing angles run clockwise on screen, like the SwiftUI ring.
        let sweep = 245 * Double.pi / 180
        let n = 24
        for i in 0..<n {
            let a0 = -sweep * Double(i) / Double(n)
            // A hair of overlap hides the seams between segments.
            let a1 = -sweep * Double(i + 1) / Double(n) - 0.01
            let path = CGMutablePath()
            path.addArc(center: c, radius: r, startAngle: a0, endAngle: a1, clockwise: true)
            let seg = CAShapeLayer()
            seg.path = path
            seg.fillColor = nil
            seg.strokeColor = s.color.copy(alpha: s.color.alpha * (0.05 + 0.95 * (Double(i) + 0.5) / Double(n)))
            seg.lineWidth = s.line
            seg.lineCap = i == n - 1 ? .round : .butt
            arc.addSublayer(seg)
        }
    }

    /// Clockwise, in step with every other spinner (the old shared clock kept them in step too).
    override func animate(_ s: Style) {
        let a = CABasicAnimation(keyPath: "transform.rotation.z")
        a.fromValue = 0
        a.toValue = -2 * Double.pi
        a.duration = s.period
        loop(a, on: arc, key: "spin", cycle: s.period)
    }
}

// MARK: - breathing glow

/// The glow of an urgent card, brightening and fading every second. Put it behind the card; the
/// card itself is not re-rendered while it breathes.
struct BreathingGlow: NSViewRepresentable {
    let color: Color
    let corner: CGFloat
    let radius: CGFloat

    func makeNSView(context: Context) -> BreathingGlowView { BreathingGlowView() }

    func updateNSView(_ view: BreathingGlowView, context: Context) {
        view.style = .init(color: color.resolve(in: context.environment).cgColor, corner: corner, radius: radius)
    }
}

final class BreathingGlowView: EffectView<BreathingGlowView.Style> {
    struct Style: Equatable {
        var color: CGColor
        var corner: CGFloat
        var radius: CGFloat
    }

    private let glow = CALayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.addSublayer(glow)
    }

    required init?(coder: NSCoder) { nil }

    override func build(_ s: Style) {
        glow.frame = bounds
        // A shadow path needs no content and no offscreen pass.
        glow.shadowPath = CGPath(roundedRect: bounds, cornerWidth: s.corner, cornerHeight: s.corner, transform: nil)
        glow.shadowColor = s.color
        glow.shadowRadius = s.radius
        glow.shadowOffset = .zero
        glow.shadowOpacity = 0
    }

    /// One second up, one second down, bright on even seconds like the clock-driven glow it replaces.
    override func animate(_ s: Style) {
        let a = CABasicAnimation(keyPath: "shadowOpacity")
        a.fromValue = 0
        a.toValue = 0.55
        a.duration = 1
        a.autoreverses = true
        a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        loop(a, on: glow, key: "breathe", cycle: 2)
    }
}

// MARK: - pulsing symbol

/// An SF Symbol that fades out and back in, like `.symbolEffect(.pulse)`.
struct PulsingSymbol: NSViewRepresentable {
    let name: String
    let color: Color
    let pointSize: CGFloat
    let weight: NSFont.Weight
    let glow: CGFloat

    func makeNSView(context: Context) -> PulsingSymbolView { PulsingSymbolView() }

    func updateNSView(_ view: PulsingSymbolView, context: Context) {
        view.style = .init(name: name, color: color.resolve(in: context.environment).cgColor, pointSize: pointSize, weight: weight, glow: glow)
    }
}

final class PulsingSymbolView: EffectView<PulsingSymbolView.Style> {
    struct Style: Equatable {
        var name: String
        var color: CGColor
        var pointSize: CGFloat
        var weight: NSFont.Weight
        var glow: CGFloat
    }

    private let symbol = CALayer()

    override init(frame: NSRect) {
        super.init(frame: frame)
        layer?.addSublayer(symbol)
    }

    required init?(coder: NSCoder) { nil }

    override func build(_ s: Style) {
        let config = NSImage.SymbolConfiguration(pointSize: s.pointSize, weight: s.weight)
            .applying(.init(paletteColors: [NSColor(cgColor: s.color) ?? .systemOrange]))
        let image = NSImage(systemSymbolName: s.name, accessibilityDescription: nil)?.withSymbolConfiguration(config)
        symbol.frame = bounds
        symbol.contentsGravity = .center
        symbol.contentsScale = window?.backingScaleFactor ?? 2
        // An NSImage as contents gives Core Animation the symbol's vector form at the layer's scale.
        symbol.contents = image
        symbol.shadowColor = s.color
        symbol.shadowOpacity = 0.5
        symbol.shadowRadius = s.glow
        symbol.shadowOffset = .zero
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        symbol.contentsScale = window?.backingScaleFactor ?? 2
    }

    override func animate(_ s: Style) {
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 1
        a.toValue = 0.4
        a.duration = 0.75
        a.autoreverses = true
        a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        loop(a, on: symbol, key: "pulse", cycle: 1.5)
    }
}
