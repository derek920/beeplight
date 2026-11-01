import assert from 'node:assert/strict';
import test from 'node:test';
import { Config } from '../src/config/index.js';
import { CpuMeter } from '../src/core/cpu.js';
import { cpuSeconds, parsePs } from '../src/sources/system/proc.js';

test('ps lines carry CPU time, in any of the formats ps prints it', () => {
  const ps = parsePs([
    '  379     1 Ss   ??     405:22.76 Fri Oct 30 09:12:01 2026     /System/Library/WindowServer',
    '41413   379 S    ttys003  0:01.50 Fri Oct 30 16:39:46 2026     /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)',
    'garbage',
  ].join('\n'));
  assert.equal(ps.size, 2);
  assert.deepEqual(ps.get(379), {
    pid: 379, ppid: 1, stat: 'Ss', tty: '??', cpu: 24322.76, start: new Date('Fri Oct 30 09:12:01 2026').getTime(), comm: '/System/Library/WindowServer',
  });
  assert.equal(ps.get(41413).comm, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper (Renderer)');
  assert.equal(cpuSeconds('1:02:03'), 3723);
  assert.equal(cpuSeconds('2-01:00:00.5'), 176400.5);
  assert.equal(cpuSeconds('?'), 0);
});

const START = Date.parse('2026-10-30T10:00:00');
const proc = (pid, ppid, cpu, comm = 'x', start = START) => [pid, { pid, ppid, cpu, comm, start }];
const ps = (...rows) => new Map(rows);
// A 4-core Mac: `total` grows by 4 CPU-seconds per wall second.
const mac = (sec, busySec) => ({ cores: 4, total: sec * 4000, busy: busySec * 1000 });
const meter = (averageSec = 10) => {
  const config = new Config({ file: null, env: {} });
  config.set({ 'collector.cpuAverageSec': averageSec });
  return new CpuMeter({ config, selfPid: 50 });
};

test('Claude counts its sessions and what they started; Beeplight counts itself, its children and the app', () => {
  const m = meter();
  const before = ps(
    proc(1, 0, 0),
    proc(10, 1, 0, '/Applications/iTerm.app/Contents/MacOS/iTerm2'),
    proc(20, 10, 1, 'claude'), // a session
    proc(21, 20, 0, 'node mcp-server'), // started by it
    proc(50, 20, 0, 'node'), // this service, started from that session's shell: Beeplight's
    proc(51, 50, 0, 'claude'), // a Haiku call
    proc(60, 1, 0, '/Applications/Beeplight.app/Contents/MacOS/Beeplight'),
    proc(70, 10, 0, 'vim'), // in a terminal, not under Claude
  );
  assert.equal(m.view(), null, 'nothing before the first scan');
  m.record({ ps: before, machine: mac(0, 0), claudePids: [20], at: START + 10_000 });
  assert.equal(m.view(), null, 'nothing until two scans are in');
  const after = ps(
    proc(1, 0, 0),
    proc(10, 1, 0.4, '/Applications/iTerm.app/Contents/MacOS/iTerm2'),
    proc(20, 10, 2, 'claude'), // +1 s
    proc(21, 20, 0.5, 'node mcp-server'), // +0.5 s
    proc(22, 20, 0.5, 'bash', START + 11_000), // started since the last scan: all of it
    proc(50, 20, 0.1, 'node'), // +0.1 s
    proc(51, 50, 0.3, 'claude'), // +0.3 s
    proc(60, 1, 0.2, '/Applications/Beeplight.app/Contents/MacOS/Beeplight'), // +0.2 s
    proc(70, 10, 1, 'vim'),
  );
  // 2 s on 4 cores is 8 CPU-seconds; 4 of them busy.
  m.record({ ps: after, machine: mac(2, 4), claudePids: [20], at: START + 12_000 });
  assert.deepEqual(m.view(), { cores: 4, sec: 2, total: 0.5, claude: 2 / 8, codex: 0, beeplight: 0.6 / 8 });
});

test('Codex counts the processes that run its threads, after Claude', () => {
  const m = meter();
  const app = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const scan = (cpu) => ps(
    proc(1, 0, 0),
    proc(20, 1, cpu.claude, 'claude'),
    proc(30, 1, cpu.app, app), // the ChatGPT app's app-server
    proc(31, 30, cpu.shell, '/bin/zsh'), // a command it runs
    proc(32, 20, cpu.both, '/bin/zsh'), // under Claude, and listed for Codex too: Claude's
  );
  m.record({ ps: scan({ claude: 0, app: 0, shell: 0, both: 0 }), machine: mac(0, 0), claudePids: [20], codexPids: [30, 32], at: START + 10_000 });
  m.record({ ps: scan({ claude: 1, app: 0.5, shell: 1, both: 0.5 }), machine: mac(2, 4), claudePids: [20], codexPids: [30, 32], at: START + 12_000 });
  const v = m.view();
  assert.equal(v.claude, 1.5 / 8);
  assert.equal(v.codex, 1.5 / 8);
});

test('a pid now held by a newer process counts as new; a part never exceeds the whole', () => {
  const m = meter();
  m.record({ ps: ps(proc(20, 1, 30)), machine: mac(0, 0), claudePids: [20], at: START + 10_000 });
  // pid 20 was reused by a process started long before the last scan: no baseline, so nothing.
  m.record({ ps: ps(proc(20, 1, 5, 'claude', START - 60_000)), machine: mac(2, 1), claudePids: [20], at: START + 12_000 });
  assert.equal(m.view().claude, 0);
  // Read a few ms apart, the process can show more than the Mac's busy time.
  m.record({ ps: ps(proc(20, 1, 7, 'claude', START - 60_000)), machine: mac(4, 2), claudePids: [20], at: START + 14_000 });
  assert.equal(m.view().claude, m.view().total);
});

test('the shares are averaged over collector.cpuAverageSec', () => {
  const m = meter(4);
  let busy = 0;
  // Three 2 s spans: busy 8, 0, 0 CPU-seconds of 8.
  for (const [i, add] of [0, 8, 0, 0].entries()) {
    busy += add;
    m.record({ ps: ps(proc(50, 1, 0)), machine: mac(i * 2, busy), claudePids: [], at: START + i * 2000 });
  }
  assert.deepEqual(m.view(), { cores: 4, sec: 4, total: 0, claude: 0, codex: 0, beeplight: 0 }, 'only the last 4 seconds');
  m.config.set({ 'collector.cpuAverageSec': 120 });
  m.record({ ps: ps(proc(50, 1, 0)), machine: mac(8, busy), claudePids: [], at: START + 8000 });
  assert.equal(m.view().sec, 6, 'a longer window keeps what is left, then grows');
});
