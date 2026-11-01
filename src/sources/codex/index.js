import fs from 'node:fs';
import path from 'node:path';
import { CODEX_DIR, config as defaultConfig } from '../../config/index.js';
import { readJson, SESSION_ID_RE } from '../../lib/util.js';
import { JsonlTail } from '../common/jsonl-tail.js';
import { Rollout } from './rollout.js';

// OpenAI Codex as an agent source (interface in src/core/collector.js): the ChatGPT desktop app's
// Codex and the `codex` CLI, which share ~/.codex. Task ids are `codex:<threadId>`.
//
// Codex keeps no per-process status file like Claude's registry. A thread an app or CLI has open
// holds ~/.codex/thread-writer-locks/<threadId>.lock (we only stat it, never lock it), and its
// rollout says whether a turn is open (rollout.js). Which process writes it:
//   Codex Desktop  ChatGPT.app's own `codex app-server`, shared by all its threads
//   codex-tui      a `codex` process on a tty, through a shared daemon (app-server-daemon/daemon.pid)
// Reverse-engineered from Codex 0.166; adapt it here when Codex changes.

export const ID_PREFIX = 'codex:';
const DAY = 86_400_000;
const LOCK_GRACE_SCANS = 2; // a CLI thread ends after its lock is missing this many scans in a row

export class CodexSource {
  id = 'codex';
  name = 'Codex';
  speaker = 'Codex';
  // Codex has its own account: it never drives Claude limit probes.
  caps = { limits: false, cpu: 'codex' };

  constructor({ dir = CODEX_DIR, config = defaultConfig } = {}) {
    this.dir = dir;
    this.config = config;
    this.threads = new Map(); // threadId → { file, rollout, lockAt, missing, bound, pid }
    this.titles = new ThreadNames(path.join(dir, 'session_index.jsonl'), config);
    this.desktop = null; // { pid, start }: ChatGPT.app's app-server
    this.daemon = null; // { pid, start }: the CLI's shared app-server
    this.clis = []; // `codex` processes on a terminal: { pid, start, tty }
    this.lastScan = 0;
  }

  owns(sid) {
    return sid.startsWith(ID_PREFIX);
  }

  /** Every tick: the open threads' rollouts, and their status from them. */
  poll(now, ps) {
    if (!this.enabled()) return new Map();
    if (now - this.lastScan >= this.config.get('codex.scanSec') * 1000) this.scan(now, ps);
    const out = new Map();
    for (const [tid, th] of this.threads) {
      // Who writes a thread (desktop app or terminal) is in its first line.
      if (!th.rollout.meta) th.rollout.poll();
      if (!this.isLive(th, ps)) continue;
      th.rollout.poll();
      const r = th.rollout;
      if (r.meta?.threadSource && r.meta.threadSource !== 'user') continue; // a subagent's thread
      out.set(ID_PREFIX + tid, this.liveEntry(th, now));
    }
    return out;
  }

  enabled() {
    return this.config.get('codex.scanSec') > 0;
  }

  // Which threads are open (lock files) and who could be writing them (ps). A handful of stat calls.
  scan(now, ps) {
    this.lastScan = now;
    this.findHosts(ps);
    this.titles.poll();
    let locks;
    try {
      locks = fs.readdirSync(path.join(this.dir, 'thread-writer-locks'));
    } catch {
      locks = [];
    }
    const present = new Set();
    for (const name of locks) {
      const tid = /^(.+)\.lock$/.exec(name)?.[1];
      if (!tid || !SESSION_ID_RE.test(tid)) continue;
      present.add(tid);
      let th = this.threads.get(tid);
      if (!th) {
        const file = findRollout(this.dir, tid);
        if (!file) continue; // the rollout appears with the thread's first line
        th = this.track(tid, file);
        th.lockAt = birthtime(path.join(this.dir, 'thread-writer-locks', name)) ?? now;
      }
      th.missing = 0;
      th.locked = true;
    }
    for (const th of this.threads.values()) {
      if (present.has(th.tid)) continue;
      th.locked = false;
      th.missing++;
    }
    // Bound the work: the newest threads by lock time.
    const max = this.config.get('codex.maxThreads');
    if (this.threads.size > max) {
      const keep = [...this.threads.values()].sort((x, y) => (y.lockAt ?? 0) - (x.lockAt ?? 0)).slice(0, max);
      const ids = new Set(keep.map((th) => th.tid));
      for (const tid of this.threads.keys()) if (!ids.has(tid)) this.threads.delete(tid);
    }
    this.matchClis();
  }

  track(tid, file) {
    const th = { tid, file, rollout: new Rollout(file, this.config), lockAt: null, missing: 0, locked: false, bound: null, pid: null };
    th.rollout.poll();
    this.threads.set(tid, th);
    return th;
  }

  findHosts(ps) {
    let desktop = null;
    let cli = [];
    for (const p of ps.values()) {
      if (p.comm.endsWith('/CodexCLI.app/Contents/MacOS/codex') && ps.get(p.ppid)?.comm.includes('/ChatGPT.app/')) {
        if (!desktop || p.start < desktop.start) desktop = { pid: p.pid, start: p.start };
      } else if (path.basename(p.comm) === 'codex' && p.tty && p.tty !== '??') {
        cli.push({ pid: p.pid, start: p.start, tty: p.tty });
      }
    }
    this.desktop = desktop;
    this.clis = cli;
    const d = readJson(path.join(this.dir, 'app-server-daemon', 'daemon.pid'));
    const p = d && ps.get(Number(d.pid));
    const startSec = d?.processIdentity?.startSeconds;
    // Genuine: the pid is alive and started when the file says (not a recycled pid).
    this.daemon = p && (!startSec || Math.abs(p.start / 1000 - startSec) < 2) ? { pid: p.pid, start: p.start } : null;
  }

  // A CLI process opens its thread as it starts: pair them by time when exactly one fits.
  matchClis() {
    for (const th of this.threads.values()) {
      const kept = th.pid != null && this.clis.some((c) => c.pid === th.pid);
      if (kept || th.lockAt == null || this.originOf(th) !== 'cli') continue;
      const fits = this.clis.filter((c) => th.lockAt - c.start >= -1000 && th.lockAt - c.start <= 3000);
      th.pid = fits.length === 1 ? fits[0].pid : null;
    }
  }

  originOf(th) {
    return th.rollout.meta?.originator === 'Codex Desktop' ? 'desktop' : 'cli';
  }

  isLive(th, ps) {
    if (this.originOf(th) === 'desktop') {
      // Open while the app runs: the app keeps (and may drop) locks for its threads as it likes.
      const host = this.desktop && ps.get(this.desktop.pid);
      if (!host) {
        th.bound = null;
        return false;
      }
      if (th.locked) th.bound = this.desktop.pid;
      return th.bound === this.desktop.pid;
    }
    const writer = this.daemon || (th.pid != null && ps.get(th.pid));
    return !!writer && th.missing < LOCK_GRACE_SCANS && th.lockAt != null;
  }

  liveEntry(th, now) {
    const r = th.rollout;
    const a = r.a;
    const desktop = this.originOf(th) === 'desktop';
    const open = a.turn && a.turn.endedAt == null;
    // The escalated call's output is written once the user has answered (seen on 0.166). A new
    // shell under the host is no sign of that: Codex starts one before asking.
    const waiting = open && r.escalation && asksUser(r.policy, r.escalation);
    let status = 'idle';
    let since = a.turn?.endedAt ?? (a.lastTs || th.lockAt || now);
    if (waiting) {
      status = 'waiting';
      since = r.escalation.ts;
    } else if (open) {
      status = 'busy';
      since = a.turn.startedAt;
    }
    return {
      pid: desktop ? this.desktop.pid : th.pid,
      sharedHost: desktop,
      cwd: r.cwd || r.meta?.cwd || null,
      status,
      waitingFor: waiting ? 'permission prompt' : undefined,
      needs: waiting ? r.escalation.justification || undefined : undefined,
      statusUpdatedAt: since,
      startedAt: th.lockAt,
      entrypoint: desktop ? 'codex-desktop' : 'codex-cli',
      updatedAt: a.lastTs || null,
    };
  }

  /** Codex's CPU: the processes that run its threads, while any thread is open. */
  cpuRoots(ps) {
    if (![...this.threads.values()].some((th) => th.locked)) return [];
    return [this.desktop?.pid, this.daemon?.pid, ...this.clis.map((c) => c.pid)].filter((pid) => pid != null && ps.has(pid));
  }

  open(s) {
    const tid = s.sid.slice(ID_PREFIX.length);
    let th = this.threads.get(tid);
    if (!th) {
      const file = findRollout(this.dir, tid);
      if (!file) return null;
      th = this.track(tid, file);
    }
    return { tx: th.rollout };
  }

  names(s) {
    return [this.titles.get(s.sid.slice(ID_PREFIX.length))];
  }

  restore(sid, v) {
    return { pid: null, cwd: v.cwd, status: v.lastRegStatus, entrypoint: v.entrypoint };
  }

  focus(t) {
    const tid = t.id.slice(ID_PREFIX.length);
    if (t.entrypoint === 'codex-desktop') return [{ do: 'url', kind: 'codex-thread', id: tid }];
    const steps = [{ do: 'host' }];
    if (!t.live && t.cwd) steps.push({ do: 'newTab', cli: 'codex', args: ['resume', tid], cwd: t.cwd });
    return steps;
  }
}

// Codex's own thread names (~/.codex/session_index.jsonl: {id, thread_name, updated_at}).
class ThreadNames extends JsonlTail {
  constructor(file, config) {
    super(file, config);
    this.map = new Map();
  }

  onLine(line) {
    try {
      const d = JSON.parse(line);
      if (d.id && d.thread_name) this.map.set(d.id, String(d.thread_name));
      return true;
    } catch {
      return false;
    }
  }

  onReset() {
    this.map.clear();
  }

  get(id) {
    return this.map.get(id) ?? null;
  }
}

/** Whether Codex stops for the user on this escalation, given the turn's approval_policy. */
export function asksUser(policy, escalation) {
  if (policy == null) return true;
  if (typeof policy === 'string') return policy !== 'never';
  const g = policy.granular;
  if (!g) return true;
  return escalation.kind === 'permissions' ? g.request_permissions !== false : g.sandbox_approval !== false;
}

/** The rollout file of a thread. A thread id is a UUIDv7: its first 48 bits are its creation time. */
export function findRollout(dir, tid) {
  const ms = parseInt(tid.replace(/-/g, '').slice(0, 12), 16);
  if (!Number.isFinite(ms)) return null;
  // The folder is named in local time; look a day either side in case the zone changed.
  for (const at of [ms, ms - DAY, ms + DAY]) {
    const d = new Date(at);
    const folder = path.join(dir, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    const name = names.find((n) => n.endsWith(`-${tid}.jsonl`));
    if (name) return path.join(folder, name);
  }
  return null;
}

function birthtime(file) {
  try {
    return fs.statSync(file).birthtimeMs;
  } catch {
    return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');
