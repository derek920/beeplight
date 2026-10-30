import Foundation

/// One-time move from the pre-release names, "Tasklight" (`app.tasklight.mac`) and before it
/// "Claude Monitor" (`local.claude-monitor`). Runs before anything reads settings, so appearance,
/// island position, notification switches and the menu bar slot carry over, and the data folder
/// keeps the phone pairing token.
enum LegacyMigration {
    /// Newest first, so a setting or folder from the newer name wins.
    private static let names = [(domain: "app.tasklight.mac", folder: "Tasklight"),
                                (domain: "local.claude-monitor", folder: "ClaudeMonitor")]
    private static let doneKey = "migratedFromLegacyNames"

    static func run() {
        let d = UserDefaults.standard
        guard !d.bool(forKey: doneKey) else { return }
        defer { d.set(true, forKey: doneKey) }

        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let to = ServerManager.shared.dataDir
        // Only this app's own keys count as already set. persistentDomain, not object(forKey:) or
        // UserDefaults(suiteName:): those also see global keys, and the global AppleLanguages would
        // hide the app's own language setting.
        var own = Bundle.main.bundleIdentifier.flatMap { d.persistentDomain(forName: $0) } ?? [:]
        for name in names {
            for (key, value) in d.persistentDomain(forName: name.domain) ?? [:] where own[key] == nil {
                d.set(value, forKey: key)
                own[key] = value
            }
            let from = support.appending(path: name.folder, directoryHint: .isDirectory)
            if fm.fileExists(atPath: from.path), !fm.fileExists(atPath: to.path) {
                try? fm.moveItem(at: from, to: to)
            }
        }
    }
}
