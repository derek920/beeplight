// Jumping to a task: the Claude source plans the steps, src/actions/focus.js runs them. Commands
// are recorded by a fake runner instead of being executed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { focusTarget } from '../src/actions/focus.js';
import { setLang } from '../src/lib/i18n.js';
import { ClaudeCodeSource } from '../src/sources/claude-code/index.js';

setLang('en');

const SID = '11111111-1111-4111-8111-111111111111';
const claude = new ClaudeCodeSource({ registry: {}, jobs: {} });

/** A runner that answers each command with the next canned result, and records the calls. */
function fakeRun(...results) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return results.shift() ?? { ok: true, out: '', err: null };
  };
  return { run, calls };
}

const plan = (target) => ({ ...target, steps: claude.focus(target) });
const iterm = { kind: 'iterm', app: 'iTerm', appPath: '/Applications/iTerm.app', tty: '/dev/ttys009' };

test('a Claude desktop session opens through its deep link, and nothing else is tried', async () => {
  const t = { id: SID, live: true, entrypoint: 'claude-desktop', hostSessionId: 'local_ab12', host: iterm, cwd: '/repo' };
  const ok = fakeRun();
  assert.deepEqual(await focusTarget(plan(t), ok.run), { ok: true, how: 'Claude desktop app' });
  assert.deepEqual(ok.calls, [['open', 'claude://code/continue?session=local_ab12']]);

  const failed = fakeRun({ ok: false, err: 'no handler' });
  assert.deepEqual(await focusTarget(plan(t), failed.run), { ok: false, error: 'no handler' });
  assert.equal(failed.calls.length, 1);
});

test('a live terminal session selects its tab, else opens the app', async () => {
  const t = { id: SID, live: true, entrypoint: 'cli', host: iterm, cwd: '/repo' };
  const found = fakeRun({ ok: true, out: 'ok' });
  assert.deepEqual(await focusTarget(plan(t), found.run), { ok: true, how: 'iTerm2 ttys009', appleEvents: true });
  assert.equal(found.calls[0][0], 'osascript');
  assert.match(found.calls[0][2], /tty of s is "\/dev\/ttys009"/);

  const missing = fakeRun({ ok: true, out: 'notfound' }, { ok: true });
  assert.deepEqual(await focusTarget(plan(t), missing.run), { ok: true, how: "iTerm (couldn't select the exact tab)" });
  assert.deepEqual(missing.calls[1], ['open', '-a', '/Applications/iTerm.app']);
});

test('an IDE opens on the project, and tmux is reported', async () => {
  const ide = { kind: 'ide', app: 'Cursor', appPath: '/Applications/Cursor.app', tty: null };
  const r = fakeRun();
  assert.deepEqual(await focusTarget(plan({ id: SID, live: true, host: ide, cwd: '/repo' }), r.run), { ok: true, how: 'Cursor' });
  assert.deepEqual(r.calls, [['open', '-a', '/Applications/Cursor.app', '/repo']]);

  const tmux = { kind: 'tmux', app: null, appPath: null, tty: '/dev/ttys001' };
  const t = fakeRun();
  const res = await focusTarget(plan({ id: SID, live: true, host: tmux, cwd: '/repo' }), t.run);
  assert.equal(res.ok, false);
  assert.match(res.error, /tmux/);
  assert.deepEqual(t.calls, []);
});

test('a background job is attached, an ended session resumed, in a new tab', async () => {
  const job = fakeRun();
  const r1 = await focusTarget(plan({ id: SID, live: false, entrypoint: 'background', host: null, cwd: '/repo', jobShort: 'abc123' }), job.run);
  assert.equal(r1.ok, true);
  assert.match(job.calls[0][2], /attach abc123/);

  const ended = fakeRun();
  const r2 = await focusTarget(plan({ id: SID, live: false, entrypoint: 'cli', host: null, cwd: "/tmp/it's here" }), ended.run);
  assert.equal(r2.ok, true);
  // The folder is shell-quoted, then the whole line AppleScript-quoted.
  assert.ok(ended.calls[0][2].includes(`cd '/tmp/it'\\\\''s here' && `), ended.calls[0][2]);
  assert.ok(ended.calls[0][2].includes(`--resume ${SID}`));
});

test('nothing runs without a way in, and unsafe arguments are refused', async () => {
  const none = fakeRun();
  const r = await focusTarget(plan({ id: SID, live: true, host: null, cwd: '/repo' }), none.run);
  assert.deepEqual(r, { ok: false, error: "Couldn't find this session's window" });
  assert.deepEqual(none.calls, []);

  const evil = fakeRun();
  const steps = [{ do: 'newTab', cli: 'claude', args: ['--resume', '$(rm -rf ~)'] }, { do: 'newTab', cli: 'sh', args: ['x'] }, { do: 'url', kind: 'file', id: 'x' }];
  assert.equal((await focusTarget({ id: SID, live: false, steps }, evil.run)).ok, false);
  assert.deepEqual(evil.calls, []);
});
