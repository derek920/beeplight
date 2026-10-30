// Each session's state trajectory (Doing → Waiting → Doing → Done …) and today's totals,
// built from the transitions the monitor observes.

export const HISTORY_MAX = 40;

// History keys. A turn that ended on a question ('waiting:q') is drawn like waiting, but is
// not counted as time blocked on the user: the session simply awaits its next instruction.
export function stateKey(v) {
  if (v.state === 'done') return `done:${v.outcome}`;
  if (v.state === 'waiting' && v.kind === 'question') return 'waiting:q';
  return v.state;
}

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Part of [t0, t1] that falls on the same day as `now`.
export function overlapToday(t0, t1, now) {
  return Math.max(0, t1 - Math.max(t0, dayStart(now)));
}

export function emptyDay(now) {
  return { date: dayKey(now), done: 0, failed: 0, workMs: 0, waitMs: 0, longestWaitMs: 0 };
}

export class Timeline {
  constructor(daily) {
    this.daily = daily?.date ? daily : emptyDay(Date.now());
  }

  roll(now) {
    if (this.daily.date !== dayKey(now)) this.daily = emptyDay(now);
  }

  /**
   * Records the session's current view into its history (mutated in place).
   * @returns {boolean} whether the history changed
   */
  track(history, v, now) {
    if (v.state === 'idle') return false;
    this.roll(now);
    const key = stateKey(v);
    const last = history[history.length - 1];
    if (last && last.k === key) {
      if (last.p && !v.pending) {
        delete last.p;
        this.finished(key, last.t);
        return true;
      }
      return false;
    }
    if (last?.p) {
      // A provisional "done" (verdict still pending) turned out to be another state:
      // rewrite it rather than leave a few-second sliver behind.
      last.k = key;
      if (v.pending) last.p = true;
      else {
        delete last.p;
        this.finished(key, last.t);
      }
      return true;
    }
    const at = Math.min(now, Math.max(last?.t ?? 0, v.since || now));
    if (last) this.span(last.k, last.t, at, now);
    const entry = { k: key, t: at };
    if (v.pending) entry.p = true;
    else this.finished(key, at);
    history.push(entry);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    return true;
  }

  finished(key, at) {
    if (!key.startsWith('done:') || dayKey(at) !== this.daily.date) return;
    if (key === 'done:failed') this.daily.failed++;
    else this.daily.done++;
  }

  span(k, t0, t1, now) {
    const ms = overlapToday(t0, t1, now);
    if (k === 'doing') this.daily.workMs += ms;
    else if (k === 'waiting') {
      this.daily.waitMs += ms;
      if (ms > 0) this.daily.longestWaitMs = Math.max(this.daily.longestWaitMs, t1 - t0);
    }
  }

  // Today's totals, including segments that are still open.
  today(histories, now) {
    this.roll(now);
    const d = { ...this.daily };
    for (const h of histories) {
      const last = h[h.length - 1];
      if (!last) continue;
      const ms = overlapToday(last.t, now, now);
      if (last.k === 'doing') d.workMs += ms;
      else if (last.k === 'waiting') {
        d.waitMs += ms;
        d.longestWaitMs = Math.max(d.longestWaitMs, now - last.t);
      }
    }
    return d;
  }
}
