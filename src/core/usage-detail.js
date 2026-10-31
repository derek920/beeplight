import path from 'node:path';

// The limit details view: one limit window's usage in buckets of a chosen size, the limit's
// measured utilization through the window, and where the usage went (models, token kinds,
// projects, sessions). Built on request while a details view is open, so none of it rides in the
// stream.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Bucket sizes each window offers, smallest first. */
export const STEPS = {
  '5h': { '10m': 10 * MINUTE, '30m': 30 * MINUTE, '1h': HOUR },
  '7d': { '1h': HOUR, '6h': 6 * HOUR, '1d': DAY },
};
export const DEFAULT_STEP = { '5h': '10m', '7d': '6h' };

/**
 * Bucket boundaries from `from` to `to` on the local clock: every 10 minutes counted from :00,
 * every 6 hours from midnight, each midnight. A window starts at its reset time, not on the clock,
 * so the first and last buckets may be partial.
 */
export function edges(from, to, step) {
  const out = [from];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  if (step >= DAY) {
    for (d.setDate(d.getDate() + 1); +d < to; d.setDate(d.getDate() + 1)) out.push(+d);
  } else {
    const midnight = +d;
    for (let t = midnight + (Math.floor((from - midnight) / step) + 1) * step; t < to; t += step) out.push(t);
  }
  out.push(to);
  return out;
}

/** 'claude-opus-5-5-20261001' → 'Opus 5.5', 'claude-3-5-sonnet-20241022' → 'Sonnet 3.5'. */
export function modelName(id = '') {
  const name = (s) => s[0].toUpperCase() + s.slice(1);
  // One or two digits, so the date in 'claude-3-5-sonnet-20241022' is not read as a version.
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/.exec(id);
  if (m) return `${name(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  const old = /claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)/.exec(id);
  if (old) return `${name(old[3])} ${old[1]}${old[2] ? `.${old[2]}` : ''}`;
  return id || '?';
}

const money = (c) => Math.round(c * 1e4) / 1e4;
const kinds = (t) => ({ tokens: t.tokens, in: t.in, out: t.out, cw: t.cw5 + t.cw1, cr: t.cr, cost: money(t.cost), requests: t.requests });

/**
 * @param {object} deps usage (UsageIndex), limits (Limits), titleOf({sid, cwd, title}) and live(sid)
 * @param {{window: '5h'|'7d', step: string, now: number}} q a window and one of its STEPS
 */
export function buildDetail({ usage, limits, titleOf, live }, { window, step, now }) {
  const key = window === '5h' ? 'fiveHour' : 'sevenDay';
  const range = limits.windows(now)[key];
  const limit = limits.snapshot(now)[key] ?? null;
  const bounds = edges(range.start, range.end, STEPS[window][step]);
  const d = usage.detail(bounds);

  const total = { tokens: 0, in: 0, out: 0, cw: 0, cr: 0, cost: 0, requests: 0 };
  for (const b of d.buckets) for (const [k, v] of Object.entries(kinds(b))) total[k] += v;
  total.cost = money(total.cost);
  // A session's share of the limit, assuming this Mac's Claude Code is all of the usage.
  const share = (cost) => (limit && total.cost > 0 ? (cost / total.cost) * limit.utilization : null);

  const sessions = [...d.bySid.values()]
    .filter((s) => s.tokens > 0)
    .sort((a, b) => b.cost - a.cost)
    .map((s) => ({ sid: s.sid, title: titleOf(s), project: path.basename(s.cwd || ''), live: live(s.sid), ...kinds(s), share: share(s.cost) }));
  const titles = new Map(sessions.map((s) => [s.sid, s.title]));

  const projects = new Map();
  for (const s of sessions) {
    const p = projects.get(s.project) || { project: s.project, tokens: 0, cost: 0, sessions: 0 };
    p.tokens += s.tokens;
    p.cost += s.cost;
    p.sessions++;
    projects.set(s.project, p);
  }

  const models = new Map();
  for (const [id, t] of d.byModel) {
    if (!t.tokens) continue;
    const m = models.get(modelName(id)) || { model: modelName(id), tokens: 0, cost: 0, requests: 0 };
    m.tokens += t.tokens;
    m.cost += t.cost;
    m.requests += t.requests;
    models.set(m.model, m);
  }

  return {
    window,
    step,
    steps: Object.keys(STEPS[window]),
    range,
    now,
    limit,
    utilization: limits.history(key, now),
    buckets: d.buckets.map((b, i) => ({
      start: bounds[i],
      end: bounds[i + 1],
      ...kinds(b),
      top: [...b.bySid].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([sid, cost]) => ({ sid, title: titles.get(sid) || sid.slice(0, 8), cost: money(cost) })),
    })),
    total,
    models: [...models.values()].sort((a, b) => b.cost - a.cost).map((m) => ({ ...m, cost: money(m.cost) })),
    projects: [...projects.values()].sort((a, b) => b.cost - a.cost).slice(0, 8).map((p) => ({ ...p, cost: money(p.cost) })),
    sessions: sessions.slice(0, 10),
  };
}
