import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { oneLine } from './util.js';

// Sync with the Beeplight on your other devices through a self-hosted relay (relay/server.js).
// Every device uploads a sealed summary of its board and streams the others'. The group key never
// leaves the devices: it seals the summaries (AES-256-GCM) and names the group's space on the
// relay, which only ever sees ciphertext. Joining takes one code that carries the relay address,
// the relay's access token and the key.

const HEARTBEAT_MS = 30_000;
const ONLINE_MS = 90_000;
const FORGET_MS = 24 * 3600_000;
const CODE_PREFIX = 'beeplight-relay:1:';

function derive(key, info) {
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from('beeplight'), Buffer.from(info), 32));
}

export function spaceOf(key) {
  return derive(key, 'relay-v1 space').toString('base64url').slice(0, 22);
}

export function seal(key, aad, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', derive(key, 'relay-v1 seal'), iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 1, iv: iv.toString('base64url'), data: data.toString('base64url') };
}

export function open(key, aad, p) {
  const buf = Buffer.from(p.data, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', derive(key, 'relay-v1 seal'), Buffer.from(p.iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}

export function makeJoinCode({ url, token, key }) {
  return CODE_PREFIX + Buffer.from(JSON.stringify({ u: url, t: token, k: key })).toString('base64url');
}

export function parseJoinCode(code) {
  const s = String(code || '').trim();
  if (!s.startsWith(CODE_PREFIX)) return null;
  try {
    const { u, t, k } = JSON.parse(Buffer.from(s.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
    return normalizeConfig({ url: u, token: t, key: k });
  } catch {
    return null;
  }
}

function normalizeConfig({ url, token, key }) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(u.protocol) || !token || !/^[A-Za-z0-9_-]{43}$/.test(key || '')) return null;
  return { url: u.origin + u.pathname.replace(/\/+$/, ''), token: String(token), key };
}

function deviceName() {
  if (process.env.BEEPLIGHT_DEVICE_NAME) return process.env.BEEPLIGHT_DEVICE_NAME;
  if (process.platform === 'darwin') {
    try {
      return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim() || os.hostname();
    } catch {}
  }
  return os.hostname();
}

/**
 * What another device sees of one task: enough to show its card (title, state, the step it is on,
 * timeline), nothing that identifies files or reproduces the conversation.
 */
export function shareView(v) {
  return {
    id: v.id,
    title: oneLine(v.title, 80),
    goal: v.goal ? oneLine(v.goal, 160) : undefined,
    state: v.state,
    outcome: v.outcome,
    kind: v.kind,
    label: v.label,
    detail: v.detail ? oneLine(v.detail, 200) : undefined,
    pending: v.pending || undefined,
    since: v.since,
    turnStartedAt: v.turnStartedAt,
    updatedAt: v.updatedAt,
    project: v.project,
    host: v.host?.app ? { kind: v.host.kind, app: v.host.app } : undefined,
    live: v.live,
    ended: v.ended,
    unread: v.unread || undefined,
    history: v.history?.slice(-40),
  };
}

export class Relay extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.name = deviceName();
    this.remote = new Map(); // device id → { name, at, sessions }
    this.clockOffset = 0; // relay time − local time
    this.status = 'off';
    this.error = null;
    this.lastShared = '';
    this.lastPutAt = 0;
    this.abort = null;
    this.heartbeat = setInterval(() => this.flush(true), HEARTBEAT_MS);
    this.heartbeat.unref();
    if (this.config) this.connect();
  }

  get config() {
    return this.store.flags.relay || null;
  }

  get deviceId() {
    if (!this.store.flags.relayDevice) this.store.setFlag('relayDevice', crypto.randomBytes(12).toString('base64url'));
    return this.store.flags.relayDevice;
  }

  /** Starts a new group on this relay; returns its join code. */
  create({ url, token }) {
    const cfg = normalizeConfig({ url, token, key: crypto.randomBytes(32).toString('base64url') });
    if (!cfg) throw new Error('bad relay address or token');
    return this.use(cfg);
  }

  join(code) {
    const cfg = parseJoinCode(code);
    if (!cfg) throw new Error('bad join code');
    return this.use(cfg);
  }

  use(cfg) {
    this.disconnect();
    this.store.setFlag('relay', cfg);
    this.remote.clear();
    this.lastShared = '';
    this.connect();
    this.emit('change');
    return makeJoinCode(cfg);
  }

  async leave() {
    const cfg = this.config;
    this.disconnect();
    this.store.setFlag('relay', null);
    this.remote.clear();
    this.status = 'off';
    this.emit('change');
    if (cfg) await this.request(cfg, 'DELETE', `devices/${this.deviceId}`).catch(() => {});
  }

  info() {
    const cfg = this.config;
    const now = this.relayNow();
    return {
      configured: !!cfg,
      url: cfg?.url ?? null,
      status: this.status,
      error: this.error,
      joinCode: cfg ? makeJoinCode(cfg) : null,
      device: { id: this.deviceId, name: this.name },
      devices: [...this.remote].map(([id, d]) => ({ id, name: d.name, at: d.at, online: now - d.at < ONLINE_MS, tasks: d.sessions.length })),
    };
  }

  relayNow() {
    return Date.now() + this.clockOffset;
  }

  /** The other devices' tasks, ids prefixed by device so they never collide with local ones. */
  remoteViews() {
    const now = this.relayNow();
    const out = [];
    for (const [id, d] of this.remote) {
      if (now - d.at > FORGET_MS) continue;
      const online = now - d.at < ONLINE_MS;
      for (const v of d.sessions) {
        out.push({ ...v, id: `${id}~${v.id}`, sdk: false, remote: { id, name: d.name, online } });
      }
    }
    return out;
  }

  /** Called with every new local board; uploads what changed (and a heartbeat now and then). */
  share(board) {
    this.board = board;
    this.flush(false);
  }

  flush(heartbeat) {
    const cfg = this.config;
    if (!cfg || !this.board) return;
    const sessions = this.board.filter((v) => !v.sdk && !v.remote).map(shareView);
    const body = JSON.stringify(sessions);
    const due = Date.now() - this.lastPutAt >= HEARTBEAT_MS;
    if (body === this.lastShared && !(heartbeat && due)) return;
    if (this.putting) {
      this.again = true;
      return;
    }
    this.putting = true;
    this.lastShared = body;
    this.lastPutAt = Date.now();
    const payload = seal(cfg.key, `${spaceOf(cfg.key)}:${this.deviceId}`, { name: this.name, sessions });
    this.request(cfg, 'PUT', `devices/${this.deviceId}`, payload)
      .catch((e) => {
        this.lastShared = ''; // retry with the next board or heartbeat
        this.fail(e);
      })
      .finally(() => {
        this.putting = false;
        if (this.again) {
          this.again = false;
          this.flush(false);
        }
      });
  }

  async request(cfg, method, path, body) {
    const res = await fetch(`${cfg.url}/v1/spaces/${spaceOf(cfg.key)}/${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`relay ${res.status}: ${(await res.json().catch(() => ({}))).error || res.statusText}`);
    return res.json();
  }

  fail(e) {
    const msg = oneLine(e?.cause?.code || e?.message || String(e), 160);
    if (msg === this.error && this.status === 'error') return;
    this.error = msg;
    this.status = 'error';
    this.emit('change');
  }

  disconnect() {
    this.abort?.abort();
    this.abort = null;
  }

  // Streams the other devices' summaries; reconnects with backoff while the config stays.
  async connect() {
    const cfg = this.config;
    if (!cfg) return;
    const ctl = new AbortController();
    this.abort = ctl;
    let backoff = 1000;
    while (!ctl.signal.aborted && this.config === cfg) {
      this.status = 'connecting';
      try {
        const res = await fetch(`${cfg.url}/v1/spaces/${spaceOf(cfg.key)}/stream`, {
          headers: { authorization: `Bearer ${cfg.token}` },
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`relay ${res.status}`);
        this.status = 'connected';
        this.error = null;
        this.lastShared = ''; // the relay may have restarted and lost our entry
        this.flush(false);
        this.emit('change');
        backoff = 1000;
        await this.read(res.body, cfg);
        throw new Error('relay closed the stream');
      } catch (e) {
        if (ctl.signal.aborted) return;
        this.fail(e);
        await new Promise((r) => setTimeout(r, backoff).unref());
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async read(stream, cfg) {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) this.onEvent(event, JSON.parse(data), cfg);
      }
    }
  }

  onEvent(event, d, cfg) {
    if (event === 'tick') {
      this.clockOffset = d.now - Date.now();
      this.emit('change'); // online flags age with time
    } else if (event === 'gone') {
      if (this.remote.delete(d.device)) this.emit('change');
    } else if (event === 'device' && d.device !== this.deviceId) {
      try {
        const { name, sessions } = open(cfg.key, `${spaceOf(cfg.key)}:${d.device}`, d.payload);
        this.remote.set(d.device, { name: oneLine(name, 60), at: d.at, sessions: Array.isArray(sessions) ? sessions : [] });
        this.emit('change');
      } catch {
        // Sealed with another key (a stale member of an old group): not ours to read.
      }
    }
  }
}
