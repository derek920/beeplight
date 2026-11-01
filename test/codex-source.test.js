// The Codex source over a throwaway CODEX_HOME and a made-up process table: which threads are
// open, who writes them, and what state each is in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Config } from '../src/config/index.js';
import { setLang } from '../src/lib/i18n.js';
import { CodexSource, findRollout } from '../src/sources/codex/index.js';

setLang('en');

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const config = new Config({ file: null, env: {} });

/** A UUIDv7 thread id created `msAgo` ago. */
function threadId(msAgo, tail = '7abc-8def-0123456789ab') {
  const h = (NOW - msAgo).toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${tail}`;
}

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeplight-codex-'));
  fs.mkdirSync(path.join(dir, 'thread-writer-locks'), { recursive: true });
  return dir;
}

let ordinal = 0;
const line = (msAgo, type, payload) => JSON.stringify({ timestamp: iso(msAgo), ordinal: ordinal++, type, payload });

function writeThread(dir, tid, { originator = 'codex-tui', lines = [], lock = true, createdAgo = 60_000 } = {}) {
  const d = new Date(NOW - createdAgo);
  const folder = path.join(dir, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const meta = line(createdAgo, 'session_meta', { id: tid, cwd: '/repo', originator, source: 'vscode', thread_source: 'user' });
  fs.writeFileSync(path.join(folder, `rollout-2026-11-01T00-00-00-${tid}.jsonl`), [meta, ...lines, ''].join('\n'));
  if (lock) fs.writeFileSync(path.join(dir, 'thread-writer-locks', `${tid}.lock`), '');
}

const started = (ago, turn = 't1') => line(ago, 'event_msg', { type: 'task_started', turn_id: turn, turn_attribution: { turn_trigger: 'user' } });
const context = (ago, policy = 'on-request') => line(ago, 'turn_context', { turn_id: 't1', cwd: '/repo/app', approval_policy: policy });
const user = (ago, text) => line(ago, 'event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: `u${ago}`, content: [{ type: 'text', text }] } });
const complete = (ago) => line(ago, 'event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: 'Done.', duration_ms: 1000 });
const escalated = (ago, id) =>
  line(ago, 'response_item', {
    type: 'custom_tool_call', call_id: id, name: 'exec',
    input: 'text(await tools.exec_command({cmd:"touch ~/x",sandbox_permissions:"require_escalated",justification:"Allow writing ~/x?"}))',
  });

const proc = (pid, ppid, comm, { start = NOW - 3600_000, tty = '??' } = {}) => [pid, { pid, ppid, comm, start, tty, stat: 'S', cpu: 0 }];
const CHATGPT = proc(500, 1, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
const APP_SERVER = proc(501, 500, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
const DAEMON_START = NOW - 600_000;
const DAEMON = proc(900, 1, '/Users/me/.codex/packages/app-server-daemon/releases/0.166.0/bin/codex', { start: DAEMON_START });

function writeDaemonPid(dir, pid = 900, start = DAEMON_START) {
  fs.mkdirSync(path.join(dir, 'app-server-daemon'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid, processIdentity: { startSeconds: Math.floor(start / 1000) } }));
}

test('a terminal thread with an open turn is busy, paired with its codex process', () => {
  const dir = home();
  const tid = threadId(60_000);
  writeThread(dir, tid, { lines: [started(50_000), context(50_000), user(49_000, 'Fix the flaky test')] });
  writeDaemonPid(dir);
  // The CLI process started as its thread's lock was created (now).
  const ps = new Map([DAEMON, proc(1200, 300, 'codex', { start: NOW - 500, tty: 'ttys003' })]);
  const src = new CodexSource({ dir, config });
  const live = src.poll(NOW, ps);
  const e = live.get(`codex:${tid}`);
  assert.equal(e.status, 'busy');
  assert.equal(e.entrypoint, 'codex-cli');
  assert.equal(e.pid, 1200);
  assert.equal(e.sharedHost, false);
  assert.equal(e.cwd, '/repo/app');
  assert.equal(e.statusUpdatedAt, Date.parse(iso(50_000)));
  assert.deepEqual(src.focus({ id: `codex:${tid}`, live: true, entrypoint: 'codex-cli', cwd: '/repo' }), [{ do: 'host' }]);
});

test('an escalated call with no output is waiting for approval, until its output lands', () => {
  const dir = home();
  const tid = threadId(60_000);
  writeThread(dir, tid, { lines: [started(50_000), context(50_000), user(49_000, 'touch ~/x'), escalated(40_000, 'c1')] });
  writeDaemonPid(dir);
  const src = new CodexSource({ dir, config });
  const e = src.poll(NOW, new Map([DAEMON])).get(`codex:${tid}`);
  assert.equal(e.status, 'waiting');
  assert.equal(e.waitingFor, 'permission prompt');
  assert.equal(e.needs, 'Allow writing ~/x?');
  assert.equal(e.statusUpdatedAt, Date.parse(iso(40_000)));

  // Codex starts a shell before asking: that doesn't end the wait.
  const shell = new Map([DAEMON, proc(950, 900, '/bin/zsh', { start: NOW - 1000 })]);
  assert.equal(src.poll(NOW + 10, shell).get(`codex:${tid}`).status, 'waiting');
  // Approved: the call's output is written.
  const file = findRollout(dir, tid);
  fs.appendFileSync(file, line(5_000, 'response_item', { type: 'custom_tool_call_output', id: 'o1', call_id: 'c1', output: 'Script running with cell ID g2:8' }) + '\n');
  assert.equal(src.poll(NOW + 20, shell).get(`codex:${tid}`).status, 'busy');

  // A policy that never asks means the escalation just fails: busy, not waiting.
  const never = home();
  writeThread(never, tid, { lines: [started(50_000), context(50_000, 'never'), user(49_000, 'x'), escalated(40_000, 'c1')] });
  writeDaemonPid(never);
  assert.equal(new CodexSource({ dir: never, config }).poll(NOW, new Map([DAEMON])).get(`codex:${tid}`).status, 'busy');
});

test('a terminal thread ends after its lock has been gone for two scans', () => {
  const dir = home();
  const tid = threadId(60_000);
  writeThread(dir, tid, { lines: [started(50_000), user(49_000, 'x'), complete(45_000)] });
  writeDaemonPid(dir);
  const ps = new Map([DAEMON]);
  const src = new CodexSource({ dir, config });
  const scan = config.get('codex.scanSec') * 1000;
  assert.equal(src.poll(NOW, ps).get(`codex:${tid}`).status, 'idle');
  fs.rmSync(path.join(dir, 'thread-writer-locks', `${tid}.lock`));
  assert.ok(src.poll(NOW + scan, ps).has(`codex:${tid}`), 'one missed scan is not enough');
  assert.equal(src.poll(NOW + 2 * scan, ps).has(`codex:${tid}`), false);
  // Ended terminal threads resume in a new tab.
  assert.deepEqual(src.focus({ id: `codex:${tid}`, live: false, entrypoint: 'codex-cli', cwd: '/repo' }), [
    { do: 'host' },
    { do: 'newTab', cli: 'codex', args: ['resume', tid], cwd: '/repo' },
  ]);
});

test('desktop threads stay open while the ChatGPT app runs, and share its process', () => {
  const dir = home();
  const tid = threadId(120_000, '7abc-8def-aaaaaaaaaaaa');
  writeThread(dir, tid, { originator: 'Codex Desktop', createdAgo: 120_000, lines: [started(100_000), user(99_000, 'Research'), complete(90_000)] });
  const ps = new Map([CHATGPT, APP_SERVER]);
  const src = new CodexSource({ dir, config });
  const e = src.poll(NOW, ps).get(`codex:${tid}`);
  assert.equal(e.entrypoint, 'codex-desktop');
  assert.equal(e.pid, 501);
  assert.equal(e.sharedHost, true);
  // The app may drop a thread's lock; the thread stays open until the app quits.
  fs.rmSync(path.join(dir, 'thread-writer-locks', `${tid}.lock`));
  const scan = config.get('codex.scanSec') * 1000;
  assert.ok(src.poll(NOW + 3 * scan, ps).has(`codex:${tid}`));
  assert.equal(src.poll(NOW + 4 * scan, new Map()).has(`codex:${tid}`), false, 'app quit');
  assert.deepEqual(src.focus({ id: `codex:${tid}`, live: false, entrypoint: 'codex-desktop' }), [{ do: 'url', kind: 'codex-thread', id: tid }]);
});

test('thread names, restore after a restart, and switching Codex off', () => {
  const dir = home();
  const tid = threadId(30_000);
  writeThread(dir, tid, { lock: false, lines: [started(20_000), user(19_000, 'Plan the migration'), complete(10_000)] });
  fs.writeFileSync(path.join(dir, 'session_index.jsonl'), JSON.stringify({ id: tid, thread_name: 'Plan the migration', updated_at: iso(10_000) }) + '\n');
  assert.ok(findRollout(dir, tid).endsWith(`-${tid}.jsonl`));

  const src = new CodexSource({ dir, config });
  src.poll(NOW, new Map());
  const s = { sid: `codex:${tid}`, cwd: '/repo' };
  assert.deepEqual(src.restore(s.sid, { cwd: '/repo', lastRegStatus: 'idle', entrypoint: 'codex-cli' }), { pid: null, cwd: '/repo', status: 'idle', entrypoint: 'codex-cli' });
  const opened = src.open(s);
  opened.tx.poll();
  assert.equal(opened.tx.a.lastPrompt.text, 'Plan the migration');
  assert.deepEqual(src.names(s), ['Plan the migration']);
  assert.equal(src.owns(s.sid), true);
  assert.equal(src.owns('11111111-1111-4111-8111-111111111111'), false);

  const off = new CodexSource({ dir, config: new Config({ file: null, env: { BEEPLIGHT_CODEX_MONITOR: 'off' } }) });
  assert.equal(off.poll(NOW, new Map()).size, 0);
});
