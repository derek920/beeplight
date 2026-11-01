import AppKit
import SwiftUI

// A Dynamic-Island-style status pill at the top of the screen. In notch mode it grows out of the
// MacBook notch (and falls back to a pill on screens without one); in floating mode it is always a
// pill. The pill can be dragged anywhere. It peeks open for a few seconds when a task finishes or
// needs you, and with auto-hide on it is out of sight the rest of the time.

struct IslandGeometry: Equatable {
    var notch = false
    var notchWidth: CGFloat = 0
    var notchHeight: CGFloat = 30
    /// A draggable pill: floating mode, or notch mode with no notch to grow out of.
    var floating = false
}

@MainActor
final class IslandModel: ObservableObject {
    @Published var hovering = false
    @Published var pinned = false
    @Published var flash: Flash?
    @Published var geometry = IslandGeometry()
    /// Bumped to rebuild the island view, which resets SwiftUI's hover tracking.
    @Published var hoverEpoch = 0
    /// Where the island is drawn, in the panel's top-left coordinates (for the hover watchdog).
    var frame: CGRect = .zero

    struct Flash: Equatable {
        let id: String
        let phase: Phase
        let headline: String
        let title: String
    }

    var open: Bool { hovering || pinned }
}

// A non-activating panel: clicking it never steals focus from the app you are in, but it may
// become key so SwiftUI buttons inside it work.
private final class IslandPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

// The panel is never the active window, so every click is a "first mouse"; without this AppKit
// swallows it and the island's buttons do nothing (hover still works, which hides the problem).
private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // SwiftUI builds the island's `.contextMenu` (menu(for:) returns it), but a right-click sent to
    // this panel did not open it (tested with synthesized events). Open it the plain AppKit way.
    override func rightMouseDown(with event: NSEvent) {
        if let menu = menu(for: event) {
            NSMenu.popUpContextMenu(menu, with: event, for: self)
        } else {
            super.rightMouseDown(with: event)
        }
    }
}

/// Lets views outside a SwiftUI scene (the island) open the board window.
@MainActor
enum WindowOpener {
    static var board: (() -> Void)?

    static func openBoard() {
        board?()
        NSApp.activate(ignoringOtherApps: true)
    }
}

@MainActor
final class IslandController {
    static let shared = IslandController()
    let model = IslandModel()
    /// The panel is a fixed transparent canvas; only the drawn island takes clicks. Its width
    /// leaves room right of center for half the notch, the widest counts wing (144 pt) and the
    /// glow: notches are about 140–250 pt depending on the Mac and its display scaling, and
    /// 760 fits up to about 400 pt.
    static let canvas = NSSize(width: 760, height: 440)
    private var panel: IslandPanel?
    private var flashTask: Task<Void, Never>?
    private var watchdog: Timer?
    private var missedChecks = 0
    private var clickMonitor: Any?
    static var spring: Animation? { Theme.animated ? .spring(response: 0.38, dampingFraction: 0.82) : nil }

    func apply(_ config: AppearanceConfig) {
        guard config.island != .off else {
            panel?.orderOut(nil)
            panel = nil
            return
        }
        if panel == nil { makePanel() }
        layout(config)
        panel?.orderFrontRegardless()
    }

    private func makePanel() {
        let p = IslandPanel(contentRect: NSRect(origin: .zero, size: Self.canvas), styleMask: [.borderless, .nonactivatingPanel],
                            backing: .buffered, defer: false)
        p.title = "island"
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
        p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        p.hidesOnDeactivate = false
        p.becomesKeyOnlyIfNeeded = true
        p.contentView = FirstMouseHostingView(rootView: IslandView(model: model, monitor: .shared, appearance: .shared))
        panel = p
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in IslandController.shared.layout(Appearance.shared.config) }
        }
        // A click anywhere else (another app, or the island's transparent canvas, which passes
        // clicks through) closes it, pinned or not. Clicks on the island itself are local events.
        if clickMonitor == nil {
            clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { _ in
                Task { @MainActor in IslandController.shared.collapse() }
            }
        }
    }

    /// Closes the list and any peek, e.g. after jumping to a task from the island.
    func collapse() {
        let m = model
        guard m.open || m.flash != nil else { return }
        stopWatch()
        flashTask?.cancel()
        withAnimation(Self.spring) {
            m.hovering = false
            m.pinned = false
            m.flash = nil
        }
    }

    /// SwiftUI sometimes misses the hover exit (seen after jumping to a task from the island),
    /// which left the island stuck open. While it is open by hover, check where the mouse is.
    func watchHover() {
        missedChecks = 0
        guard watchdog == nil else { return }
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
            Task { @MainActor in IslandController.shared.checkHover() }
        }
    }

    private func checkHover() {
        guard model.hovering, let panel else {
            stopWatch()
            return
        }
        // Pinned stays open until a click elsewhere.
        let f = model.frame
        guard !model.pinned, f != .zero else { return }
        let rect = NSRect(x: panel.frame.minX + f.minX, y: panel.frame.maxY - f.maxY, width: f.width, height: f.height)
        if rect.insetBy(dx: -8, dy: -8).contains(NSEvent.mouseLocation) {
            missedChecks = 0
            return
        }
        missedChecks += 1
        guard missedChecks >= 2 else { return }
        stopWatch()
        withAnimation(Self.spring) { model.hovering = false }
        // SwiftUI still thinks the mouse is inside and would ignore the next hover; start fresh.
        model.hoverEpoch += 1
    }

    private func stopWatch() {
        watchdog?.invalidate()
        watchdog = nil
    }

    func layout(_ config: AppearanceConfig) {
        guard let panel else { return }
        var g = IslandGeometry()
        var screen = NSScreen.main ?? NSScreen.screens[0]
        if config.island == .notch, let s = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
            screen = s
            g.notch = true
            g.notchHeight = s.safeAreaInsets.top
            if let l = s.auxiliaryTopLeftArea, let r = s.auxiliaryTopRightArea { g.notchWidth = r.minX - l.maxX } else { g.notchWidth = 190 }
        }
        // Without a notch the pill sits over the top of windows, so it can be moved out of the way.
        g.floating = !g.notch
        model.geometry = g
        let size = Self.canvas
        var origin: CGPoint
        if g.notch {
            origin = CGPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.maxY - size.height)
        } else {
            origin = CGPoint(x: screen.frame.midX - size.width / 2, y: screen.visibleFrame.maxY - size.height - 6)
            if g.floating, let top = Self.savedPillTop() {
                // Only reuse a position that is still on some screen.
                if NSScreen.screens.contains(where: { $0.frame.contains(CGPoint(x: top.x, y: top.y - 10)) }) {
                    origin = CGPoint(x: top.x - size.width / 2, y: top.y - size.height)
                }
            }
        }
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    private var dragStart: (mouse: CGPoint, origin: CGPoint)?

    // Screen coordinates: the gesture's own space moves along with the window being dragged.
    func drag() {
        guard let panel else { return }
        let m = NSEvent.mouseLocation
        if dragStart == nil { dragStart = (m, panel.frame.origin) }
        guard let s = dragStart else { return }
        panel.setFrameOrigin(CGPoint(x: s.origin.x + m.x - s.mouse.x, y: s.origin.y + m.y - s.mouse.y))
    }

    func endDrag() {
        dragStart = nil
        guard let f = panel?.frame else { return }
        UserDefaults.standard.set(NSStringFromPoint(CGPoint(x: f.midX, y: f.maxY)), forKey: "islandTop")
        UserDefaults.standard.removeObject(forKey: "islandOrigin")
    }

    /// Where the user left the pill: its top center, which stays put when the canvas changes size.
    /// `islandOrigin`, saved by older versions, is the corner of a 520 pt wide canvas.
    private static func savedPillTop() -> CGPoint? {
        let d = UserDefaults.standard
        if let s = d.string(forKey: "islandTop") { return NSPointFromString(s) }
        guard let s = d.string(forKey: "islandOrigin") else { return nil }
        let o = NSPointFromString(s)
        return CGPoint(x: o.x + 260, y: o.y + canvas.height)
    }

    /// Debug aid for `--island-click`: a synthetic click on the first task row, so a snapshot run
    /// can prove the island's buttons receive clicks (the server logs `[focus] … from island`).
    func debugClickFirstRow() {
        guard let panel else { return }
        let top = model.geometry.notch ? model.geometry.notchHeight : 0
        // Window coordinates have their origin at the bottom left.
        let p = CGPoint(x: Self.canvas.width / 2 - 80, y: Self.canvas.height - (top + 44 + 22))
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                panel.sendEvent(e)
            }
        }
    }

    /// Peek open with a one-line live activity for a task that just finished or needs the user.
    func flash(_ item: TaskItem) {
        let cfg = Appearance.shared.config
        guard panel != nil, cfg.islandLiveActivity else { return }
        let headline: String
        switch item.phase {
        case .waiting: headline = item.kind == "question" ? String(localized: "Awaiting your reply") : String(localized: "Waiting for you")
        case .failed: headline = String(localized: "Task failed")
        case .success: headline = String(localized: "Task done")
        case .doing: return
        }
        withAnimation(Theme.animated ? .spring(response: 0.42, dampingFraction: 0.78) : nil) {
            model.flash = .init(id: item.id, phase: item.phase, headline: headline, title: item.title)
        }
        flashTask?.cancel()
        flashTask = Task {
            try? await Task.sleep(for: .seconds(4.5))
            guard !Task.isCancelled else { return }
            withAnimation(Theme.animated ? .spring(response: 0.42, dampingFraction: 0.85) : nil) { model.flash = nil }
        }
    }
}

struct IslandView: View {
    @ObservedObject var model: IslandModel
    let monitor: Monitor
    @ObservedObject var appearance: Appearance

    var body: some View {
        VStack(spacing: 0) {
            // A hidden pill is not drawn at all, so its transparent canvas lets clicks through.
            if !(hidden && !g.notch) {
                island.transition(.scale(scale: 0.6, anchor: .top).combined(with: .opacity))
            }
            Spacer(minLength: 0)
        }
        .animation(spring, value: hidden)
        .frame(width: IslandController.canvas.width, height: IslandController.canvas.height, alignment: .top)
        .environment(\.colorScheme, .dark)
        .fontDesign(Theme.palette.fontDesign)
        .id([appearance.revision, model.hoverEpoch])
    }

    // MARK: layout

    private var g: IslandGeometry { model.geometry }
    private var peek: Bool { !model.open && model.flash != nil }
    private var active: Bool { !(monitor.waiting.isEmpty && monitor.doing.isEmpty && monitor.unreadDone.isEmpty) }
    /// Auto-hide while nothing needs the user: the pill disappears, and the notch island pulls back
    /// into the notch, where hovering still opens the list. Running tasks alone don't bring it back.
    private var hidden: Bool {
        appearance.config.islandAutoHide && !model.open && model.flash == nil
            && monitor.waiting.isEmpty && monitor.unreadDone.isEmpty
    }
    private var rows: [TaskItem] { Array((monitor.waiting + monitor.doing + monitor.unreadDone).prefix(6)) }
    private var topInset: CGFloat { g.notch ? g.notchHeight : 0 }
    private let wing: CGFloat = 62
    /// The right wing grows to fit every count: with waiting, running and done all showing
    /// (or more digits) they overflow `wing` and get clipped. Each count is at most a 14 pt
    /// symbol plus 8 pt per digit, 7 pt apart; 8 pt of margin keeps them off the rounded
    /// corner. 999 of each needs 144 pt. The left wing only holds one glyph and stays `wing`,
    /// so it covers no more of the app menus than before.
    private var countsWing: CGFloat {
        let ns = [monitor.waiting.count, monitor.doing.count, monitor.unreadDone.count].filter { $0 > 0 }
        let content = ns.reduce(0) { $0 + 14 + 8 * CGFloat(String($1).count) } + 7 * CGFloat(max(0, ns.count - 1))
        return max(wing, content + 16)
    }
    /// With wings of different widths the island is pushed right by half the difference, so
    /// the gap between them still sits exactly under the notch.
    private var notchShift: CGFloat { g.notch && active && !hidden && !model.open && !peek ? (countsWing - wing) / 2 : 0 }
    /// Narrower wings for the idle eyes, which stay out all the time.
    private let idleWing: CGFloat = 46
    private var faceOn: Bool { appearance.config.character != Characters.classic }
    private var limits: LimitsInfo? { monitor.limits }

    private var size: CGSize {
        if model.open {
            let list = max(1, rows.count)
            return CGSize(width: 440, height: topInset + 44 + CGFloat(list) * 44 + 40)
        }
        if peek { return CGSize(width: max(g.notchWidth + 2 * wing, 380), height: topInset + (g.notch ? 44 : 50)) }
        if g.notch { return CGSize(width: g.notchWidth + (hidden ? 0 : active ? wing + countsWing : faceOn ? 2 * idleWing : 0), height: g.notchHeight) }
        // The pill grows by as much as the counts outgrow `wing`.
        return CGSize(width: 236 + countsWing - wing, height: 32)
    }

    private var shape: some Shape {
        let r: CGFloat = model.open || peek ? 22 : (g.notch ? 10 : 16)
        return UnevenRoundedRectangle(topLeadingRadius: g.notch ? 0 : r, bottomLeadingRadius: r,
                                      bottomTrailingRadius: r, topTrailingRadius: g.notch ? 0 : r, style: .continuous)
    }

    private var accent: Color {
        if let f = model.flash { return Theme.color(f.phase) }
        if !monitor.waiting.isEmpty { return Theme.color(.waiting, urgent: monitor.anyUrgent) }
        if !monitor.unreadDone.isEmpty { return monitor.unreadDone.contains { $0.phase == .failed } ? Theme.failed : Theme.success }
        return faceOn ? Energy(limits).color(Theme.palette) : Theme.doing
    }

    private var islandContent: some View {
        ZStack(alignment: .top) {
            if model.open {
                expanded.transition(.opacity)
            } else if peek, let f = model.flash {
                peekRow(f).transition(.opacity)
            } else {
                collapsed.transition(.opacity)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .top)
    }

    /// Always dark, like the island it imitates: its text is drawn light, so a light theme's backdrop
    /// would leave it unreadable. A dark theme lends its backdrop; the accents follow any theme.
    private var fill: Color {
        if g.notch { return .black }
        let p = Theme.palette
        return (p.scheme == .dark ? p.backdrop ?? .black : .black).opacity(0.94)
    }
    private var lit: Bool { Theme.palette.glow > 0 || Theme.palette.brackets }
    private var strokeColor: Color { lit ? accent.opacity(model.open || peek ? 0.7 : 0.45) : Color.white.opacity(g.notch ? 0 : 0.12) }
    private var glowColor: Color { Theme.palette.glow > 0 ? accent.opacity(0.55) : Color.black.opacity(0.35) }
    private var glowRadius: CGFloat { Theme.palette.glow > 0 ? Theme.palette.glow : 8 }
    private var showBrackets: Bool { Theme.palette.brackets && (model.open || peek) }
    private var showScanlines: Bool { Theme.palette.scanlines && model.open }
    private var spring: Animation? { IslandController.spring }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 3)
            .onChanged { _ in if g.floating { IslandController.shared.drag() } }
            .onEnded { _ in if g.floating { IslandController.shared.endDrag() } }
    }

    private func hover(_ h: Bool) {
        guard appearance.config.islandHover else { return }
        withAnimation(spring) { model.hovering = h }
        if h { IslandController.shared.watchHover() }
    }

    // A click on the island (not on a row) pins it open; a click anywhere else closes it.
    private func toggle() {
        withAnimation(spring) { model.pinned.toggle() }
        if model.hovering { IslandController.shared.watchHover() }
    }

    /// Jump to the task and get out of the way.
    private func open(_ id: String) {
        monitor.focus(id, via: "island")
        IslandController.shared.collapse()
    }

    private var island: some View {
        islandContent
            .background(GeometryReader { p in
                Color.clear
                    .onAppear { model.frame = p.frame(in: .global) }
                    .onChange(of: p.frame(in: .global)) { _, f in model.frame = f }
            })
            .background(shape.fill(fill))
            .overlay(shape.stroke(strokeColor, lineWidth: 1))
            .overlay { if showBrackets { CornerBrackets(color: accent, length: 12).padding(3) } }
            .clipShape(shape)
            .shadow(color: glowColor, radius: glowRadius, y: 2)
            .overlay { if showScanlines { Scanlines().clipShape(shape) } }
            .contentShape(shape)
            // The board's close button leaves the app running; this is a quit that is easy to find.
            .contextMenu {
                Button("Open board") {
                    WindowOpener.openBoard()
                    IslandController.shared.collapse()
                }
                Divider()
                Button("Quit Beeplight") { NSApp.terminate(nil) }
            }
            .onHover(perform: hover)
            .onTapGesture(perform: toggle)
            // `.none` would disable every gesture below too, buttons included; `.subviews`
            // turns off only the drag (notch mode) and keeps the rows clickable.
            .gesture(dragGesture, including: g.floating ? .all : .subviews)
            // Padding, not offset, so the hover watchdog's frame moves with it.
            .padding(.leading, 2 * notchShift)
            .animation(Theme.animated ? .spring(response: 0.4, dampingFraction: 0.8) : nil, value: size)
    }

    // MARK: states

    private var leadGlyph: some View {
        Group {
            if let w = monitor.waiting.first { StatusGlyph(phase: .waiting, urgent: monitor.isUrgent(w), size: 15) }
            else if let d = monitor.unreadDone.first { StatusGlyph(phase: d.phase, size: 15) }
            else if !monitor.doing.isEmpty { StatusGlyph(phase: .doing, size: 15) }
            else if faceOn { LiveCharacter(character: appearance.config.character, height: 17) }
            else { Image(systemName: "sparkle").font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)) }
        }
    }

    /// What is left of the fuller limit window, next to the idle eyes.
    @ViewBuilder private var remaining: some View {
        if let used = Energy.used(limits) {
            Text(Fmt.pct(max(0, 1 - used)))
                .font(.system(size: 11, weight: .bold).monospacedDigit())
                .foregroundStyle(Energy(limits).color(Theme.palette))
                .help(String(localized: "Usage limit left"))
        }
    }

    private var counts: some View {
        HStack(spacing: 7) {
            if !monitor.waiting.isEmpty { count("hand.raised.fill", monitor.waiting.count, Theme.color(.waiting, urgent: monitor.anyUrgent)) }
            if !monitor.doing.isEmpty { count("circle.dotted", monitor.doing.count, Theme.doing) }
            if !monitor.unreadDone.isEmpty { count("checkmark", monitor.unreadDone.count, Theme.success) }
        }
    }

    private func count(_ symbol: String, _ n: Int, _ color: Color) -> some View {
        HStack(spacing: 2) {
            Image(systemName: symbol).font(.system(size: 9, weight: .bold))
            Text("\(n)").font(.system(size: 11.5, weight: .bold).monospacedDigit())
        }
        .foregroundStyle(color)
        .stateGlow(color)
    }

    @ViewBuilder private var collapsed: some View {
        if g.notch {
            HStack(spacing: 0) {
                if hidden {
                    EmptyView()
                } else if active {
                    leadGlyph.frame(width: wing, alignment: .center)
                    Spacer(minLength: g.notchWidth)
                    counts.fixedSize().frame(width: countsWing, alignment: .center)
                } else if faceOn {
                    LiveCharacter(character: appearance.config.character, height: 20).frame(width: idleWing, alignment: .center)
                    Spacer(minLength: g.notchWidth)
                    remaining.frame(width: idleWing, alignment: .center)
                }
            }
            .frame(height: g.notchHeight)
        } else {
            HStack(spacing: 8) {
                leadGlyph
                Text(rows.first?.title ?? String(localized: "Nothing is running"))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Spacer(minLength: 4)
                counts.fixedSize()
                if !active && faceOn { remaining }
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
        }
    }

    private func peekRow(_ f: IslandModel.Flash) -> some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: topInset)
            HStack(spacing: 10) {
                StatusGlyph(phase: f.phase, size: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(f.headline).font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.color(f.phase))
                    Text(f.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                }
                Spacer(minLength: 6)
                Button("View") { open(f.id) }
                    .buttonStyle(.borderless)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.color(f.phase))
            }
            .padding(.horizontal, 16)
            .frame(height: g.notch ? 44 : 50)
        }
    }

    private var expanded: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: topInset)
            HStack(spacing: 10) {
                Text("Claude").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                counts
                if model.pinned { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(.white.opacity(0.45)) }
                Spacer()
                if let L = monitor.limits {
                    Text("5h \(Fmt.pct(L.fiveHour?.utilization)) · wk \(Fmt.pct(L.sevenDay?.utilization))")
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 44)
            if rows.isEmpty {
                HStack(spacing: 10) {
                    if faceOn { LiveCharacter(character: appearance.config.character, height: 22) }
                    Text("Nothing running or waiting for you").font(.system(size: 12)).foregroundStyle(.white.opacity(0.5))
                }
                .frame(height: 44)
            }
            ForEach(rows) { item in
                Button { open(item.id) } label: {
                    HStack(spacing: 10) {
                        if item.unread == true { UnreadDot(size: 6) }
                        StatusGlyph(phase: item.phase, urgent: monitor.isUrgent(item), size: 15)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                            Text(([item.agentBadge] + [item.detail?.isEmpty == false ? item.detail! : item.label]).compactMap { $0 }.joined(separator: " · "))
                                .font(.system(size: 10.5))
                                .foregroundStyle(.white.opacity(0.55))
                                .lineLimit(1)
                        }
                        Spacer(minLength: 6)
                        Ticking(monitor) { now in
                            Text(Fmt.elapsed(item, now: now))
                                .font(.system(size: 10.5).monospacedDigit())
                                .foregroundStyle(monitor.isUrgent(item) ? Theme.urgent : .white.opacity(0.5))
                        }
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            HStack {
                Button("Open board") {
                    WindowOpener.openBoard()
                    IslandController.shared.collapse()
                }
                Spacer()
                if !monitor.unreadDone.isEmpty { Button("Mark all read") { monitor.markAllRead() } }
            }
            .buttonStyle(.borderless)
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(Theme.doing)
            .padding(.horizontal, 16)
            .frame(height: 40)
        }
    }
}
