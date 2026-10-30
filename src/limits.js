import { config as defaultConfig } from './config.js';
import { oneLine } from './util.js';

// The account's plan limits as the server reports them. Every `claude -p` stream-json call
// emits a rate_limit_event carrying the utilization of the 5-hour and weekly windows; the
// summarizer's calls feed it, and a tiny probe keeps it fresh when nothing else runs.

export const FIVE_HOURS = 5 * 3600_000;
export const SEVEN_DAYS = 7 * 86400_000;
const SAMPLE_KEEP_MS = 8 * 86400_000;
const SAMPLE_MIN_GAP_MS = 60_000;
const PROBE_TIMEOUT_MS = 45_000;

function win(x) {
  return x && typeof x.utilization === 'number' ? { utilization: x.utilization, resetsAt: x.resetsAt * 1000, status: x.status ?? null } : null;
}

export class Limits {
  constructor(store, runner, config = defaultConfig) {
    this.config = config;
    this.store = store;
    this.runner = runner;
    const saved = store.limits || {};
    this.latest = saved.latest || null;
    this.samples = saved.samples || [];
    this.self = saved.self || { date: null, calls: 0, cost: 0 };
    this.probing = false;
    this.lastProbeAt = 0;
    this.lastError = null;
    this.version = 0;
    runner.onRateLimit = (info) => this.ingest(info);
    runner.onResult = (r) => this.countSelf(r);
  }

  ingest(info, at = Date.now()) {
    const w = info.unifiedWindows || {};
    const extra = {};
    for (const [k, v] of Object.entries(w)) if (k !== 'five_hour' && k !== 'seven_day' && win(v)) extra[k] = win(v);
    const fiveHour = win(w.five_hour);
    const sevenDay = win(w.seven_day);
    this.latest = { at, status: info.status ?? null, overage: info.overageStatus ?? null, fiveHour, sevenDay, extra };
    const last = this.samples[this.samples.length - 1];
    const u5 = fiveHour?.utilization;
    const u7 = sevenDay?.utilization;
    if (!last || at - last.t >= SAMPLE_MIN_GAP_MS || last.u5 !== u5 || last.u7 !== u7) {
      this.samples.push({ t: at, u5, r5: fiveHour?.resetsAt, u7, r7: sevenDay?.resetsAt });
      while (this.samples.length && at - this.samples[0].t > SAMPLE_KEEP_MS) this.samples.shift();
    }
    this.version++;
    this.save();
  }

  // The monitor's own spend (summaries + probes), so it can show what it costs.
  countSelf(result) {
    const today = new Date().toDateString();
    if (this.self.date !== today) this.self = { date: today, calls: 0, cost: 0 };
    this.self.calls++;
    this.self.cost += result.total_cost_usd || 0;
    this.save();
  }

  save() {
    this.store.limits = { latest: this.latest, samples: this.samples, self: this.self };
    this.store.save();
  }

  // Growth of utilization within the current window → when it would reach 100%.
  project(key, now) {
    const w = this.latest?.[key];
    if (!w) return null;
    const [uk, rk, lookback] = key === 'fiveHour' ? ['u5', 'r5', 3600_000] : ['u7', 'r7', 12 * 3600_000];
    const pts = this.samples.filter((s) => s[rk] === w.resetsAt && typeof s[uk] === 'number' && now - s.t <= lookback);
    if (pts.length < 2) return null;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const hours = (b.t - a.t) / 3600_000;
    if (hours < 0.1) return null; // need ≥ 6 minutes of history
    const ratePerHour = (b[uk] - a[uk]) / hours;
    if (ratePerHour <= 0) return { ratePerHour: 0, etaMs: null, beforeReset: false };
    const etaMs = ((1 - w.utilization) / ratePerHour) * 3600_000;
    return { ratePerHour, etaMs, beforeReset: now + etaMs < w.resetsAt };
  }

  // Window boundaries, aligned to the server's reset times (falls back to rolling windows).
  windows(now) {
    const fh = this.latest?.fiveHour;
    const sd = this.latest?.sevenDay;
    return {
      fiveHour: fh && fh.resetsAt > now ? { start: fh.resetsAt - FIVE_HOURS, end: fh.resetsAt, aligned: true } : { start: now - FIVE_HOURS, end: now, aligned: false },
      sevenDay: sd && sd.resetsAt > now ? { start: sd.resetsAt - SEVEN_DAYS, end: sd.resetsAt, aligned: true } : { start: now - SEVEN_DAYS, end: now, aligned: false },
    };
  }

  snapshot(now) {
    if (!this.latest) return { known: false, probing: this.probing, error: this.lastError, self: this.self };
    const view = (key) => {
      const w = this.latest[key];
      // A window whose reset time has passed no longer describes the current window.
      if (!w || w.resetsAt <= now) return null;
      return { ...w, projection: this.project(key, now) };
    };
    return {
      known: true,
      at: this.latest.at,
      status: this.latest.status,
      overage: this.latest.overage,
      fiveHour: view('fiveHour'),
      sevenDay: view('sevenDay'),
      extra: this.latest.extra,
      probing: this.probing,
      error: this.lastError,
      self: this.self,
    };
  }

  due(now, recentlyActive) {
    const active = this.config.get('limits.probeMinutes') * 60_000;
    if (this.probing || active <= 0 || now - this.lastProbeAt < 60_000) return false;
    if (!this.latest) return true;
    const age = now - this.latest.at;
    const rolled = [this.latest.fiveHour, this.latest.sevenDay].some((w) => w && w.resetsAt <= now);
    return rolled || age > (recentlyActive ? active : Math.max(active, this.config.get('limits.idleProbeMinutes') * 60_000));
  }

  // One minimal request; the rate_limit_event it produces updates `latest` via the runner hook.
  async probe() {
    if (this.probing) return;
    this.probing = true;
    this.lastProbeAt = Date.now();
    this.version++;
    try {
      await this.runner.run(['--model', this.config.get('summarizer.model'), '--system-prompt', 'Reply with the single word: ok'], 'ok', PROBE_TIMEOUT_MS);
      this.lastError = null;
    } catch (e) {
      this.lastError = oneLine(e.message, 160);
      console.warn(`[limits] probe failed: ${this.lastError}`);
    } finally {
      this.probing = false;
      this.version++;
    }
  }
}
