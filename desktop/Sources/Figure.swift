import SwiftUI

// The parts of the idle face that don't depend on AppKit, shared with the iPhone app (a separate,
// closed-source project that compiles this file): how much limit is left, the eye pose, the
// line-drawn characters from characters.json and the SVG path subset they use.

/// How much limit is left, as the eyes show it. Thresholds match the quota bars' colors.
enum Energy: Hashable {
    case unknown, full, half, low, empty

    init(_ limits: LimitsInfo?) {
        guard let used = Self.used(limits) else {
            self = .unknown
            return
        }
        if limits?.status == "rejected" || used >= 0.95 { self = .empty }
        else if used >= 0.8 { self = .low }
        else if used >= 0.5 { self = .half }
        else { self = .full }
    }

    /// The fuller of the 5-hour and weekly windows.
    static func used(_ limits: LimitsInfo?) -> Double? {
        [limits?.fiveHour?.utilization, limits?.sevenDay?.utilization].compactMap { $0 }.max()
    }

    /// How far the lids are open at rest.
    var openness: CGFloat {
        switch self {
        case .unknown, .full: 1
        case .half: 0.72
        case .low: 0.46
        case .empty: 0.18
        }
    }

    /// Seconds between moves: tired eyes move less.
    var rest: ClosedRange<Double> {
        switch self {
        case .unknown, .full: 2.2...4.5
        case .half: 3.5...6.5
        case .low: 5...9
        case .empty: 7...12
        }
    }

    /// How many times the antenna goes around in one whirl: a tired robot whirls slower.
    var turns: Double {
        switch self {
        case .unknown, .full: 2.5
        case .half: 1.75
        case .low: 1
        case .empty: 0
        }
    }

    /// Chance that a move is a look around rather than a blink.
    var curiosity: Double {
        switch self {
        case .unknown, .full: 0.5
        case .half: 0.3
        case .low: 0.12
        case .empty: 0
        }
    }
}

struct EyePose: Equatable {
    /// 1 open … 0 shut, on top of the energy's openness.
    var blink: CGFloat = 1
    /// -1 left … 1 right.
    var look: CGFloat = 0
    /// ^ ^ for a moment once everything is handled.
    var happy = false
    /// A drawn character's own move (ear flop, ear twitch, antenna spark).
    var alt = false
    /// Where the `spin` parts (the robot's antenna) lean, in turns: 0 toward you, 0.25 right.
    var spin: CGFloat = 0
    /// How far they lean: 0 upright … 1 fully.
    var swing: CGFloat = 0

    /// One whirl at `x` from 0 to 1: leans out, goes around `turns` times and settles back
    /// upright. Same curve as whirlAt() in public/app.js.
    mutating func whirl(_ x: Double, turns: Double) {
        let x = min(max(x, 0), 1)
        spin = CGFloat(turns * x * x * (3 - 2 * x))
        swing = CGFloat(sin(.pi * x))
    }

    /// While working: around once every `period` seconds, after a short lean-in.
    mutating func whirl(running t: Double, period: Double = 1.1) {
        spin = CGFloat(t / period)
        swing = CGFloat(0.8 * min(1, t / 0.6))
    }
}

/// A line-drawn character: SVG paths in a box, plus where its eyes go. Or a text-art one (`text`),
/// which has no paths.
struct Figure: Decodable {
    let id: String
    let name: [String: String]
    let box: [CGFloat]
    /// Always drawn; `rest` normally, `alt` instead during the character's own move.
    let paths: [String]
    let rest: [String]
    let alt: [String]
    /// Eye centers and the eye height, in box units.
    let eyes: [[CGFloat]]
    let eye: CGFloat
    /// Parts that whirl around `base` like a spring antenna; upright at rest.
    let spin: Spin?
    let text: TextArt?

    struct Spin: Decodable {
        let base: [CGFloat]
        let paths: [String]
    }

    /// Terminal-style text art: `face` is one line for small sizes (the menu bar, the island),
    /// `rest` and `alt` the full drawing; `*` marks the eyes.
    struct TextArt: Decodable {
        let face: String
        /// The open eye; tired, shut and happy eyes are the same for every character.
        let eye: String?
        let rest: [String]
        let alt: [String]?

        /// Same rules as eyeGlyph() in public/app.js.
        func eyeGlyph(_ pose: EyePose, openness: CGFloat) -> String {
            if pose.happy { return "^" }
            if pose.blink < 0.35 { return "-" }
            let open = openness * pose.blink
            return open >= 0.6 ? eye ?? "o" : open >= 0.3 ? "~" : "_"
        }

        func face(_ pose: EyePose, openness: CGFloat) -> String {
            face.replacingOccurrences(of: "*", with: eyeGlyph(pose, openness: openness))
        }

        func lines(_ pose: EyePose, openness: CGFloat) -> String {
            let eye = eyeGlyph(pose, openness: openness)
            return (pose.alt ? alt ?? rest : rest).map { $0.replacingOccurrences(of: "*", with: eye) }.joined(separator: "\n")
        }
    }

    private enum Keys: String, CodingKey { case id, name, box, paths, rest, alt, eyes, eye, spin, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode([String: String].self, forKey: .name)
        text = try c.decodeIfPresent(TextArt.self, forKey: .text)
        box = try c.decodeIfPresent([CGFloat].self, forKey: .box) ?? []
        paths = try c.decodeIfPresent([String].self, forKey: .paths) ?? []
        rest = try c.decodeIfPresent([String].self, forKey: .rest) ?? []
        alt = try c.decodeIfPresent([String].self, forKey: .alt) ?? []
        eyes = try c.decodeIfPresent([[CGFloat]].self, forKey: .eyes) ?? []
        eye = try c.decodeIfPresent(CGFloat.self, forKey: .eye) ?? 0
        spin = try c.decodeIfPresent(Spin.self, forKey: .spin)
    }

    var isValid: Bool {
        if text != nil { return true }
        return box.count == 2 && eyes.allSatisfy { $0.count == 2 } && (spin?.base.count ?? 2) == 2
    }

    /// The spin parts for a pose: leaning up to 30° toward `pose.spin`, seen from a little above,
    /// so the tip dips coming toward you and rises going away. Same as spinMatrix() in
    /// public/app.js.
    func spinTransform(_ pose: EyePose) -> CGAffineTransform {
        guard let spin, pose.swing > 0 else { return .identity }
        let lean = pose.swing * .pi / 6
        let dir = pose.spin * 2 * .pi
        let c = -sin(lean) * sin(dir)
        let d = cos(lean) - 0.35 * sin(lean) * cos(dir)
        let by = spin.base[1]
        return CGAffineTransform(a: 1, b: 0, c: c, d: d, tx: -c * by, ty: by * (1 - d))
    }

    /// Draws the character in thin strokes, `scale` points per box unit; the Mac and iOS apps
    /// both draw it here.
    func draw(_ ctx: GraphicsContext, scale: CGFloat, pose: EyePose, openness: CGFloat, color: Color) {
        var ctx = ctx
        ctx.scaleBy(x: scale, y: scale)
        // Thin, but never thinner than a point, or the menu bar version breaks up.
        let line = StrokeStyle(lineWidth: max(1.0 / scale, 1.3), lineCap: .round, lineJoin: .round)
        for d in paths + (pose.alt ? alt : rest) { ctx.stroke(SVGPath.parse(d), with: .color(color), style: line) }
        if let spin {
            let t = spinTransform(pose)
            for d in spin.paths { ctx.stroke(SVGPath.parse(d).applying(t), with: .color(color), style: line) }
        }
        ctx.stroke(eyePath(pose, openness: openness), with: .color(color), style: StrokeStyle(lineWidth: max(1.5 / scale, 2.2), lineCap: .round))
    }

    /// The eyes for a pose: a vertical stroke that tired lids shorten from the top, a short
    /// line when shut, ^ when happy. Same geometry as eyePath() in public/app.js.
    func eyePath(_ pose: EyePose, openness: CGFloat) -> Path {
        var p = Path()
        for e in eyes {
            let (x, y, h) = (e[0] + pose.look * 1.5, e[1], eye)
            if pose.happy {
                p.move(to: CGPoint(x: x - 2.2, y: y + 1))
                p.addQuadCurve(to: CGPoint(x: x + 2.2, y: y + 1), control: CGPoint(x: x, y: y - 2.2))
            } else if pose.blink < 0.35 {
                p.move(to: CGPoint(x: x - 1.6, y: y + h / 2 - 0.4))
                p.addLine(to: CGPoint(x: x + 1.6, y: y + h / 2 - 0.4))
            } else {
                let l = max(0.9, h * openness * pose.blink)
                p.move(to: CGPoint(x: x, y: y + h / 2 - l))
                p.addLine(to: CGPoint(x: x, y: y + h / 2))
            }
        }
        return p
    }
}

/// The subset of SVG path data characters.json uses: M L H V C Q Z, absolute or relative.
enum SVGPath {
    private static var cache: [String: Path] = [:]

    static func parse(_ d: String) -> Path {
        if let p = cache[d] { return p }
        var path = Path()
        var nums: [CGFloat] = []
        var cmd: Character = "M"
        var cur = CGPoint.zero
        var start = CGPoint.zero

        func flush() {
            let rel = cmd.isLowercase
            let base = rel ? cur : .zero
            func pt(_ i: Int) -> CGPoint { CGPoint(x: base.x + nums[i], y: base.y + nums[i + 1]) }
            var i = 0
            switch cmd.uppercased() {
            case "M":
                while i + 1 < nums.count {
                    let p = CGPoint(x: (rel ? cur.x : 0) + nums[i], y: (rel ? cur.y : 0) + nums[i + 1])
                    // Pairs after the first are implicit line-tos.
                    if i == 0 { path.move(to: p); start = p } else { path.addLine(to: p) }
                    cur = p
                    i += 2
                }
            case "L":
                while i + 1 < nums.count {
                    let p = CGPoint(x: (rel ? cur.x : 0) + nums[i], y: (rel ? cur.y : 0) + nums[i + 1])
                    path.addLine(to: p)
                    cur = p
                    i += 2
                }
            case "H":
                for n in nums { cur = CGPoint(x: (rel ? cur.x : 0) + n, y: cur.y); path.addLine(to: cur) }
            case "V":
                for n in nums { cur = CGPoint(x: cur.x, y: (rel ? cur.y : 0) + n); path.addLine(to: cur) }
            case "C":
                while i + 5 < nums.count {
                    let (c1, c2, p) = (pt(i), pt(i + 2), pt(i + 4))
                    path.addCurve(to: p, control1: c1, control2: c2)
                    cur = p
                    i += 6
                }
            case "Q":
                while i + 3 < nums.count {
                    let (c, p) = (pt(i), pt(i + 2))
                    path.addQuadCurve(to: p, control: c)
                    cur = p
                    i += 4
                }
            case "Z":
                path.closeSubpath()
                cur = start
            default:
                break
            }
            nums.removeAll()
        }

        var token = ""
        func endNumber() {
            if let n = Double(token) { nums.append(CGFloat(n)) }
            token = ""
        }
        for ch in d {
            if ch.isLetter && ch != "e" && ch != "E" {
                endNumber()
                flush()
                cmd = ch
            } else if ch == "-" && !token.isEmpty && !token.hasSuffix("e") {
                endNumber()
                token = "-"
            } else if ch == "," || ch == " " || ch == "\n" || ch == "\t" {
                endNumber()
            } else if ch == "." && token.contains(".") {
                endNumber()
                token = "."
            } else {
                token.append(ch)
            }
        }
        endNumber()
        flush()
        cache[d] = path
        return path
    }
}
