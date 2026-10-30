import { execFile } from 'node:child_process';

// pid ppid stat tty lstart(5 tokens) comm(full path, may contain spaces)
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function psSnapshot() {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axww', '-o', 'pid=,ppid=,stat=,tty=,lstart=,comm='],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout) => {
        const map = new Map();
        if (!err) {
          for (const line of stdout.split('\n')) {
            const m = PS_LINE.exec(line);
            if (!m) continue;
            map.set(Number(m[1]), {
              pid: Number(m[1]),
              ppid: Number(m[2]),
              stat: m[3],
              tty: m[4],
              start: new Date(m[5]).getTime(),
              comm: m[6],
            });
          }
        }
        resolve(map);
      },
    );
  });
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
