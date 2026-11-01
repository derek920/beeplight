import { config as defaultConfig } from '../config/index.js';

// How much CPU the whole Mac, Claude Code and Beeplight itself use, averaged over the last
// collector.cpuAverageSec. Fed by the collector's process scan, so it runs no command of its own:
// ps already reports each process's CPU time, and the difference between two scans is what the
// process used in between. Every share is of the whole Mac (all cores), so the three numbers
// compare directly; top and Activity Monitor measure a process against one core instead.
//
// Claude: each live session's process and everything it started (tools, MCP servers). Codex: the
// processes that run Codex threads (the ChatGPT app's app-server, the CLI and its daemon) and their
// children. Beeplight: this service and its children (Haiku calls, ps, osascript) and the Mac app.
// Each process counts once, Beeplight's first, then Claude's, then Codex's, so a service started
// from a Claude session's shell is not Claude's.
// A process that ends between two scans loses what it used since the last one.

const MAC_APP = /\/Beeplight\.app\/Contents\/MacOS\/Beeplight$/;

export class CpuMeter {
  constructor({ config = defaultConfig, selfPid = process.pid } = {}) {
    this.config = config;
    this.selfPid = selfPid;
    this.last = null; // the previous scan: { ps, machine, at }
    this.spans = []; // one per pair of scans, in CPU ms: { from, at, total, busy, claude, beeplight }
    this.cores = 0;
  }

  /** One scan: `ps` from psSnapshot(), `machine` from machineCpu(), each agent's process roots. */
  record({ ps, machine, claudePids, codexPids = [], at = Date.now() }) {
    const last = this.last;
    this.last = { ps, machine, at };
    this.cores = machine.cores;
    if (!last || machine.total <= last.machine.total) return;
    const children = new Map();
    for (const p of ps.values()) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p.pid);
    }
    const counted = new Set();
    const apps = [...ps.values()].filter((p) => MAC_APP.test(p.comm)).map((p) => p.pid);
    const beeplight = used(claim([this.selfPid, ...apps], ps, children, counted), ps, last);
    const claude = used(claim(claudePids, ps, children, counted), ps, last);
    const codex = used(claim(codexPids, ps, children, counted), ps, last);
    const busy = machine.busy - last.machine.busy;
    this.spans.push({ from: last.at, at, total: machine.total - last.machine.total, busy, claude, codex, beeplight });
    const since = at - this.config.get('collector.cpuAverageSec') * 1000;
    while (this.spans.length > 1 && this.spans[0].from < since) this.spans.shift();
  }

  /** Shares of the whole Mac (0…1) over the last `sec` seconds; null until two scans are in. */
  view() {
    if (!this.spans.length) return null;
    const sum = (k) => this.spans.reduce((n, s) => n + s[k], 0);
    const total = sum('total');
    const busy = sum('busy');
    // Process times and the Mac's counters are read a few ms apart; never show a part above the whole.
    const share = (ms) => Math.round((Math.min(ms, busy) / total) * 10_000) / 10_000;
    return {
      cores: this.cores,
      sec: Math.round((this.spans.at(-1).at - this.spans[0].from) / 1000),
      total: share(busy),
      claude: share(sum('claude')),
      codex: share(sum('codex')),
      beeplight: share(sum('beeplight')),
    };
  }
}

/** The roots and all their descendants that are not counted yet, marking them counted. */
function claim(roots, ps, children, counted) {
  const out = [];
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop();
    if (pid <= 1 || counted.has(pid) || !ps.has(pid)) continue;
    counted.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** CPU ms these processes used since the last scan. A pid now held by a newer process counts as new. */
function used(pids, ps, last) {
  let ms = 0;
  for (const pid of pids) {
    const p = ps.get(pid);
    const before = last.ps.get(pid);
    if (before && before.start === p.start) ms += Math.max(0, p.cpu - before.cpu) * 1000;
    // Started since the last scan (ps gives start times to the second).
    else if (p.start >= last.at - 1000) ms += p.cpu * 1000;
  }
  return ms;
}
