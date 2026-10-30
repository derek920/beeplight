import AppKit
import SwiftUI

/// The menu bar bitmap, redrawn at 12fps while a task runs. Kept out of `Monitor` so that only the
/// menu bar label re-renders on every frame, not every view that observes `Monitor`.
@MainActor
final class MenuBarImage: ObservableObject {
    @Published var image = MenuBarRenderer.idle(hasTasks: false)
}

/// Live state from the Node service (SSE on /api/stream) plus the actions the UI can take.
@MainActor
final class Monitor: ObservableObject {
    static let shared = Monitor()

    @Published private(set) var items: [TaskItem] = []
    @Published private(set) var idleCount = 0
    @Published private(set) var staleCount = 0
    @Published private(set) var meta: Meta?
    @Published private(set) var connected = false
    @Published private(set) var now = Date()
    let menuBar = MenuBarImage()
    var menuBarImage: NSImage { menuBar.image }
    @Published var toast: String?

    @Published var showSDK = UserDefaults.standard.bool(forKey: "showSDK") {
        didSet { UserDefaults.standard.set(showSDK, forKey: "showSDK"); refreshImage() }
    }
    @Published var notifyWaiting = UserDefaults.standard.object(forKey: "notifyWaiting") as? Bool ?? true {
        didSet { UserDefaults.standard.set(notifyWaiting, forKey: "notifyWaiting") }
    }
    @Published var notifyDone = UserDefaults.standard.object(forKey: "notifyDone") as? Bool ?? true {
        didSet { UserDefaults.standard.set(notifyDone, forKey: "notifyDone") }
    }
    @Published var notifyLimits = UserDefaults.standard.object(forKey: "notifyLimits") as? Bool ?? true {
        didSet { UserDefaults.standard.set(notifyLimits, forKey: "notifyLimits") }
    }

    let base = URL(string: "http://127.0.0.1:7333")!
    private let session = URLSession(configuration: .ephemeral)
    private var seenKey: [String: String] = [:]
    private var notifiedKey: [String: String] = [:]
    private var firstSnapshot = true
    /// Called when a task newly needs the user or newly finished (drives the island's pop-up).
    var onTransition: ((TaskItem) -> Void)?
    private var lastMetaAt = Date.distantPast
    private var spinPhase = 0.0
    private var toastTask: Task<Void, Never>?
    private var wasIdle: Bool?
    private var faceCache: (key: String, image: NSImage)?
    private var badgeCache: (key: String, frames: [Int: NSImage]) = ("", [:])

    // MARK: derived lists

    var visible: [TaskItem] { items.filter { showSDK || $0.sdk != true } }
    var waiting: [TaskItem] { visible.filter { $0.phase == .waiting }.sorted { ($0.since ?? 0) < ($1.since ?? 0) } }
    var doing: [TaskItem] {
        visible.filter { $0.phase == .doing }.sorted { ($0.turnStartedAt ?? $0.since ?? 0) < ($1.turnStartedAt ?? $1.since ?? 0) }
    }
    /// Unread finishes first, like unread chats.
    var done: [TaskItem] {
        visible.filter { $0.phase == .success || $0.phase == .failed }.sorted {
            ($0.unread == true) != ($1.unread == true) ? $0.unread == true : ($0.since ?? 0) > ($1.since ?? 0)
        }
    }
    var unreadDone: [TaskItem] { done.filter { $0.unread == true } }
    var anyUrgent: Bool { waiting.contains { $0.isUrgent(now: now) } }

    var limitsNote: String {
        guard let L = meta?.usage?.limits else { return "" }
        if let e = L.error { return String(localized: "Couldn't get limits: \(e)") }
        if L.probing == true { return String(localized: "Refreshing limits…") }
        return L.at.map { String(localized: "Limits updated \(Fmt.clock($0))") } ?? ""
    }

    /// Shown in the menu bar once a window is ≥ 80% used.
    var limitBadge: (label: String, value: Double)? {
        let L = meta?.usage?.limits
        if let u = L?.fiveHour?.utilization, u >= 0.8 { return ("5h", u) }
        if let u = L?.sevenDay?.utilization, u >= 0.8 { return (String(localized: "wk"), u) }
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
                self.spinPhase = (self.spinPhase + 1.0 / 12).truncatingRemainder(dividingBy: 1)
                self.refreshImage()
            }
        }
    }

    private func secondTick() {
        now = Date()
        if now.timeIntervalSince(lastMetaAt) > 3, connected { connected = false }
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
            withAnimation(.spring(response: 0.45, dampingFraction: 0.86)) {
                items = snap.sessions
                idleCount = snap.idleCount ?? 0
                staleCount = snap.staleCount ?? 0
            }
            trackTransitions()
            refreshImage()
        case "meta":
            guard let m = try? decoder.decode(Meta.self, from: data) else { return }
            meta = m
            lastMetaAt = Date()
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
                Notifier.shared.post(id: v.id, title: String(localized: "Waiting for you · \(v.title)"), body: [v.remote?.name, v.label, v.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            case .success where notifyDone, .failed where notifyDone:
                Notifier.shared.post(id: v.id, title: v.phase == .failed ? String(localized: "Task failed · \(v.title)") : String(localized: "Task done · \(v.title)"), body: [v.remote?.name, v.label, v.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
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
        menuBar.image = !c.isQuiet ? badgeImage(c)
            : faceShown ? faceImage(character, face)
            : MenuBarRenderer.idle(hasTasks: !visible.isEmpty)
        // Same predicate as the lists: things that need the user (waiting + unread finishes).
        let badge = w + fresh.count
        let label = badge > 0 ? String(badge) : nil
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    /// The menu bar refreshes every second; redraw the eyes only when they changed.
    private func faceImage(_ character: String, _ face: FaceAnimator) -> NSImage {
        let key = "\(character) \(face.pose) \(face.energy) \(Appearance.shared.revision)"
        if let c = faceCache, c.key == key { return c.image }
        let image = MenuBarRenderer.face(character, face.pose, energy: face.energy)
        faceCache = (key, image)
        return image
    }

    /// The badge animates through 12 frames a second; render each frame once per look and counts.
    private func badgeImage(_ c: MenuBarCounts) -> NSImage {
        let style = Appearance.shared.config.menuBar
        let key = "\(c) \(style) \(Appearance.shared.revision) \(MenuBarLook.isDark)"
        if badgeCache.key != key { badgeCache = (key, [:]) }
        let frame = Int((spinPhase * 12).rounded()) % 12
        if let image = badgeCache.frames[frame] { return image }
        let image = MenuBarRenderer.render(c, style: style, spin: Double(frame) / 12)
        badgeCache.frames[frame] = image
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
