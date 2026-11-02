import AppKit
import Observation
import SwiftUI

/// Live state from the Node service (SSE on /api/stream) plus the actions the UI can take.
///
/// Observed per property: a view re-renders only when a property it read has changed. Some
/// properties change often (the menu bar bitmap 12 times a second while a task runs, the clock
/// and the service's meta once a second), so every property is assigned only when its value
/// changed, and only small leaf views read the clock (see `Ticking`).
@MainActor
@Observable
final class Monitor {
    static let shared = Monitor()

    private(set) var items: [TaskItem] = [] {
        didSet { derive() }
    }
    private(set) var idleCount = 0
    private(set) var staleCount = 0
    private(set) var connected = false
    /// Once a second. Read it only in leaf views (`Ticking`), never in a list's or a window's body.
    private(set) var now = Date()
    /// `now` to the minute, for countdowns that show minutes.
    private(set) var minute = Date()
    private(set) var menuBarImage = MenuBarRenderer.idle(hasTasks: false)
    var toast: String?

    // The service's meta event in parts, so a change in one part re-renders only its readers.
    private(set) var hz: Double?
    private(set) var today: Today?
    private(set) var summarizer: SummarizerStats?
    private(set) var usage: UsageMeta?
    private(set) var limits: LimitsInfo?
    private(set) var cpu: CpuMeta?
    private(set) var titles: String?
    /// False when the service shows original titles and makes no summary calls.
    var aiTitles: Bool { titles != "original" }

    var showSDK = UserDefaults.standard.bool(forKey: "showSDK") {
        didSet { UserDefaults.standard.set(showSDK, forKey: "showSDK"); derive(); refreshImage() }
    }
    var notifyWaiting = UserDefaults.standard.object(forKey: "notifyWaiting") as? Bool ?? true {
        didSet { UserDefaults.standard.set(notifyWaiting, forKey: "notifyWaiting") }
    }
    var notifyDone = UserDefaults.standard.object(forKey: "notifyDone") as? Bool ?? true {
        didSet { UserDefaults.standard.set(notifyDone, forKey: "notifyDone") }
    }
    var notifyLimits = UserDefaults.standard.object(forKey: "notifyLimits") as? Bool ?? true {
        didSet { UserDefaults.standard.set(notifyLimits, forKey: "notifyLimits") }
    }

    // MARK: derived lists, recomputed when the snapshot or the SDK filter changes

    private(set) var visible: [TaskItem] = []
    private(set) var waiting: [TaskItem] = []
    private(set) var doing: [TaskItem] = []
    /// Unread finishes first, like unread chats.
    private(set) var done: [TaskItem] = []
    private(set) var unreadDone: [TaskItem] = []
    /// Servers and watchers agents left running (and ones that just ended): listed apart, never notified.
    private(set) var services: [ServiceItem] = []
    /// Waiting on a real prompt for longer than `urgentAfter`; checked every second.
    private(set) var urgentIDs: Set<String> = []
    var anyUrgent: Bool { !urgentIDs.isEmpty }

    @ObservationIgnored let base = URL(string: "http://127.0.0.1:7333")!
    @ObservationIgnored private let session = URLSession(configuration: .ephemeral)
    @ObservationIgnored private var seenKey: [String: String] = [:]
    @ObservationIgnored private var notifiedKey: [String: String] = [:]
    @ObservationIgnored private var firstSnapshot = true
    /// Called when a task newly needs the user or newly finished (drives the island's pop-up).
    @ObservationIgnored var onTransition: ((TaskItem) -> Void)?
    @ObservationIgnored private var lastMetaAt = Date.distantPast
    /// Frame of the menu bar animation, 0..<12.
    @ObservationIgnored private var spinStep = 0
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var wasIdle: Bool?
    @ObservationIgnored private var faceCache: (key: String, image: NSImage)?
    @ObservationIgnored private var badgeCache: [BadgeKey: NSImage] = [:]
    @ObservationIgnored private var badgeByPixels: [Data: NSImage] = [:]
    @ObservationIgnored private var itemIDs: Set<String> = []

    /// Whether a task is urgent. A task on the board reads only `urgentIDs`, so its view is not
    /// re-rendered every second; anything else (the settings preview) is checked against the clock.
    func isUrgent(_ item: TaskItem) -> Bool {
        itemIDs.contains(item.id) ? urgentIDs.contains(item.id) : item.isUrgent(now: now)
    }

    private func derive() {
        let v = items.filter { showSDK || $0.sdk != true }
        let d = v.filter { $0.phase == .success || $0.phase == .failed }.sorted {
            ($0.unread == true) != ($1.unread == true) ? $0.unread == true : ($0.since ?? 0) > ($1.since ?? 0)
        }
        assign(\.visible, v)
        assign(\.waiting, v.filter { $0.phase == .waiting }.sorted { ($0.since ?? 0) < ($1.since ?? 0) })
        assign(\.doing, v.filter { $0.phase == .doing }.sorted { ($0.turnStartedAt ?? $0.since ?? 0) < ($1.turnStartedAt ?? $1.since ?? 0) })
        assign(\.done, d)
        assign(\.unreadDone, d.filter { $0.unread == true })
        assign(\.services, ServiceItem.all(in: v))
        itemIDs = Set(items.map(\.id))
        updateUrgent()
    }

    private func updateUrgent() {
        assign(\.urgentIDs, Set(waiting.filter { $0.isUrgent(now: now) }.map(\.id)))
    }

    /// Setting an observed property notifies its readers even when the value is the same.
    private func assign<T: Equatable>(_ path: ReferenceWritableKeyPath<Monitor, T>, _ value: T) {
        if self[keyPath: path] != value { self[keyPath: path] = value }
    }

    var limitsNote: String {
        guard let L = limits else { return "" }
        if let e = L.error { return String(localized: "Couldn't get limits: \(e)") }
        if L.probing == true { return String(localized: "Refreshing limits…") }
        return L.at.map { String(localized: "Limits updated \(Fmt.clock($0))") } ?? ""
    }

    /// Shown in the menu bar once a window is ≥ 80% used.
    var limitBadge: (label: String, value: Double)? {
        if let u = limits?.fiveHour?.utilization, u >= 0.8 { return ("5h", u) }
        if let u = limits?.sevenDay?.utilization, u >= 0.8 { return (String(localized: "wk"), u) }
        return nil
    }

    // MARK: lifecycle

    func start() {
        FaceAnimator.shared.onFrame = { Monitor.shared.refreshImage() }
        Task { await streamLoop() }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in self.secondTick() }
        }
        // Menu bar animation; only re-renders while something is running or waiting, and motion is on.
        Timer.scheduledTimer(withTimeInterval: 1.0 / 12, repeats: true) { _ in
            Task { @MainActor in
                guard Theme.animated, !self.doing.isEmpty || !self.waiting.isEmpty else { return }
                self.spinStep = (self.spinStep + 1) % 12
                self.refreshImage()
            }
        }
    }

    private func secondTick() {
        let t = Date()
        now = t
        assign(\.minute, Date(timeIntervalSince1970: (t.timeIntervalSince1970 / 60).rounded(.down) * 60))
        updateUrgent()
        if t.timeIntervalSince(lastMetaAt) > 3, connected { connected = false }
        if doing.isEmpty { refreshImage() } // urgency can change with time alone
    }

    private func streamLoop() async {
        while !Task.isCancelled {
            do {
                var req = URLRequest(url: base.appending(path: "api/stream"))
                req.timeoutInterval = 10
                let (bytes, resp) = try await session.bytes(for: req)
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                var event = "message"
                // `lines` drops blank lines, but the service sends exactly one data line per event.
                for try await line in bytes.lines {
                    if line.hasPrefix("event:") {
                        event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                    } else if line.hasPrefix("data:") {
                        handle(event: event, data: Data(line.dropFirst(5).utf8))
                    }
                }
            } catch {}
            connected = false
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func handle(event: String, data: Data) {
        let decoder = JSONDecoder()
        switch event {
        case "state":
            guard let snap = try? decoder.decode(Snapshot.self, from: data) else { return }
            if snap.sessions != items {
                // Animate only when tasks come, go, move or change state. Most snapshots just carry
                // a new tool line or token count, and animating those relaid out the board for a second.
                let shape = { (list: [TaskItem]) in list.map { "\($0.id) \($0.phase) \($0.unread == true)" } }
                if shape(snap.sessions) != shape(items) {
                    withAnimation(.spring(response: 0.45, dampingFraction: 0.86)) { items = snap.sessions }
                } else {
                    items = snap.sessions
                }
            }
            assign(\.idleCount, snap.idleCount ?? 0)
            assign(\.staleCount, snap.staleCount ?? 0)
            trackTransitions()
            refreshImage()
        case "meta":
            guard let m = try? decoder.decode(Meta.self, from: data) else { return }
            lastMetaAt = Date()
            assign(\.hz, m.hz)
            assign(\.today, m.today)
            assign(\.summarizer, m.summarizer)
            assign(\.usage, m.usage)
            assign(\.limits, m.usage?.limits)
            assign(\.cpu, m.cpu)
            assign(\.titles, m.titles)
            if !connected {
                connected = true
                syncCharacter()
            }
            checkLimitThresholds(m.usage?.limits)
            let energy = Energy(m.usage?.limits)
            if FaceAnimator.shared.energy != energy {
                FaceAnimator.shared.energy = energy
                refreshImage()
            }
        default:
            break
        }
    }

    // MARK: notifications

    private func stateKey(_ v: TaskItem) -> String {
        v.state == "done" ? "done:\(v.outcome ?? "success")" : v.state
    }

    private func trackTransitions() {
        for v in visible {
            let key = stateKey(v)
            let prev = seenKey[v.id]
            seenKey[v.id] = key
            if firstSnapshot {
                notifiedKey[v.id] = key
                continue
            }
            // Wait for the verdict so one turn end produces one notification.
            if v.pending == true || notifiedKey[v.id] == key { continue }
            notifiedKey[v.id] = key
            guard prev != nil || v.phase == .waiting else { continue }
            if v.phase != .doing { onTransition?(v) }
            switch v.phase {
            case .waiting where notifyWaiting:
                Notifier.shared.post(id: v.id, title: String(localized: "Waiting for you · \(v.title)"), body: [v.remote?.name, v.agentBadge, v.label, v.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            case .success where notifyDone, .failed where notifyDone:
                Notifier.shared.post(id: v.id, title: v.phase == .failed ? String(localized: "Task failed · \(v.title)") : String(localized: "Task done · \(v.title)"), body: [v.remote?.name, v.agentBadge, v.label, v.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            default:
                break
            }
        }
        firstSnapshot = false
    }

    /// One notification per window and threshold, remembered across relaunches.
    private func checkLimitThresholds(_ L: LimitsInfo?) {
        guard notifyLimits, let L else { return }
        // `id` keeps the remembered key the same whatever the UI language.
        for (id, name, w) in [("5h", String(localized: "5-hour limit"), L.fiveHour), ("7d", String(localized: "Weekly limit"), L.sevenDay)] {
            guard let w else { continue }
            guard let threshold = [0.95, 0.8].first(where: { w.utilization >= $0 }) else { continue }
            let key = "limitNotified.\(id).\(Int(w.resetsAt))"
            if UserDefaults.standard.double(forKey: key) >= threshold { continue }
            UserDefaults.standard.set(threshold, forKey: key)
            let (proj, _) = projectionText(w)
            let resets = Fmt.clock(w.resetsAt, withDay: id == "7d")
            Notifier.shared.post(id: "limits", title: String(localized: "\(name) at \(Fmt.pct(w.utilization))"),
                                 body: proj.isEmpty ? String(localized: "Resets \(resets)") : String(localized: "Resets \(resets); \(proj)"))
        }
    }

    /// Tells the service which character is chosen, so the phone's status screen shows it too.
    func syncCharacter() {
        Task {
            var req = URLRequest(url: base.appending(path: "api/character"))
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "x-beeplight")
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONEncoder().encode(["id": Appearance.shared.config.character])
            _ = try? await session.data(for: req)
        }
    }

    func refreshLimits() {
        Task {
            var req = URLRequest(url: base.appending(path: "api/limits/refresh"))
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "x-beeplight")
            req.timeoutInterval = 60
            show(String(localized: "Refreshing limits…"))
            let ok = (try? await session.data(for: req)).map { _ in true } ?? false
            show(ok ? String(localized: "Limits refreshed") : String(localized: "Refresh failed"))
        }
    }

    // MARK: menu bar

    var menuBarCounts: MenuBarCounts {
        let fresh = unreadDone
        let newOK = fresh.filter { $0.phase == .success }.count
        let limit = limitBadge
        return MenuBarCounts(waiting: waiting.count, doing: doing.count, newDone: newOK, newFailed: fresh.count - newOK,
                             urgent: anyUrgent, limitLabel: limit?.label, limitValue: limit?.value)
    }

    func refreshImage() {
        MenuBarLook.observe { Monitor.shared.refreshImage() }
        let c = menuBarCounts
        let w = c.waiting
        let fresh = unreadDone
        // The idle eyes move only while shown, and squint happily once the last task is handled.
        let face = FaceAnimator.shared
        let idle = waiting.isEmpty && doing.isEmpty && fresh.isEmpty
        let character = Appearance.shared.config.character
        let faceShown = idle && character != Characters.classic
        face.setVisible(faceShown)
        if faceShown, wasIdle == false { face.celebrate() }
        wasIdle = idle
        let image = !c.isQuiet ? badgeImage(c)
            : faceShown ? faceImage(character, face)
            : MenuBarRenderer.idle(hasTasks: !visible.isEmpty)
        if image !== menuBarImage { menuBarImage = image }
        // Same predicate as the lists: things that need the user (waiting + unread finishes).
        let badge = w + fresh.count
        let label = badge > 0 ? String(badge) : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    private struct BadgeKey: Hashable {
        let counts: MenuBarCounts
        let style: MenuBarStyle
        let step: Int
        let revision: Int
        let dark: Bool
    }

    /// The animation loops through 12 frames, so after the first loop every frame comes from here
    /// instead of another `ImageRenderer` pass.
    private func badgeImage(_ c: MenuBarCounts) -> NSImage {
        let key = BadgeKey(counts: c, style: Appearance.shared.config.menuBar, step: spinStep,
                           revision: Appearance.shared.revision, dark: MenuBarLook.isDark)
        if let image = badgeCache[key] { return image }
        if badgeCache.count >= 48 {
            badgeCache.removeAll(keepingCapacity: true)
            badgeByPixels.removeAll(keepingCapacity: true)
        }
        var image = MenuBarRenderer.render(c, style: key.style, spin: Double(key.step) / 12)
        // Frames that look the same share one image, and `refreshImage` skips setting an image that
        // is already up. Most styles have only a few distinct frames (the terminal cursor has two),
        // and every new image makes the menu bar lay out and redraw its copy on each display.
        if let pixels = image.cgImage(forProposedRect: nil, context: nil, hints: nil)?.dataProvider?.data as Data? {
            if let same = badgeByPixels[pixels] { image = same } else { badgeByPixels[pixels] = image }
        }
        badgeCache[key] = image
        return image
    }

    /// The menu bar refreshes every second; redraw the eyes only when they changed.
    private func faceImage(_ character: String, _ face: FaceAnimator) -> NSImage {
        let key = "\(character) \(face.pose) \(face.energy) \(Appearance.shared.revision)"
        if let c = faceCache, c.key == key { return c.image }
        let image = MenuBarRenderer.face(character, face.pose, energy: face.energy)
        faceCache = (key, image)
        return image
    }

    // MARK: actions

    func focus(_ id: String, via: String = "app") { perform(id, "focus", via: via) }
    func dismiss(_ id: String) { perform(id, "dismiss") }
    func resummarize(_ id: String) { perform(id, "resummarize") }
    func markRead(_ id: String) { perform(id, "read") }

    func markAllRead() {
        Task {
            var req = URLRequest(url: base.appending(path: "api/read-all"))
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "x-beeplight")
            _ = try? await session.data(for: req)
            show(String(localized: "Marked all read"))
        }
    }

    private struct ActionResult: Decodable {
        var ok: Bool?
        var how: String?
        var error: String?
    }

    private func perform(_ id: String, _ action: String, via: String? = nil) {
        // Another device's task is read-only here.
        if let r = items.first(where: { $0.id == id })?.remote {
            if action == "focus" { show(String(localized: "This task runs on \(r.name)")) }
            return
        }
        Task {
            var url = base.appending(path: "api/sessions/\(id)/\(action)")
            if let via { url.append(queryItems: [URLQueryItem(name: "via", value: via)]) }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "x-beeplight")
            req.timeoutInterval = 10
            do {
                let (data, _) = try await session.data(for: req)
                let r = try JSONDecoder().decode(ActionResult.self, from: data)
                switch action {
                case "focus": if r.ok != true { show(String(localized: "Couldn't jump to task: \(r.error ?? String(localized: "Unknown error"))")) }
                case "resummarize": show(r.ok == true ? String(localized: "Queued to summarize again") : String(localized: "This session has nothing to summarize"))
                case "read": break
                default: if r.ok == true { show(String(localized: "Removed from board")) }
                }
            } catch {
                show(String(localized: "Request failed: \(error.localizedDescription)"))
            }
        }
    }

    func show(_ message: String) {
        toastTask?.cancel()
        withAnimation { toast = message }
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2.6))
            if !Task.isCancelled { withAnimation { toast = nil } }
        }
    }
}

/// Wraps the parts of a view that change with the clock (elapsed times, trajectory strips), so
/// only they re-render every second and the card or list around them stays put.
struct Ticking<Content: View>: View {
    let monitor: Monitor
    let content: (Date) -> Content

    init(_ monitor: Monitor, @ViewBuilder content: @escaping (Date) -> Content) {
        self.monitor = monitor
        self.content = content
    }

    var body: some View { content(monitor.now) }
}
