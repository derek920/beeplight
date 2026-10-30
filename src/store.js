import { config as defaultConfig, STORE_FILE } from './config.js';
import { readJson, writeJsonAtomic } from './util.js';

const SUMMARY_TTL_MS = 7 * 24 * 3600_000;

// data/state.json: LLM summaries (so restarts don't re-summarize), the last view of
// sessions that ended, items the user dismissed, per-session state histories and today's totals.
export class Store {
  constructor(file = STORE_FILE, config = defaultConfig) {
    this.file = file;
    this.config = config;
    const d = readJson(file) || {};
    this.summaries = d.summaries || {};
    this.ended = d.ended || {};
    this.dismissed = d.dismissed || {};
    this.histories = d.histories || {};
    this.daily = d.daily || null;
    this.limits = d.limits || null; // owned by Limits: latest reading, samples, own spend
    // Finished turns the user has not looked at yet, like unread messages: sid -> { at, outcome }.
    this.unread = d.unread || {};
    this.flags = d.flags || {};
    this.timer = null;
    this.prune();
  }

  getSummary(sid) {
    return this.summaries[sid] || null;
  }

  setSummary(sid, s) {
    this.summaries[sid] = s;
    this.save();
  }

  clearSummaryKey(sid) {
    if (this.summaries[sid]) {
      this.summaries[sid] = { ...this.summaries[sid], key: null };
      this.save();
    }
  }

  getHistory(sid) {
    return (this.histories[sid] ||= []);
  }

  setHistory(sid, history, daily) {
    this.histories[sid] = history;
    this.daily = daily;
    this.save();
  }

  markUnread(sid, at, outcome) {
    this.unread[sid] = { at, outcome };
    this.save();
  }

  markRead(sid) {
    if (!this.unread[sid]) return false;
    delete this.unread[sid];
    this.save();
    return true;
  }

  setFlag(name, value) {
    if (this.flags[name] === value) return;
    this.flags[name] = value;
    this.save();
  }

  setEnded(sid, view) {
    this.ended[sid] = view;
    this.save();
  }

  dismiss(sid) {
    this.dismissed[sid] = Date.now();
    delete this.ended[sid];
    delete this.unread[sid];
    this.save();
  }

  isDismissed(sid, since) {
    const at = this.dismissed[sid];
    // A dismissed session that starts doing new work comes back.
    return at != null && (since == null || since <= at);
  }

  prune() {
    const now = Date.now();
    const retain = this.config.get('collector.retainHours') * 3600_000;
    for (const [sid, s] of Object.entries(this.summaries)) if (now - (s.at || 0) > SUMMARY_TTL_MS) delete this.summaries[sid];
    for (const [sid, v] of Object.entries(this.ended)) if (now - (v.endedAt || 0) > retain) delete this.ended[sid];
    for (const [sid, at] of Object.entries(this.dismissed)) if (now - at > SUMMARY_TTL_MS) delete this.dismissed[sid];
    for (const [sid, u] of Object.entries(this.unread)) if (now - (u.at || 0) > retain) delete this.unread[sid];
    for (const [sid, h] of Object.entries(this.histories)) if (!h.length || now - h[h.length - 1].t > SUMMARY_TTL_MS) delete this.histories[sid];
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      writeJsonAtomic(this.file, {
        v: 1,
        summaries: this.summaries,
        ended: this.ended,
        dismissed: this.dismissed,
        histories: this.histories,
        daily: this.daily,
        limits: this.limits,
        unread: this.unread,
        flags: this.flags,
      });
    } catch (e) {
      console.warn(`[store] save failed: ${e.message}`);
    }
  }
}
