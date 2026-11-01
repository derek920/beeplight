import { t, applyI18n, LANG } from './i18n.js';

const $ = (sel, el = document) => el.querySelector(sel);
applyI18n();
document.querySelectorAll('.mark').forEach((el, i) => (el.innerHTML = logoSVG(`m${i}`)));
const LOCALE = LANG === 'zh-Hans' ? 'zh-CN' : 'en-US';

// On the LAN (phone) every API call carries the pairing token from the QR code link. It stays
// in the URL on purpose: a home-screen web app saves the URL it was added from.
const params = new URLSearchParams(location.search);
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
// Keys from the earlier names (Tasklight, before it Claude Monitor), moved once so a paired phone
// stays paired. The newer name goes first, so its value wins.
try {
  for (const prefix of ['tasklight', 'claude-monitor']) {
    for (const k of ['token', 'prefs']) {
      const old = localStorage.getItem(`${prefix}-${k}`);
      if (old != null && localStorage.getItem(`beeplight-${k}`) == null) localStorage.setItem(`beeplight-${k}`, old);
      localStorage.removeItem(`${prefix}-${k}`);
    }
  }
} catch {}
const TOKEN = (() => {
  const t = params.get('t');
  try {
    if (t) localStorage.setItem('beeplight-token', t);
    return t || localStorage.getItem('beeplight-token');
  } catch {
    return t;
  }
})();
const authHeaders = () => (TOKEN && !IS_LOCAL ? { 'x-beeplight-token': TOKEN } : {});
const withToken = (path) => (TOKEN && !IS_LOCAL ? `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(TOKEN)}` : path);
if (TOKEN && !IS_LOCAL) document.getElementById('manifest').href = withToken('/manifest.webmanifest');
const MOBILE = matchMedia('(max-width: 700px)');
const board = $('.board');
const cols = {
  waiting: $('[data-col="waiting"]'),
  doing: $('[data-col="doing"]'),
  done: $('[data-col="done"]'),
};

const prefs = loadPrefs();
let snapshot = { sessions: [], idleCount: 0 };
let meta = null;
let lastMetaAt = 0;
let firstRender = true;
const seenKey = new Map(); // id -> last observed state key
const notifiedKey = new Map(); // id -> state key we already notified about

function loadPrefs() {
  const base = { notify: false, sdk: false, doneFilter: 'all', skin: 'native' };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem('beeplight-prefs') || '{}') };
  } catch {
    return base;
  }
}

function savePrefs() {
  try {
    localStorage.setItem('beeplight-prefs', JSON.stringify(prefs));
  } catch {}
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const stateKey = (v) => (v.state === 'done' ? `done:${v.outcome}` : v.state);
const stateClass = (v) => (v.state === 'done' ? (v.outcome === 'failed' ? 's-failed' : 's-success') : `s-${v.state}`);

function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('{n} sec', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('{n} min', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? t('{h} hr {m} min', { h, m: m % 60 }) : t('{h} hr', { h });
  const d = Math.floor(h / 24);
  if (h % 24) return d === 1 ? t('1 day {h} hr', { h: h % 24 }) : t('{d} days {h} hr', { d, h: h % 24 });
  return d === 1 ? t('1 day') : t('{d} days', { d });
}

function elapsedText(mode, at, now) {
  if (!at) return '';
  // Short forms for the status screen.
  if (mode === 's-wait' || mode === 's-run') return dur(now - at);
  if (mode === 's-ago') return now - at < 10_000 ? t('Just now') : t('{t} ago', { t: dur(now - at) });
  if (mode === 'wait') return t('Waiting {t}', { t: dur(now - at) });
  if (mode === 'run') return t('Running {t}', { t: dur(now - at) });
  const ms = now - at;
  return ms < 10_000 ? t('Just now') : t('{t} ago', { t: dur(ms) });
}

function hostText(v) {
  if (v.entrypoint === 'background') return t('Background session');
  if (v.entrypoint === 'claude-desktop') return t('Claude Desktop');
  if (v.sdk) return 'SDK';
  const h = v.host;
  if (!h) return v.entrypoint === 'cli' ? t('CLI') : v.entrypoint || '';
  const tty = h.tty ? ` · ${h.tty.replace('/dev/', '')}` : '';
  if (h.kind === 'iterm') return `iTerm2${tty}`;
  if (h.kind === 'terminal') return `Terminal${tty}`;
  if (h.kind === 'tmux') return 'tmux';
  return h.app || t('CLI');
}

function primaryAction(v) {
  if (v.live)
    return IS_LOCAL
      ? [t('Jump to task'), t("Switch to this session's window")]
      : [t('Open on Mac'), t("Switch to this session's window on the Mac")];
  if (v.entrypoint === 'claude-desktop') return [t('Open'), t('Open this session in Claude Desktop')];
  if (v.jobShort) return [t('Attach'), t('Run claude attach {id} in a new terminal tab', { id: v.jobShort })];
  return [t('Resume'), t('Run claude --resume in a new terminal tab')];
}

const SEG_CLASS = { doing: 'seg-doing', waiting: 'seg-waiting', 'waiting:q': 'seg-question', 'done:failed': 'seg-failed' };
const STRIP_WINDOW = 30 * 60_000;
const URGENT_MS = 3 * 60_000;

// Last 30 minutes of the state trajectory; right edge = now. Filled in by updateElapsed()
// rather than cardHTML(), so the cached card markup does not change every second.
function stripHTML(history = [], now = Date.now()) {
  const start = now - STRIP_WINDOW;
  const segs = history
    .map((s, i) => {
      const t0 = Math.max(s.t, start);
      const t1 = i + 1 < history.length ? history[i + 1].t : now;
      if (t1 <= start || t1 <= t0) return '';
      const left = ((t0 - start) / STRIP_WINDOW) * 100;
      const width = ((t1 - t0) / STRIP_WINDOW) * 100;
      return `<i class="${SEG_CLASS[s.k] || 'seg-done'}" style="left:${left.toFixed(2)}%;width:max(2px,${width.toFixed(2)}%)"></i>`;
    })
    .join('');
  return segs;
}

function turnStats(v, now = Date.now()) {
  const h = v.history || [];
  if (!h.length) return '';
  const start = v.turnStartedAt || h[0].t;
  let work = 0;
  let wait = 0;
  h.forEach((s, i) => {
    const t0 = Math.max(s.t, start);
    const t1 = i + 1 < h.length ? h[i + 1].t : now;
    if (t1 <= t0) return;
    if (s.k === 'doing') work += t1 - t0;
    else if (s.k === 'waiting') wait += t1 - t0;
  });
  if (work < 1000 && wait < 1000) return '';
  return wait >= 1000
    ? t('This turn: running {work} · waiting {wait}', { work: dur(work), wait: dur(wait) })
    : t('This turn: running {work}', { work: dur(work) });
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(n);
}

const requestsText = (n) => (n === 1 ? t('1 request') : t('{n} requests', { n }));
const pct = (x) => (x == null ? '—' : `${x >= 0.1 ? Math.round(x * 100) : (x * 100).toFixed(1)}%`);
const usd = (x) => `$${x >= 100 ? Math.round(x) : x.toFixed(x >= 10 ? 1 : 2)}`;

function usageLine(u) {
  if (!u) return '';
  const parts = [t('This session: {n} tokens', { n: fmtTokens(u.total.tokens) })];
  if (u.fiveHour.share != null && u.fiveHour.tokens) parts.push(t('≈{p} of 5-hour limit', { p: pct(u.fiveHour.share) }));
  if (u.sevenDay.share != null && u.sevenDay.tokens) parts.push(t('≈{p} of weekly limit', { p: pct(u.sevenDay.share) }));
  const tip = t(
    "{requests} in total, {out} output tokens, ≈{cost} at API prices. Limit shares are estimated from this session's share of API-equivalent cost in this Mac's usage; other devices aren't counted.",
    { requests: requestsText(u.total.requests), out: fmtTokens(u.total.out), cost: usd(u.total.cost) },
  );
  return `<div class="usage-line" title="${esc(tip)}">${parts.join(' · ')}</div>`;
}

function promptHTML(v) {
  return v.lastPrompt ? `<div class="last-prompt"><span>${t('Last request')}</span>${esc(v.lastPrompt)}</div>` : '';
}

function cardHTML(v) {
  const mode = v.state === 'done' ? 'ago' : v.state === 'waiting' ? 'wait' : 'run';
  const t0 = v.state === 'doing' ? v.turnStartedAt || v.since : v.since;
  const isTool = /^[\w.-]+ · /.test(v.detail);
  const detailCls = v.pending ? 'detail muted' : isTool ? 'detail tool' : 'detail';

  const agents = v.subagents || [];
  const agentItems = agents
    .slice(0, 5)
    .map(
      (a) =>
        `<li class="${a.running ? 'run' : ''}"><span class="a-ic"></span><span class="a-type">${esc(a.type)}</span><span class="a-desc">${esc(a.activity || a.description)}</span></li>`,
    )
    .join('');
  const agentMore = agents.length > 5 ? `<li><span class="a-desc">${t('… {n} more', { n: agents.length - 5 })}</span></li>` : '';

  const chips = [`<span class="chip" title="${esc(v.cwd)}">${esc(v.project || '—')}</span>`];
  if (v.remote) chips.unshift(deviceChip(v.remote));
  const host = hostText(v);
  if (host) chips.push(`<span class="chip">${esc(host)}</span>`);
  if (v.stopped)
    chips.push(`<span class="chip warn" title="${esc(t('Process suspended (Ctrl+Z). Type fg in its terminal to resume.'))}">${t('Suspended')}</span>`);
  if (v.ended && v.endReason === 'switched') chips.push(`<span class="chip">${t('Switched to a new session')}</span>`);
  else if (v.ended && v.endReason !== 'background') chips.push(`<span class="chip">${t('Closed')}</span>`);

  const [label, hint] = primaryAction(v);
  // Another device's task: read-only here.
  const actions = v.remote ? '' : [
    meta?.titles === 'original' ? '' : `<button class="btn ghost" data-act="resummarize" title="${esc(t('Summarize title and result again'))}">↻</button>`,
    v.state === 'done'
      ? `<button class="btn ghost" data-act="dismiss" title="${esc(t('Remove from board (it comes back when there is new activity)'))}">✕</button>`
      : '',
    `<button class="btn" data-act="focus" title="${esc(hint)}">${label} ↗</button>`,
  ].join('');

  return `<article class="card ${stateClass(v)}${v.ended ? ' is-ended' : ''}${v.unread ? ' unread' : ''}${v.remote ? ' remote' : ''}" data-id="${esc(v.id)}" data-kind="${esc(v.kind || '')}" tabindex="0" title="${esc(v.lastPrompt ? t('Last request: {prompt}', { prompt: v.lastPrompt }) : '')}">
  <div class="row1">${v.unread ? `<span class="dot-new" title="${esc(t('Finished, not viewed yet. Open the task, stay on its terminal tab for a moment, or send it a new message to mark it read'))}"></span>` : ''}<span class="pill"><span class="ic"></span>${esc(v.label)}</span><span class="elapsed" data-mode="${mode}" data-t="${t0 || ''}"></span></div>
  <h3 class="title">${esc(v.title)}${v.summarizing ? `<span class="spark">${t('Summarizing…')}</span>` : ''}</h3>
  ${v.goal ? `<p class="goal">${esc(v.goal)}</p>` : ''}
  ${v.detail ? `<div class="${detailCls}">${esc(v.detail)}</div>` : ''}
  ${agentItems ? `<ul class="agents">${agentItems}${agentMore}</ul>` : ''}
  ${promptHTML(v)}
  ${usageLine(v.usage)}
  <div class="strip" data-id="${esc(v.id)}"></div>
  <div class="strip-meta"><span>${t('Last 30 min')}</span><span class="turn" data-id="${esc(v.id)}"></span></div>
  <div class="foot-row">${chips.join('')}<span class="actions">${actions}</span></div>
</article>`;
}

function renderColumn(key, items, changed) {
  const col = cols[key];
  const box = $('.cards', col);
  const existing = new Map([...box.children].map((el) => [el.dataset.id, el]));
  let prev = null;
  for (const v of items) {
    const html = cardHTML(v);
    let el = existing.get(v.id);
    if (!el || el._html !== html) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const fresh = tpl.content.firstElementChild;
      fresh._html = html;
      if (el) {
        fresh.style.animation = 'none';
        el.replaceWith(fresh);
      }
      el = fresh;
    }
    if (changed.has(v.id)) {
      el.style.animation = '';
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
    existing.delete(v.id);
    const want = prev ? prev.nextElementSibling : box.firstElementChild;
    if (want !== el) box.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
  col.classList.toggle('has-cards', items.length > 0);
  $('.count', col).textContent = items.length;
}

function render() {
  const visible = snapshot.sessions.filter((v) => prefs.sdk || !v.sdk);
  const changed = trackTransitions(visible);

  const waiting = visible.filter((v) => v.state === 'waiting').sort((a, b) => (a.since || 0) - (b.since || 0));
  const doing = visible
    .filter((v) => v.state === 'doing')
    .sort((a, b) => (a.turnStartedAt || a.since || 0) - (b.turnStartedAt || b.since || 0));
  // Unread finishes first, like unread chats.
  const doneAll = visible
    .filter((v) => v.state === 'done')
    .sort((a, b) => Number(!!b.unread) - Number(!!a.unread) || (b.since || 0) - (a.since || 0));
  const done = prefs.doneFilter === 'all' ? doneAll : doneAll.filter((v) => v.outcome === prefs.doneFilter);

  renderColumn('waiting', waiting, changed);
  renderColumn('doing', doing, changed);
  renderColumn('done', done, changed);
  renderTabs(waiting.length, doing.length, doneAll.length, doneAll.filter((v) => v.unread).length);
  renderAmbient(waiting, doing, doneAll);

  const counts = {
    waiting: waiting.length,
    doing: doing.length,
    success: doneAll.filter((v) => v.outcome !== 'failed').length,
    failed: doneAll.filter((v) => v.outcome === 'failed').length,
    unread: doneAll.filter((v) => v.unread).length,
  };
  const nb = $('#new-badge');
  nb.hidden = !counts.unread;
  nb.textContent = t('{n} new', { n: counts.unread });
  $('[data-col="done"] .hint').hidden = !!counts.unread;
  $('#read-all').hidden = !counts.unread;
  renderStats(counts);
  updateChrome(counts);
  renderFoot();
  updateElapsed();
  firstRender = false;
}

function renderStats(c) {
  const items = [
    ['waiting', t('Needs you')],
    ['doing', t('Running')],
    ['success', t('Done')],
    ['failed', t('Failed')],
  ];
  $('#stats').innerHTML = items
    .map(
      ([k, label]) =>
        `<div class="stat ${k}${c[k] ? '' : ' zero'}"><b>${c[k]}</b><span>${label}</span>${k === 'success' && c.unread ? `<em class="stat-new">${t('{n} new', { n: c.unread })}</em>` : ''}</div>`,
    )
    .join('');
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// The app icon (desktop/Icon.swift) cropped to its rounded body, for the header, the pairing card
// and the tab. `id` keeps each copy's gradients its own: a hidden copy's would not paint.
function logoSVG(id, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 824 824"><defs><linearGradient id="bg-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#232B3B"/><stop offset="1" stop-color="#0B0F17"/></linearGradient><radialGradient id="glow-${id}" cx="512" cy="512" r="380" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3B82F6" stop-opacity="0.28"/><stop offset="1" stop-color="#3B82F6" stop-opacity="0"/></radialGradient></defs><rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg-${id})"/><rect x="100" y="100" width="824" height="824" rx="186" fill="url(#glow-${id})"/><g fill="none" stroke-width="78" stroke-linecap="round"><path d="M 689.1 328.6 A 255 255 0 0 0 334.9 328.6" stroke="#FF9F0A"/><path d="M 582.3 757.1 A 255 255 0 0 0 759.4 450.3" stroke="#0A84FF"/><path d="M 264.6 450.3 A 255 255 0 0 0 441.7 757.1" stroke="#30D158"/></g><circle cx="512" cy="512" r="62" fill="#fff"/>${extra}</svg>`;
}

function updateChrome(c) {
  // The app icon with a badge, as in the Dock: how many need you, or a dot while tasks run.
  const n = c.waiting || c.unread;
  const color = c.waiting ? cssVar('--waiting') : c.unread ? cssVar('--success') : cssVar('--doing');
  const badge = n
    ? `<circle cx="724" cy="300" r="200" fill="${color}" stroke="#0B0F17" stroke-width="40"/><text x="724" y="394" font-size="270" font-family="Arial, sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${Math.min(n, 9)}</text>`
    : c.doing
      ? `<circle cx="764" cy="260" r="130" fill="${color}" stroke="#0B0F17" stroke-width="40"/>`
      : '';
  $('#favicon').href = `data:image/svg+xml,${encodeURIComponent(logoSVG('tab', badge))}`;
  const head = [c.waiting && t('{n} waiting', { n: c.waiting }), c.unread && t('{n} done', { n: c.unread })].filter(Boolean).join(' · ');
  document.title = head ? `(${head}) Beeplight` : c.doing ? t('{n} running · Beeplight', { n: c.doing }) : 'Beeplight';
}

function renderLive() {
  const el = $('#live');
  const fresh = Date.now() - lastMetaAt < 2500;
  el.className = `live ${fresh ? 'on' : 'off'}`;
  $('span', el).textContent = fresh && meta ? t('Live · {hz}/s', { hz: meta.hz.toFixed(1) }) : t('Disconnected, reconnecting…');
}

function renderFoot() {
  const parts = [];
  const n1 = snapshot.idleCount;
  if (n1) parts.push(n1 === 1 ? t('1 empty session not shown') : t('{n} empty sessions not shown', { n: n1 }));
  const n2 = snapshot.staleCount;
  if (n2) parts.push(n2 === 1 ? t('1 session inactive for 12+ hours not shown') : t('{n} sessions inactive for 12+ hours not shown', { n: n2 }));
  const sdkHidden = !prefs.sdk && snapshot.sessions.filter((v) => v.sdk).length;
  if (sdkHidden) parts.push(sdkHidden === 1 ? t('1 SDK session hidden') : t('{n} SDK sessions hidden', { n: sdkHidden }));
  if (meta?.summarizer && meta.titles !== 'original') {
    const s = meta.summarizer;
    let line = t('Titles and results by Haiku: {ok} done', { ok: s.ok });
    if (s.inflight || s.queued) line += t(', {inflight} in progress, {queued} queued', { inflight: s.inflight, queued: s.queued });
    if (s.failed) line += t(', {failed} failed', { failed: s.failed });
    parts.push(line);
  }
  const self = meta?.usage?.limits?.self;
  if (self?.calls) parts.push(t('Haiku calls by Beeplight today: {n}, ≈{cost}', { n: self.calls, cost: usd(self.cost || 0) }));
  parts.push(t('Done keeps tasks from the last 12 hours'));
  $('#foot').textContent = parts.join(' · ');
}

// CPU use of the Mac, Claude and Beeplight, as shares of the whole Mac (meta.cpu, src/core/cpu.js).
function renderCpu() {
  const c = meta?.cpu;
  const el = $('#cpu');
  const text = c ? t('CPU · This Mac {total} · Claude {claude} · Beeplight {beeplight}', { total: pct(c.total), claude: pct(c.claude), beeplight: pct(c.beeplight) }) : '';
  const title = c ? t('Average over the last {sec} sec, as a share of the whole Mac ({cores} cores). Claude: every session and the commands it runs. Beeplight: the app, its service and its Haiku calls.', { sec: c.sec, cores: c.cores }) : '';
  if (el.textContent !== text) el.textContent = text;
  if (el.title !== title) el.title = title;
}

function updateElapsed() {
  const now = Date.now();
  const clock = $('#amb-clock');
  if (clock) clock.textContent = new Date(now).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
  for (const el of document.querySelectorAll('.elapsed[data-t]')) {
    el.textContent = elapsedText(el.dataset.mode, Number(el.dataset.t), now);
  }
  // A real prompt left waiting longer than URGENT_MS turns red.
  for (const el of document.querySelectorAll('.card.s-waiting[data-kind="prompt"]')) {
    const t = Number(el.querySelector('.elapsed')?.dataset.t);
    el.classList.toggle('urgent', t > 0 && now - t > URGENT_MS);
  }
  const byId = new Map(snapshot.sessions.map((v) => [v.id, v]));
  for (const el of document.querySelectorAll('.strip[data-id]')) {
    const v = byId.get(el.dataset.id);
    if (v) el.innerHTML = stripHTML(v.history, now);
  }
  for (const el of document.querySelectorAll('.turn[data-id]')) {
    const v = byId.get(el.dataset.id);
    if (v) el.textContent = turnStats(v, now);
  }
}

function clock(ms, withDay) {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return withDay ? `${d.toLocaleDateString(LOCALE, { weekday: 'short' })} ${hm}` : hm;
}

function level(u) {
  return u >= 0.8 ? 'hot' : u >= 0.5 ? 'warm' : 'ok';
}

function projectionText(p, w, now) {
  if (!p) return `<span class="muted">${t('Sampling; burn rate coming soon')}</span>`;
  if (!p.ratePerHour) return `<span class="muted">${t('No new usage lately')}</span>`;
  const rate = pct(p.ratePerHour);
  return p.beforeReset
    ? `<span class="hot">${t('+{rate}/hr, runs out in about {eta} (before reset)', { rate, eta: dur(p.etaMs) })}</span>`
    : `<span class="muted">${t("+{rate}/hr, won't run out before reset", { rate })}</span>`;
}

function barsHTML(values, start, end, now) {
  const max = Math.max(...values, 1e-9);
  const step = (end - start) / values.length;
  return values
    .map((v, i) => {
      const future = start + i * step > now;
      const h = v > 0 ? Math.max(6, (v / max) * 100) : 0;
      return `<i class="${future ? 'future' : ''}" style="height:${h.toFixed(0)}%" title="≈${usd(v)}"></i>`;
    })
    .join('');
}

// Time marks under the bars: each hour of a 5-hour window, each day of a week (named in the
// middle of the day, ticks at midnight). Same marks as UsageAxis in desktop/Sources/Quota.swift.
function axisHTML(start, end, days) {
  const at = (ms) => ((ms - start) / (end - start)) * 100;
  const ticks = [];
  const labels = [];
  const d = new Date(start);
  if (days) {
    d.setHours(0, 0, 0, 0);
    while (+d < end) {
      const a = Math.max(+d, start);
      d.setDate(d.getDate() + 1);
      const b = Math.min(+d, end);
      // Only days mostly in the window get a name; a sliver at either end stays blank.
      if (b - a >= 12 * 3600e3) labels.push([at((a + b) / 2), new Date(a).toLocaleDateString(LOCALE, { weekday: 'short' })]);
      if (+d < end) ticks.push(at(+d));
    }
  } else {
    d.setMinutes(0, 0, 0);
    for (d.setHours(d.getHours() + 1); +d < end; d.setHours(d.getHours() + 1)) {
      const x = at(+d);
      // Any closer to an edge and the label sticks out of the card.
      if (x > 4 && x < 96) {
        ticks.push(x);
        labels.push([x, clock(+d)]);
      }
    }
  }
  return (
    ticks.map((x) => `<i style="left:${x.toFixed(2)}%"></i>`).join('') +
    labels.map(([x, s]) => `<span style="left:${x.toFixed(2)}%">${esc(s)}</span>`).join('')
  );
}

function quotaCard(key, name, w, local, win, buckets, now, withDay) {
  const u = w?.utilization;
  const head = w
    ? `<b class="q-pct ${level(u)}">${pct(u)}</b><span class="q-reset">${t('Resets {time} · {left} left', { time: clock(w.resetsAt, withDay), left: dur(w.resetsAt - now) })}</span>`
    : `<b class="q-pct">—</b><span class="q-reset">${t('No limit data yet')}</span>`;
  return `<div class="q-card q-open" data-window="${key}" role="button" tabindex="0" title="${esc(t('Show details: usage at finer or coarser steps, the limit over time, and where it went'))}">
  <div class="q-title">${name}<span class="q-more">${t('Details ›')}</span></div>
  <div class="q-head">${head}</div>
  <div class="q-bar"><i class="${level(u || 0)}" style="width:${Math.min(100, (u || 0) * 100).toFixed(1)}%"></i></div>
  <div class="q-proj">${w ? projectionText(w.projection, w, now) : ''}</div>
  <div class="q-local" title="${esc(t("Usage in this Mac's transcripts within this window (subagents included); claude.ai on the web and other devices aren't counted"))}">${t('This Mac: {tokens} tokens · {out} output · {cr} cache read · ≈{cost}', { tokens: fmtTokens(local.tokens), out: fmtTokens(local.out), cr: fmtTokens(local.cr), cost: usd(local.cost) })}</div>
  <div class="q-bars">${barsHTML(buckets, win.start, win.end, now)}</div>
  <div class="q-axis">${axisHTML(win.start, win.end, withDay)}</div>
</div>`;
}

function renderQuota() {
  const u = meta?.usage;
  const el = $('#quota');
  if (!u) return;
  const now = meta.now;
  const L = u.limits || {};
  const top = (u.top || [])
    .slice(0, 6)
    .map(
      (r, i) => `<li data-id="${esc(r.sid)}" title="${esc(`${r.project} · ${requestsText(r.requests)} · ≈${usd(r.cost)}`)}">
  <span class="t-rank">${i + 1}</span><span class="t-name">${esc(r.title)}${r.live ? `<em>${t('Live')}</em>` : ''}</span>
  <span class="t-tok">${fmtTokens(r.tokens)}</span><span class="t-share">${r.share != null ? `≈${pct(r.share)}` : usd(r.cost)}</span>
  <span class="t-bar"><i style="width:${Math.min(100, ((r.share ?? 0) / Math.max(L.sevenDay?.utilization || 0, 1e-9)) * 100).toFixed(1)}%"></i></span>
</li>`,
    )
    .join('');
  const note = L.error
    ? `<span class="hot">${t("Couldn't get limits: {error}", { error: esc(L.error) })}</span>`
    : L.probing
      ? t('Refreshing limits…')
      : L.at
        ? t('Limits updated {time}', { time: clock(L.at) })
        : '';
  const html = `${quotaCard('5h', t('5-hour limit'), L.fiveHour, u.fiveHour, u.windows.fiveHour, u.buckets5h, now, false)}
${quotaCard('7d', t('Weekly limit'), L.sevenDay, u.sevenDay, u.windows.sevenDay, u.buckets7d, now, true)}
<div class="q-card q-top">
  <div class="q-title">${t('Top sessions this week')} <span class="muted">${t('share of weekly limit (est.)')}</span></div>
  <ol>${top || `<li class="muted">${t('No usage this week yet')}</li>`}</ol>
  <div class="q-note">${note} · <button class="linkish" data-act="refresh-limits">${t('Refresh limits')}</button></div>
</div>`;
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

// ---------- limit details (a click on a limit card) ----------
// The service builds them on request (GET /api/usage/detail, src/core/usage-detail.js), so they
// are fetched only while open. Same content as desktop/Sources/QuotaDetail.swift.

const STEP_NAMES = { '10m': '10 min', '30m': '30 min', '1h': '1 hour', '6h': '6 hours', '1d': '1 day' };
// window: '5h' | '7d' while open; hover: the start of the bar under the pointer.
const qd = { window: null, detail: null, error: null, hover: null, timer: 0 };

function openDetail(window) {
  qd.window = window;
  qd.detail = null;
  qd.hover = null;
  $('#qd').hidden = false;
  document.documentElement.classList.add('qd-open');
  renderDetail();
  loadDetail();
  clearInterval(qd.timer);
  qd.timer = setInterval(loadDetail, 15000);
}

function closeDetail() {
  qd.window = null;
  clearInterval(qd.timer);
  $('#qd').hidden = true;
  document.documentElement.classList.remove('qd-open');
}

async function loadDetail() {
  const w = qd.window;
  if (!w) return;
  const step = prefs.detailSteps?.[w];
  const q = new URLSearchParams({ window: w });
  if (step) q.set('step', step);
  const r = await fetch(`/api/usage/detail?${q}`, { headers: authHeaders() }).catch((e) => ({ ok: false, error: e }));
  // A size this service no longer offers: fall back to its default.
  if (r.status === 400 && step) {
    delete prefs.detailSteps[w];
    savePrefs();
    return loadDetail();
  }
  const d = r.ok ? await r.json().catch(() => null) : null;
  if (qd.window !== w) return;
  qd.error = d ? null : t("Couldn't load: {error}", { error: r.error?.message || r.status || '?' });
  if (d) qd.detail = d;
  renderDetail();
}

// Charts are SVG stretched to the box (preserveAspectRatio="none"), with HTML labels on top so text
// keeps its shape: x across 0–1000, y down 0–100.
const PLOT_W = 1000;
const PLOT_H = 100;

function detailX(d, ms) {
  return ((ms - d.range.start) / (d.range.end - d.range.start)) * PLOT_W;
}

function lineChart(d) {
  const pts = d.utilization;
  const color = d.limit ? level(d.limit.utilization) : 'ok';
  // From the last reading at the current rate, until the limit is used up or the window resets.
  const rate = d.limit?.projection?.ratePerHour;
  const last = pts[pts.length - 1];
  const trend = [];
  if (rate > 0 && last) {
    const end = Math.min(d.range.end, last.t + ((1 - last.u) / rate) * 3600e3);
    if (end > last.t) trend.push(last, { t: end, u: Math.min(1, last.u + (rate * (end - last.t)) / 3600e3) });
  }
  const peak = Math.max(0, ...pts.map((p) => p.u), ...trend.map((p) => p.u));
  // Room above the line; the whole limit once it gets close.
  const top = peak > 0.7 ? 1 : Math.max(0.2, Math.min(1, peak * 1.3));
  const y = (u) => PLOT_H - (u / top) * PLOT_H;
  const path = (list) => list.map((p, i) => `${i ? 'L' : 'M'}${detailX(d, p.t).toFixed(1)} ${y(p.u).toFixed(1)}`).join('');
  const ticks = [0, top / 2, top];
  const svg = `<svg viewBox="0 0 ${PLOT_W} ${PLOT_H}" preserveAspectRatio="none" class="qd-svg ${color}">
  ${ticks.map((v) => `<line class="grid" x1="0" x2="${PLOT_W}" y1="${y(v)}" y2="${y(v)}"/>`).join('')}
  ${top >= 1 ? `<line class="limit" x1="0" x2="${PLOT_W}" y1="0" y2="0"/>` : ''}
  ${pts.length ? `<path class="area" d="${path(pts)}L${detailX(d, last.t).toFixed(1)} ${PLOT_H}L${detailX(d, pts[0].t).toFixed(1)} ${PLOT_H}Z"/><path class="line" d="${path(pts)}"/>` : ''}
  ${trend.length ? `<path class="trend" d="${path(trend)}"/>` : ''}
  <line class="now" x1="${detailX(d, d.now)}" x2="${detailX(d, d.now)}" y1="0" y2="${PLOT_H}"/>
</svg>`;
  const yLabels = ticks.map((v) => `<span style="top:${((y(v) / PLOT_H) * 100).toFixed(1)}%">${pct(v)}</span>`).join('');
  return `<div class="qd-plot"><div class="qd-y">${yLabels}</div><div class="qd-area">${svg}${pts.length ? '' : `<p class="qd-empty">${t('No readings in this window yet')}</p>`}</div></div>
<div class="qd-x q-axis">${axisHTML(d.range.start, d.range.end, d.window === '7d')}</div>`;
}

function barChart(d) {
  const shown = d.buckets.filter((b) => b.start <= d.now);
  const max = Math.max(...shown.map((b) => b.cost), 1e-9);
  const bars = shown
    .map((b) => {
      const pad = (b.end - b.start) * 0.08;
      const x = detailX(d, b.start + pad);
      const h = b.cost > 0 ? Math.max(1.5, (b.cost / max) * PLOT_H) : 0;
      return `<rect data-start="${b.start}" class="${qd.hover === b.start ? 'on' : ''}" x="${x.toFixed(1)}" width="${(detailX(d, b.end - pad) - x).toFixed(1)}" y="${(PLOT_H - h).toFixed(1)}" height="${h.toFixed(1)}"/>`;
    })
    .join('');
  const yLabels = [0, max / 2, max].map((v) => `<span style="top:${(100 - (v / max) * 100).toFixed(1)}%">${usd(v)}</span>`).join('');
  return `<div class="qd-plot" data-qd-bars><div class="qd-y">${yLabels}</div><div class="qd-area"><svg viewBox="0 0 ${PLOT_W} ${PLOT_H}" preserveAspectRatio="none" class="qd-svg">
  ${[0, PLOT_H / 2, PLOT_H].map((v) => `<line class="grid" x1="0" x2="${PLOT_W}" y1="${v}" y2="${v}"/>`).join('')}
  ${bars}
  <line class="now" x1="${detailX(d, d.now)}" x2="${detailX(d, d.now)}" y1="0" y2="${PLOT_H}"/>
</svg></div></div>
<div class="qd-x q-axis">${axisHTML(d.range.start, d.range.end, d.window === '7d')}</div>`;
}

/** Under the bars: the one under the pointer, or how to get one. */
function hoverHTML(d) {
  const b = d.buckets.find((x) => x.start === qd.hover);
  if (!b) return `<span class="muted">${t('Point at or tap a bar to see what went into it')}</span>`;
  const top = b.top.length ? `<div class="muted">${t('Most used by: {list}', { list: esc(b.top.map((x) => x.title).join(', ')) })}</div>` : '';
  return `<div><b>${clock(b.start, d.window === '7d')}–${clock(b.end)}</b> ${t('{tokens} tokens · {out} output · ≈{cost} · {requests}', { tokens: fmtTokens(b.tokens), out: fmtTokens(b.out), cost: usd(b.cost), requests: requestsText(b.requests) })}</div>${top}`;
}

function shareRow(name, note, value, fraction, cls = '', attrs = '') {
  return `<li class="${cls}" ${attrs}><div class="qd-row"><span class="qd-name">${name}</span>${note ? `<span class="qd-note">${note}</span>` : ''}<span class="qd-val">${value}</span></div><span class="qd-bar"><i style="width:${(Math.min(1, fraction) * 100).toFixed(1)}%"></i></span></li>`;
}

function breakdowns(d) {
  const T = d.total;
  const part = (c) => (T.cost > 0 ? c / T.cost : 0);
  // The limit share when there is a limit reading, else the API-equivalent amount.
  const amount = (c) => (d.limit && T.cost > 0 ? `≈${pct((c / T.cost) * d.limit.utilization)}` : `≈${usd(c)}`);
  const none = `<li class="muted">${t('No usage in this window yet')}</li>`;
  const models = d.models.map((m) => shareRow(esc(m.model), requestsText(m.requests), `${fmtTokens(m.tokens)} · ${pct(part(m.cost))}`, part(m.cost))).join('');
  const kinds = [
    [t('Input'), T.in, 'k-in'],
    [t('Output'), T.out, 'k-out'],
    [t('Cache write'), T.cw, 'k-cw'],
    [t('Cache read'), T.cr, 'k-cr'],
  ]
    .map(([name, n, cls]) => shareRow(name, '', `${fmtTokens(n)} · ${pct(T.tokens ? n / T.tokens : 0)}`, T.tokens ? n / T.tokens : 0, cls))
    .join('');
  const projects = d.projects
    .map((p) => shareRow(esc(p.project || '—'), t('Sessions: {n}', { n: p.sessions }), `${fmtTokens(p.tokens)} · ${amount(p.cost)}`, part(p.cost)))
    .join('');
  const sessions = d.sessions
    .map((s) =>
      shareRow(`${esc(s.title)}${s.live ? `<em>${t('Live')}</em>` : ''}`, esc(s.project), `${fmtTokens(s.tokens)} · ${amount(s.cost)}`, part(s.cost), 'qd-link', `data-id="${esc(s.sid)}"`),
    )
    .join('');
  const card = (title, hint, rows) => `<section class="qd-card"><div class="qd-title">${title}${hint ? ` <span class="muted">${hint}</span>` : ''}</div><ul class="qd-list">${rows || none}</ul></section>`;
  return `<div class="qd-grid">
${card(t('Models'), '', models)}
${card(t('Token types'), '', T.tokens ? kinds : '')}
${card(t('Projects'), '', projects)}
${card(t('Sessions'), t('Click to jump to one'), sessions)}
</div>`;
}

function renderDetail() {
  if (!qd.window) return;
  const d = qd.detail?.window === qd.window ? qd.detail : null;
  const tabs = ['5h', '7d']
    .map((w) => `<button data-qd-window="${w}" class="${w === qd.window ? 'on' : ''}">${w === '5h' ? t('5-hour limit') : t('Weekly limit')}</button>`)
    .join('');
  const step = d && (prefs.detailSteps?.[d.window] || d.step);
  const steps = d
    ? `<div class="qd-seg" title="${esc(t('Size of each bar'))}">${d.steps.map((s) => `<button data-qd-step="${s}" class="${s === step ? 'on' : ''}">${t(STEP_NAMES[s] || s)}</button>`).join('')}</div>`
    : '';
  let body = qd.error ? `<p class="hot">${esc(qd.error)}</p>` : `<p class="muted">${t('Loading…')}</p>`;
  if (d) {
    const w = d.limit;
    const head = w
      ? `<b class="q-pct ${level(w.utilization)}">${pct(w.utilization)}</b><div><div class="q-reset">${t('Resets {time} · {left} left', { time: clock(w.resetsAt, d.window === '7d'), left: dur(w.resetsAt - d.now) })}</div><div class="q-proj">${projectionText(w.projection, w, d.now)}</div></div>`
      : `<b class="q-pct">—</b><div class="q-reset">${t('No limit data yet')}</div>`;
    body = `<div class="qd-summary">${head}<div class="qd-local">${t('This Mac: {tokens} tokens · {out} output · {cr} cache read · ≈{cost}', { tokens: fmtTokens(d.total.tokens), out: fmtTokens(d.total.out), cr: fmtTokens(d.total.cr), cost: usd(d.total.cost) })}<br>${requestsText(d.total.requests)}</div></div>
<section class="qd-card"><div class="qd-title">${t('Limit used')} <span class="muted">${t("Readings from Anthropic's servers; the dashed line follows the current rate until the reset")}</span></div>${lineChart(d)}</section>
<section class="qd-card"><div class="qd-title">${t('Usage on this Mac')} <span class="muted">${t('Weighted by API prices, a rough stand-in for how limits count')}</span></div>${barChart(d)}<div class="qd-hover" id="qd-hover">${hoverHTML(d)}</div></section>
${breakdowns(d)}`;
  }
  const html = `<div class="qd-head"><div class="qd-seg">${tabs}</div>${steps}<button class="qd-close" data-qd-close aria-label="${esc(t('Close'))}">×</button></div>${body}`;
  const el = $('#qd .qd');
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

/** The bar under the pointer, without rebuilding the dialog. */
function setHover(start) {
  if (qd.hover === start || !qd.detail) return;
  qd.hover = start;
  for (const r of document.querySelectorAll('#qd rect')) r.classList.toggle('on', Number(r.dataset.start) === start);
  $('#qd-hover').innerHTML = hoverHTML(qd.detail);
  // Keep renderDetail() from redrawing what is already on screen.
  $('#qd .qd')._html = null;
}

function bucketAt(e) {
  const area = e.target.closest('[data-qd-bars]')?.querySelector('.qd-area');
  const d = qd.detail;
  if (!area || !d) return null;
  const box = area.getBoundingClientRect();
  const ms = d.range.start + ((e.clientX - box.left) / box.width) * (d.range.end - d.range.start);
  return d.buckets.find((b) => b.start <= ms && ms < b.end && b.start <= d.now)?.start ?? null;
}

$('#qd').addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && e.target.closest('[data-qd-bars]')) setHover(bucketAt(e));
});
$('#qd').addEventListener('click', (e) => {
  if (e.target === e.currentTarget || e.target.closest('[data-qd-close]')) return closeDetail();
  const w = e.target.closest('[data-qd-window]')?.dataset.qdWindow;
  if (w && w !== qd.window) return openDetail(w);
  const step = e.target.closest('[data-qd-step]')?.dataset.qdStep;
  if (step && qd.detail) {
    prefs.detailSteps = { ...prefs.detailSteps, [qd.detail.window]: step };
    savePrefs();
    qd.hover = null;
    renderDetail();
    return loadDetail();
  }
  // A tap on the bars, where there is no pointer to follow.
  if (e.target.closest('[data-qd-bars]')) return setHover(bucketAt(e));
  const row = e.target.closest('li[data-id]');
  if (row) act(row.dataset.id, 'focus');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && qd.window) closeDetail();
});

// ---------- status screen (phone as a second display) ----------

const touchDevice = matchMedia('(pointer: coarse)').matches;
const viewDefault = () => (!IS_LOCAL || touchDevice || MOBILE.matches ? 'ambient' : 'board');
const currentView = () => prefs.view || viewDefault();
const ambOpen = new Set();
const ambKept = new Set(); // new finishes tapped open: read, but kept on the list while open

function applyView() {
  const amb = currentView() === 'ambient';
  // On <html> too: the iOS home-screen app shows the root background below the page.
  document.documentElement.classList.toggle('mode-ambient', amb);
  document.body.classList.toggle('mode-ambient', amb);
  $('#ambient').hidden = !amb;
  // On the Mac too: the status screen is the pared-down view, e.g. for a second display.
  $('#amb-on').hidden = amb;
}

// Which of your other devices a synced task runs on, and whether it is reachable.
function deviceChip(r) {
  const label = r.online ? r.name : t('{device} · offline', { device: r.name });
  return `<span class="chip device${r.online ? '' : ' offline'}" title="${esc(t('Runs on another device; synced through your relay'))}">${esc(label)}</span>`;
}

function ambRowHTML(v, past) {
  const mode = v.state === 'waiting' ? 's-wait' : v.state === 'doing' ? 's-run' : 's-ago';
  const t0 = v.state === 'doing' ? v.turnStartedAt || v.since : v.since;
  const detail = v.state === 'doing' ? v.detail || t('Thinking…') : v.detail || v.label;
  const open = ambOpen.has(v.id);
  return `<li class="amb-row ${stateClass(v)}${v.unread ? ' unread' : ''}${open ? ' open' : ''}${past ? ' past' : ''}${v.remote ? ' remote' : ''}" data-id="${esc(v.id)}">
  <span class="amb-glyph"></span>
  <div class="amb-text"><b>${esc(v.title)}</b><small>${esc(detail)}</small></div>
  <span class="amb-time elapsed" data-mode="${mode}" data-t="${t0 || ''}"></span>
  <div class="amb-more">${v.goal ? `<p>${esc(v.goal)}</p>` : ''}${v.remote ? deviceChip(v.remote) : `<button data-act="focus">${t('Open on Mac')}</button>`}</div>
</li>`;
}

function renderAmbient(waiting, doing, doneAll) {
  applyView();
  if (currentView() !== 'ambient') return;
  const fresh = doneAll.filter((v) => v.unread);
  let tone = 'idle';
  let state = t('Claude is idle');
  let sub = t('Nothing running or waiting for you');
  const nw = waiting.length;
  const nf = fresh.length;
  const nd = doing.length;
  if (nw) [tone, state, sub] = ['waiting', nw === 1 ? t('1 task needs you') : t('{n} tasks need you', { n: nw }), waiting[0].title];
  else if (nf)
    [tone, state, sub] = [
      fresh.some((v) => v.outcome === 'failed') ? 'failed' : 'success',
      nf === 1 ? t('1 task just finished') : t('{n} tasks just finished', { n: nf }),
      fresh[0].title,
    ];
  else if (nd) [tone, state, sub] = ['doing', nd === 1 ? t('1 task running') : t('{n} tasks running', { n: nd }), doing[0].title];
  const amb = $('#ambient');
  amb.dataset.tone = tone;
  $('#amb-state').textContent = state;
  $('#amb-sub').textContent = sub;
  // The core shows the most pressing number; its ring splits by state.
  // Lowercase keys: the caption under the number, distinct from the capitalized labels elsewhere.
  // Idle shows the Mac app's character instead (robot eyes or a drawn character, CSS keyed on
  // data-tone, data-energy and data-character); a drawn character stays for every state and the
  // number moves into the caption.
  const character = meta?.character || 'eyes';
  const figure = CHARACTERS[character];
  amb.dataset.character = character;
  amb.toggleAttribute('data-figure', !!figure);
  // Terminal text art stands on a ground line in place of the ring, and walks it.
  amb.toggleAttribute('data-text', !!figure?.text);
  const [big, bigLabel] = nw ? [nw, t('waiting')] : nf ? [nf, t('new')] : nd ? [nd, t('running')] : [character === 'classic' ? '✦' : '', idleCaption()];
  $('#amb-big').textContent = big;
  $('#amb-big-label').textContent = figure && big !== '' ? `${bigLabel} ${big}` : bigLabel;
  syncFigure(figure, tone === 'idle' ? amb.dataset.energy || 'unknown' : tone);
  renderCoreArcs([
    [waiting.length, 'var(--a-wait)'],
    [doing.length, 'var(--a-doing)'],
    [fresh.filter((v) => v.outcome === 'failed').length, 'var(--a-fail)'],
    [fresh.filter((v) => v.outcome !== 'failed').length, 'var(--a-ok)'],
  ]);
  const count = (cls, label, n) => `<span class="pill ${cls}${n ? '' : ' zero'}"><i></i>${label}<b>${n}</b></span>`;
  const counts = count('c-w', t('Waiting'), nw) + count('c-d', t('Doing'), nd) + count('c-n', t('New'), nf);
  if ($('#amb-counts')._html !== counts) {
    $('#amb-counts').innerHTML = counts;
    $('#amb-counts')._html = counts;
  }

  // Only what needs a look; when all is quiet, the last few results, dimmed. A new finish that
  // was tapped open stays, in its place, until it is closed, though the tap has read it.
  const news = doneAll
    .filter((v) => v.unread || ambKept.has(v.id))
    .sort((a, b) => (b.since || 0) - (a.since || 0) || a.id.localeCompare(b.id));
  let rows = [...waiting, ...news, ...doing];
  const past = !rows.length;
  if (past) rows = doneAll.slice(0, 3);
  const max = 6;
  const items = rows.slice(0, max).map((v) => [v.id, ambRowHTML(v, past)]);
  if (rows.length > max) items.push(['more', `<li class="amb-more-count">${t('{n} more · Tap Details to see all', { n: rows.length - max })}</li>`]);
  if (past && rows.length) items.unshift(['caption', `<li class="amb-caption">${t('Recently finished')}</li>`]);
  patchList($('#amb-list'), items);
  updateElapsed();
}

// Updates the rows in place, keyed by task: a tap or a new step on one card leaves the other
// cards' nodes alone, so their entrance animation doesn't replay.
function patchList(list, items) {
  const html = items.map(([, h]) => h).join('');
  if (list._html === html) return;
  list._html = html;
  const keys = new Set(items.map(([k]) => k));
  for (const el of [...list.children]) if (!keys.has(el._key)) el.remove();
  const old = new Map([...list.children].map((el) => [el._key, el]));
  let at = list.firstElementChild;
  for (const [key, h] of items) {
    const tpl = document.createElement('template');
    tpl.innerHTML = h;
    const next = tpl.content.firstElementChild;
    let el = old.get(key);
    if (!el) {
      el = next;
      el._key = key;
    } else if (el._src !== h) {
      el.className = next.className;
      if (el._inner !== next.innerHTML) el.innerHTML = next.innerHTML;
    }
    el._src = h;
    el._inner = next.innerHTML;
    if (el === at) at = at.nextElementSibling;
    else list.insertBefore(el, at);
  }
}

const CORE_R = 78;
const CORE_C = 2 * Math.PI * CORE_R;

function renderCoreArcs(parts) {
  const ticks = $('#core-ticks');
  if (!ticks.childElementCount) {
    let t = '';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * 2 * Math.PI;
      const r0 = i % 5 ? 89 : 86;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      t += `<line x1="${(100 + r0 * c).toFixed(2)}" y1="${(100 + r0 * s).toFixed(2)}" x2="${(100 + 93 * c).toFixed(2)}" y2="${(100 + 93 * s).toFixed(2)}"${i % 5 ? '' : ' class="major"'}/>`;
    }
    ticks.innerHTML = t;
  }
  const total = parts.reduce((n, [k]) => n + k, 0);
  const gap = total > 1 ? 7 : 0;
  let start = 0;
  let html = '';
  for (const [n, color] of parts) {
    if (!n) continue;
    const len = (n / total) * CORE_C;
    html += `<circle class="core-arc" cx="100" cy="100" r="${CORE_R}" style="color:${color}" stroke-dasharray="${Math.max(2, len - gap).toFixed(2)} ${CORE_C.toFixed(2)}" transform="rotate(${((start / CORE_C) * 360 - 90).toFixed(2)} 100 100)"/>`;
    start += len;
  }
  const arcs = $('#core-arcs');
  if (arcs._html !== html) {
    arcs.innerHTML = html;
    arcs._html = html;
  }
}

// ---------- drawn characters (characters.json, shared with the Mac app) ----------

const CHARACTERS = {};
fetch('/characters.json')
  .then((r) => r.json())
  .then((d) => {
    for (const c of d.characters || []) CHARACTERS[c.id] = c;
    if (snapshot) render();
  })
  .catch(() => {});

// How the character looks and moves: by remaining limit when idle, by task state otherwise.
// `turns`: how many times a spin character's antenna goes around when it whirls (Energy.turns in
// the Mac app); `whirl`: it whirls the whole time. A walking character strolls every `walk`
// seconds, or paces end to end the whole time (`pace`), at `speed` times its own pace.
const MOODS = {
  unknown: { open: 1, rest: [2.2, 4.5], look: 0.5, move: 0.25, turns: 2.5, walk: [2, 6], speed: 1 },
  full: { open: 1, rest: [2.2, 4.5], look: 0.5, move: 0.25, turns: 2.5, walk: [2, 6], speed: 1 },
  half: { open: 0.72, rest: [3.5, 6.5], look: 0.3, move: 0.25, turns: 1.75, walk: [5, 10], speed: 0.75 },
  low: { open: 0.46, rest: [5, 9], look: 0.12, move: 0.25, turns: 1, walk: [9, 15], speed: 0.55 },
  empty: { open: 0.18, rest: [7, 12], look: 0, move: 0 },
  doing: { open: 1, rest: [0.6, 1.4], look: 0.6, move: 0.3, whirl: true, pace: true, speed: 1.2 },
  waiting: { open: 1, rest: [0.8, 1.6], look: 0.1, move: 0.7 },
  success: { open: 1, rest: [2, 4], look: 0.2, move: 0.3, happy: true, turns: 2.5, walk: [3, 7], speed: 1 },
  failed: { open: 0.46, rest: [4, 8], look: 0.1, move: 0 },
};
const fig = { char: null, mood: 'unknown', pose: {}, timer: 0, spin: null, spinTimer: 0, walker: null, walkTimer: 0 };
const stillMotion = matchMedia('(prefers-reduced-motion: reduce)');

function syncFigure(char, mood) {
  if (!char) {
    clearTimeout(fig.timer);
    clearTimeout(fig.spinTimer);
    clearTimeout(fig.walkTimer);
    fig.char = null;
    return;
  }
  if (char === fig.char && mood === fig.mood && !fig.paused) return;
  clearTimeout(fig.timer);
  const fresh = char !== fig.char;
  if (fresh) $('#amb-figure').innerHTML = char.text ? '<pre></pre>' : figureSVG(char);
  Object.assign(fig, { char, mood });
  if (fresh) fig.walker = char.text?.walk ? { x: 0, face: char.text.walk.facing, mode: 'rest', dist: 0 } : null;
  setPose({});
  scheduleFigure();
  whirl(MOODS[mood]?.whirl ? { from: performance.now() } : null);
  walk();
}

function scheduleFigure() {
  const m = MOODS[fig.mood] || MOODS.full;
  // Paused on another view; the next status screen render starts it again.
  fig.paused = currentView() !== 'ambient';
  if (stillMotion.matches || fig.paused) return;
  const [lo, hi] = m.rest;
  fig.timer = setTimeout(figureMove, (lo + Math.random() * (hi - lo)) * 1000);
}

// A glance, the character's own move (alt frame, or a whirl of its antenna), or a blink. A whirling
// antenna skips the alt frame, whose sparks are drawn around the upright antenna. Text art has no
// glance, and its moves wait while it walks.
function figureMove() {
  const m = MOODS[fig.mood] || MOODS.full;
  if (fig.walker && fig.walker.mode !== 'rest') return scheduleFigure();
  const r = Math.random();
  const look = fig.char.text ? 0 : m.look;
  const spins = !!fig.char.spin;
  if (spins && !m.whirl && m.turns && r >= look && r < look + m.move && Math.random() < 0.5) {
    whirl({ from: performance.now(), turns: m.turns });
    return scheduleFigure();
  }
  const steps =
    r < look ? [[{ look: Math.random() < 0.5 ? -1 : 1 }, 1200]]
    : r < look + m.move && !(spins && fig.spin) ? [[{ alt: true }, 200], [{}, 200], [{ alt: true }, 200], [{}, 200], [{ alt: true }, 200]]
    : [[{ blink: 0 }, 140]];
  const play = () => {
    const step = steps.shift();
    if (!step) {
      setPose({});
      return scheduleFigure();
    }
    setPose(step[0]);
    fig.timer = setTimeout(play, step[1]);
  };
  play();
}

function setPose(p) {
  const m = MOODS[fig.mood] || MOODS.full;
  fig.pose = { blink: 1, look: 0, alt: false, ...p, happy: !!m.happy && !('blink' in p) };
  drawFigure();
}

function drawFigure() {
  const c = fig.char;
  const m = MOODS[fig.mood] || MOODS.full;
  const box = $('#amb-figure');
  if (!c.text) {
    box.querySelector('.v').innerHTML = figurePaths(fig.pose.alt ? c.alt : c.rest);
    box.querySelector('.e').setAttribute('d', eyePath(c, fig.pose, m.open));
    return;
  }
  // Terminal text art with its eyes filled in; while it walks, the frame for how far it has gone.
  const T = c.text;
  const frame = walkFrame();
  const lines = frame >= 0 ? T.walk.frames[frame] : fig.pose.alt ? T.alt || T.rest : T.rest;
  const pose = frame >= 0 ? { blink: 1, happy: fig.pose.happy } : fig.pose;
  const art = lines.join('\n').replaceAll('*', eyeGlyph(T, pose, m.open));
  const pre = box.querySelector('pre');
  if (pre.textContent !== art) pre.textContent = art;
}

// Same rules as Figure.TextArt.eyeGlyph in the Mac app: open, heavy-lidded, nearly shut as the
// limit runs out; - mid-blink, ^ when happy.
function eyeGlyph(T, pose, openness) {
  if (pose.happy) return '^';
  if (pose.blink < 0.35) return '-';
  const open = openness * pose.blink;
  return open >= 0.6 ? T.eye || 'o' : open >= 0.3 ? '~' : '_';
}

// A walking character (text art with `walk` frames) in place of the ring: rests in its usual
// drawing, now and then strolls to another spot (turning around first, so its tail trails), and
// while Claude works paces from end to end. Positions are in character widths; per frame only
// the CSS translate and scale of its <pre> change, and its text when the step does.
const TURN_MS = 360;

function walk() {
  clearTimeout(fig.walkTimer);
  const w = fig.walker;
  if (!w) return;
  const m = MOODS[fig.mood] || MOODS.full;
  if (stillMotion.matches || fig.paused || !(m.walk || m.pace) || !walkRange()) {
    if (w.mode !== 'rest') settle();
    return placeWalker();
  }
  if (m.pace) {
    if (w.mode === 'rest') stroll(w.face * walkRange());
    else w.target = Math.sign(w.target - w.x || w.face) * walkRange();
    return stepWalker();
  }
  if (w.mode !== 'rest') return stepWalker();
  placeWalker();
  const [lo, hi] = m.walk;
  fig.walkTimer = setTimeout(() => {
    // Somewhere at least a third of the way across from here.
    const r = walkRange();
    let x = (Math.random() * 2 - 1) * r;
    if (Math.abs(x - w.x) < r * 0.66) x = w.x > 0 ? x - r : x + r;
    stroll(Math.max(-r, Math.min(r, x)));
    stepWalker();
  }, (lo + Math.random() * (hi - lo)) * 1000);
}

function stroll(target) {
  const w = fig.walker;
  w.target = target;
  w.last = performance.now();
  if (Math.sign(target - w.x) === -w.face) {
    w.mode = 'turn';
    w.turnAt = w.last;
  } else w.mode = 'walk';
}

function settle() {
  fig.walker.mode = 'rest';
  drawFigure();
}

function stepWalker() {
  const w = fig.walker;
  if (!w || w.mode === 'rest') return;
  if (currentView() !== 'ambient') {
    fig.paused = true;
    return;
  }
  const m = MOODS[fig.mood] || MOODS.full;
  const now = performance.now();
  const dt = Math.min(0.1, (now - w.last) / 1000);
  w.last = now;
  if (w.mode === 'turn') {
    if (now - w.turnAt >= TURN_MS) {
      w.face = -w.face;
      w.mode = 'walk';
    }
  } else {
    const left = w.target - w.x;
    const d = Math.min(Math.abs(left), fig.char.text.walk.speed * (m.speed || 1) * dt);
    w.x += Math.sign(left) * d;
    w.dist += d;
    if (Math.abs(w.target - w.x) < 0.01) {
      if (!m.pace) {
        settle();
        return walk();
      }
      stroll(-w.face * walkRange());
    }
  }
  placeWalker();
  fig.walkTimer = setTimeout(stepWalker, 33);
}

// The walking frame for how far it has gone, or -1 at rest. Turning shows the first one.
function walkFrame() {
  const w = fig.walker;
  if (!w || w.mode === 'rest') return -1;
  const { frames, step } = fig.char.text.walk;
  return w.mode === 'turn' ? 0 : Math.floor(w.dist / step) % frames.length;
}

// Pixels per character width.
function walkUnit() {
  const pre = $('#amb-figure pre');
  return pre ? pre.offsetWidth / fig.char.text.rest[0].length : 0;
}

// How far from the middle it may go, in character widths: to the ends of the ground line.
function walkRange() {
  const u = walkUnit();
  if (!u) return 0;
  return Math.max(0, ($('#amb-figure').clientWidth - $('#amb-figure pre').offsetWidth) / 2 / u);
}

function placeWalker() {
  const w = fig.walker;
  const pre = $('#amb-figure pre');
  if (!w || !pre) return;
  const r = walkRange();
  w.x = Math.max(-r, Math.min(r, w.x));
  // As written it walks `facing`; the other way it is mirrored. Turning around, it narrows to an
  // edge and opens the other way. Every other step bobs up.
  let flip = w.face * fig.char.text.walk.facing;
  if (w.mode === 'turn') flip *= Math.cos(Math.min(1, (performance.now() - w.turnAt) / TURN_MS) * Math.PI);
  const up = w.mode === 'walk' && walkFrame() % 2 ? '-0.15em' : '0';
  pre.style.translate = `${(w.x * walkUnit()).toFixed(1)}px ${up}`;
  pre.style.scale = `${flip.toFixed(3)} 1`;
  drawFigure();
}

// The antenna of a spin character: one whirl ({from, turns}), the whole time while working
// ({from}), or upright (null). Only its transform changes, at 30 fps, while it moves.
function whirl(spin) {
  clearTimeout(fig.spinTimer);
  fig.spin = stillMotion.matches || !fig.char?.spin ? null : spin;
  const g = $('#amb-figure .s');
  const step = () => {
    let pose = { spin: 0, swing: 0 };
    const s = fig.spin;
    if (s && currentView() !== 'ambient') fig.paused = true;
    if (s && !fig.paused) {
      const t = (performance.now() - s.from) / 1000;
      if (!s.turns) pose = { spin: t / 1.1, swing: 0.8 * Math.min(1, t / 0.6) };
      else if (t < 1.6) pose = whirlAt(t / 1.6, s.turns);
      else fig.spin = null;
    } else fig.spin = null;
    g?.setAttribute('transform', spinMatrix(fig.char, pose));
    if (fig.spin) fig.spinTimer = setTimeout(step, 33);
  };
  step();
}

// Same curve as EyePose.whirl in the Mac app: leans out, goes around `turns` times, settles upright.
function whirlAt(x, turns) {
  return { spin: turns * x * x * (3 - 2 * x), swing: Math.sin(Math.PI * x) };
}

// Same as Figure.spinTransform in the Mac app: leaning up to 30° toward `spin` (in turns, 0 toward
// you), seen from a little above, around the antenna's base.
function spinMatrix(c, { spin, swing }) {
  if (!c?.spin || !swing) return '';
  const lean = (swing * Math.PI) / 6;
  const dir = spin * 2 * Math.PI;
  const k = -Math.sin(lean) * Math.sin(dir);
  const d = Math.cos(lean) - 0.35 * Math.sin(lean) * Math.cos(dir);
  const by = c.spin.base[1];
  return `matrix(1 0 ${k.toFixed(4)} ${d.toFixed(4)} ${(-k * by).toFixed(3)} ${(by * (1 - d)).toFixed(3)})`;
}

// Same geometry as Figure.eyePath in the Mac app: a vertical stroke that tired lids shorten
// from the top, a short line when shut, ^ when happy.
function eyePath(c, pose, openness) {
  const h = c.eye;
  return c.eyes
    .map(([ex, y]) => {
      const x = ex + pose.look * 1.5;
      if (pose.happy) return `M ${x - 2.2} ${y + 1} Q ${x} ${y - 2.2} ${x + 2.2} ${y + 1}`;
      if (pose.blink < 0.35) return `M ${x - 1.6} ${y + h / 2 - 0.4} H ${x + 1.6}`;
      const l = Math.max(0.9, h * openness * pose.blink);
      return `M ${x} ${y + h / 2 - l} V ${y + h / 2}`;
    })
    .join(' ');
}

function figurePaths(ds) {
  return (ds || []).map((d) => `<path d="${d}"/>`).join('');
}

// Drawn once per character; poses only swap the rest/alt group, the eyes and the antenna's transform.
function figureSVG(c) {
  return `<svg viewBox="0 0 ${c.box[0]} ${c.box[1]}">${figurePaths(c.paths)}<g class="v"></g><g class="s">${figurePaths(c.spin?.paths)}</g><path class="e"/></svg>`;
}

// The idle eyes take their color and energy from the fuller limit window, like the Mac app's.
function usedLimit(L) {
  const u = [L?.fiveHour?.utilization, L?.sevenDay?.utilization].filter((x) => typeof x === 'number');
  return u.length ? Math.max(...u) : null;
}

function energyOf(L) {
  const u = usedLimit(L);
  if (u == null) return 'unknown';
  if (L.status === 'rejected' || u >= 0.95) return 'empty';
  return u >= 0.8 ? 'low' : u >= 0.5 ? 'half' : 'full';
}

function idleCaption() {
  const u = usedLimit(meta?.usage?.limits);
  return u == null ? t('idle') : t('{p} left', { p: pct(Math.max(0, 1 - u)) });
}

function renderAmbientQuota() {
  const L = meta?.usage?.limits;
  if (!L || currentView() !== 'ambient') return;
  const amb = $('#ambient');
  amb.dataset.energy = energyOf(L);
  if (amb.dataset.tone === 'idle') $('#amb-big-label').textContent = idleCaption();
  const row = (label, w) => {
    const u = w?.utilization;
    const c = u == null ? 'var(--ink-3)' : u >= 0.8 ? 'var(--a-fail)' : u >= 0.5 ? 'var(--a-wait)' : 'var(--a-ok)';
    return `<div class="q"><span>${label}</span><i style="--p:${Math.min(100, (u || 0) * 100).toFixed(1)}%;--qc:${c}"></i><b>${pct(u)}</b></div>`;
  };
  const html = row(t('5-hour'), L.fiveHour) + row(t('Weekly'), L.sevenDay);
  const el = $('#amb-quota');
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

$('#amb-list').addEventListener('click', (e) => {
  const li = e.target.closest('.amb-row');
  if (!li) return;
  const btn = e.target.closest('button[data-act]');
  if (btn) return act(li.dataset.id, btn.dataset.act);
  // A tap reads a new finish and opens the row; another tap closes it.
  const id = li.dataset.id;
  if (li.classList.contains('unread') && !li.classList.contains('remote')) {
    act(id, 'read');
    ambKept.add(id);
  }
  if (ambOpen.has(id)) {
    ambOpen.delete(id);
    ambKept.delete(id);
  } else ambOpen.add(id);
  render();
});

$('#amb-switch').addEventListener('click', () => {
  prefs.view = 'board';
  savePrefs();
  render();
});

function renderToday() {
  const day = meta?.today;
  if (!day) return;
  const items = [`<b>${t('Today')}</b>`, `<span class="t-ok">${t('✓ {n} done', { n: day.done })}</span>`];
  if (day.failed) items.push(`<span class="t-fail">${t('✕ {n} failed', { n: day.failed })}</span>`);
  items.push(`<span class="t-work">${t('Claude worked {t}', { t: dur(day.workMs) })}</span>`);
  const wait =
    day.longestWaitMs >= 1000
      ? t('Waited for you {t} (longest {max})', { t: dur(day.waitMs), max: dur(day.longestWaitMs) })
      : t('Waited for you {t}', { t: dur(day.waitMs) });
  items.push(`<span class="t-wait">${wait}</span>`);
  $('#today').innerHTML = items.join('');
}

// Returns ids whose state changed since the last render, and fires desktop notifications.
function trackTransitions(list) {
  const changed = new Set();
  for (const v of list) {
    const key = stateKey(v);
    const prev = seenKey.get(v.id);
    seenKey.set(v.id, key);
    if (firstRender) {
      notifiedKey.set(v.id, key);
      continue;
    }
    if (prev !== undefined && prev !== key) changed.add(v.id);
    // Wait for the verdict before announcing a finish, so one turn end = one notification.
    if (v.pending || notifiedKey.get(v.id) === key) continue;
    if (key === 'doing') {
      notifiedKey.set(v.id, key);
      continue;
    }
    notifiedKey.set(v.id, key);
    if (prev !== undefined || v.state === 'waiting') notify(v);
  }
  return changed;
}

function notify(v) {
  // Plain-HTTP LAN pages cannot show system notifications: banner + vibration while open.
  if (!window.isSecureContext || !('Notification' in window)) {
    const head = v.state === 'waiting' ? t('Needs you: {title}', { title: v.title }) : v.outcome === 'failed' ? t('Failed: {title}', { title: v.title }) : t('Done: {title}', { title: v.title });
    if (document.visibilityState === 'visible') {
      toast(head);
      navigator.vibrate?.([120, 60, 120]);
    }
    return;
  }
  if (!prefs.notify || Notification.permission !== 'granted') return;
  const head = v.state === 'waiting' ? t('Needs you: {title}', { title: v.title }) : v.outcome === 'failed' ? t('Failed: {title}', { title: v.title }) : t('Done: {title}', { title: v.title });
  const n = new Notification(head, {
    body: [v.label, v.detail].filter(Boolean).join(' · '),
    tag: v.id,
  });
  n.onclick = () => {
    window.focus();
    act(v.id, 'focus');
    n.close();
  };
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function act(id, action) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'x-beeplight': '1', ...authHeaders() },
    });
    const r = await res.json();
    if (action === 'focus') toast(r.ok ? t('Switched to {how}', { how: r.how }) : t("Couldn't jump: {error}", { error: r.error || res.status }));
    else if (action === 'resummarize') toast(r.ok ? t('Queued to summarize again') : t('Nothing to summarize in this session'));
    else if (action === 'dismiss' && r.ok) toast(t('Removed from board'));
  } catch (e) {
    toast(t('Request failed: {error}', { error: e.message }));
  }
}

$('#quota').addEventListener('click', async (e) => {
  if (e.target.closest('[data-act="refresh-limits"]')) {
    toast(t('Refreshing limits…'));
    const r = await fetch('/api/limits/refresh', { method: 'POST', headers: { 'x-beeplight': '1', ...authHeaders() } })
      .then((x) => x.json())
      .catch(() => null);
    toast(r?.ok ? t('Limits refreshed') : t('Refresh failed: {error}', { error: r?.error || t('Request failed') }));
    return;
  }
  const row = e.target.closest('li[data-id]');
  if (row) return act(row.dataset.id, 'focus');
  const card = e.target.closest('.q-open');
  if (card) openDetail(card.dataset.window);
});
$('#quota').addEventListener('keydown', (e) => {
  const card = e.target.closest('.q-open');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    openDetail(card.dataset.window);
  }
});

$('#read-all').addEventListener('click', async () => {
  await fetch('/api/read-all', { method: 'POST', headers: { 'x-beeplight': '1', ...authHeaders() } }).catch(() => null);
  toast(t('Marked all read'));
});

board.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const btn = e.target.closest('button[data-act]');
  if (btn) return act(card.dataset.id, btn.dataset.act);
  if (card.classList.contains('remote')) return card.classList.toggle('expanded');
  // On a phone, a tap reads the task (or shows its last request); jumping a Mac window is a button.
  if (!IS_LOCAL || MOBILE.matches) {
    if (card.classList.contains('unread')) act(card.dataset.id, 'read');
    else card.classList.toggle('expanded');
    return;
  }
  act(card.dataset.id, 'focus');
});

// Phone layout: one list at a time. Until the user picks one, show the most pressing.
let mobileTab = null;
function renderTabs(w, d, done, fresh) {
  const tabs = $('#mtabs');
  const set = (k, n, hot) => {
    const b = tabs.querySelector(`[data-tab="${k}"] b`);
    b.textContent = n || '';
    b.className = hot ? 'hot' : '';
  };
  set('waiting', w, w > 0);
  set('doing', d, false);
  set('done', fresh ? t('{n} new', { n: fresh }) : done, fresh > 0);
  const tab = mobileTab || (w ? 'waiting' : fresh ? 'done' : d ? 'doing' : 'done');
  board.dataset.tab = tab;
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
}
$('#mtabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  mobileTab = b.dataset.tab;
  render();
});

board.addEventListener('keydown', (e) => {
  const card = e.target.closest?.('.card');
  if (card && e.key === 'Enter' && e.target === card) act(card.dataset.id, 'focus');
});

$('#amb-on').addEventListener('click', () => {
  prefs.view = 'ambient';
  savePrefs();
  render();
});
applyView();

// ---------- themes (public/themes.json, presets.json; format in docs/packs.md) ----------
// The menu lists the presets; each picks a theme and motion. The service inlines both packs into
// the page (#packs), so the look is there before anything is fetched.

const PACKS = (() => {
  try {
    return JSON.parse($('#packs').textContent || '{}');
  } catch {
    return {};
  }
})();
const THEMES = new Map((PACKS.themes?.themes || []).map((th) => [th.id, th]));
const PRESETS = (PACKS.presets?.presets || []).filter((p) => THEMES.has(p.theme));

/** A pack color for CSS. System colors (system:…, primary) stay with the page's own light and dark defaults. */
function cssColor(v) {
  const m = /^#([0-9a-f]{6})(?:@([\d.]+))?$/i.exec(v || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return m[2] === undefined ? `#${m[1]}` : `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / ${Number(m[2])})`;
}

let themeProps = [];
function applyPreset(id) {
  const root = document.documentElement;
  for (const p of themeProps) root.style.removeProperty(p);
  themeProps = [];
  const set = (prop, value) => {
    if (!value) return;
    root.style.setProperty(prop, value);
    themeProps.push(prop);
  };
  const preset = PRESETS.find((p) => p.id === id);
  const theme = THEMES.get(preset?.theme) || {};
  const c = theme.colors || {};
  set('--bg', cssColor(c.backdrop));
  set('--panel', cssColor(c.column));
  set('--card', cssColor(c.card));
  set('--text', cssColor(c.text));
  for (const s of ['doing', 'waiting', 'success', 'failed']) set(`--${s}`, cssColor(c[s]));
  if (typeof theme.corner === 'number') set('--radius', `${theme.corner}px`);
  // Colors only the page uses: shadowHover → --shadow-hover.
  for (const [k, v] of Object.entries(theme.web || {})) set(`--${k.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`, v);
  if (theme.scheme === 'dark' || theme.scheme === 'light') set('color-scheme', theme.scheme);
  root.dataset.font = theme.font || 'default';
  root.dataset.glow = (theme.glow || 0) >= 8 ? 'strong' : 'none';
  root.dataset.effects = (theme.effects || []).join(' ');
  root.dataset.motion = preset?.motion || 'full';
}

const optSkin = $('#opt-skin');
for (const p of PRESETS) optSkin.add(new Option(p.name?.[LANG] || p.name?.en || p.id, p.id));
const applySkin = () => {
  // A preset that is gone falls back to the native one.
  if (!PRESETS.some((p) => p.id === prefs.skin)) prefs.skin = 'native';
  applyPreset(prefs.skin);
  optSkin.value = prefs.skin;
};
applySkin();
optSkin.addEventListener('change', () => {
  prefs.skin = optSkin.value;
  savePrefs();
  applySkin();
  render();
});

if (!IS_LOCAL && !TOKEN) $('#pairing').hidden = false;

// Pairing by the 6-digit code shown on the Mac — the way in for a home-screen app, which has
// its own storage and cannot use the camera over HTTP.
$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pair-pin').value.replace(/\D/g, '');
  const msg = $('#pair-msg');
  if (pin.length !== 6) return (msg.textContent = t('Enter all 6 digits'));
  msg.textContent = t('Pairing…');
  const r = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'x-beeplight': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  })
    .then((x) => x.json())
    .catch(() => null);
  if (!r?.ok) return (msg.textContent = r?.error || t("Can't reach the Mac. Check the network."));
  try {
    localStorage.setItem('beeplight-token', r.token);
  } catch {}
  location.replace(`/?t=${encodeURIComponent(r.token)}`);
});

// Full screen: the Fullscreen API where it exists (Android Chrome, iPad); iPhone Safari only
// allows it for video, so there the way is a home-screen web app, which opens without browser UI.
const fsBtn = $('#fs-btn');
const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone;
const touch = matchMedia('(pointer: coarse)').matches;
fsBtn.hidden = standalone || !(touch || !IS_LOCAL);
fsBtn.addEventListener('click', async () => {
  const el = document.documentElement;
  if (document.fullscreenElement) return document.exitFullscreen();
  if (el.requestFullscreen && document.fullscreenEnabled) {
    try {
      await el.requestFullscreen({ navigationUI: 'hide' });
    } catch (e) {
      toast(t("Can't go full screen: {error}", { error: e.message }));
    }
  } else if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
  } else {
    toast(t('On iPhone: in Safari, tap Share → Add to Home Screen, then open it from the Home Screen for full screen'));
  }
});
document.addEventListener('fullscreenchange', () => {
  fsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
  fsBtn.title = document.fullscreenElement ? t('Exit full screen') : t('Full screen');
});
if (!window.isSecureContext) $('#opt-notify').closest('label').hidden = true;

const optNotify = $('#opt-notify');
const optSdk = $('#opt-sdk');
optNotify.checked = prefs.notify && 'Notification' in window && Notification.permission === 'granted';
optSdk.checked = prefs.sdk;

optNotify.addEventListener('change', async () => {
  if (optNotify.checked && 'Notification' in window && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') {
      optNotify.checked = false;
      toast(t("The browser didn't grant notification permission"));
    }
  }
  prefs.notify = optNotify.checked;
  savePrefs();
});

optSdk.addEventListener('change', () => {
  prefs.sdk = optSdk.checked;
  savePrefs();
  render();
});

const seg = $('#done-filter');
const syncSeg = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === prefs.doneFilter));
syncSeg();
seg.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  prefs.doneFilter = b.dataset.f;
  savePrefs();
  syncSeg();
  render();
});

function connect() {
  const es = new EventSource(withToken('/api/stream'));
  es.addEventListener('state', (e) => {
    snapshot = JSON.parse(e.data);
    render();
  });
  es.addEventListener('meta', (e) => {
    const before = `${meta?.character} ${$('#ambient').dataset.energy}`;
    const page = meta?.page;
    meta = JSON.parse(e.data);
    // The service now serves newer files than this page was loaded from (an update): reload.
    if (page && meta.page && page !== meta.page) return location.reload();
    lastMetaAt = Date.now();
    renderLive();
    renderFoot();
    renderCpu();
    renderToday();
    renderQuota();
    renderAmbientQuota();
    // The status screen's character follows the Mac app's choice and the remaining limit.
    if (`${meta.character} ${$('#ambient').dataset.energy}` !== before) render();
  });
  es.onerror = async () => {
    renderLive();
    // EventSource hides the status code; ask once to tell "not paired" from "server down".
    const r = await fetch(withToken('/api/state'), { headers: authHeaders() }).catch(() => null);
    if (r?.status === 401) {
      es.close();
      $('#pairing').hidden = false;
    }
  };
}

setInterval(() => {
  updateElapsed();
  renderLive();
}, 1000);

connect();
