// What the collector makes of Claude Code's files, end to end: registry entries, transcripts and
// background jobs on disk → board views, focus targets and summary requests. These pin today's
// behavior so the agent-source refactor can prove it changed nothing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// config/index.js fixes Claude's directories when it loads, so point them here first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beeplight-collector-'));
const CLAUDE = path.join(TMP, 'claude');
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
const { Collector } = await import('../src/core/collector.js');
const { Config } = await import('../src/config/index.js');
const { Store } = await import('../src/core/store.js');
const { setLang } = await import('../src/lib/i18n.js');
const { projectSlug } = await import('../src/lib/util.js');
const { ClaudeCodeSource } = await import('../src/sources/claude-code/index.js');
const { CodexSource } = await import('../src/sources/codex/index.js');

setLang('en');

const NOW = Date.now();
const iso = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();

// Session ids must look like Claude's (UUIDs): focus resumes only those.
const SID = {
  busy: '11111111-1111-4111-8111-111111111111',
  wait: '22222222-2222-4222-8222-222222222222',
  done: '33333333-3333-4333-8333-333333333333',
  closed: '44444444-4444-4444-8444-444444444444',
  before: '55555555-5555-4555-8555-555555555555',
  after: '66666666-6666-4666-8666-666666666666',
  job: '77777777-7777-4777-8777-777777777777',
  old: '88888888-8888-4888-8888-888888888888',
  own: '99999999-9999-4999-8999-999999999999',
};
const CWD = '/tmp/beeplight-test/shop';

// --- Claude Code's files ---------------------------------------------------------------------

function reset() {
  fs.rmSync(CLAUDE, { recursive: true, force: true });
  for (const d of ['sessions', 'projects', 'jobs']) fs.mkdirSync(path.join(CLAUDE, d), { recursive: true });
}

function writeRegistry(pid, entry) {
  const file = path.join(CLAUDE, 'sessions', `${pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid, cwd: CWD, kind: 'interactive', entrypoint: 'cli', startedAt: NOW - 3600_000, ...entry }));
  // The registry re-reads a file only when its mtime or size moved.
  const t = new Date(Date.now() + Math.random() * 1000);
  fs.utimesSync(file, t, t);
}

function removeRegistry(pid) {
  fs.rmSync(path.join(CLAUDE, 'sessions', `${pid}.json`), { force: true });
}

function writeTranscript(sid, lines, cwd = CWD) {
  const dir = path.join(CLAUDE, 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeJob(short, state) {
  const dir = path.join(CLAUDE, 'jobs', short);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ daemonShort: short, ...state }));
}

const human = (uuid, text, secAgo) => ({
  type: 'user', isSidechain: false, uuid, origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: iso(secAgo),
});
const reply = (text, secAgo) => ({
  type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: iso(secAgo),
});
const toolUse = (id, name, input, secAgo) => ({
  type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, timestamp: iso(secAgo),
});
const toolResult = (id, secAgo) => ({
  type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, timestamp: iso(secAgo),
});
const turnEnd = (secAgo) => ({ type: 'system', subtype: 'turn_duration', isSidechain: false, durationMs: 4000, timestamp: iso(secAgo) });

// --- the collector's other inputs, stubbed -----------------------------------------------------

/** Records requests; pump() answers them at once from `answers` (sid → summary fields). */
class FakeSummarizer {
  constructor(store, answers) {
    this.store = store;
    this.answers = answers;
    this.queue = new Map();
    this.inflight = new Map();
    this.stats = { ok: 0, failed: 0, lastError: null };
    this.requests = [];
    this.forced = [];
  }
  request(job) {
    this.requests.push(job);
    this.queue.set(job.sid, job);
  }
  force(sid, job) {
    this.forced.push({ sid, job });
  }
  pump() {
    for (const j of this.queue.values()) {
      const answer = this.answers[j.sid];
      if (answer) this.store.setSummary(j.sid, { key: j.key, kind: j.kind, turnId: j.turnId, at: Date.now(), ...answer });
    }
    this.queue.clear();
  }
}

const fakeUsage = () => ({
  version: 0,
  ready: true,
  stats: {},
  sessions: new Map(),
  window: () => ({ tokens: 0, out: 0, cost: 0, requests: 0 }),
  buckets: () => [],
  top: () => [],
  refresh: async () => {},
});

const fakeLimits = () => ({
  version: 0,
  windows: (now) => ({ fiveHour: { start: now - 3600_000 }, sevenDay: { start: now - 86400_000 } }),
  snapshot: () => ({ fiveHour: null, sevenDay: null }),
  due: () => false,
  probe: () => {},
});

const OWN_PID = 424242;
let storeN = 0;

function makeCollector({ answers = {}, seed, sources, available } = {}) {
  const config = new Config({ file: null, env: {} });
  const file = path.join(TMP, `state-${storeN++}.json`);
  if (seed) fs.writeFileSync(file, JSON.stringify(seed));
  const store = new Store(file, config);
  const summarizer = new FakeSummarizer(store, answers);
  if (available !== undefined) summarizer.available = available;
  const runner = { isOwnPid: (pid) => pid === OWN_PID };
  const collector = new Collector({ store, summarizer, runner, usage: fakeUsage(), limits: fakeLimits(), config, sources: sources?.(config, runner) });
  return { collector, store, summarizer };
}

/** The view fields the clients act on (time-dependent ones dropped). */
function views(collector) {
  return Object.fromEntries(
    collector.snapshot.sessions.map((v) => [
      v.id,
      {
        title: v.title,
        titleFromAi: v.titleFromAi,
        goal: v.goal,
        state: v.state,
        outcome: v.outcome,
        kind: v.kind,
        label: v.label,
        detail: v.detail,
        pending: v.pending,
        cwd: v.cwd,
        project: v.project,
        entrypoint: v.entrypoint,
        sdk: v.sdk,
        host: v.host,
        live: v.live,
        ended: v.ended,
        endReason: v.endReason,
        lastPrompt: v.lastPrompt,
        jobShort: v.jobShort,
        unread: v.unread,
        usage: v.usage,
        history: v.history.map((h) => h.k),
      },
    ]),
  );
}

/** A process that is alive until killed: stands in for a Claude session that later exits. */
function liveProcess() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { pid: child.pid, kill: () => (child.kill(), exited) };
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// --- live sessions -----------------------------------------------------------------------------

test('busy, waiting and idle sessions become Doing, Waiting and Done cards', () => {
  reset();
  const p = { busy: process.pid, wait: process.ppid };
  writeRegistry(p.busy, { sessionId: SID.busy, status: 'busy', statusUpdatedAt: NOW - 20_000 });
  writeTranscript(SID.busy, [human('u1', 'Fix the checkout total', 60), toolUse('t1', 'Bash', { command: 'npm test' }, 30)]);
  writeRegistry(p.wait, { sessionId: SID.wait, status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 10_000 });
  writeTranscript(SID.wait, [human('u2', 'Clean up old logs', 50), toolUse('t2', 'Bash', { command: 'rm -rf logs' }, 40)]);
  // Beeplight's own `claude -p` registers too; it is never a task.
  writeRegistry(OWN_PID, { sessionId: SID.own, status: 'busy', entrypoint: 'sdk-cli' });

  const { collector } = makeCollector();
  collector.tick();

  assert.deepEqual(views(collector), {
    [SID.busy]: {
      title: 'Fix the checkout total',
      titleFromAi: false,
      goal: '',
      state: 'doing',
      outcome: null,
      kind: null,
      label: 'Running',
      detail: 'Bash · npm test',
      pending: false,
      cwd: CWD,
      project: 'shop',
      entrypoint: 'cli',
      sdk: false,
      host: null,
      live: true,
      ended: false,
      endReason: null,
      lastPrompt: 'Fix the checkout total',
      jobShort: null,
      unread: false,
      usage: null,
      history: ['doing'],
    },
    [SID.wait]: {
      title: 'Clean up old logs',
      titleFromAi: false,
      goal: '',
      state: 'waiting',
      outcome: null,
      kind: 'prompt',
      label: 'Needs permission',
      detail: 'Bash · rm -rf logs',
      pending: false,
      cwd: CWD,
      project: 'shop',
      entrypoint: 'cli',
      sdk: false,
      host: null,
      live: true,
      ended: false,
      endReason: null,
      lastPrompt: 'Clean up old logs',
      jobShort: null,
      unread: false,
      usage: null,
      history: ['waiting'],
    },
  });
  assert.equal(collector.recentlyActive(Date.now()), true);
  assert.deepEqual(collector.focusTarget(SID.busy), {
    id: SID.busy, live: true, entrypoint: 'cli', hostSessionId: undefined, host: null, cwd: CWD, jobShort: undefined,
  });
});

test('a finished turn is Done once the verdict is in, and asks for one when it ends', () => {
  reset();
  writeRegistry(process.pid, { sessionId: SID.done, status: 'idle', statusUpdatedAt: NOW - 5000 });
  writeTranscript(SID.done, [
    human('u3', 'Add a dark mode toggle', 120),
    toolUse('t3', 'Edit', { file_path: '/tmp/beeplight-test/shop/theme.css' }, 100),
    toolResult('t3', 95),
    reply('Dark mode is in; the toggle sits in the header.', 90),
    turnEnd(89),
  ]);
  const answer = { title: 'Dark mode toggle', goal: 'Added the toggle to the header', outcome: 'done', reason: 'Toggle works' };
  const { collector, summarizer } = makeCollector({ answers: { [SID.done]: answer } });

  collector.tick();
  const end = summarizer.requests.find((j) => j.sid === SID.done);
  assert.equal(end.kind, 'end');
  assert.equal(end.turnId, 'u3');
  assert.equal(end.key, `u3@${Date.parse(iso(90))}`);
  assert.equal(
    end.buildInput(),
    [
      `Project directory: ${CWD}`,
      '## Recent conversation, oldest first\nUser: Add a dark mode toggle\n  [tool] Edit: theme.css\nClaude: Dark mode is in; the toggle sits in the header.',
      "Current state: Claude has ended the turn and is waiting for the user's next message.",
    ].join('\n\n'),
  );

  collector.tick(); // the verdict landed in the store during the first tick's pump()
  const v = views(collector)[SID.done];
  assert.equal(v.title, 'Dark mode toggle');
  assert.equal(v.titleFromAi, true);
  assert.equal(v.state, 'done');
  assert.equal(v.outcome, 'success');
  assert.equal(v.label, 'Done');
  assert.equal(v.detail, 'Toggle works');
  assert.equal(v.pending, false);
  assert.deepEqual(v.history, ['done:success']);
  // A session first seen already done is not news.
  assert.equal(v.unread, false);
});

test('a session that exits mid-turn fails, and is resumed with claude --resume', async () => {
  reset();
  const proc = liveProcess();
  writeRegistry(proc.pid, { sessionId: SID.closed, status: 'busy', statusUpdatedAt: NOW - 30_000 });
  writeTranscript(SID.closed, [human('u4', 'Migrate the orders table', 60), toolUse('t4', 'Bash', { command: 'npm run migrate' }, 50)]);
  const { collector } = makeCollector();
  collector.tick();
  assert.equal(views(collector)[SID.closed].state, 'doing');

  await proc.kill();
  removeRegistry(proc.pid);
  collector.tick();
  const v = views(collector)[SID.closed];
  assert.equal(v.state, 'done');
  assert.equal(v.outcome, 'failed');
  assert.equal(v.label, 'Exited mid-turn');
  assert.equal(v.live, false);
  assert.equal(v.ended, true);
  assert.equal(v.endReason, 'closed');
  assert.deepEqual(v.history, ['doing', 'done:failed']);
  assert.equal(v.unread, true);
  assert.deepEqual(collector.focusTarget(SID.closed), {
    id: SID.closed, live: false, entrypoint: 'cli', hostSessionId: undefined, host: null, cwd: CWD, jobShort: undefined,
  });
});

test('/clear in the same terminal ends the old session as switched', () => {
  reset();
  writeRegistry(process.pid, { sessionId: SID.before, status: 'idle' });
  writeTranscript(SID.before, [human('u5', 'Write the release notes', 300), reply('Done: notes are in CHANGELOG.md.', 290), turnEnd(289)]);
  const { collector } = makeCollector();
  collector.tick();

  writeRegistry(process.pid, { sessionId: SID.after, status: 'busy', statusUpdatedAt: NOW });
  writeTranscript(SID.after, [human('u6', 'Bump the version', 5)]);
  collector.tick();
  const all = views(collector);
  assert.equal(all[SID.before].endReason, 'switched');
  assert.equal(all[SID.before].ended, true);
  assert.equal(all[SID.after].state, 'doing');
  assert.equal(all[SID.after].detail, 'Thinking…');
  // Still the same terminal, so jumping to the old one goes to the live tab.
  assert.equal(collector.focusTarget(SID.before).live, true);
});

// --- without a process ------------------------------------------------------------------------

test('a background job with no process shows the daemon’s verdict', () => {
  reset();
  writeJob('abc123', {
    sessionId: SID.job, state: 'blocked', needs: 'Pick Postgres or SQLite', name: 'Move to a real database', cwd: CWD, updatedAt: iso(30),
  });
  const { collector } = makeCollector();
  collector.tick();
  assert.deepEqual(views(collector)[SID.job], {
    title: 'Move to a real database',
    titleFromAi: false,
    goal: '',
    state: 'waiting',
    outcome: null,
    kind: 'question',
    label: 'Awaiting your reply',
    detail: 'Pick Postgres or SQLite',
    pending: false,
    cwd: CWD,
    project: 'shop',
    entrypoint: 'background',
    sdk: false,
    host: null,
    live: false,
    ended: true,
    endReason: 'background',
    lastPrompt: '',
    jobShort: 'abc123',
    unread: false,
    usage: undefined,
    history: ['waiting:q'],
  });
  assert.deepEqual(collector.focusTarget(SID.job), {
    id: SID.job, live: false, entrypoint: 'background', hostSessionId: null, host: null, cwd: CWD, jobShort: 'abc123',
  });
  assert.equal(collector.recentlyActive(Date.now()), false);
});

test('sessions that ended before a restart come back and are judged again', () => {
  reset();
  writeTranscript(SID.old, [human('u7', 'Speed up the image build', 600), reply('Cut the build from 4 to 1 minute.', 590), turnEnd(589)]);
  const seed = {
    ended: {
      [SID.old]: { id: SID.old, pid: 2, cwd: CWD, lastRegStatus: 'idle', entrypoint: 'cli', endedAt: NOW - 500_000, endReason: 'closed', host: null },
    },
  };
  const { collector, summarizer } = makeCollector({ seed });
  collector.tick();
  const v = views(collector)[SID.old];
  assert.equal(v.title, 'Speed up the image build');
  assert.equal(v.state, 'done');
  assert.equal(v.pending, true);
  assert.equal(v.detail, 'Checking the result…');
  assert.equal(v.ended, true);
  assert.equal(v.endReason, 'closed');
  assert.equal(summarizer.requests.find((j) => j.sid === SID.old)?.kind, 'end');
  assert.equal(collector.focusTarget(SID.old).live, false);
  // A conversation that moved in the last 30 minutes counts as recent activity, live or not.
  assert.equal(collector.recentlyActive(Date.now()), true);
});

test('sessions known only from their usage can still be resumed', () => {
  reset();
  const { collector } = makeCollector();
  collector.usage.sessions.set(SID.old, { cwd: CWD, total: { requests: 0 } });
  assert.deepEqual(collector.focusTarget(SID.old), { id: SID.old, live: false, cwd: CWD });
  assert.equal(collector.focusTarget('nope'), null);
});

test('resummarize asks for a fresh verdict on an idle session', () => {
  reset();
  writeRegistry(process.pid, { sessionId: SID.done, status: 'idle' });
  writeTranscript(SID.done, [human('u8', 'Tidy the README', 60), reply('Tidied.', 50), turnEnd(49)]);
  const { collector, summarizer } = makeCollector();
  collector.tick();
  assert.equal(collector.resummarize(SID.done), true);
  assert.equal(summarizer.forced[0].job.kind, 'end');
  assert.equal(summarizer.forced[0].job.key, `u8@${Date.parse(iso(50))}`);
  assert.equal(collector.resummarize('missing'), false);
});

test('unread finishes in a terminal tab are offered to the "looked at it" check', () => {
  reset();
  writeRegistry(process.pid, { sessionId: SID.busy, status: 'busy' });
  writeTranscript(SID.busy, [human('u9', 'Ship it', 10)]);
  const { collector, store } = makeCollector();
  // ps: our pid runs in an iTerm tab.
  const app = '/Applications/iTerm.app/Contents/MacOS/iTerm2';
  collector.ps = new Map([
    [process.pid, { pid: process.pid, ppid: 7000, stat: 'S', tty: 'ttys009', comm: 'claude' }],
    [7000, { pid: 7000, ppid: 1, stat: 'S', tty: '??', comm: app }],
  ]);
  collector.tick();
  assert.deepEqual(views(collector)[SID.busy].host, { kind: 'iterm', app: 'iTerm', tty: '/dev/ttys009' });
  store.markUnread(SID.busy, NOW, 'success');
  assert.deepEqual(collector.unreadTerminalTargets(), [{ sid: SID.busy, tty: '/dev/ttys009' }]);
});

// --- other agents ------------------------------------------------------------------------------

test('without a summary model, a finished turn is Done at once, with its last reply', () => {
  reset();
  writeRegistry(process.pid, { sessionId: SID.done, status: 'idle' });
  writeTranscript(SID.done, [human('u10', 'Rename the config file', 60), reply('Renamed it to beeplight.json.', 50), turnEnd(49)]);
  const { collector } = makeCollector({ available: false });
  collector.tick();
  const v = views(collector)[SID.done];
  assert.equal(v.state, 'done');
  assert.equal(v.outcome, 'success');
  assert.equal(v.pending, false);
  assert.equal(v.detail, 'Renamed it to beeplight.json.');
});

test('a Codex thread joins the board as its own agent, next to Claude', () => {
  reset();
  const codex = path.join(TMP, 'codex');
  fs.rmSync(codex, { recursive: true, force: true });
  fs.mkdirSync(path.join(codex, 'thread-writer-locks'), { recursive: true });
  // A UUIDv7 thread id made a minute ago; its rollout lives in that day's folder.
  const made = NOW - 60_000;
  const h = made.toString(16).padStart(12, '0');
  const tid = `${h.slice(0, 8)}-${h.slice(8, 12)}-7abc-8def-0123456789ab`;
  const d = new Date(made);
  const folder = path.join(codex, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const row = (secAgo, type, payload) => JSON.stringify({ timestamp: iso(secAgo), ordinal: 0, type, payload });
  fs.writeFileSync(path.join(folder, `rollout-x-${tid}.jsonl`), [
    row(60, 'session_meta', { id: tid, cwd: CWD, originator: 'codex-tui', thread_source: 'user' }),
    row(50, 'event_msg', { type: 'task_started', turn_id: 't1', turn_attribution: {} }),
    row(49, 'event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Port the cart to Rust' }] } }),
    row(45, 'event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'AgentMessage', id: 'm1', phase: 'commentary', content: [{ type: 'Text', text: 'Starting with the models.' }] } }),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(codex, 'thread-writer-locks', `${tid}.lock`), '');
  fs.mkdirSync(path.join(codex, 'app-server-daemon'), { recursive: true });
  fs.writeFileSync(path.join(codex, 'app-server-daemon', 'daemon.pid'), JSON.stringify({ pid: 900 }));

  const { collector, summarizer } = makeCollector({
    sources: (config, runner) => [new ClaudeCodeSource({ isOwnPid: (pid) => runner.isOwnPid(pid), config }), new CodexSource({ dir: codex, config })],
  });
  collector.ps = new Map([[900, { pid: 900, ppid: 1, stat: 'S', tty: '??', comm: '/x/bin/codex', start: NOW - 600_000 }]]);
  collector.tick();

  const id = `codex:${tid}`;
  const v = collector.snapshot.sessions.find((x) => x.id === id);
  assert.equal(v.agent, 'codex');
  assert.equal(v.agentName, 'Codex');
  assert.equal(v.state, 'doing');
  assert.equal(v.entrypoint, 'codex-cli');
  assert.equal(v.title, 'Port the cart to Rust');
  assert.equal(v.usage, null);

  const job = summarizer.requests.find((j) => j.sid === id);
  assert.deepEqual(job.agent, { name: 'Codex', speaker: 'Codex' });
  assert.match(job.buildInput(), /\nCodex: Starting with the models\.\n/);
  assert.match(job.buildInput(), /Current state: Codex is working on this turn/);

  assert.deepEqual(collector.focusPlan(id).steps, [{ do: 'host' }]);
  // Codex activity doesn't spend Claude limit probes.
  assert.equal(collector.recentlyActive(Date.now()), false);

  // Switched off, its tasks leave the board at once (not as closed cards); back on, they return.
  collector.config.set({ 'codex.monitor': 'off' });
  collector.tick();
  assert.equal(collector.snapshot.sessions.some((x) => x.agent === 'codex'), false);
  collector.config.set({ 'codex.monitor': 'on' });
  collector.tick();
  assert.equal(collector.snapshot.sessions.find((x) => x.id === id)?.state, 'doing');
});
