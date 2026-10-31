import { execFile } from 'node:child_process';
import os from 'node:os';

// pid ppid stat tty time lstart(5 tokens) comm(full path, may contain spaces)
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d:.-]+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function psSnapshot() {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axww', '-o', 'pid=,ppid=,stat=,tty=,time=,lstart=,comm='],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => resolve(err ? new Map() : parsePs(stdout)),
    );
  });
}

/** pid -> process, from the output of the ps command above. `cpu` is the CPU time used so far, in seconds. */
export function parsePs(stdout) {
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    map.set(Number(m[1]), {
      pid: Number(m[1]),
      ppid: Number(m[2]),
      stat: m[3],
      tty: m[4],
      cpu: cpuSeconds(m[5]),
      start: new Date(m[6]).getTime(),
      comm: m[7],
    });
  }
  return map;
}

/** ps's CPU time, "[[dd-]hh:]mm:ss.cc" (macOS prints minutes past 59, e.g. "405:22.76"), in seconds. */
export function cpuSeconds(text) {
  const [days, rest] = text.includes('-') ? text.split('-') : [0, text];
  const secs = rest.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return Number(days) * 86400 + secs || 0;
}

/** CPU time of the whole Mac so far, summed over every core, in ms. */
export function machineCpu() {
  let busy = 0;
  let total = 0;
  const cpus = os.cpus();
  for (const { times: t } of cpus) {
    busy += t.user + t.nice + t.sys + t.irq;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { busy, total, cores: cpus.length };
}

const IDE_APPS = /^(Visual Studio Code|Code - Insiders|Cursor|Trae|Trae CN|Windsurf|VSCodium|Zed)$/;

// Walks the parent chain and names the outermost .app bundle hosting the process.
export function detectHost(pid, ps) {
  const self = ps.get(pid);
  if (!self) return null;
  const tty = self.tty && self.tty !== '??' ? `/dev/${self.tty}` : null;
  let app = null;
  let tmux = false;
  for (let p = self, hops = 0; p && p.pid > 1 && hops < 40; p = ps.get(p.ppid), hops++) {
    if (/(^|\/)tmux( |$)/.test(p.comm)) tmux = true;
    const m = /^(.*?\/([^/]+)\.app)\//.exec(p.comm);
    if (m) app = { name: m[2], path: m[1] };
  }
  let kind = 'unknown';
  if (tmux) kind = 'tmux';
  else if (app?.name === 'iTerm') kind = 'iterm';
  else if (app?.name === 'Terminal') kind = 'terminal';
  else if (app?.name === 'Claude') kind = 'desktop';
  else if (app && IDE_APPS.test(app.name)) kind = 'ide';
  else if (app) kind = 'app';
  return { kind, app: app?.name ?? null, appPath: app?.path ?? null, tty };
}
