import AppKit
import CoreImage
import SwiftUI

/// Pairing info from the local service (`GET /api/lan`).
struct LanInfo: Decodable, Equatable {
    struct Link: Decodable, Equatable, Hashable {
        var iface: String
        var url: String
    }

    struct Pin: Decodable, Equatable {
        var code: String
        var expires: Double
    }

    var enabled: Bool
    var listening: [String]
    var urls: [Link]
    var mdnsUrl: String?
    /// 6-digit code for pairing a home-screen app, which cannot scan or reuse Safari's pairing.
    var pin: Pin?
}

@MainActor
final class LanController: ObservableObject {
    static let shared = LanController()
    @Published private(set) var info: LanInfo?
    @Published private(set) var busy = false
    @Published var error: String?

    private let base = URL(string: "http://127.0.0.1:7333/api/lan")!

    func refresh() async {
        do {
            let (data, _) = try await URLSession.shared.data(from: base)
            info = try JSONDecoder().decode(LanInfo.self, from: data)
            error = nil
        } catch {
            self.error = String(localized: "Couldn't load: \(error.localizedDescription)")
        }
    }

    func setEnabled(_ on: Bool) { post(base, body: ["enabled": on]) }
    func resetToken() { post(base.appending(path: "reset"), body: [:]) }

    private func post(_ url: URL, body: [String: Bool]) {
        busy = true
        Task {
            defer { busy = false }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("1", forHTTPHeaderField: "x-beeplight")
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try? JSONEncoder().encode(body)
            if let (data, _) = try? await URLSession.shared.data(for: req), let i = try? JSONDecoder().decode(LanInfo.self, from: data) {
                info = i
                error = nil
                // Phone access or its token changed: the Bluetooth service follows.
                await BluetoothBridge.shared.refresh()
            } else {
                error = String(localized: "Couldn't apply the change. Is the Beeplight service running?")
            }
        }
    }
}

func qrImage(_ text: String, scale: CGFloat = 8) -> NSImage? {
    guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    f.setValue(Data(text.utf8), forKey: "inputMessage")
    f.setValue("M", forKey: "inputCorrectionLevel")
    guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) else { return nil }
    let rep = NSCIImageRep(ciImage: out)
    let img = NSImage(size: rep.size)
    img.addRepresentation(rep)
    return img
}

/// Phone Access: LAN toggle, QR code to pair a phone, and how to add it to the home screen.
struct PhoneSettingsView: View {
    @ObservedObject var lan = LanController.shared
    @State private var picked: String?
    @AppStorage(BluetoothBridge.enabledKey) private var bluetooth = true

    var body: some View {
        let info = lan.info
        let links = (info?.urls ?? []) + (info?.mdnsUrl.map { [LanInfo.Link(iface: "Bonjour", url: $0)] } ?? [])
        let url = picked.flatMap { p in links.first { $0.url == p } }?.url ?? links.first?.url

        HStack(alignment: .top, spacing: 26) {
            VStack(alignment: .leading, spacing: 14) {
                Text("View on your phone").font(.system(size: 18, weight: .bold))
                Text("Put your phone on the same Wi-Fi as this Mac and scan the code. Then in Safari tap “Share → Add to Home Screen” (Android Chrome: menu → Add to Home screen) to use it full screen, like an app.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Toggle("Allow phones on the local network", isOn: Binding(get: { info?.enabled ?? false }, set: { lan.setEnabled($0) }))
                    .toggleStyle(.switch)
                    .disabled(lan.busy || info == nil)
                Toggle("Also over Bluetooth, for the iPhone app", isOn: $bluetooth)
                    .toggleStyle(.switch)
                    .disabled(info?.enabled != true)
                    .onChange(of: bluetooth) { Task { await BluetoothBridge.shared.refresh() } }
                if let info, info.enabled {
                    if links.isEmpty {
                        Text("No Wi-Fi or wired network address found. VPN addresses aren't used, since phones can't reach them.")
                            .font(.system(size: 12)).foregroundStyle(Theme.failed)
                    } else {
                        Picker("Address", selection: Binding(get: { url ?? "" }, set: { picked = $0 })) {
                            ForEach(links, id: \.url) { l in
                                Text("\(l.iface) · \(URL(string: l.url)?.host ?? l.url)").tag(l.url)
                            }
                        }
                        .frame(maxWidth: 320)
                        HStack(spacing: 10) {
                            Button("Copy link") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(url ?? "", forType: .string)
                            }
                            Button("Reset pairing code") { lan.resetToken() }
                                .help("The old QR code and paired phones stop working and need to scan again")
                        }
                    }
                }
                notes
                if let e = lan.error { Text(e).font(.system(size: 12)).foregroundStyle(Theme.failed) }
                Spacer(minLength: 0)
            }
            .frame(width: 430, alignment: .leading)

            VStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 16).fill(.white)
                    if info?.enabled == true, let url, let img = qrImage(url) {
                        Image(nsImage: img).interpolation(.none).resizable().scaledToFit().padding(16)
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "iphone.gen3").font(.system(size: 36)).foregroundStyle(.gray)
                            Text("Turn on network access to show the QR code").font(.system(size: 12)).foregroundStyle(.gray)
                        }
                    }
                }
                .frame(width: 250, height: 250)
                if info?.enabled == true, let url {
                    Text(url).font(.system(size: 10.5, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                        .lineLimit(2).frame(width: 250)
                }
                if info?.enabled == true, let pin = info?.pin {
                    VStack(spacing: 4) {
                        Text("Enter this pairing code in the home screen app").font(.system(size: 12)).foregroundStyle(.secondary)
                        Text("\(pin.code.prefix(3)) \(pin.code.suffix(3))")
                            .font(.system(size: 34, weight: .bold, design: .monospaced))
                            .textSelection(.enabled)
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            let left = max(0, Int(pin.expires / 1000 - ctx.date.timeIntervalSince1970))
                            Text(left > 0 ? String(localized: "New code in \(left / 60):\(String(format: "%02d", left % 60)) · single use") : String(localized: "Changing code…"))
                                .font(.system(size: 11).monospacedDigit())
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding(.top, 6)
                }
            }
        }
        .padding(26)
        .frame(width: 890, height: 640, alignment: .topLeading)
        .task {
            await lan.refresh()
            // Addresses change when the Mac switches networks.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await lan.refresh()
            }
        }
    }

    private var notes: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Good to know").font(.system(size: 13, weight: .semibold))
            note("lock.shield", String(localized: "A phone can only read data with the pairing code from the QR code, and resetting it locks phones out at once. The switch and the pairing code can only be changed on this Mac."))
            note("exclamationmark.triangle", String(localized: "The connection is plain HTTP, not encrypted. Only turn this on in trusted networks such as at home or on a phone hotspot; on office or public Wi-Fi, others on the network can see the traffic."))
            note("cable.connector", String(localized: "Office Wi-Fi usually keeps devices from reaching each other. Then turn on Personal Hotspot on the phone and connect it to the Mac with a USB cable (or join the iPhone's network from the Mac's Bluetooth menu); an “iPhone USB” or Bluetooth address shows up here, so scan its QR code. The Mac stays on the office Wi-Fi for the internet."))
            note("flame", String(localized: "The first time, the macOS firewall asks whether node may accept incoming connections; click “Allow”."))
            note("dot.radiowaves.left.and.right", String(localized: "Over Bluetooth, the paired Beeplight iPhone app gets the same task list when it can't reach this Mac on the network, and keeps it current in the background while the phone is nearby. It's encrypted with the pairing code; the first time, macOS asks to allow Bluetooth."))
            note("bell.slash", String(localized: "HTTP pages can't send push notifications: while the page is open it vibrates and shows a banner, but nothing arrives once the phone is locked."))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }

    private func note(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 14)
            Text(text).font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The Settings window: general, appearance, phone access, devices and the service's parameters.
struct SettingsRoot: View {
    @AppStorage("settingsTab") private var tab = "appearance"

    var body: some View {
        TabView(selection: $tab) {
            GeneralSettingsView()
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag("general")
            AppearanceSettingsView()
                .tabItem { Label("Appearance", systemImage: "paintpalette") }
                .tag("appearance")
            PhoneSettingsView()
                .tabItem { Label("Phone", systemImage: "iphone") }
                .tag("phone")
            DevicesSettingsView()
                .tabItem { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
                .tag("devices")
            AdvancedSettingsView()
                .tabItem { Label("Advanced", systemImage: "slider.horizontal.3") }
                .tag("advanced")
        }
    }
}
