import Foundation

/// Keeps the bundled Node service running. If something already serves the port (a dev
/// `npm start`, the LaunchAgent), it is used as is; a watchdog starts our own when it is gone.
final class ServerManager {
    static let shared = ServerManager()

    let port = 7333
    private(set) var lastError: String?
    private var process: Process?
    private var checking = false

    var dataDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "Beeplight", directoryHint: .isDirectory)
    }

    private var serverDir: URL? {
        Bundle.main.resourceURL?.appending(path: "server", directoryHint: .isDirectory)
    }

    func start() {
        check()
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.check() }
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    private func check() {
        if checking || process?.isRunning == true { return }
        checking = true
        Task {
            let up = await healthy()
            await MainActor.run {
                self.checking = false
                if !up { self.launch() }
            }
        }
    }

    private func healthy() async -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/state")!)
        req.timeoutInterval = 1.5
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    private func launch() {
        guard let serverDir, FileManager.default.fileExists(atPath: serverDir.appending(path: "src/server.js").path) else {
            lastError = String(localized: "The app bundle is missing the Beeplight service; rebuild the app")
            return
        }
        guard let node = Self.findNode() else {
            lastError = String(localized: "Can't find node; install Node.js ≥ 20.11 first")
            return
        }
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let log = dataDir.appending(path: "server.log")
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }
        let out = try? FileHandle(forWritingTo: log)
        _ = try? out?.seekToEnd()

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [serverDir.appending(path: "src/server.js").path]
        p.currentDirectoryURL = serverDir
        var env = ProcessInfo.processInfo.environment
        env["BEEPLIGHT_DATA_DIR"] = dataDir.path
        env["PORT"] = String(port)
        // Labels and LLM titles from the service follow the app's language.
        env["BEEPLIGHT_LANG"] = Bundle.main.preferredLocalizations.first ?? "en"
        // Apps launched from Finder get a bare PATH; the summarizer needs `claude` next to node.
        let nodeDir = (node as NSString).deletingLastPathComponent
        env["PATH"] = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", env["PATH"] ?? ""].joined(separator: ":")
        p.environment = env
        p.standardOutput = out
        p.standardError = out
        do {
            try p.run()
            process = p
            lastError = nil
        } catch {
            lastError = String(localized: "Couldn't start the Beeplight service: \(error.localizedDescription)")
        }
    }

    static func findNode() -> String? {
        let fm = FileManager.default
        // build.sh copies a node binary next to the app's executable; the others are fallbacks for
        // a bundle built without one.
        var candidates: [String] = []
        if let bundled = Bundle.main.executableURL?.deletingLastPathComponent().appending(path: "node") {
            candidates.append(bundled.path)
        }
        let nvm = fm.homeDirectoryForCurrentUser.appending(path: ".nvm/versions/node").path
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            let sorted = versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            candidates += sorted.map { "\(nvm)/\($0)/bin/node" }
        }
        candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }
}
