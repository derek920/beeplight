import AppKit
import SwiftUI

/// A parameter value from the service: a number or text.
enum ConfigValue: Decodable, Equatable {
    case number(Double)
    case text(String)

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { self = .number(d) } else { self = .text(try c.decode(String.self)) }
    }

    /// As it is typed in a field: 333, 1.2, haiku.
    var text: String {
        switch self {
        case .number(let d): return d == d.rounded() && abs(d) < 1e15 ? String(Int(d)) : String(d)
        case .text(let s): return s
        }
    }
}

/// One runtime parameter as `GET /api/config` describes it (src/config/schema.js). Labels, help and
/// errors come in the service's language, which is the app's.
struct ConfigParam: Decodable, Identifiable, Equatable {
    var key: String
    var group: String
    var type: String
    var label: String
    var help: String
    /// In effect now.
    var value: ConfigValue
    /// What applies after a restart; differs from `value` only for restart-only parameters.
    var configured: ConfigValue
    var `default`: ConfigValue
    /// default | file | env
    var source: String
    /// The environment variable that sets it, which wins over this page.
    var env: String?
    var restart: Bool
    var restartPending: Bool
    /// For type "choice": the allowed values with their labels.
    var choices: [Choice]?

    struct Choice: Decodable, Equatable {
        var value: String
        var label: String
    }

    var id: String { key }
}

struct ConfigInfo: Decodable {
    struct Group: Decodable, Identifiable {
        var id: String
        var label: String
        /// Buttons under the group, e.g. cleaning up stored data now.
        var actions: [Action]?
    }

    /// A button that POSTs to a local-only route and shows the message it returns.
    struct Action: Decodable, Identifiable {
        var id: String
        var label: String
        var help: String
        var path: String
    }

    /// An entry of the config file or the environment that was ignored.
    struct Problem: Decodable, Hashable {
        var place: String
        var error: String

        enum CodingKeys: String, CodingKey {
            case place = "where"
            case error
        }
    }

    var file: String?
    var groups: [Group]
    var params: [ConfigParam]
    var problems: [Problem]
    /// Set on a refused change: parameter key → why.
    var errors: [String: String]?
}

@MainActor
final class ConfigController: ObservableObject {
    static let shared = ConfigController()
    @Published private(set) var info: ConfigInfo?
    @Published private(set) var errors: [String: String] = [:]
    @Published var error: String?
    /// The service's message after an action ran, by action id.
    @Published private(set) var results: [String: String] = [:]
    @Published private(set) var running: Set<String> = []

    private let service = "http://127.0.0.1:7333"
    private let url = URL(string: "http://127.0.0.1:7333/api/config")!

    func refresh() async {
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            info = try JSONDecoder().decode(ConfigInfo.self, from: data)
            error = nil
        } catch {
            self.error = String(localized: "Couldn't load: \(error.localizedDescription)")
        }
    }

    /// Sends a value as typed (the service checks it); nil goes back to the default.
    func set(_ key: String, _ value: String?) async {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "x-beeplight")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["set": [key: value.map { $0 as Any } ?? NSNull()]])
        guard let (data, _) = try? await URLSession.shared.data(for: req), let i = try? JSONDecoder().decode(ConfigInfo.self, from: data) else {
            error = String(localized: "Couldn't apply the change. Is the Beeplight service running?")
            return
        }
        info = i
        error = nil
        errors[key] = i.errors?[key]
    }

    func run(_ action: ConfigInfo.Action) async {
        guard action.path.hasPrefix("/api/"), let url = URL(string: service + action.path) else { return }
        running.insert(action.id)
        defer { running.remove(action.id) }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "x-beeplight")
        struct Reply: Decodable {
            var message: String?
            var error: String?
        }
        guard let (data, _) = try? await URLSession.shared.data(for: req), let r = try? JSONDecoder().decode(Reply.self, from: data) else {
            results[action.id] = String(localized: "Couldn't apply the change. Is the Beeplight service running?")
            return
        }
        results[action.id] = r.message ?? r.error
    }
}

/// Advanced: the service's runtime parameters. Laid out from what the service describes, so a new
/// parameter in src/config/schema.js shows up here without a change to the app.
struct AdvancedSettingsView: View {
    @ObservedObject var config = ConfigController.shared
    /// Text being edited, by parameter key; sent on Return or when the field loses focus.
    @State private var drafts: [String: String] = [:]
    @FocusState private var focused: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Advanced").font(.system(size: 14, weight: .bold))
                Text("Settings of the Beeplight service. Most changes apply within a second; the ones marked “Needs restart” apply after Beeplight restarts.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
            }
            if let e = config.error {
                Text(e).font(.system(size: 12)).foregroundStyle(Theme.failed)
            }
            if let info = config.info {
                if !info.problems.isEmpty { problems(info.problems) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        ForEach(info.groups) { g in
                            let params = info.params.filter { $0.group == g.id }
                            let actions = g.actions ?? []
                            if !params.isEmpty || !actions.isEmpty { section(g.label, params, actions) }
                        }
                    }
                    .padding(.trailing, 14)
                }
                if let file = info.file {
                    Button("Show config file in Finder") { reveal(file) }
                        .buttonStyle(.link)
                        .font(.system(size: 11.5))
                }
            } else if config.error == nil {
                ProgressView().controlSize(.small)
            }
        }
        .padding(22)
        .frame(width: 890, height: 640, alignment: .topLeading)
        // While the page is open: retry every second until the service answers (it may still be
        // starting), then refresh every 3 s to pick up hand edits of the file.
        .task {
            while !Task.isCancelled {
                await config.refresh()
                try? await Task.sleep(for: .seconds(config.info == nil ? 1 : 3))
            }
        }
        .onChange(of: focused) { old, _ in
            if let old { commit(old) }
        }
    }

    private func section(_ title: String, _ params: [ConfigParam], _ actions: [ConfigInfo.Action]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary).padding(.bottom, 4)
            ForEach(params) { p in
                row(p)
                if p.id != params.last?.id || !actions.isEmpty { Divider().opacity(0.5) }
            }
            ForEach(actions) { actionRow($0) }
        }
    }

    private func actionRow(_ a: ConfigInfo.Action) -> some View {
        HStack(alignment: .top, spacing: 16) {
            Text(a.help)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 3) {
                Button(a.label) { Task { await config.run(a) } }
                    .controlSize(.small)
                    .disabled(config.running.contains(a.id))
                if let m = config.results[a.id] {
                    Text(m)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 260, alignment: .trailing)
                }
            }
        }
        .padding(.vertical, 8)
    }

    private func row(_ p: ConfigParam) -> some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(p.label).font(.system(size: 12.5, weight: .medium))
                    if p.restart { Chip(text: String(localized: "Needs restart"), tint: Theme.waiting) }
                }
                Text(p.help)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let e = config.errors[p.key] {
                    Text(e).font(.system(size: 11)).foregroundStyle(Theme.failed)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 3) {
                if let choices = p.choices {
                    Picker("", selection: Binding(get: { p.configured.text }, set: { v in Task { await config.set(p.key, v) } })) {
                        ForEach(choices, id: \.value) { Text($0.label).tag($0.value) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .disabled(p.source == "env")
                } else {
                    TextField(defaultText(p), text: draft(p))
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(p.type == "string" ? .leading : .trailing)
                        .font(.system(size: 12).monospacedDigit())
                        .frame(width: p.type == "string" ? 240 : 90)
                        .focused($focused, equals: p.key)
                        .onSubmit { commit(p.key) }
                        .disabled(p.source == "env")
                }
                note(p)
            }
        }
        .padding(.vertical, 8)
    }

    /// Under the field: who sets it, a pending restart, or the default and a way back to it.
    @ViewBuilder private func note(_ p: ConfigParam) -> some View {
        if let env = p.env {
            Text("Set by \(env)").font(.system(size: 10.5)).foregroundStyle(.secondary)
        } else if p.restartPending {
            HStack(spacing: 6) {
                Text("Restart to apply").font(.system(size: 10.5)).foregroundStyle(Theme.waiting)
                Button("Restart now") { relaunchApp() }.controlSize(.mini)
            }
        } else if p.source == "file" {
            HStack(spacing: 6) {
                Text("Default: \(defaultText(p))").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                Button("Reset to default") {
                    drafts[p.key] = nil
                    Task { await config.set(p.key, nil) }
                }
                .buttonStyle(.link)
                .font(.system(size: 10.5))
            }
        }
    }

    private func problems(_ list: [ConfigInfo.Problem]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Label("Some entries in the config file were ignored:", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(Theme.waiting)
            ForEach(list, id: \.self) { p in
                Text("\(p.place): \(p.error)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.waiting.opacity(0.1)))
    }

    private func defaultText(_ p: ConfigParam) -> String {
        if let c = p.choices?.first(where: { $0.value == p.default.text }) { return c.label }
        return p.default.text.isEmpty ? String(localized: "Automatic") : p.default.text
    }

    private func draft(_ p: ConfigParam) -> Binding<String> {
        Binding(get: { drafts[p.key] ?? p.configured.text }, set: { drafts[p.key] = $0 })
    }

    private func commit(_ key: String) {
        guard let text = drafts[key], let p = config.info?.params.first(where: { $0.key == key }) else { return }
        let value = text.trimmingCharacters(in: .whitespaces)
        guard value != p.configured.text else {
            drafts[key] = nil
            return
        }
        Task {
            await config.set(key, value)
            // A refused value stays in the field so it can be corrected.
            if config.errors[key] == nil { drafts[key] = nil }
        }
    }

    /// The file only exists once something was saved; until then, show its folder.
    private func reveal(_ file: String) {
        let url = URL(fileURLWithPath: file)
        if FileManager.default.fileExists(atPath: file) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }
}
