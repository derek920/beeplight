import AppKit
import SwiftUI

/// Beeplight's own language. Stored like the per-app language in System Settings (`AppleLanguages`
/// in the app's defaults), so both places show the same choice. Localizations are fixed at launch:
/// a change applies after a restart, which also starts the bundled service in the new language.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case en
    case zhHans = "zh-Hans"

    var id: String { rawValue }

    var name: String {
        switch self {
        case .system: return String(localized: "Follow system")
        // Each language in its own name, whatever the current one.
        case .en: return "English"
        case .zhHans: return "简体中文"
        }
    }

    private static let key = "AppleLanguages"

    static var saved: AppLanguage {
        guard let domain = Bundle.main.bundleIdentifier,
              let prefs = UserDefaults.standard.persistentDomain(forName: domain)?[key] as? [String], !prefs.isEmpty
        else { return .system }
        let l = Bundle.preferredLocalizations(from: Bundle.main.localizations, forPreferences: prefs).first
        return allCases.first { $0 != .system && $0.rawValue == l } ?? .system
    }

    func save() {
        if self == .system {
            UserDefaults.standard.removeObject(forKey: Self.key)
        } else {
            UserDefaults.standard.set([rawValue], forKey: Self.key)
        }
    }

    /// The localization the app runs in with this choice.
    var resolved: String {
        let prefs = self == .system
            ? UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)?[Self.key] as? [String] ?? []
            : [rawValue]
        return Bundle.preferredLocalizations(from: Bundle.main.localizations, forPreferences: prefs).first ?? "en"
    }

    /// The localization this process runs in.
    static let running = Bundle.main.preferredLocalizations.first ?? "en"
}

/// Quits, then opens the app again once this process is gone, so the two never run at once and the
/// new one starts its own service.
@MainActor
func relaunchApp() {
    let wait = Process()
    wait.executableURL = URL(fileURLWithPath: "/bin/sh")
    wait.arguments = ["-c", "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open \"$0\"",
                      Bundle.main.bundlePath]
    guard (try? wait.run()) != nil else { return }
    NSApp.terminate(nil)
}

/// General settings: the app's language.
struct GeneralSettingsView: View {
    @State private var language = AppLanguage.saved

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Language").font(.system(size: 14, weight: .bold))
                Text("For the app, the web board, the phone page and task titles written from now on. “Follow system” uses the Mac's language.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
            }
            Picker("", selection: Binding(get: { language }, set: { language = $0; $0.save() })) {
                ForEach(AppLanguage.allCases) { Text($0.name).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            if language.resolved != AppLanguage.running {
                HStack(spacing: 10) {
                    Text("Takes effect after Beeplight restarts").font(.system(size: 12)).foregroundStyle(.secondary)
                    Button("Restart now") { relaunchApp() }
                }
                .padding(.top, 4)
            }
        }
        .padding(22)
        .frame(width: 890, height: 640, alignment: .topLeading)
    }
}
