import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig, PROJECTS_DIR } from '../../config/index.js';

// Token usage of every transcript on this machine (main sessions + subagents), queryable by
// time window so it can be lined up with the account's 5-hour and weekly limits.

const DAY = 86400_000;
const CHUNK = 4 * 1024 * 1024;

const MIN = 60_000;
const HOUR = 60 * MIN;
// Burn-rate chart ranges: bar width and the span of the smoothed line. `today` runs from local
// midnight, on an axis fixed to the whole day.
export const BURN_RANGES = {
  '5h': { hours: 5, step: MIN, avg: 30 * MIN },
  '24h': { hours: 24, step: 3 * MIN, avg: HOUR },
  today: { day: true, step: 3 * MIN, avg: HOUR },
  '7d': { hours: 7 * 24, step: HOUR, avg: 6 * HOUR },
};

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
  constructor(dir = PROJECTS_DIR, config = defaultConfig) {
    this.dir = dir;
    this.config = config;
    this.files = new Map(); // path -> { size, offset, remainder, seen: Map<key, record>, sid }
    this.sessions = new Map(); // sid -> { sid, cwd, aiTitle, customTitle, total, records[], firstAt, lastAt }
    this.busy = false;
    this.ready = false; // first full pass done
    this.version = 0;
    this.stats = { files: 0, bytes: 0, ms: 0 };
  }

  // How far back records are kept: usage.keepDays plus a day so the oldest daily bar is whole.
  keepMs() {
    return (this.config.get('usage.keepDays') + 1) * DAY;
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
    const since = now - this.keepMs();
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
    if (t >= Date.now() - this.keepMs()) s.records.push(r);
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
    const cutoff = now - this.keepMs();
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

  // Usage between the first and the last of `edges` (bucket boundaries, ascending): per bucket with
  // each session's cost in it, per model and per session. For the limit details view.
  detail(edges) {
    const n = edges.length - 1;
    const [from, to] = [edges[0], edges[n]];
    const buckets = Array.from({ length: n }, () => ({ ...emptyTotals(), bySid: new Map() }));
    const byModel = new Map();
    const bySid = new Map();
    const count = (t, r) => {
      addTo(t, r);
      t.requests++;
    };
    for (const s of this.sessions.values()) {
      if (s.lastAt < from) continue;
      for (const r of s.records) {
        if (r.t < from || r.t >= to) continue;
        // The last edge at or before r.t.
        let lo = 0;
        let hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (edges[mid] <= r.t) lo = mid;
          else hi = mid - 1;
        }
        const b = buckets[lo];
        count(b, r);
        b.bySid.set(s.sid, (b.bySid.get(s.sid) || 0) + r.cost);
        if (!byModel.has(r.model)) byModel.set(r.model, emptyTotals());
        count(byModel.get(r.model), r);
        if (!bySid.has(s.sid)) bySid.set(s.sid, { sid: s.sid, cwd: s.cwd, title: s.customTitle || s.aiTitle, ...emptyTotals() });
        count(bySid.get(s.sid), r);
      }
    }
    return { buckets, byModel, bySid };
  }

  // Token burn rate across all sessions, for the burn-rate chart. `range` is one of BURN_RANGES.
  // Buckets sit on clock boundaries and the last one holds `now`; each gives tokens per hour
  // split into cache read (cr), cache write (cw), uncached input (in) and output (out), plus the
  // trailing average of all input and of output over the range's `avg` span. The last bucket is
  // still filling, so it (and the averages that include it) count only the time it has had so
  // far. Cost is the API-equivalent estimate (see costOf), not a bill.
  // `from`–`to` is the axis; bars stop at `now`.
  burn(range = '24h', now = Date.now()) {
    if (!BURN_RANGES[range]) range = '24h';
    const { hours, day, step, avg } = BURN_RANGES[range];
    const span = Math.round(avg / step); // buckets in the average
    const end = Math.floor(now / step) * step + step;
    let from = end - hours * 3600_000;
    let to = end;
    if (day) {
      const d = new Date(now);
      from = d.setHours(0, 0, 0, 0);
      to = d.setDate(d.getDate() + 1);
    }
    const n = Math.round((end - from) / step);
    const total = n + span;
    const start = end - total * step; // the first bars' averages reach back one span
    const keys = ['cr', 'cw', 'in', 'out', 'cost'];
    const raw = Object.fromEntries(keys.map((k) => [k, new Array(total).fill(0)]));
    for (const s of this.sessions.values()) {
      for (const r of s.records) {
        if (r.t < start || r.t >= end) continue;
        const i = Math.floor((r.t - start) / step);
        raw.cr[i] += r.cr;
        raw.cw[i] += r.cw5 + r.cw1;
        raw.in[i] += r.in;
        raw.out[i] += r.out;
        raw.cost[i] += r.cost;
      }
    }
    const lastMs = Math.max(30_000, now - (end - step));
    const out = { range, ready: this.ready, from, to, stepMs: step, avgMs: avg, now, cr: [], cw: [], in: [], out: [], avgIn: [], avgOut: [], costPerHour: 0, totals: { cr: 0, cw: 0, in: 0, out: 0, cost: 0 } };
    let sumIn = 0;
    let sumOut = 0;
    let sumCost = 0;
    for (let i = 0; i < total; i++) {
      sumIn += raw.cr[i] + raw.cw[i] + raw.in[i];
      sumOut += raw.out[i];
      sumCost += raw.cost[i];
      if (i >= span) {
        sumIn -= raw.cr[i - span] + raw.cw[i - span] + raw.in[i - span];
        sumOut -= raw.out[i - span];
        sumCost -= raw.cost[i - span];
      }
      if (i < span) continue;
      const last = i === total - 1;
      const hrs = (last ? lastMs : step) / 3600_000;
      const avgHrs = (last ? avg - step + lastMs : avg) / 3600_000;
      for (const k of ['cr', 'cw', 'in', 'out']) {
        out[k].push(Math.round(raw[k][i] / hrs));
        out.totals[k] += raw[k][i];
      }
      out.totals.cost += raw.cost[i];
      out.avgIn.push(Math.round(sumIn / avgHrs));
      out.avgOut.push(Math.round(sumOut / avgHrs));
      if (last) out.costPerHour = Math.round((sumCost / avgHrs) * 100) / 100;
    }
    out.totals.cost = Math.round(out.totals.cost * 100) / 100;
    return out;
  }

  // One bar per local calendar day for the last `days` days (today last, still filling), in the same
  // shape as burn() but with tokens per day instead of per hour: cache read, cache write, uncached
  // input, output. `avgIn` / `avgOut` are the trailing 7-day mean per day (fewer days at the start),
  // and `costPerHour` holds the mean cost per day over the last 7 days. Bars sit DAY apart from
  // local midnight of the first day; across a DST change that is off by an hour, which no bar shows.
  daily(days = 28, now = Date.now()) {
    // Never more days than are kept (usage.keepDays, at least 8): a short setting shows fewer bars.
    days = Math.max(1, Math.min(days, this.config.get('usage.keepDays')));
    const d0 = new Date(now);
    const first = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() - (days - 1)).getTime();
    const to = first + days * DAY;
    const out = { range: '28d', ready: this.ready, from: first, to, stepMs: DAY, now, cr: [], cw: [], in: [], out: [], avgIn: [], avgOut: [], costPerHour: 0, totals: { cr: 0, cw: 0, in: 0, out: 0, cost: 0 } };
    const raw = Object.fromEntries(['cr', 'cw', 'in', 'out', 'cost'].map((k) => [k, new Array(days).fill(0)]));
    for (const s of this.sessions.values()) {
      if (s.lastAt < first) continue;
      for (const r of s.records) {
        if (r.t < first || r.t >= to) continue;
        const i = Math.min(days - 1, Math.floor((r.t - first) / DAY));
        raw.cr[i] += r.cr;
        raw.cw[i] += r.cw5 + r.cw1;
        raw.in[i] += r.in;
        raw.out[i] += r.out;
        raw.cost[i] += r.cost;
      }
    }
    for (const k of ['cr', 'cw', 'in', 'out']) {
      out[k] = raw[k];
      out.totals[k] = raw[k].reduce((x, y) => x + y, 0);
    }
    for (let i = 0; i < days; i++) {
      const lo = Math.max(0, i - 6);
      let a = 0;
      let b = 0;
      for (let j = lo; j <= i; j++) {
        a += raw.cr[j] + raw.cw[j] + raw.in[j];
        b += raw.out[j];
      }
      out.avgIn.push(Math.round(a / (i - lo + 1)));
      out.avgOut.push(Math.round(b / (i - lo + 1)));
    }
    const week = raw.cost.slice(-7);
    out.costPerHour = Math.round((week.reduce((x, y) => x + y, 0) / week.length) * 100) / 100;
    out.totals.cost = Math.round(raw.cost.reduce((x, y) => x + y, 0) * 100) / 100;
    return out;
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
