import { config as defaultConfig, STORE_FILE } from '../config/index.js';
import { readJson, writeFileAtomic } from '../lib/util.js';

const DAY = 86_400_000;
const PRUNE_EVERY_MS = 3600_000;

// data/state.json: LLM summaries (so restarts don't re-summarize), the last view of
// sessions that ended, items the user dismissed, per-session state histories and today's totals.
// Nothing in it is kept longer than store.keepDays (30 days at most); what only the board uses
// (ended sessions, unread marks) goes after collector.retainHours. Settings (flags) are not
// history and stay. Pruned at startup, every hour, when either setting changes, and on request.
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
    this.prune('startup');
  }

  /** Hourly pruning, and at once when a retention setting changes. */
  start() {
    this.pruneTimer = setInterval(() => this.prune('hourly'), PRUNE_EVERY_MS);
    this.pruneTimer.unref();
    this.config.on('change', (keys) => {
      if (keys.includes('store.keepDays') || keys.includes('collector.retainHours')) this.prune('setting changed');
    });
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

  /** @returns {number} how many entries were removed */
  prune(reason) {
    const now = Date.now();
    const keep = this.config.get('store.keepDays') * DAY;
    const board = Math.min(keep, this.config.get('collector.retainHours') * 3600_000);
    let removed = 0;
    const drop = (map, expired) => {
      for (const [sid, v] of Object.entries(map)) {
        if (!expired(v)) continue;
        delete map[sid];
        removed++;
      }
    };
    drop(this.summaries, (s) => now - (s.at || 0) > keep);
    drop(this.dismissed, (at) => now - at > keep);
    drop(this.histories, (h) => h.length > 0 && now - h[h.length - 1].t > keep);
    drop(this.ended, (v) => now - (v.endedAt || 0) > board);
    drop(this.unread, (u) => now - (u.at || 0) > board);
    // Empty histories are placeholders for sessions with nothing recorded yet, not data.
    for (const [sid, h] of Object.entries(this.histories)) if (!h.length) delete this.histories[sid];
    if (removed) {
      console.log(`[store] ${reason}: removed ${removed} entries`);
      this.save();
    }
    return removed;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }

  /** Writes now. @returns {number} the file's size in bytes, 0 if it could not be written */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const text = JSON.stringify({
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
      writeFileAtomic(this.file, text);
      return Buffer.byteLength(text);
    } catch (e) {
      console.warn(`[store] save failed: ${e.message}`);
      return 0;
    }
  }
}
