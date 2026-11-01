import { EventEmitter } from 'node:events';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { config as defaultConfig } from '../config/index.js';
import { ClaudeCodeSource } from '../sources/claude-code/index.js';
import { detectHost, machineCpu, psSnapshot } from '../sources/system/proc.js';
import { deriveStatus, endKey, matchingEndSummary } from './status.js';
import { buildSummaryInput } from '../services/summarizer.js';
import { stateKey, Timeline } from './timeline.js';
import { buildDetail, DEFAULT_STEP, STEPS } from './usage-detail.js';
import { FIVE_HOURS, SEVEN_DAYS } from '../services/limits.js';
import { cleanTitle, oneLine, pidAlive, shortId } from '../lib/util.js';

// Per-session and account usage are recomputed at most this often (or when new data lands).
const USAGE_CACHE_MS = 10_000;
// Claude writes its last transcript lines right before exiting.
const ENDED_GRACE_MS = 5000;
const TRANSCRIPT_PROBE_MS = 2000;

/**
 * Turns what coding agents leave on this Mac into board views. Each agent is a source
 * (src/sources/<agent>/index.js) with this interface:
 *   id, name, speaker      'claude-code', 'Claude Code', 'Claude' (the summarizer's "Claude:" lines)
 *   caps                   { limits, cpu }: whether its activity drives Claude limit probes, and
 *                          which share of the CPU meter its processes count toward ('claude' | 'codex')
 *   owns(sid)              whether a task id is one of its own
 *   poll(now, ps)          every tick, cheap: Map<sid, live entry> in the registry-entry shape
 *                          { pid, cwd, status: busy|waiting|idle, waitingFor, needs, statusUpdatedAt,
 *                          startedAt, entrypoint, hostSessionId, name, nameSource, sharedHost }
 *   background?()          tasks without a process: Map<sid, job>
 *   open(s)                { tx: { poll(), a, ino }, subs? } once the conversation can be read, else null;
 *                          tx.a is the shared analysis (src/sources/common/analysis.js)
 *   names(s, job)          title candidates, best first
 *   restore(sid, view)     live-entry seed for a task that ended before a restart, or null to drop it
 *   focus(target)          steps for src/actions/focus.js to bring the task to the front
 *   cpuRoots?(ps)          processes whose trees count as its CPU, when not simply its live tasks' pids
 * Everything after that (status, summaries, timeline, unread, relay) never asks which agent it was.
 */
export class Collector extends EventEmitter {
  constructor({ store, summarizer, runner, usage, limits, relay, cpu, sources, config = defaultConfig }) {
    super();
    this.config = config;
    this.store = store;
    this.summarizer = summarizer;
    this.runner = runner;
    this.usage = usage;
    this.limits = limits;
    // Tasks from your other devices (src/transports/relay.js), shown read-only next to this Mac's.
    this.relay = relay;
    // CPU use of the Mac, Claude and Beeplight (src/core/cpu.js), fed by each process scan.
    this.cpu = cpu;
    this.remoteVersion = 0;
    relay?.on('change', () => this.remoteVersion++);
    this.localSig = '';
    this.usageCache = { key: '', at: 0, bySid: new Map(), account: null };
    this.sources = sources ?? [new ClaudeCodeSource({ isOwnPid: (pid) => runner.isOwnPid(pid), config })];
    this.sessions = new Map(); // sid -> session state (live, or ended while we watched)
    this.jobs = new Map();
    this.ps = new Map();
    this.tickCount = 0;
    this.tickTimes = [];
    this.lastTickMs = 0;
    this.sig = '';
    this.timeline = new Timeline(store.daily);
    this.boardIds = new Set();
    this.snapshot = { sessions: [], idleCount: 0, staleCount: 0, generatedAt: Date.now() };
    this.restoreEnded();
  }

  // Sessions that ended before a restart come back as ended sessions whose transcript is
  // re-read, so they keep being judged and summarized like any other.
  restoreEnded() {
    const now = Date.now();
    for (const [sid, v] of Object.entries(this.store.ended)) {
      if (now - (v.endedAt || 0) > this.retainMs() || this.sessions.has(sid)) continue;
      const source = this.sourceFor(sid);
      const seed = source?.restore(sid, v);
      if (!seed) continue;
      const s = this.createSession(sid, seed, source);
      Object.assign(s, { host: v.host, ended: true, endedAt: v.endedAt, endReason: v.endReason });
      this.sessions.set(sid, s);
    }
  }

  /** The processes counted toward one share of the CPU meter: each source's own roots, or its live tasks. */
  cpuRoots(share, ps) {
    const pids = [];
    for (const source of this.sources) {
      if (source.caps?.cpu !== share) continue;
      if (source.cpuRoots) pids.push(...source.cpuRoots(ps));
      else for (const s of this.sessions.values()) if (s.source === source && !s.ended && s.pid != null) pids.push(s.pid);
    }
    return pids;
  }

  /** The source a task id belongs to. */
  sourceFor(sid) {
    return this.sources.find((src) => src.owns(sid)) ?? null;
  }

  /** How long ended and quiet tasks stay (collector.retainHours). */
  retainMs() {
    return this.config.get('collector.retainHours') * 3600_000;
  }

  start() {
    this.refreshPs().then(() => this.tick());
    // Each timer re-arms itself when its interval changes in the config.
    this.timer = this.config.every('collector.tickMs', 1, () => this.tick());
    this.psTimer = this.config.every('collector.psRefreshMs', 1, () => this.refreshPs());
    // Token indexing is async and chunked so the first big pass never stalls the tick.
    const refreshUsage = () => this.usage.refresh().catch((e) => console.warn(`[usage] ${e.message}`));
    refreshUsage();
    this.usageTimer = this.config.every('usage.refreshSec', 1000, refreshUsage);
  }

  stop() {
    this.timer?.stop();
    this.psTimer?.stop();
    this.usageTimer?.stop();
  }

  async refreshPs() {
    if (this.psBusy) return;
    this.psBusy = true;
    try {
      const ps = await psSnapshot();
      if (ps.size) {
        this.ps = ps;
        this.cpu?.record({ ps, machine: machineCpu(), claudePids: this.cpuRoots('claude', ps), codexPids: this.cpuRoots('codex', ps) });
      }
      for (const s of this.sessions.values()) {
        if (s.ended) continue;
        s.host = detectHost(s.pid, this.ps) ?? s.host;
        s.stopped = this.ps.get(s.pid)?.stat?.startsWith('T') ?? false;
      }
    } finally {
      this.psBusy = false;
    }
  }

  tick() {
    const t0 = performance.now();
    const now = Date.now();
    this.tickCount++;
    this.tickTimes.push(now);
    while (now - this.tickTimes[0] > 3000) this.tickTimes.shift();
    try {
      if (this.tickCount % 6 === 1) this.pollBackground();

      const live = new Set();
      const livePids = new Set();
      for (const source of this.sources) {
        for (const [sid, reg] of source.poll(now, this.ps)) {
          let s = this.sessions.get(sid);
          if (!s) {
            s = this.createSession(sid, reg, source);
            this.sessions.set(sid, s);
          } else if (s.ended) {
            s.ended = false;
            s.endedAt = null;
            s.endReason = null;
          }
          if (s.pid !== reg.pid) s.host = detectHost(reg.pid, this.ps);
          s.reg = reg;
          s.pid = reg.pid;
          s.cwd = reg.cwd || s.cwd;
          s.lastRegStatus = reg.status;
          live.add(sid);
          // One process hosting many tasks says nothing about which of them is still open.
          if (reg.pid != null && !reg.sharedHost) livePids.add(reg.pid);
        }
      }
      for (const s of this.sessions.values()) {
        if (s.ended || live.has(s.sid)) continue;
        s.ended = true;
        s.endedAt = now;
        // Same process, new session id: /clear or /resume inside one terminal.
        s.endReason = livePids.has(s.pid) ? 'switched' : 'closed';
      }

      for (const s of this.sessions.values()) {
        // An ended session is read until its final lines are in (or once, after a restart).
        const settled = s.ended && now - s.endedAt > ENDED_GRACE_MS && (s.tx?.ino != null || s.txProbes >= 3);
        if (!settled) {
          if (!s.tx) this.attachTranscript(s, now);
          s.tx?.poll();
          if (s.subs && this.tickCount % 3 === 0) s.subs.poll();
        }
        if (this.aiTitles()) this.maybeSummarize(s, now);
      }
      if (this.aiTitles()) this.summarizer.pump();
      if (this.tickCount % 6 === 0 && this.limits.due(now, this.recentlyActive(now))) this.limits.probe();
      this.publish(now);
    } catch (e) {
      // Same failure on every tick would print 3 lines a second; log it once a minute.
      const msg = String(e?.stack || e);
      if (msg !== this.lastError || now - this.lastErrorAt > 60_000) console.error('[collector] tick failed:', msg);
      this.lastError = msg;
      this.lastErrorAt = now;
    }
    this.lastTickMs = performance.now() - t0;
  }

  // Tasks without a process (Claude's `--bg` jobs), from every source that has them.
  pollBackground() {
    const jobs = new Map();
    for (const source of this.sources) {
      for (const [sid, job] of source.background?.() ?? []) jobs.set(sid, Object.assign(job, { agent: source.id, agentName: source.name }));
    }
    this.jobs = jobs;
  }

  createSession(sid, reg, source) {
    return {
      sid,
      source,
      reg,
      pid: reg.pid,
      cwd: reg.cwd,
      host: detectHost(reg.pid, this.ps),
      stopped: this.ps.get(reg.pid)?.stat?.startsWith('T') ?? false,
      tx: null,
      subs: null,
      txProbeAt: 0,
      txProbes: 0,
      ended: false,
      endedAt: null,
      endReason: null,
      lastRegStatus: reg.status,
      endedSig: null,
      history: this.store.getHistory(sid),
    };
  }

  attachTranscript(s, now) {
    if (now - s.txProbeAt < TRANSCRIPT_PROBE_MS) return;
    s.txProbeAt = now;
    s.txProbes++;
    const opened = s.source.open(s);
    if (!opened) return;
    s.tx = opened.tx;
    s.subs = opened.subs ?? null;
    s.subs?.poll();
  }

  maybeSummarize(s, now) {
    const a = s.tx?.a;
    if (!a?.turn) return;
    const turnId = a.turn.key;
    const status = s.ended ? 'ended' : s.reg?.status;
    // Long-quiet conversations are off the board; don't spend calls on them.
    if (status !== 'busy' && status !== 'waiting' && now - a.lastTs > this.retainMs()) return;
    const sum = this.store.getSummary(s.sid);
    const request = (kind, key, delayMs) =>
      this.summarizer.request({ sid: s.sid, key, kind, turnId, delayMs, agent: agentOf(s), buildInput: () => this.summaryInput(s) });

    // A failed summary is re-requested; Summarizer holds it back until its backoff passes.
    if (status === 'idle' || status === 'ended') {
      const verdict = matchingEndSummary(sum, a, !s.ended);
      if (!verdict || verdict.error) request('end', endKey(a), this.config.get('summarizer.endDelaySec') * 1000);
      return;
    }
    // busy / waiting: keep the title on the current turn. A new turn waits for its first reply
    // and tool calls to land, so the title knows what it is about.
    const refreshMs = this.config.get('summarizer.refreshMinutes') * 60_000;
    if (!sum || sum.turnId !== turnId || sum.error) {
      request('run', `${turnId}@run`, this.config.get('summarizer.newTurnDelaySec') * 1000);
    } else if (now - a.turn.startedAt > refreshMs && now - (sum.at || 0) > refreshMs && a.lastTs > (sum.at || 0)) {
      request('run', `${turnId}@${Math.floor(now / refreshMs)}`, 0);
    }
  }

  // summarizer.titles = original shows the session's own name and never calls the summarizer.
  aiTitles() {
    return this.config.get('summarizer.titles') === 'ai';
  }

  // Summaries already stored stay unused while titles are original.
  summaryOf(sid) {
    return this.aiTitles() ? this.store.getSummary(sid) : null;
  }

  summaryInput(s) {
    const a = s.tx?.a;
    if (!a) return '';
    return buildSummaryInput({
      cwd: s.cwd,
      a,
      names: s.source.names(s, this.jobs.get(s.sid)),
      state: s.ended ? 'ended' : s.reg?.status,
      waitingFor: s.reg?.waitingFor,
      speaker: s.source.speaker,
    });
  }

  resummarize(sid) {
    const s = this.sessions.get(sid);
    const a = s?.tx?.a;
    if (!a?.turn || !this.aiTitles()) return false;
    const idle = s.ended || s.reg?.status === 'idle';
    this.summarizer.force(sid, {
      sid,
      kind: idle ? 'end' : 'run',
      key: idle ? endKey(a) : `${a.turn.key}@manual-${Date.now()}`,
      turnId: a.turn.key,
      agent: agentOf(s),
      buildInput: () => this.summaryInput(s),
    });
    return true;
  }

  buildView(s, now) {
    const a = s.tx?.a;
    const job = this.jobs.get(s.sid);
    const summary = this.summaryOf(s.sid);
    const subagents = s.subs ? s.subs.list(now, !s.ended) : [];
    const st = deriveStatus({
      live: !s.ended,
      reg: s.reg,
      lastRegStatus: s.lastRegStatus,
      job: s.ended ? job : null,
      a,
      summary,
      // No verdict comes with original titles, or without a summary model (no claude, no codex):
      // don't show "checking the result" forever.
      verdicts: this.aiTitles() && this.summarizer.available !== false,
      runningAgents: subagents.filter((x) => x.running).length,
    });
    const reg = s.reg || {};
    return {
      id: s.sid,
      agent: s.source.id,
      agentName: s.source.name,
      title:
        summary?.title ||
        s.source.names(s, job).find(Boolean) ||
        oneLine(a?.lastPrompt?.text, 30) ||
        path.basename(s.cwd || '') ||
        shortId(s.sid),
      titleFromAi: !!summary?.title,
      goal: summary?.goal || '',
      state: st.state,
      outcome: st.outcome || null,
      kind: st.kind || null,
      label: st.label,
      detail: st.detail || '',
      pending: !!st.pending,
      since: st.since || null,
      cwd: s.cwd,
      project: path.basename(s.cwd || ''),
      entrypoint: reg.entrypoint || null,
      hostSessionId: reg.hostSessionId || null,
      sdk: reg.entrypoint === 'sdk-cli',
      host: s.host ? { kind: s.host.kind, app: s.host.app, tty: s.host.tty } : null,
      pid: s.pid,
      lastRegStatus: s.lastRegStatus,
      live: !s.ended,
      ended: s.ended,
      endedAt: s.endedAt,
      endReason: s.endReason,
      stopped: !s.ended && s.stopped,
      lastPrompt: oneLine(a?.lastPrompt?.text, 200),
      turnStartedAt: a?.turn?.startedAt || null,
      updatedAt: Math.max(a?.lastTs || 0, reg.statusUpdatedAt || 0) || null,
      subagents,
      jobShort: job?.short || null,
      summarizing: this.summarizer.inflight.has(s.sid),
      usage: this.sessionUsage(s.sid, now),
    };
  }

  jobView(job) {
    const st = deriveStatus({ live: false, job });
    return {
      id: job.sessionId,
      agent: job.agent,
      agentName: job.agentName,
      title: job.name || path.basename(job.cwd || '') || job.short,
      titleFromAi: false,
      goal: '',
      state: st.state,
      outcome: st.outcome || null,
      kind: st.kind || null,
      label: st.label,
      detail: st.detail || '',
      pending: false,
      since: st.since,
      cwd: job.cwd,
      project: path.basename(job.cwd || ''),
      entrypoint: 'background',
      hostSessionId: null,
      sdk: false,
      host: null,
      pid: null,
      live: false,
      ended: true,
      endedAt: job.updatedAt,
      endReason: 'background',
      stopped: false,
      lastPrompt: '',
      turnStartedAt: null,
      updatedAt: job.updatedAt,
      subagents: [],
      jobShort: job.short,
      summarizing: false,
      unread: false,
    };
  }

  publish(now) {
    const views = [];
    const seen = new Set();
    const retain = this.retainMs();
    for (const s of this.sessions.values()) {
      if (s.ended && now - s.endedAt > retain) {
        this.sessions.delete(s.sid);
        continue;
      }
      const v = this.buildView(s, now);
      this.trackState(s, v, now);
      v.history = s.history.slice();
      v.unread = !!this.store.unread[s.sid];
      if (s.ended) {
        const sig = JSON.stringify(v);
        if (sig !== s.endedSig) {
          s.endedSig = sig;
          this.store.setEnded(s.sid, v);
        }
      }
      views.push(v);
      seen.add(s.sid);
    }
    for (const job of this.jobs.values()) {
      if (seen.has(job.sessionId) || now - job.updatedAt > retain) continue;
      const v = this.jobView(job);
      v.history = [{ k: stateKey(v), t: v.since }];
      views.push(v);
      seen.add(job.sessionId);
    }
    let idleCount = 0;
    let staleCount = 0;
    const board = views.filter((v) => {
      if (v.state === 'idle') {
        idleCount++;
        return false;
      }
      // Running work and real permission prompts always show; anything else that has been
      // quiet for longer than the retention window (e.g. old chats the desktop app keeps
      // alive) is noise.
      const active = v.state === 'doing' || (v.state === 'waiting' && v.kind === 'prompt');
      if (!active && now - (v.updatedAt || v.since || 0) > retain) {
        staleCount++;
        return false;
      }
      return !this.store.isDismissed(v.id, v.updatedAt);
    });
    this.boardIds = new Set(board.map((v) => v.id));
    const localSig = JSON.stringify(board) + idleCount + staleCount;
    if (localSig !== this.localSig) {
      this.localSig = localSig;
      this.relay?.share(board);
    }
    const sig = `${localSig}#${this.remoteVersion}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const shown = this.relay ? board.concat(this.relay.remoteViews()) : board;
    this.snapshot = { sessions: shown, idleCount, staleCount, generatedAt: now };
    this.emit('update', this.snapshot);
  }

  // Records the state trajectory, and marks a turn that just finished as unread. Like an unread
  // message it stays until the user opens the task, sends it a new prompt, or looks at its tab.
  trackState(s, v, now) {
    const prev = s.history[s.history.length - 1];
    const prevKey = prev?.k;
    const prevPending = !!prev?.p;
    if (this.timeline.track(s.history, v, now)) {
      this.store.setHistory(s.sid, s.history, this.timeline.daily);
      const last = s.history[s.history.length - 1];
      // Only finishes we saw happen: a session first seen already done is old news.
      if (prevKey && last.k.startsWith('done:') && !last.p && (prevKey !== last.k || prevPending)) {
        this.store.markUnread(s.sid, last.t, last.k.slice(5));
        console.log(`[unread] ${shortId(s.sid)} ${last.k} → unread`);
      }
    }
    // Back to work (new prompt, or Claude resumed): the old result is no longer the news.
    if (v.state !== 'done' && v.state !== 'idle' && this.store.markRead(s.sid)) {
      console.log(`[unread] ${shortId(s.sid)} read (back to ${v.state})`);
    }
  }

  // Live unread sessions sitting in a terminal tab, for "looked at it there" detection.
  unreadTerminalTargets() {
    const out = [];
    for (const sid of Object.keys(this.store.unread)) {
      const s = this.sessions.get(sid);
      const h = s?.host;
      if (s && !s.ended && h?.tty && (h.kind === 'iterm' || h.kind === 'terminal')) out.push({ sid, tty: h.tty });
    }
    return out;
  }

  markRead(sid, reason) {
    if (!this.store.markRead(sid)) return;
    console.log(`[unread] ${shortId(sid)} read (${reason})`);
    this.sig = '';
  }

  markAllRead() {
    for (const sid of Object.keys(this.store.unread)) this.markRead(sid, 'read all');
  }

  /** Takes a task off the board until it shows new activity. */
  dismiss(sid) {
    this.store.dismiss(sid);
    this.sig = '';
  }

  // Whether Claude is in use, which sets how often its limits are probed. Other agents don't count.
  recentlyActive(now) {
    for (const s of this.sessions.values()) {
      if (!s.source?.caps?.limits) continue;
      if (!s.ended && (s.reg?.status === 'busy' || s.reg?.status === 'waiting')) return true;
      if (s.tx && now - s.tx.a.lastTs < 30 * 60_000) return true;
    }
    return false;
  }

  // Recomputes per-session window totals and the account view when new usage data or a new
  // limits reading arrived, or every USAGE_CACHE_MS (window starts move with the clock).
  refreshUsageCache(now) {
    const c = this.usageCache;
    const key = `${this.usage.version}:${this.limits.version}:${this.aiTitles()}`;
    if (key === c.key && now - c.at < USAGE_CACHE_MS) return c;
    const w = this.limits.windows(now);
    const lim = this.limits.snapshot(now);
    const acct5 = this.usage.window(w.fiveHour.start);
    const acct7 = this.usage.window(w.sevenDay.start);
    // A session's share of a limit, assuming this machine's Claude Code is all of the usage.
    const share = (cost, acct, lw) => (lw && acct.cost > 0 ? (cost / acct.cost) * lw.utilization : null);
    c.bySid = new Map();
    for (const [sid, u] of this.usage.sessions) {
      if (!u.total.requests) continue;
      const f = this.usage.window(w.fiveHour.start, sid);
      const s7 = this.usage.window(w.sevenDay.start, sid);
      c.bySid.set(sid, {
        total: { tokens: u.total.tokens, out: u.total.out, cost: Math.round(u.total.cost * 1e4) / 1e4, requests: u.total.requests },
        fiveHour: { tokens: f.tokens, cost: f.cost, share: share(f.cost, acct5, lim.fiveHour) },
        sevenDay: { tokens: s7.tokens, cost: s7.cost, share: share(s7.cost, acct7, lim.sevenDay) },
      });
    }
    const titleOf = (row) => this.usageTitle(row);
    c.account = {
      ready: this.usage.ready,
      index: this.usage.stats,
      limits: lim,
      windows: w,
      fiveHour: acct5,
      sevenDay: acct7,
      buckets5h: this.usage.buckets(w.fiveHour.start, w.fiveHour.start + FIVE_HOURS, 20),
      buckets7d: this.usage.buckets(w.sevenDay.start, w.sevenDay.start + SEVEN_DAYS, 28),
      top: this.usage.top(w.sevenDay.start, 15).map((row) => {
        const s = this.sessions.get(row.sid);
        return {
          sid: row.sid,
          title: titleOf(row),
          project: path.basename(row.cwd || ''),
          live: !!s && !s.ended,
          lastAt: row.lastAt,
          tokens: row.tokens,
          out: row.out,
          cost: row.cost,
          requests: row.requests,
          share: share(row.cost, acct7, lim.sevenDay),
          fiveHourTokens: c.bySid.get(row.sid)?.fiveHour.tokens ?? 0,
        };
      }),
    };
    c.key = key;
    c.at = now;
    return c;
  }

  /** A title for a usage row ({sid, cwd, title}): the summary's, the transcript's, else the folder. */
  usageTitle(row) {
    return this.summaryOf(row.sid)?.title || cleanTitle(row.title) || path.basename(row.cwd || '') || row.sid.slice(0, 8);
  }

  /** The limit details view (src/core/usage-detail.js); null for an unknown window or step. */
  usageDetail(window, step, now) {
    if (!Object.hasOwn(STEPS, window)) return null;
    step ||= DEFAULT_STEP[window];
    if (!Object.hasOwn(STEPS[window], step)) return null;
    const live = (sid) => {
      const s = this.sessions.get(sid);
      return !!s && !s.ended;
    };
    return buildDetail({ usage: this.usage, limits: this.limits, titleOf: (row) => this.usageTitle(row), live }, { window, step, now });
  }

  sessionUsage(sid, now) {
    return this.refreshUsageCache(now).bySid.get(sid) || null;
  }

  meta() {
    const t = this.tickTimes;
    const hz = t.length > 1 ? ((t.length - 1) * 1000) / (t[t.length - 1] - t[0]) : 0;
    const now = Date.now();
    const histories = [...this.sessions.values()].filter((s) => this.boardIds.has(s.sid)).map((s) => s.history);
    return {
      now,
      usage: this.refreshUsageCache(now).account,
      today: this.timeline.today(histories, now),
      hz: Math.round(hz * 10) / 10,
      tickMs: Math.round(this.lastTickMs * 10) / 10,
      character: this.store.flags.character || 'eyes',
      cpu: this.cpu?.view() ?? null,
      titles: this.config.get('summarizer.titles'),
      summarizer: {
        queued: this.summarizer.queue.size,
        inflight: this.summarizer.inflight.size,
        ...this.summarizer.stats,
      },
    };
  }

  /** What src/actions/focus.js runs to bring a task to the front: the target plus its source's steps. */
  focusPlan(sid) {
    const target = this.focusTarget(sid);
    const source = target && this.sourceFor(sid);
    return source ? { ...target, steps: source.focus(target) } : null;
  }

  // What is known about where a task runs, or ran.
  focusTarget(sid) {
    const s = this.sessions.get(sid);
    if (s) {
      const switched = s.ended && s.endReason === 'switched' && pidAlive(s.pid);
      return {
        id: sid,
        live: !s.ended || switched,
        entrypoint: s.reg?.entrypoint,
        hostSessionId: s.reg?.hostSessionId,
        host: s.host,
        cwd: s.cwd,
        jobShort: this.jobs.get(sid)?.short,
      };
    }
    const v = this.snapshot.sessions.find((x) => x.id === sid) || this.store.ended[sid];
    if (!v) {
      // Sessions known only from their token usage (e.g. the weekly ranking) can be resumed.
      const u = this.usage.sessions.get(sid);
      return u?.cwd ? { id: sid, live: false, cwd: u.cwd } : null;
    }
    return { id: sid, live: false, entrypoint: v.entrypoint, hostSessionId: v.hostSessionId, host: null, cwd: v.cwd, jobShort: v.jobShort };
  }
}

/** Who a session's summary is about, for the summarizer's prompt. */
function agentOf(s) {
  return { name: s.source.name, speaker: s.source.speaker };
}
