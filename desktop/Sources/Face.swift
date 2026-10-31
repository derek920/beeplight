import AppKit
import SwiftUI

// The idle face: robot eyes or a line-drawn character, shown when no task is running, waiting or newly done. Their color
// and energy follow how much usage limit is left, so a glance at an idle Mac tells whether there
// is room for a big task. The eyes blink and look around on their own, and only redraw while
// they move, so an idle menu bar costs next to nothing.

extension Energy {
    func color(_ p: Palette) -> Color {
        switch self {
        case .unknown: p.doing
        case .full: p.success
        case .half: p.waiting
        case .low, .empty: p.failed
        }
    }
}

@MainActor
final class FaceAnimator: ObservableObject {
    static let shared = FaceAnimator()

    @Published private(set) var pose = EyePose()
    @Published var energy = Energy.unknown
    /// Called on every frame, for the menu bar bitmap.
    var onFrame: (() -> Void)?

    private var running = false
    private var rest: Timer?
    private var frames: Timer?

    private enum Move {
        case blink, doubleBlink, glance(CGFloat), happy, special, whirl

        var duration: Double {
            switch self {
            case .blink: 0.18
            case .doubleBlink: 0.46
            case .glance: 1.5
            case .happy: 2.2
            case .special: 1.2
            case .whirl: 1.6
            }
        }
    }

    /// Moves only while something shows the face.
    func setVisible(_ visible: Bool) {
        guard visible != running else { return }
        running = visible
        rest?.invalidate()
        frames?.invalidate()
        frames = nil
        pose = EyePose()
        if visible { scheduleMove() }
    }

    /// A happy squint, e.g. when the last task has been looked at.
    func celebrate() {
        guard running, Theme.animated else { return }
        play(.happy)
    }

    private func scheduleMove() {
        rest?.invalidate()
        guard running, Theme.animated else { return }
        rest = Timer.scheduledTimer(withTimeInterval: .random(in: energy.rest), repeats: false) { _ in
            Task { @MainActor in FaceAnimator.shared.playRandom() }
        }
    }

    private func playRandom() {
        // Gentle motion looks around half as often.
        let curious = Theme.motion == .full ? energy.curiosity : energy.curiosity / 2
        let figure = Characters.figure(Appearance.shared.config.character)
        let r = Double.random(in: 0..<1)
        if r < curious { play(.glance(Bool.random() ? -1 : 1)) }
        // A text-art face has no move of its own at this size; it glances and blinks.
        else if let figure, figure.text == nil, r < curious + 0.25, energy != .empty { play(figure.spin != nil && Bool.random() ? .whirl : .special) }
        else { play(Double.random(in: 0..<1) < 0.2 ? .doubleBlink : .blink) }
    }

    private func play(_ move: Move) {
        rest?.invalidate()
        frames?.invalidate()
        let start = Date()
        frames = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
            Task { @MainActor in FaceAnimator.shared.step(move, Date().timeIntervalSince(start)) }
        }
    }

    private func step(_ move: Move, _ t: Double) {
        let d = move.duration
        guard t < d else {
            frames?.invalidate()
            frames = nil
            set(EyePose())
            scheduleMove()
            return
        }
        var p = EyePose()
        switch move {
        case .blink:
            p.blink = Self.shut(t / d)
        case .doubleBlink:
            p.blink = Self.shut((t / d * 2).truncatingRemainder(dividingBy: 1))
        case .glance(let dir):
            let k = min(1, min(t, d - t) / 0.2)
            p.look = dir * CGFloat(k * k * (3 - 2 * k))
        case .happy:
            // Squint (the robot twirls its antenna), then open with a blink.
            p.happy = t < d - 0.2
            if !p.happy { p.blink = Self.shut((t - (d - 0.2)) / 0.4 + 0.5) }
            if Characters.figure(Appearance.shared.config.character)?.spin != nil { p.whirl(t / 1.6, turns: Energy.full.turns) }
        case .special:
            p.alt = Int(t / 0.2) % 2 == 0
        case .whirl:
            p.whirl(t / d, turns: energy.turns)
        }
        set(p)
    }

    /// 1 → 0 → 1 over x in 0…1.
    private static func shut(_ x: Double) -> CGFloat { CGFloat(abs(1 - 2 * x)) }

    private func set(_ p: EyePose) {
        guard p != pose else { return }
        pose = p
        onFrame?()
    }
}

/// Two robot eyes. `height` is the eye box; widths and spacing follow it.
struct EyesView: View {
    let pose: EyePose
    let energy: Energy
    var palette: Palette = Theme.palette
    var height: CGFloat = 11

    private var w: CGFloat { height * 0.62 }

    var body: some View {
        let color = energy.color(palette)
        HStack(spacing: w * 0.8) {
            eye(color)
            eye(color)
        }
        .offset(x: pose.look * w * 0.45)
        .frame(width: w * 3.7, height: height)
        .shadow(color: color.opacity(0.7), radius: height * 0.16)
        .opacity(energy == .empty ? 0.75 : 1)
    }

    @ViewBuilder private func eye(_ color: Color) -> some View {
        if pose.happy {
            HappyArc()
                .stroke(color, style: StrokeStyle(lineWidth: w * 0.34, lineCap: .round))
                .frame(width: w, height: w * 0.55)
                .frame(height: height)
        } else {
            // Tired lids close from the top; a blink closes around what is left.
            let open = height * energy.openness
            let h = max(height * 0.1, open * pose.blink)
            RoundedRectangle(cornerRadius: min(w, h) * 0.42, style: .continuous)
                .fill(color)
                .frame(width: w, height: h)
                .offset(y: (height - open) / 2)
                .frame(height: height)
        }
    }
}

private struct HappyArc: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: r.minX, y: r.maxY))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.maxY), control: CGPoint(x: r.midX, y: r.minY - r.height * 0.6))
        return p
    }
}

// MARK: - characters

/// The choices for the idle face: robot eyes, the line-drawn characters in characters.json, or
/// the classic icon. Adding a character to that file adds it to the settings; no code changes.
enum Characters {
    static let eyes = "eyes"
    static let classic = "classic"

    static let figures: [Figure] = {
        // characters.json ships with the web page, which the app bundles as the service's files. It
        // is the character pack: each entry decodes on its own, so one bad entry hides only itself,
        // and one that needs a purchase is not offered in the open-source app.
        guard let url = Bundle.main.resourceURL?.appending(path: "server/public/characters.json") else { return [] }
        return Packs.available(Packs.load(Figure.self, from: url), NoPurchases()).filter(\.isValid)
    }()

    static var all: [String] { [eyes] + figures.map(\.id) + [classic] }

    static func figure(_ id: String) -> Figure? { figures.first { $0.id == id } }

    static func name(_ id: String) -> String {
        switch id {
        case eyes: return String(localized: "Robot eyes")
        case classic: return String(localized: "Classic")
        default:
            guard let f = figure(id) else { return id }
            let lang = Bundle.main.preferredLocalizations.first ?? "en"
            return f.name[lang] ?? f.name["en"] ?? id
        }
    }

}

/// A character in thin strokes, colored by energy; a text-art one shows its one-line face.
struct FigureView: View {
    let figure: Figure
    let pose: EyePose
    let energy: Energy
    var palette: Palette = Theme.palette
    var height: CGFloat

    var body: some View {
        let color = energy.color(palette)
        Group {
            if let text = figure.text {
                // A glance nudges the face the way it looks.
                Text(text.face(pose, openness: energy.openness))
                    .font(.system(size: height * 0.56, weight: .bold, design: .monospaced))
                    .foregroundStyle(color)
                    .fixedSize()
                    .offset(x: pose.look * height * 0.06)
                    .frame(height: height)
            } else {
                let scale = height / figure.box[1]
                Canvas { ctx, _ in figure.draw(ctx, scale: scale, pose: pose, openness: energy.openness, color: color) }
                .frame(width: figure.box[0] * scale, height: height)
            }
        }
        .shadow(color: color.opacity(0.55), radius: max(1, height * 0.04))
        .opacity(energy == .empty ? 0.75 : 1)
    }
}

/// The chosen character in a box `height` tall.
struct CharacterView: View {
    let character: String
    let pose: EyePose
    let energy: Energy
    var palette: Palette = Theme.palette
    var height: CGFloat

    var body: some View {
        Group {
            if let f = Characters.figure(character) {
                FigureView(figure: f, pose: pose, energy: energy, palette: palette, height: height)
            } else {
                EyesView(pose: pose, energy: energy, palette: palette, height: height * 0.58)
            }
        }
        .frame(height: height)
    }
}

/// The chosen character, following the shared animator.
struct LiveCharacter: View {
    @ObservedObject private var face = FaceAnimator.shared
    let character: String
    var height: CGFloat

    var body: some View {
        CharacterView(character: character, pose: face.pose, energy: face.energy, height: height)
    }
}
