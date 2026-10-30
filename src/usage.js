import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';

// Token usage of every transcript on this machine (main sessions + subagents), queryable by
// time window so it can be lined up with the account's 5-hour and weekly limits.

const KEEP_RECORDS_MS = 8 * 86400_000; // a little more than the weekly window
const CHUNK = 4 * 1024 * 1024;

// USD per million tokens (Anthropic first-party list prices). Only used to weight tokens when
// estimating each session's share of a limit; subscription limits are not billed this way.
// `cr` = cache read; cache writes cost 1.25× (5 min) or 2× (1 h) input.
const PRICES = [
  [/fable|mythos/, { in: 10, out: 50, cr: 0.25 }],
  [/opus-5-5/, { in: 4, out: 20, cr: 0.2 }],
  [/opus/, { in: 5, out: 25, cr: 0.5 }],
  [/sonnet-5/, { in: 2, out: 10, cr: 0.2 }],
  [/sonnet/, { in: 3, out: 15, cr: 0.3 }],
  [/haiku-5/, { in: 0.1, out: 0.5, cr: 0.01 }],
  [/haiku-4/, { in: 1, out: 5, cr: 0.1 }],
  [/haiku/, { in: 0.8, out: 4, cr: 0.08 }],
];
const DEFAULT_PRICE = { in: 4, out: 20, cr: 0.2 };

export function priceOf(model = '') {
  for (const [re, p] of PRICES) if (re.test(model)) return p;
  return DEFAULT_PRICE;
}

// u: { in, out, cw5, cw1, cr } → API-equivalent USD
export function costOf(model, u) {
  const p = priceOf(model);
  return (u.in * p.in + u.out * p.out + u.cw5 * p.in * 1.25 + u.cw1 * p.in * 2 + u.cr * p.cr) / 1e6;
}

export function emptyTotals() {
  return { in: 0, out: 0, cw5: 0, cw1: 0, cr: 0, tokens: 0, cost: 0, requests: 0 };
}

function addTo(t, r, sign = 1) {
  t.in += sign * r.in;
  t.out += sign * r.out;
  t.cw5 += sign * r.cw5;
  t.cw1 += sign * r.cw1;
  t.cr += sign * r.cr;
  t.tokens += sign * (r.in + r.out + r.cw5 + r.cw1 + r.cr);
  t.cost += sign * r.cost;
}

export function recordFromUsage(model, u, t) {
  const cw1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const cc = u.cache_creation_input_tokens ?? 0;
  const r = {
    t,
    model,
    in: u.input_tokens ?? 0,
    out: u.output_tokens ?? 0,
    cw1,
    cw5: Math.max(0, cc - cw1),
    cr: u.cache_read_input_tokens ?? 0,
  };
  r.cost = costOf(model, r);
  return r;
}

export class UsageIndex {
  constructor(dir = PROJECTS_DIR) {
    this.dir = dir;
    this.files = new Map(); // path -> { size, offset, remainder, seen: Map<key, record>, sid }
    this.sessions = new Map(); // sid -> { sid, cwd, aiTitle, customTitle, total, records[], firstAt, lastAt }
    this.busy = false;
    this.ready = false; // first full pass done
    this.version = 0;
    this.stats = { files: 0, bytes: 0, ms: 0 };
  }

  session(sid) {
    let s = this.sessions.get(sid);
    if (!s) {
      s = { sid, cwd: null, aiTitle: null, customTitle: null, total: emptyTotals(), records: [], firstAt: 0, lastAt: 0 };
      this.sessions.set(sid, s);
    }
    return s;
  }

  // Reads whatever transcripts grew since the last call. Yields to the event loop between
  // chunks so the 333 ms status tick keeps running during the first big pass.
  async refresh(now = Date.now()) {
    if (this.busy) return false;
    this.busy = true;
    const t0 = Date.now();
    let changed = false;
    try {
      for (const file of this.listFiles(now)) {
        let st;
        try {
          st = await fs.promises.stat(file.path);
        } catch {
          continue;
        }
        let f = this.files.get(file.path);
        if (f && st.size === f.size) continue;
        if (!f || st.size < f.offset) {
          if (f) this.forgetFile(f);
          f = { size: 0, offset: 0, remainder: Buffer.alloc(0), seen: new Map(), sid: file.sid };
          this.files.set(file.path, f);
        }
        f.size = st.size;
        if (await this.readFile(file.path, f)) changed = true;
      }
      this.prune(now);
      this.stats = { files: this.files.size, bytes: [...this.files.values()].reduce((a, f) => a + f.offset, 0), ms: Date.now() - t0 };
    } finally {
      this.busy = false;
      this.ready = true;
    }
    if (changed) this.version++;
    return changed;
  }

  listFiles(now) {
    const out = [];
    let projects;
    try {
      projects = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    const since = now - KEEP_RECORDS_MS;
    for (const p of projects) {
      const pdir = path.join(this.dir, p);
      let entries;
      try {
        entries = fs.readdirSync(pdir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          const fp = path.join(pdir, e.name);
          if (this.files.has(fp) || mtime(fp) >= since) out.push({ path: fp, sid: e.name.slice(0, -6) });
        } else if (e.isDirectory()) {
          // <project>/<sessionId>/subagents/agent-*.jsonl count toward the parent session.
          const sdir = path.join(pdir, e.name, 'subagents');
          let subs;
          try {
            subs = fs.readdirSync(sdir);
          } catch {
            continue;
          }
          for (const n of subs) {
            if (!n.endsWith('.jsonl')) continue;
            const fp = path.join(sdir, n);
            if (this.files.has(fp) || mtime(fp) >= since) out.push({ path: fp, sid: e.name });
          }
        }
      }
    }
    return out;
  }

  async readFile(file, f) {
    let changed = false;
    const fh = await fs.promises.open(file, 'r');
    try {
      while (f.offset < f.size) {
        const len = Math.min(CHUNK, f.size - f.offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, f.offset);
        if (!bytesRead) break;
        f.offset += bytesRead;
        const data = f.remainder.length ? Buffer.concat([f.remainder, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const last = data.lastIndexOf(10);
        if (last < 0) {
          f.remainder = Buffer.from(data);
          continue;
        }
        f.remainder = Buffer.from(data.subarray(last + 1));
        for (const line of data.toString('utf8', 0, last).split('\n')) {
          if (line && this.ingest(f, line)) changed = true;
        }
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      await fh.close();
    }
    return changed;
  }

  ingest(f, line) {
    const s = this.session(f.sid);
    // Cheap substring checks first: most bytes are tool results and request blobs.
    if (line.startsWith('{"type":"ai-title"') || line.startsWith('{"type":"custom-title"')) {
      try {
        const d = JSON.parse(line);
        if (d.aiTitle) s.aiTitle = d.aiTitle;
        if (d.customTitle) s.customTitle = d.customTitle;
      } catch {}
      return false;
    }
    if (!s.cwd) {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line.slice(0, 4000));
      if (m) s.cwd = JSON.parse(`"${m[1]}"`);
    }
    if (!line.includes('"usage"') || !line.includes('"type":"assistant"')) return false;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return false;
    }
    const m = d.message;
    if (d.type !== 'assistant' || !m?.usage || !m.model || m.model === '<synthetic>') return false;
    const t = Date.parse(d.timestamp) || 0;
    const r = recordFromUsage(m.model, m.usage, t);
    // One API response is written as one line per content block, each repeating the usage.
    const key = `${m.id}|${d.requestId ?? ''}`;
    const prev = f.seen.get(key);
    if (prev) {
      if (r.out <= prev.out && r.in <= prev.in && r.cr <= prev.cr && r.cw1 + r.cw5 <= prev.cw1 + prev.cw5) return false;
      addTo(s.total, prev, -1);
      Object.assign(prev, { in: Math.max(prev.in, r.in), out: Math.max(prev.out, r.out), cw5: Math.max(prev.cw5, r.cw5), cw1: Math.max(prev.cw1, r.cw1), cr: Math.max(prev.cr, r.cr) });
      prev.cost = costOf(prev.model, prev);
      addTo(s.total, prev);
      return true;
    }
    f.seen.set(key, r);
    s.total.requests++;
    addTo(s.total, r);
    if (t >= Date.now() - KEEP_RECORDS_MS) s.records.push(r);
    if (!s.firstAt || t < s.firstAt) s.firstAt = t;
    if (t > s.lastAt) s.lastAt = t;
    return true;
  }

  forgetFile(f) {
    const s = this.sessions.get(f.sid);
    if (!s) return;
    for (const r of f.seen.values()) {
      addTo(s.total, r, -1);
      s.total.requests--;
    }
    const gone = new Set(f.seen.values());
    s.records = s.records.filter((r) => !gone.has(r));
  }

  prune(now) {
    const cutoff = now - KEEP_RECORDS_MS;
    for (const s of this.sessions.values()) {
      if (s.records.length && s.records[0].t < cutoff) s.records = s.records.filter((r) => r.t >= cutoff);
    }
  }

  // Totals of one session (or all sessions when sid is null) for records with t >= from.
  window(from, sid = null) {
    const t = emptyTotals();
    const byModel = {};
    const list = sid ? [this.sessions.get(sid)].filter(Boolean) : this.sessions.values();
    for (const s of list) {
      for (const r of s.records) {
        if (r.t < from) continue;
        addTo(t, r);
        t.requests++;
        const m = (byModel[r.model] ||= emptyTotals());
        addTo(m, r);
        m.requests++;
      }
    }
    return { ...round(t), byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, round(v)])) };
  }

  // Cost-weighted usage in equal buckets between from and to, for a small bar chart.
  buckets(from, to, n) {
    const out = new Array(n).fill(0);
    const w = (to - from) / n;
    for (const s of this.sessions.values()) {
      for (const r of s.records) {
        if (r.t < from || r.t >= to) continue;
        out[Math.min(n - 1, Math.floor((r.t - from) / w))] += r.cost;
      }
    }
    return out.map((c) => Math.round(c * 1e4) / 1e4);
  }

  // Sessions ranked by cost-weighted usage since `from`.
  top(from, limit = 12) {
    const rows = [];
    for (const s of this.sessions.values()) {
      if (s.lastAt < from) continue;
      const w = emptyTotals();
      for (const r of s.records) if (r.t >= from) addTo(w, r);
      if (w.tokens > 0) rows.push({ sid: s.sid, cwd: s.cwd, title: s.customTitle || s.aiTitle, lastAt: s.lastAt, ...round(w) });
    }
    return rows.sort((a, b) => b.cost - a.cost).slice(0, limit);
  }
}

function round(t) {
  return { ...t, cost: Math.round(t.cost * 1e4) / 1e4 };
}

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}
