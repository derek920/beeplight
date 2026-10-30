import AppKit
import SwiftUI

/// The service's `/api/relay`: syncing tasks with your other devices through a relay you run.
struct RelayInfo: Decodable, Equatable {
    struct Device: Decodable, Equatable, Identifiable {
        var id: String
        var name: String
        var at: Double
        var online: Bool
        var tasks: Int
    }

    struct Me: Decodable, Equatable {
        var id: String
        var name: String
    }

    var configured: Bool
    var url: String?
    var status: String
    var error: String?
    /// Relay address, access token and group key in one string; only ever served to this Mac.
    var joinCode: String?
    var device: Me
    var devices: [Device]
}

@MainActor
final class RelayController: ObservableObject {
    static let shared = RelayController()
    @Published private(set) var info: RelayInfo?
    @Published private(set) var busy = false
    @Published var error: String?

    private let base = URL(string: "http://127.0.0.1:7333/api/relay")!

    func refresh() async {
        guard !busy else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: base)
            info = try JSONDecoder().decode(RelayInfo.self, from: data)
        } catch {
            self.error = String(localized: "Couldn't load: \(error.localizedDescription)")
        }
    }

    func create(url: String, token: String) { post(["action": "create", "url": url, "token": token]) }
    func join(_ code: String) { post(["action": "join", "code": code]) }
    func leave() { post(["action": "leave"]) }

    private struct Failure: Decodable { var error: String }

    private func post(_ body: [String: String]) {
        busy = true
        Task {
            defer { busy = false }
            var req = URLRequest(url: base)
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "x-beeplight")
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONEncoder().encode(body)
            guard let (data, _) = try? await URLSession.shared.data(for: req) else {
                error = String(localized: "Couldn't apply the change. Is the Beeplight service running?")
                return
            }
            if let i = try? JSONDecoder().decode(RelayInfo.self, from: data) {
                info = i
                error = nil
            } else {
                error = (try? JSONDecoder().decode(Failure.self, from: data))?.error
            }
        }
    }
}

/// Settings → Devices.
struct DevicesSettingsView: View {
    @ObservedObject private var relay = RelayController.shared
    @State private var url = "http://127.0.0.1:7350"
    @State private var token = ""
    @State private var code = ""
    private let tick = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(alignment: .top, spacing: 28) {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Your other devices").font(.system(size: 20, weight: .bold))
                    Text("See the tasks on your other Macs here, through a relay you run yourself (relay/server.js in the Beeplight repository). Each device encrypts its titles, states and current steps before uploading; the relay only sees ciphertext. Tasks from other devices are read-only here.")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let info = relay.info, info.configured { joined(info) } else { setup }
                if let e = relay.error ?? relay.info?.error {
                    Text(e).font(.system(size: 12)).foregroundStyle(Theme.failed).textSelection(.enabled)
                }
                Spacer(minLength: 0)
            }
            .frame(width: 430, alignment: .leading)

            if let code = relay.info?.joinCode, let img = qrImage(code, scale: 6) {
                VStack(spacing: 10) {
                    Image(nsImage: img).interpolation(.none).resizable().frame(width: 230, height: 230)
                    Text("Join code for your other devices. It holds the group key: share it only with your own devices.")
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(width: 250)
                }
            }
        }
        .padding(22)
        .frame(width: 890, height: 640, alignment: .topLeading)
        .task { await relay.refresh() }
        .onReceive(tick) { _ in Task { await relay.refresh() } }
    }

    private var setup: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Start a group").font(.system(size: 14, weight: .bold))
                TextField("Relay address", text: $url).textFieldStyle(.roundedBorder)
                SecureField("Access token (BEEPLIGHT_RELAY_TOKEN)", text: $token).textFieldStyle(.roundedBorder)
                Button("Create group") { relay.create(url: url, token: token) }
                    .disabled(url.isEmpty || token.isEmpty || relay.busy)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Or join a group").font(.system(size: 14, weight: .bold))
                TextField("Join code from another device", text: $code).textFieldStyle(.roundedBorder)
                Button("Join") { relay.join(code) }
                    .disabled(code.isEmpty || relay.busy)
            }
        }
    }

    private func joined(_ info: RelayInfo) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle().fill(statusColor(info.status)).frame(width: 8, height: 8)
                Text(statusText(info)).font(.system(size: 13, weight: .medium))
            }
            Text("This Mac: \(info.device.name)").font(.system(size: 12.5)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Text("Devices in the group").font(.system(size: 14, weight: .bold))
                if info.devices.isEmpty {
                    Text("No other device yet. On another Mac, open Settings → Devices and paste this group's join code.")
                        .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(info.devices) { d in
                    HStack(spacing: 8) {
                        Circle().fill(d.online ? Theme.success : Color.secondary.opacity(0.5)).frame(width: 7, height: 7)
                        Text(d.name).font(.system(size: 12.5, weight: .medium))
                        Spacer()
                        Text(d.online ? String(localized: "Tasks: \(d.tasks)") : String(localized: "Last seen \(Fmt.clock(d.at, withDay: true))"))
                            .font(.system(size: 11.5).monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            HStack(spacing: 10) {
                Button("Copy join code") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(info.joinCode ?? "", forType: .string)
                }
                Button("Leave group") { relay.leave() }
                    .help("Stops syncing and removes this Mac from the group on the relay")
            }
        }
    }

    private func statusColor(_ s: String) -> Color {
        switch s {
        case "connected": Theme.success
        case "error": Theme.failed
        default: Theme.waiting
        }
    }

    private func statusText(_ info: RelayInfo) -> String {
        let host = info.url.flatMap { URL(string: $0)?.host } ?? info.url ?? ""
        switch info.status {
        case "connected": return String(localized: "Connected to \(host)")
        case "error": return String(localized: "Can't reach the relay at \(host)")
        default: return String(localized: "Connecting to \(host)…")
        }
    }
}
