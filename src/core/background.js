import { config as defaultConfig } from '../config/index.js';
import { runningBackground } from '../sources/common/analysis.js';
import { listeningPorts } from '../sources/system/ports.js';

// Background commands an agent left running: a dev server, a watcher, a long build. The conversation
// says what was started and how it ended (src/sources/<agent>/ fills `a.background`); the process
// table says whether it is still alive, and lsof which ports it listens on.
//
// A command is a *service* when it listens on a port or looks like a dev server or watcher. Nobody
// waits for a service to finish, so it never keeps its task in Doing and never notifies: the board
// lists services on their own, with their state. Any other command still running is work the
// agent waits for, and keeps the task in Doing (deriveStatus()).

/** Dev servers and watchers, recognized before they open a port (or when they never do). */
export const SERVICE_COMMAND = new RegExp(
  [
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b`,
    String.raw`\b(vite|nodemon|live-server|http-server|webpack-dev-server|browser-sync)\b`,
    String.raw`\b(next|nuxt|astro|remix)\s+(dev|start)\b`,
    String.raw`\bwebpack\s+serve\b`,
    String.raw`\bnpx\s+serve\b`,
    String.raw`\bpython3?\s+-m\s+http\.server\b`,
    String.raw`\b(uvicorn|gunicorn|hypercorn|flask\s+run|runserver|rails\s+s(erver)?|hugo\s+server|jekyll\s+serve|mkdocs\s+serve)\b`,
    String.raw`--watch\b`,
    String.raw`(^|[\s;&|(])watch\s`,
    String.raw`\btail\s+-[fF]\b`,
    String.raw`\bdocker(-|\s+)compose\s+up\b`,
  ].join('|'),
);

// ps start times are whole seconds, and the launch result is written right after the spawn.
const MATCH_BEFORE_MS = 10_000;
const MATCH_AFTER_MS = 1500;
const SUBTREE_MAX = 200;

export class BackgroundTracker {
  constructor({ config = defaultConfig, scanPorts = listeningPorts } = {}) {
    this.config = config;
    this.scanPorts = scanPorts;
    // session -> { procs: id -> { pid, start }, gone: id -> ts, ports: id -> [port] }
    this.state = new WeakMap();
    this.lastScan = 0;
    this.scanning = false;
  }

  stateOf(s) {
    let st = this.state.get(s);
    if (!st) this.state.set(s, (st = { procs: new Map(), gone: new Map(), ports: new Map() }));
    return st;
  }

  /**
   * After each process scan: ties each running command to the process its agent started for it
   * (a child of the agent's process, started at the launch), notices the ones whose process is
   * gone, and reads their ports when due.
   */
  async refresh(sessions, ps, now) {
    if (!ps.size) return;
    const children = childMap(ps);
    const targets = [];
    let fresh = false;
    for (const s of sessions) {
      const a = s.tx?.a;
      const st = this.state.get(s) ?? (runningBackground(a).length ? this.stateOf(s) : null);
      if (!st) continue;
      for (const map of [st.procs, st.gone, st.ports]) for (const id of map.keys()) if (!a?.background.has(id)) map.delete(id);
      const taken = new Set([...st.procs.values()].map((p) => p.pid));
      for (const c of runningBackground(a)) {
        if (st.gone.has(c.id)) continue;
        const known = st.procs.get(c.id);
        if (known) {
          if (ps.get(known.pid)?.start === known.start) targets.push({ st, id: c.id, pid: known.pid });
          else {
            st.procs.delete(c.id);
            st.gone.set(c.id, now);
          }
          continue;
        }
        if (s.ended || s.pid == null) continue;
        const pick = closest(
          (children.get(s.pid) ?? []).filter((p) => !taken.has(p.pid) && p.start >= c.startedAt - MATCH_BEFORE_MS && p.start <= c.startedAt + MATCH_AFTER_MS),
          c.startedAt,
        );
        if (!pick) continue;
        st.procs.set(c.id, { pid: pick.pid, start: pick.start });
        taken.add(pick.pid);
        targets.push({ st, id: c.id, pid: pick.pid });
        fresh = true;
      }
    }
    await this.scan(targets, children, now, fresh);
  }

  async scan(targets, children, now, fresh) {
    const every = this.config.get('background.portScanSec') * 1000;
    if (!every || !targets.length || this.scanning || (!fresh && now - this.lastScan < every)) return;
    this.scanning = true;
    this.lastScan = now;
    try {
      const trees = targets.map((t) => ({ ...t, pids: subtree(t.pid, children) }));
      const byPid = await this.scanPorts([...new Set(trees.flatMap((t) => t.pids))]);
      for (const t of trees) {
        const ports = [...new Set(t.pids.flatMap((pid) => byPid.get(pid) ?? []))].sort((x, y) => x - y);
        // A server that closed its port is still the server it was.
        if (ports.length || !t.st.ports.has(t.id)) t.st.ports.set(t.id, ports);
      }
    } finally {
      this.scanning = false;
    }
  }

  /**
   * A task's background commands as the board sees them: the running ones, and the services that
   * ended within background.keepEndedMinutes. state is running | completed | failed | stopped |
   * exited (ended without saying how); service says whether its task waits for it.
   */
  commands(s, now) {
    const a = s.tx?.a;
    if (!a?.background.size) return [];
    const st = this.state.get(s);
    const keep = this.config.get('background.keepEndedMinutes') * 60_000;
    // Claude Code writes "idle" rather than "shell" once nothing of its own runs in the background.
    const noneRunning = !s.ended && s.reg?.status === 'idle';
    const out = [];
    for (const c of a.background.values()) {
      let { status: state, endedAt } = c;
      if (state === 'running') {
        const alive = st?.procs.has(c.id);
        if (st?.gone.has(c.id)) [state, endedAt] = ['exited', st.gone.get(c.id)];
        else if (!alive && s.ended) [state, endedAt] = ['stopped', s.endedAt];
        else if (!alive && noneRunning) [state, endedAt] = ['exited', s.reg.statusUpdatedAt ?? now];
      }
      const ports = st?.ports.get(c.id) ?? [];
      const service = ports.length > 0 || SERVICE_COMMAND.test(c.command || '');
      if (state !== 'running' && (!service || !endedAt || now - endedAt > keep)) continue;
      out.push({ id: c.id, title: c.title, command: c.command, state, exitCode: c.exitCode, startedAt: c.startedAt, endedAt: state === 'running' ? null : endedAt, ports, service });
    }
    return out.sort((x, y) => Number(y.state === 'running') - Number(x.state === 'running') || y.startedAt - x.startedAt);
  }
}

function childMap(ps) {
  const map = new Map();
  for (const p of ps.values()) {
    const list = map.get(p.ppid);
    if (list) list.push(p);
    else map.set(p.ppid, [p]);
  }
  return map;
}

function subtree(pid, children) {
  const out = [pid];
  for (let i = 0; i < out.length && out.length < SUBTREE_MAX; i++) for (const c of children.get(out[i]) ?? []) out.push(c.pid);
  return out;
}

function closest(list, ts) {
  let best = null;
  for (const p of list) if (!best || Math.abs(p.start - ts) < Math.abs(best.start - ts)) best = p;
  return best;
}
