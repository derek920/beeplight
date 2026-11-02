import Foundation

// Mirrors the JSON the Node service pushes over /api/stream (see src/core/collector.js buildView).
// Shared with the iPhone app (a separate, closed-source project that compiles this file).

struct Snapshot: Decodable {
    var sessions: [TaskItem]
    var idleCount: Int?
    var staleCount: Int?
}

struct Meta: Decodable {
    var now: Double
    var hz: Double
    var tickMs: Double?
    var today: Today?
    var summarizer: SummarizerStats?
    var usage: UsageMeta?
    /// The character picked in the Mac app, for the phone's status screen.
    var character: String?
    var cpu: CpuMeta?
    /// "ai" or "original": the service's summarizer.titles parameter.
    var titles: String?
}

/// CPU use as shares (0…1) of the whole Mac, averaged over the last `sec` seconds (src/core/cpu.js).
struct CpuMeta: Decodable, Equatable {
    var cores: Int?
    var sec: Double?
    var total: Double
    var claude: Double
    /// Codex's processes (the ChatGPT app's and the CLI's); missing from older services.
    var codex: Double?
    var beeplight: Double
}

// MARK: token usage & plan limits (src/services/limits.js, src/sources/claude-code/usage.js)

struct UsageMeta: Decodable, Equatable {
    var ready: Bool?
    var limits: LimitsInfo?
    var windows: Windows?
    var fiveHour: UsageTotals?
    var sevenDay: UsageTotals?
    var buckets5h: [Double]?
    var buckets7d: [Double]?
    var top: [TopSession]?
}

struct LimitsInfo: Decodable, Equatable {
    var known: Bool?
    var at: Double?
    var status: String?
    var fiveHour: LimitWindow?
    var sevenDay: LimitWindow?
    var probing: Bool?
    var error: String?
    var monitorSelf: SelfUsage?

    enum CodingKeys: String, CodingKey {
        case known, at, status, fiveHour, sevenDay, probing, error
        case monitorSelf = "self"
    }
}

/// Server-reported utilization (0…1) of one limit window.
struct LimitWindow: Decodable, Equatable {
    var utilization: Double
    var resetsAt: Double
    var status: String?
    var projection: Projection?
}

struct Projection: Decodable, Equatable {
    var ratePerHour: Double?
    var etaMs: Double?
    var beforeReset: Bool?
}

struct WindowRange: Decodable, Equatable {
    var start: Double
    var end: Double
    var aligned: Bool?
}

struct Windows: Decodable, Equatable {
    var fiveHour: WindowRange
    var sevenDay: WindowRange
}

/// This machine's usage within a window; cost is the API-equivalent USD used as a weight.
struct UsageTotals: Decodable, Equatable {
    var tokens: Double
    var out: Double
    var cr: Double?
    var cost: Double
    var requests: Int?
}

struct TopSession: Decodable, Identifiable, Equatable {
    var sid: String
    var title: String
    var project: String?
    var live: Bool?
    var tokens: Double
    var cost: Double
    var share: Double?
    var requests: Int?
    var id: String { sid }
}

struct SelfUsage: Decodable, Equatable {
    var calls: Int?
    var cost: Double?
}

struct SessionUsage: Decodable, Equatable {
    struct Total: Decodable, Equatable {
        var tokens: Double
        var out: Double
        var cost: Double
        var requests: Int
    }

    struct Window: Decodable, Equatable {
        var tokens: Double
        var cost: Double
        /// Estimated share of the account limit (0…1), assuming this machine is all of the usage.
        var share: Double?
    }

    var total: Total
    var fiveHour: Window
    var sevenDay: Window
}

struct Today: Decodable, Equatable {
    var done: Int
    var failed: Int
    var workMs: Double
    var waitMs: Double
    var longestWaitMs: Double
}

struct SummarizerStats: Decodable, Equatable {
    var queued: Int
    var inflight: Int
    var ok: Int
    var failed: Int
    var lastError: String?
}

struct HostInfo: Decodable, Equatable {
    var kind: String?
    var app: String?
    var tty: String?
}

struct Subagent: Decodable, Equatable, Identifiable {
    var id: String
    var type: String?
    var description: String?
    var running: Bool
    var activity: String?
}

/// One entry of a session's state trajectory: key (doing | waiting | waiting:q | done:success | done:failed) and start time.
struct Seg: Decodable, Equatable {
    var k: String
    var t: Double
    var p: Bool?
}

struct TaskItem: Decodable, Identifiable, Equatable {
    var id: String
    var title: String
    var goal: String?
    var state: String
    var outcome: String?
    var kind: String?
    var label: String
    var detail: String?
    var pending: Bool?
    var since: Double?
    var cwd: String?
    var project: String?
    var entrypoint: String?
    var sdk: Bool?
    var host: HostInfo?
    var live: Bool?
    var ended: Bool?
    var endReason: String?
    var stopped: Bool?
    var lastPrompt: String?
    var turnStartedAt: Double?
    var updatedAt: Double?
    var subagents: [Subagent]?
    var jobShort: String?
    var summarizing: Bool?
    var history: [Seg]?
    var usage: SessionUsage?
    /// Finished since the user last opened / prompted / looked at it.
    var unread: Bool?
    /// Set for a task synced from another device (the service's relay); read-only here.
    var remote: RemoteInfo?
    /// The coding agent the task belongs to ("claude-code", "codex", …) and its display name.
    var agent: String?
    var agentName: String?
    /// Commands the agent left running in the background, and services that ended a little while ago.
    var background: [BackgroundCommand]?
}

/// A command an agent left running in the background (src/core/background.js). role "service": a
/// server or watcher, or anything still running after its task stopped working; it is listed on
/// its own and never notifies. role "task": work its task waits for, which keeps the task in Doing.
struct BackgroundCommand: Decodable, Equatable, Identifiable {
    var id: String
    var title: String
    var command: String?
    /// running | completed | failed | stopped | exited (ended without saying how)
    var state: String
    var role: String
    var exitCode: Int?
    var startedAt: Double?
    var endedAt: Double?
    var ports: [Int]?

    var isRunning: Bool { state == "running" }
}

/// A background service with the task that started it, for the board's own list of them.
struct ServiceItem: Identifiable, Equatable {
    var command: BackgroundCommand
    var taskID: String
    var taskTitle: String
    var project: String?
    var agent: String?
    var id: String { "\(taskID)/\(command.id)" }

    /// Every service of these tasks: running ones first, then the newest.
    static func all(in tasks: [TaskItem]) -> [ServiceItem] {
        tasks.flatMap { t in
            (t.background ?? []).filter { $0.role == "service" }.map {
                ServiceItem(command: $0, taskID: t.id, taskTitle: t.title, project: t.project, agent: t.agent)
            }
        }
        .sorted { a, b in
            a.command.isRunning != b.command.isRunning ? a.command.isRunning : (a.command.startedAt ?? 0) > (b.command.startedAt ?? 0)
        }
    }
}

enum Phase: String {
    case waiting, doing, success, failed
}

/// Waits on a real prompt longer than this are escalated visually.
struct RemoteInfo: Decodable, Equatable {
    var id: String
    var name: String
    var online: Bool

    var label: String { online ? name : String(localized: "\(name) · offline") }
}

let urgentAfter: TimeInterval = 180

func dateFromMs(_ ms: Double?) -> Date? {
    ms.map { Date(timeIntervalSince1970: $0 / 1000) }
}

extension TaskItem {
    var phase: Phase {
        switch state {
        case "waiting": return .waiting
        case "doing": return .doing
        default: return outcome == "failed" ? .failed : .success
        }
    }

    /// When the current phase started; for Doing, when the turn started.
    var phaseStart: Date? {
        phase == .doing ? dateFromMs(turnStartedAt ?? since) : dateFromMs(since)
    }

    func isUrgent(now: Date) -> Bool {
        guard phase == .waiting, kind != "question", let s = dateFromMs(since) else { return false }
        return now.timeIntervalSince(s) > urgentAfter
    }

    var isToolDetail: Bool {
        (detail ?? "").range(of: #"^[\w.-]+ · "#, options: .regularExpression) != nil
    }

    var isLive: Bool { live ?? false }

    /// The agent's name for text-only places (notifications), on tasks that aren't Claude Code's;
    /// lists show its mark instead (AgentMarkView).
    var agentBadge: String? {
        guard let agent, agent != "claude-code" else { return nil }
        return agentName ?? agent
    }

    var hostText: String {
        if entrypoint == "background" { return String(localized: "Background session") }
        if entrypoint == "claude-desktop" { return String(localized: "Claude Desktop") }
        if entrypoint == "codex-desktop" { return String(localized: "ChatGPT app") }
        if sdk == true { return "SDK" }
        guard let h = host else { return String(localized: "CLI") }
        let tty = h.tty.map { " · " + $0.replacingOccurrences(of: "/dev/", with: "") } ?? ""
        switch h.kind {
        case "iterm": return "iTerm2" + tty
        case "terminal": return "Terminal" + tty
        case "tmux": return "tmux"
        default: return h.app ?? String(localized: "CLI")
        }
    }

    var primaryAction: String {
        if isLive { return String(localized: "Jump to task") }
        if entrypoint == "claude-desktop" || entrypoint == "codex-desktop" { return String(localized: "Open") }
        if jobShort != nil { return String(localized: "Attach") }
        return String(localized: "Resume")
    }

    /// Time spent working / blocked on the user since the current turn started.
    func turnStats(now: Date) -> (work: TimeInterval, wait: TimeInterval) {
        guard let h = history, !h.isEmpty else { return (0, 0) }
        let end = now.timeIntervalSince1970 * 1000
        let start = turnStartedAt ?? h[0].t
        var work = 0.0, wait = 0.0
        for (i, s) in h.enumerated() {
            let t0 = max(s.t, start)
            let t1 = i + 1 < h.count ? h[i + 1].t : end
            guard t1 > t0 else { continue }
            if s.k == "doing" { work += t1 - t0 } else if s.k == "waiting" { wait += t1 - t0 }
        }
        return (work / 1000, wait / 1000)
    }
}
