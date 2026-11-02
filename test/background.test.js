import assert from 'node:assert/strict';
import test from 'node:test';
import { Config } from '../src/config/index.js';
import { BackgroundTracker, SERVICE_COMMAND } from '../src/core/background.js';
import { emptyAnalysis } from '../src/sources/common/analysis.js';
import { parseLsof } from '../src/sources/system/ports.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const CLAUDE_PID = 500;

function session({ status = 'shell', ended = false, commands = [] } = {}) {
  const a = emptyAnalysis();
  for (const c of commands) a.background.set(c.id, { title: c.command, endedAt: null, status: 'running', exitCode: null, ...c });
  return { sid: 's1', pid: CLAUDE_PID, ended, endedAt: ended ? NOW - 1000 : null, reg: { status, statusUpdatedAt: NOW - 5000 }, tx: { a } };
}

/** ps rows: [pid, ppid, start]; ps start times are whole seconds. */
const ps = (rows) => new Map(rows.map(([pid, ppid, start]) => [pid, { pid, ppid, start: Math.floor(start / 1000) * 1000, stat: 'S', comm: '/bin/zsh' }]));

function tracker(ports = new Map(), env = {}) {
  const scans = [];
  const t = new BackgroundTracker({
    config: new Config({ file: null, env }),
    scanPorts: async (pids) => (scans.push(pids), new Map(pids.filter((p) => ports.has(p)).map((p) => [p, ports.get(p)]))),
  });
  return { t, scans };
}

test('servers and watchers are told apart from work by their command', () => {
  for (const c of ['npm run dev', 'pnpm dev', 'yarn start', 'npx vite --port 5173', 'python3 -m http.server 8000', 'tsc --watch', 'cargo watch -x run', 'tail -f server.log', 'docker compose up', 'uvicorn app:app --reload', 'next dev']) {
    assert.ok(SERVICE_COMMAND.test(c), c);
  }
  for (const c of ['npm test', 'npm run build', 'cargo build --release', 'python3 bench.py', 'sleep 75', 'xcodebuild test', 'stopwatch run']) {
    assert.ok(!SERVICE_COMMAND.test(c), c);
  }
});

test('lsof output becomes listening ports per pid', () => {
  assert.deepEqual([...parseLsof('p10\nf5\nn127.0.0.1:7333\nf6\nn[::1]:7333\nf7\nn*:5173\np11\nf3\nn*:8080\n')], [[10, [5173, 7333]], [11, [8080]]]);
  assert.equal(parseLsof('').size, 0);
});

test('a running command is matched to the child process started for it, and its ports make it a service', async () => {
  const s = session({ commands: [{ id: 'b1', command: 'node server.js', startedAt: NOW - 60_000 }, { id: 'b2', command: 'python3 bench.py', startedAt: NOW - 30_000 }] });
  const table = ps([
    [CLAUDE_PID, 1, NOW - 3600_000],
    [600, CLAUDE_PID, NOW - 3500_000], // an MCP server, started with the session
    [601, CLAUDE_PID, NOW - 60_400], // b1's shell
    [602, 601, NOW - 59_000], // the server it runs
    [603, CLAUDE_PID, NOW - 30_200], // b2's shell
  ]);
  const { t, scans } = tracker(new Map([[602, [3000]]]));
  await t.refresh([s], table, NOW);
  assert.deepEqual(scans, [[601, 602, 603]]);
  const [b1, b2] = t.commands(s, NOW).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual([b1.state, b1.ports, b1.service], ['running', [3000], true]);
  assert.deepEqual([b2.state, b2.ports, b2.service], ['running', [], false]);

  // Ports are read again only when due (background.portScanSec), or when a new command shows up.
  await t.refresh([s], table, NOW + 2000);
  assert.equal(scans.length, 1);
  await t.refresh([s], table, NOW + 11_000);
  assert.equal(scans.length, 2);
});

test('a command whose process is gone has exited, even before its notification', async () => {
  const s = session({ commands: [{ id: 'b1', command: 'npm run dev', startedAt: NOW - 60_000 }] });
  const { t } = tracker();
  await t.refresh([s], ps([[CLAUDE_PID, 1, NOW - 3600_000], [601, CLAUDE_PID, NOW - 60_000]]), NOW);
  assert.equal(t.commands(s, NOW)[0].state, 'running');
  await t.refresh([s], ps([[CLAUDE_PID, 1, NOW - 3600_000]]), NOW + 2000);
  assert.deepEqual(
    (({ state, endedAt, service }) => ({ state, endedAt, service }))(t.commands(s, NOW + 3000)[0]),
    { state: 'exited', endedAt: NOW + 2000, service: true },
  );
  // Ended services stay for background.keepEndedMinutes.
  assert.equal(t.commands(s, NOW + 2000 + 11 * 60_000).length, 0);
});

test('Claude Code saying "idle", or the session closing, ends what no process is known for', async () => {
  const cmd = { id: 'b1', command: 'npm run dev', startedAt: NOW - 60_000 };
  const { t } = tracker();
  assert.equal(t.commands(session({ status: 'shell', commands: [cmd] }), NOW)[0].state, 'running');
  assert.equal(t.commands(session({ status: 'busy', commands: [cmd] }), NOW)[0].state, 'running');
  assert.equal(t.commands(session({ status: 'idle', commands: [cmd] }), NOW)[0].state, 'exited');
  assert.equal(t.commands(session({ ended: true, commands: [cmd] }), NOW)[0].state, 'stopped');
  // Work that ended is not listed; only services are, with how they ended.
  assert.equal(t.commands(session({ commands: [{ ...cmd, command: 'npm test', status: 'completed', endedAt: NOW - 1000, exitCode: 0 }] }), NOW).length, 0);
  const done = t.commands(session({ commands: [{ ...cmd, status: 'failed', endedAt: NOW - 1000, exitCode: 1 }] }), NOW)[0];
  assert.deepEqual([done.state, done.exitCode], ['failed', 1]);
});

test('port checks can be turned off', async () => {
  const s = session({ commands: [{ id: 'b1', command: 'node server.js', startedAt: NOW - 60_000 }] });
  const { t, scans } = tracker(new Map([[601, [3000]]]), { BEEPLIGHT_BACKGROUND_PORT_SCAN_SEC: '0' });
  await t.refresh([s], ps([[CLAUDE_PID, 1, NOW - 3600_000], [601, CLAUDE_PID, NOW - 60_000]]), NOW);
  assert.equal(scans.length, 0);
  assert.equal(t.commands(s, NOW)[0].service, false);
});
