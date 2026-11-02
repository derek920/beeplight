import CoreBluetooth
import CryptoKit
import Foundation
import os

/// Serves the paired iPhone over Bluetooth LE (BluetoothWire): advertises while phone access is on
/// and the Bluetooth switch in Phone settings is on, relays the local /api/stream to phones that
/// proved they hold the pairing token, and carries out their focus / read / read-all through the
/// local API, as the LAN would. The stream is read only while such a phone listens, and passed on
/// sparingly, since every message wakes a phone in the background: the board at most once a second
/// (the latest), meta (usage, today's totals; the stream sends it every second) every 30 s. A
/// phone that has the LAN says `pause` and gets nothing until its next hello.
///
/// `log stream --predicate 'subsystem == "dev.beeplight.mac" && category == "bluetooth"'` shows
/// what it does (never what it carries).
@MainActor
final class BluetoothBridge: NSObject, ObservableObject {
    static let shared = BluetoothBridge()
    static let enabledKey = "bluetoothEnabled"

    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: enabledKey)
            Task { await shared.refresh() }
        }
    }

    enum Status: Equatable {
        /// The switch or phone access is off.
        case off
        case starting
        case advertising
        case poweredOff
        case unauthorized
        case unsupported
        case failed(String)
    }

    /// For Phone settings.
    @Published private(set) var status: Status = .off
    /// Phones that said hello and listen.
    @Published private(set) var phones = 0

    private let log = Logger(subsystem: "dev.beeplight.mac", category: "bluetooth")
    private let base = URL(string: "http://127.0.0.1:7333/")!
    private let session = URLSession(configuration: .ephemeral)
    private var manager: CBPeripheralManager?
    private var token: String?
    private var key: SymmetricKey?
    private var service: CBUUID?
    private var down: CBMutableCharacteristic?
    private var published = false

    /// Phones subscribed to `down`, and those that said hello with the right key.
    private var subscribed: [UUID: CBCentral] = [:]
    private var trusted: Set<UUID> = []
    private var assemblers: [UUID: BluetoothWire.Assembler] = [:]
    private var seen: [Data: Date] = [:]

    private var stream: Task<Void, Never>?
    /// The latest data of each event, sent to a phone when it says hello.
    private var latest: [String: Data] = [:]
    private var pending: [String] = []
    private var flushing = false
    private var metaSent = Date.distantPast
    static let metaEvery: TimeInterval = 30
    /// Packets the send queue didn't take yet, who they're for (nil: every trusted phone), and the
    /// event they carry. A newer message of the same event replaces what is left of an older one.
    private var outbox: [(packet: Data, to: [CBCentral]?, event: String)] = []
    private static let outboxMax = 600
    private var number: UInt8 = 0

    func start() {
        // At launch the service may still be starting: ask again soon, not in 30 s.
        Task {
            for _ in 0 ..< 30 {
                if await refresh() != .unreachable { break }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        // Phone access, its token and the switch can change in Settings or from another client.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
            Task { @MainActor in await BluetoothBridge.shared.refresh() }
        }
    }

    /// Matches the Bluetooth service to the switch, phone access and the current pairing token.
    @discardableResult
    func refresh() async -> Pairing {
        guard Self.enabled else {
            stop()
            return .off
        }
        let pairing = await pairing()
        switch pairing {
        case .unreachable:
            // The service is restarting, or busy: keep the phones we have.
            break
        case .off:
            stop()
        case let .token(token):
            if token != self.token {
                stop()
                self.token = token
                key = BluetoothWire.key(token: token)
                service = BluetoothWire.service(token: token)
            }
            if manager == nil {
                log.info("starting")
                status = .starting
                // Asks for Bluetooth permission the first time.
                manager = CBPeripheralManager(delegate: self, queue: .main)
            } else {
                publish()
            }
        }
        return pairing
    }

    enum Pairing: Equatable {
        case token(String)
        /// Phone access is off.
        case off
        /// The service didn't answer.
        case unreachable
    }

    /// The LAN pairing token, when phone access is on.
    private func pairing() async -> Pairing {
        guard let (data, resp) = try? await session.data(from: base.appending(path: "api/lan")),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let info = try? JSONDecoder().decode(LanInfo.self, from: data) else { return .unreachable }
        guard info.enabled else { return .off }
        if let t = info.token, !t.isEmpty { return .token(t) }
        // An older service has it only in the URLs, and has none while it starts or the Mac is offline.
        guard let link = info.urls.first?.url ?? info.mdnsUrl,
              let t = URLComponents(string: link)?.queryItems?.first(where: { $0.name == "t" })?.value, !t.isEmpty else { return .unreachable }
        return .token(t)
    }

    private func stop() {
        if manager != nil { log.info("stopping") }
        stream?.cancel()
        stream = nil
        if let manager {
            manager.stopAdvertising()
            manager.removeAllServices()
        }
        manager = nil
        published = false
        token = nil
        key = nil
        service = nil
        down = nil
        subscribed = [:]
        trusted = []
        assemblers = [:]
        outbox = []
        latest = [:]
        pending = []
        status = .off
        countPhones()
    }

    private func publish() {
        guard !published, let manager, manager.state == .poweredOn, let service else { return }
        let down = CBMutableCharacteristic(type: BluetoothWire.down, properties: [.notify], value: nil, permissions: [])
        let up = CBMutableCharacteristic(type: BluetoothWire.up, properties: [.write], value: nil, permissions: [.writeable])
        let s = CBMutableService(type: service, primary: true)
        s.characteristics = [down, up]
        // Advertised once the service is in (didAdd).
        manager.add(s)
        self.down = down
        published = true
    }

    private func countPhones() {
        let n = trusted.filter { subscribed[$0] != nil }.count
        if n != phones { phones = n }
    }

    // MARK: the stream

    private func follow() {
        guard stream == nil else { return }
        stream = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    var req = URLRequest(url: self.base.appending(path: "api/stream"))
                    req.timeoutInterval = 10
                    let (bytes, resp) = try await self.session.bytes(for: req)
                    guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    var event = "message"
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            self.heard(event, Data(line.dropFirst(5).utf8))
                        }
                    }
                } catch {}
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func heard(_ event: String, _ data: Data) {
        guard event == "state" || event == "meta" else { return }
        latest[event] = data
        if event == "meta", Date().timeIntervalSince(metaSent) < Self.metaEvery { return }
        if !pending.contains(event) { pending.append(event) }
        guard !flushing else { return }
        flushing = true
        Task {
            try? await Task.sleep(for: .seconds(1))
            flushing = false
            let events = pending
            pending = []
            for e in events {
                if let d = latest[e] { send(e, d, to: nil) }
                if e == "meta" { metaSent = Date() }
            }
        }
    }

    // MARK: sending

    private func send(_ event: String, _ data: Data, to: [CBCentral]?) {
        guard let key, let manager else { return }
        let targets = to ?? trusted.compactMap { subscribed[$0] }
        guard !targets.isEmpty, let sealed = try? BluetoothWire.seal(Data((event + "\n").utf8) + data, key: key, .down) else { return }
        let size = targets.map(\.maximumUpdateValueLength).min() ?? 20
        // Only the latest board matters: drop what is left of an older one (the phone's assembler
        // starts over at the new message's number).
        if to == nil { outbox.removeAll { $0.to == nil && $0.event == event } }
        number = (number + 1) & 0x7F
        for p in BluetoothWire.packets(sealed, number: number, size: size) {
            outbox.append((p, to, event))
        }
        if outbox.count > Self.outboxMax { outbox.removeFirst(outbox.count - Self.outboxMax) }
        drain(manager)
    }

    private func drain(_ manager: CBPeripheralManager) {
        guard let down else { return outbox = [] }
        while let next = outbox.first {
            let targets = next.to ?? trusted.compactMap { subscribed[$0] }
            if targets.isEmpty {
                outbox.removeFirst()
                continue
            }
            // false: the queue is full; peripheralManagerIsReady says when to go on.
            guard manager.updateValue(next.packet, for: down, onSubscribedCentrals: targets) else { return }
            outbox.removeFirst()
        }
    }

    // MARK: requests

    private func received(_ packet: Data, from central: CBCentral) {
        var assembler = assemblers[central.identifier] ?? BluetoothWire.Assembler()
        let message = assembler.add(packet)
        assemblers[central.identifier] = assembler
        guard let message else { return }
        let who = String(central.identifier.uuidString.prefix(8))
        guard let key, let (plain, nonce) = try? BluetoothWire.open(message, key: key, .up),
              let request = try? JSONDecoder().decode(BluetoothWire.Up.self, from: plain) else {
            log.notice("\(who, privacy: .public): a message that doesn't open with the pairing key")
            return
        }
        let now = Date()
        seen = seen.filter { now.timeIntervalSince($0.value) < BluetoothWire.maxAge }
        guard abs(now.timeIntervalSince(request.sent)) < BluetoothWire.maxAge else {
            log.notice("\(who, privacy: .public): \(request.op, privacy: .public) is too old")
            return
        }
        guard seen[nonce] == nil else {
            log.notice("\(who, privacy: .public): \(request.op, privacy: .public) was sent before")
            return
        }
        seen[nonce] = now
        log.info("\(who, privacy: .public): \(request.op, privacy: .public)")
        switch request.op {
        case "hello":
            trusted.insert(central.identifier)
            countPhones()
            follow()
            for e in ["meta", "state"] {
                if let d = latest[e] { send(e, d, to: [central]) }
            }
            return
        case "pause":
            trusted.remove(central.identifier)
            countPhones()
            if trusted.isEmpty { unfollow() }
            return
        default:
            break
        }
        guard trusted.contains(central.identifier) else { return }
        switch request.op {
        case "focus", "read":
            guard let id = request.id, !id.isEmpty, id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == ":" || $0 == "." }) else { return }
            var url = base.appending(path: "api/sessions/\(id)/\(request.op)")
            url.append(queryItems: [URLQueryItem(name: "via", value: "phone over Bluetooth")])
            post(url)
        case "read-all":
            post(base.appending(path: "api/read-all"))
        default:
            break
        }
    }

    private func post(_ url: URL) {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("1", forHTTPHeaderField: "x-beeplight")
        req.timeoutInterval = 10
        Task { _ = try? await session.data(for: req) }
    }

    private func forget(_ central: CBCentral) {
        subscribed[central.identifier] = nil
        trusted.remove(central.identifier)
        assemblers[central.identifier] = nil
        countPhones()
        if trusted.isEmpty { unfollow() }
    }

    /// Stops reading the stream, and forgets what it said: a phone saying hello later gets the
    /// board from the stream, not one from before (which could undo what it has from the LAN).
    private func unfollow() {
        stream?.cancel()
        stream = nil
        latest = [:]
        pending = []
    }
}

extension BluetoothBridge: CBPeripheralManagerDelegate {
    nonisolated func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        MainActor.assumeIsolated {
            log.info("state \(peripheral.state.rawValue, privacy: .public)")
            switch peripheral.state {
            case .poweredOn:
                status = .starting
                publish()
                return
            case .poweredOff: status = .poweredOff
            case .unauthorized: status = .unauthorized
            case .unsupported: status = .unsupported
            default: status = .starting
            }
            // Off or not allowed: everything set up is gone; publish again when it's back.
            published = false
            subscribed = [:]
            trusted = []
            assemblers = [:]
            outbox = []
            countPhones()
            unfollow()
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        MainActor.assumeIsolated {
            guard error == nil, service.uuid == self.service else {
                if let error { log.error("adding the service failed: \(error.localizedDescription, privacy: .public)") }
                published = false
                return
            }
            peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [service.uuid]])
        }
    }

    nonisolated func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        MainActor.assumeIsolated {
            if let error {
                log.error("advertising failed: \(error.localizedDescription, privacy: .public)")
                status = .failed(error.localizedDescription)
            } else {
                log.info("advertising")
                status = .advertising
            }
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        MainActor.assumeIsolated {
            log.info("\(String(central.identifier.uuidString.prefix(8)), privacy: .public) subscribed, \(central.maximumUpdateValueLength, privacy: .public) bytes a packet")
            subscribed[central.identifier] = central
            countPhones()
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        MainActor.assumeIsolated {
            log.info("\(String(central.identifier.uuidString.prefix(8)), privacy: .public) left")
            forget(central)
        }
    }

    nonisolated func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        MainActor.assumeIsolated {
            // A write longer than one ATT packet (the phone may write up to 512 bytes with response)
            // arrives as parts with growing offsets: put each write back together before reading it.
            var write: (central: CBCentral, value: Data)?
            for r in requests where r.characteristic.uuid == BluetoothWire.up {
                guard let v = r.value else { continue }
                if let w = write, r.offset > 0, w.central.identifier == r.central.identifier {
                    write = (w.central, w.value + v)
                } else {
                    if let w = write { received(w.value, from: w.central) }
                    write = (r.central, v)
                }
            }
            if let w = write { received(w.value, from: w.central) }
            if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
        }
    }

    nonisolated func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        MainActor.assumeIsolated { drain(peripheral) }
    }
}

extension BluetoothBridge {
    /// One line for Phone settings.
    var statusText: String {
        switch status {
        case .off: return ""
        case .starting: return String(localized: "Bluetooth: starting…")
        case .advertising:
            return phones > 0 ? String(localized: "Bluetooth: \(phones) iPhone connected") : String(localized: "Bluetooth: on, waiting for the iPhone app")
        case .poweredOff: return String(localized: "Bluetooth is off on this Mac.")
        case .unauthorized: return String(localized: "Beeplight isn't allowed to use Bluetooth. Allow it in System Settings → Privacy & Security → Bluetooth.")
        case .unsupported: return String(localized: "This Mac has no Bluetooth LE.")
        case let .failed(why): return String(localized: "Bluetooth couldn't start: \(why)")
        }
    }
}
