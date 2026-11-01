import CoreBluetooth
import CryptoKit
import Foundation

/// The phone link over Bluetooth LE, shared by both ends: the Mac app is the peripheral
/// (BluetoothBridge), the iPhone app the central. It carries what /api/stream carries, for a phone
/// that can't reach the Mac over the LAN, or one in the background, which iOS lets keep a Bluetooth
/// connection but not a socket.
///
/// Everything comes from the LAN pairing token, so pairing once covers both links:
/// - the service UUID the Mac advertises (`service`): a phone looks for the Mac it paired with, and
///   the UUID tells nothing about the token;
/// - the key every message is sealed with (AES-256-GCM, `seal`), so nothing in the air can be read
///   or forged without the token, and the system's Bluetooth pairing isn't needed.
///
/// A message is compressed, sealed, and cut into packets that fit the connection: each packet
/// starts with a byte holding the message's number (0…127) shifted left one, plus 1 on the last.
/// Mac → phone (`down`, notify): "<event>\n<data>", the event's name and its JSON as on the stream.
/// Phone → Mac (`up`, write): an `Up` request. The Mac acts only on fresh requests it hasn't seen
/// (`maxAge`, by nonce), and sends nothing to a phone until it has said hello.
/// This file is compiled into the iPhone app too: keep it to Foundation, CryptoKit and CoreBluetooth.
enum BluetoothWire {
    static let down = CBUUID(string: "DFB8A62C-915F-4BB6-8CDF-46EDDF0AF654")
    static let up = CBUUID(string: "847881DB-ADAA-4F56-AEE1-629A58A75F76")
    /// How old a request may be, and how long its nonce is remembered.
    static let maxAge: TimeInterval = 120

    enum Direction: String {
        case down = "ble-v1 down"
        case up = "ble-v1 up"
    }

    /// A phone's request.
    struct Up: Codable, Equatable {
        /// hello (send me the board, from now on) | pause (I have the LAN; stop until my next hello)
        /// | focus | read | read-all
        var op: String
        var id: String?
        /// When it was sent, in milliseconds since 1970.
        var t: Double

        init(op: String, id: String? = nil, at: Date = Date()) {
            self.op = op
            self.id = id
            t = (at.timeIntervalSince1970 * 1000).rounded()
        }

        var sent: Date { Date(timeIntervalSince1970: t / 1000) }
    }

    static func service(token: String) -> CBUUID {
        var b = [UInt8](derive(token, "ble-v1 service", 16))
        // A well-formed random (version 4) UUID.
        b[6] = (b[6] & 0x0F) | 0x40
        b[8] = (b[8] & 0x3F) | 0x80
        let uuid = UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
        return CBUUID(nsuuid: uuid)
    }

    static func key(token: String) -> SymmetricKey {
        SymmetricKey(data: derive(token, "ble-v1 seal", 32))
    }

    private static func derive(_ token: String, _ info: String, _ count: Int) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: Data(token.utf8)), salt: Data("beeplight".utf8),
                               info: Data(info.utf8), outputByteCount: count)
            .withUnsafeBytes { Data($0) }
    }

    enum Failure: Error {
        case compress, decompress
    }

    /// `plain` compressed and sealed: nonce, ciphertext, tag.
    static func seal(_ plain: Data, key: SymmetricKey, _ dir: Direction) throws -> Data {
        guard let packed = try? (plain as NSData).compressed(using: .zlib) as Data else { throw Failure.compress }
        let box = try AES.GCM.seal(packed, using: key, authenticating: Data(dir.rawValue.utf8))
        return box.nonce.withUnsafeBytes { Data($0) } + box.ciphertext + box.tag
    }

    /// Opens a sealed message; also returns its nonce, to turn away a replay.
    static func open(_ sealed: Data, key: SymmetricKey, _ dir: Direction) throws -> (plain: Data, nonce: Data) {
        let box = try AES.GCM.SealedBox(combined: sealed)
        let packed = try AES.GCM.open(box, using: key, authenticating: Data(dir.rawValue.utf8))
        guard let plain = try? (packed as NSData).decompressed(using: .zlib) as Data else { throw Failure.decompress }
        return (plain, sealed.prefix(12))
    }

    /// A sealed message cut into packets of at most `size` bytes.
    static func packets(_ sealed: Data, number: UInt8, size: Int) -> [Data] {
        let body = max(1, size - 1)
        var out: [Data] = []
        var at = sealed.startIndex
        repeat {
            let end = min(at + body, sealed.endIndex)
            let last: UInt8 = end == sealed.endIndex ? 1 : 0
            out.append(Data([(number & 0x7F) << 1 | last]) + sealed[at ..< end])
            at = end
        } while at < sealed.endIndex
        return out
    }

    /// Puts the packets of one connection back into messages. A packet from another message than
    /// the one being collected (one lost on the way) starts over.
    struct Assembler {
        private var number: UInt8?
        private var buffer = Data()

        init() {}

        /// The whole message, when `packet` was its last.
        mutating func add(_ packet: Data) -> Data? {
            guard let head = packet.first else { return nil }
            let n = head >> 1
            if n != number {
                number = n
                buffer = Data()
            }
            buffer += packet.dropFirst()
            guard head & 1 == 1 else { return nil }
            defer {
                number = nil
                buffer = Data()
            }
            return buffer
        }
    }
}
