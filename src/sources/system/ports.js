import { execFile } from 'node:child_process';

// Which TCP ports a set of processes listen on, from lsof. Used for the background commands an
// agent left running: a listening port is what makes one a server, and the port is what you
// want to see. lsof exits 1 when one of the pids has nothing to show, so its output is read
// whatever the exit code.

/** pid -> sorted listening ports. Empty when lsof is missing or slow. */
export function listeningPorts(pids, { timeoutMs = 3000 } = {}) {
  if (!pids.length) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(','), '-Fpn'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (_err, stdout) => resolve(parseLsof(stdout || '')),
    );
  });
}

/** Parses `lsof -Fpn`: "p<pid>" starts a process, "n<address>:<port>" is one of its sockets. */
export function parseLsof(stdout) {
  const map = new Map();
  let pid = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || null;
    else if (line.startsWith('n') && pid != null) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (!port) continue;
      const ports = map.get(pid) ?? [];
      if (!ports.includes(port)) ports.push(port);
      map.set(pid, ports.sort((x, y) => x - y));
    }
  }
  return map;
}
