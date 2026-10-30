import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { PORT } from './config.js';

// Optional LAN access for phones. Off by default. When on, extra listeners are bound to each
// local network address (Wi-Fi, Ethernet, phone tethering; never VPN tunnels); the loopback
// server is untouched.
// Every LAN API call must carry the pairing token, which the Mac shows as a QR code.

const SYNC_MS = 10_000;
// Everything except VPN tunnels (a phone cannot reach those), loopback and Apple-internal links.
// Phone tethering (iPhone USB, Bluetooth PAN) shows up here too, which is the way in when the
// office Wi-Fi isolates clients.
const NOT_LAN = /^(lo|utun|ipsec|ppp|gif|stf|awdl|llw|anpi|ap)\d*$/;
// Links that can only lead to the phone itself go first: they work even on an isolating Wi-Fi.
const TETHER = /iPhone|iPad|Bluetooth|Android|RNDIS/i;

export class Lan {
  constructor({ store, handler }) {
    this.store = store;
    this.handler = handler;
    this.servers = new Map(); // address -> http.Server
    this.mdnsName = null;
    this.ports = new Map(); // BSD name (en8) -> hardware port name (iPhone USB)
    this.failures = new Map(); // remote address -> { n, since }
    // Short-lived 6-digit code for pairing where a QR code cannot be scanned (an iOS home-screen
    // web app has its own storage and no camera access over HTTP).
    this.pin = null; // { code, expires, misses }
    if (!store.flags.lanToken) store.setFlag('lanToken', newToken());
  }

  get enabled() {
    return !!this.store.flags.lan;
  }

  get token() {
    return this.store.flags.lanToken;
  }

  start() {
    execFile('scutil', ['--get', 'LocalHostName'], (err, out) => {
      if (!err && out.trim()) this.mdnsName = `${out.trim()}.local`;
    });
    this.loadPorts();
    this.sync();
    setInterval(() => this.sync(), SYNC_MS).unref();
  }

  setEnabled(on) {
    this.store.setFlag('lan', !!on);
    this.sync();
  }

  resetToken() {
    this.store.setFlag('lanToken', newToken());
  }

  // `networksetup -listallhardwareports` maps en8 → "iPhone USB" so the UI can say which link is which.
  loadPorts() {
    execFile('networksetup', ['-listallhardwareports'], (err, out) => {
      if (err) return;
      let port = null;
      for (const line of out.split('\n')) {
        const p = /^Hardware Port: (.+)$/.exec(line);
        if (p) port = p[1].trim();
        const d = /^Device: (\S+)$/.exec(line);
        if (d && port) this.ports.set(d[1], port);
      }
    });
  }

  addresses() {
    const out = [];
    for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
      if (NOT_LAN.test(iface)) continue;
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
        out.push({ iface, port: this.ports.get(iface) || iface, address: a.address });
      }
    }
    return out.sort((x, y) => Number(TETHER.test(y.port)) - Number(TETHER.test(x.port)));
  }

  // Binds / unbinds listeners to follow the setting and network changes.
  sync() {
    // A newly plugged-in phone is a new interface: refresh the names for it.
    if (this.addresses().some((a) => !this.ports.has(a.iface))) this.loadPorts();
    const want = new Set(this.enabled ? this.addresses().map((a) => a.address) : []);
    for (const [addr, srv] of this.servers) {
      if (!want.has(addr)) {
        srv.close();
        this.servers.delete(addr);
      }
    }
    for (const addr of want) {
      if (this.servers.has(addr)) continue;
      const srv = http.createServer(this.handler);
      srv.on('error', (e) => {
        console.warn(`[lan] ${addr}:${PORT} ${e.code || e.message}`);
        this.servers.delete(addr);
      });
      srv.listen(PORT, addr, () => console.log(`[lan] listening on http://${addr}:${PORT}`));
      this.servers.set(addr, srv);
    }
  }

  allowedHost(host = '') {
    const h = host.toLowerCase();
    if (this.addresses().some((a) => h === `${a.address}:${PORT}`)) return true;
    return !!this.mdnsName && h === `${this.mdnsName.toLowerCase()}:${PORT}`;
  }

  locked(remote, max) {
    const f = this.failures.get(remote);
    return !!f && f.n >= max && Date.now() - f.since < 60_000;
  }

  miss(remote) {
    const f = this.failures.get(remote);
    if (!f || Date.now() - f.since >= 60_000) this.failures.set(remote, { n: 1, since: Date.now() });
    else f.n++;
  }

  // Constant-time compare, with a crude lockout so a wrong-token loop cannot hammer it.
  checkToken(t, remote) {
    if (this.locked(remote, 20)) return false;
    const ok = typeof t === 'string' && t.length === this.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token));
    if (ok) this.failures.delete(remote);
    else this.miss(remote);
    return ok;
  }

  // The current code, made on demand while the Mac shows the phone page; valid 5 minutes.
  pairingPin() {
    if (!this.pin || Date.now() > this.pin.expires) {
      this.pin = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expires: Date.now() + 5 * 60_000, misses: 0 };
    }
    return this.pin;
  }

  // Trades the 6-digit code for the token. Single use; a few misses per minute lock the sender
  // out, and 20 misses in total burn the code.
  redeemPin(code, remote) {
    if (!this.enabled || this.locked(remote, 8)) return null;
    const p = this.pin;
    if (!p || Date.now() > p.expires) return null;
    const ok = typeof code === 'string' && code.length === 6 && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(p.code));
    if (!ok) {
      this.miss(remote);
      if (++p.misses >= 20) this.pin = null;
      return null;
    }
    this.pin = null;
    this.failures.delete(remote);
    return this.token;
  }

  info() {
    const urls = this.addresses().map(({ port, address }) => ({ iface: port, url: `http://${address}:${PORT}/?t=${this.token}` }));
    return {
      enabled: this.enabled,
      listening: [...this.servers.keys()],
      urls,
      mdnsUrl: this.mdnsName ? `http://${this.mdnsName}:${PORT}/?t=${this.token}` : null,
      pin: this.enabled ? this.pairingPin() : null,
    };
  }
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}
