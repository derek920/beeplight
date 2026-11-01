// Codex rollouts → the shared analysis. Lines are synthetic, in the shape Codex 0.166 writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Config } from '../src/config/index.js';
import { setLang } from '../src/lib/i18n.js';
import { ingestLine, Rollout } from '../src/sources/codex/rollout.js';
import { asksUser } from '../src/sources/codex/index.js';

setLang('en');

const T0 = Date.UTC(2026, 10, 1, 7, 0, 0);
let ordinal = 0;
const line = (s, type, payload) => JSON.stringify({ timestamp: new Date(T0 + s * 1000).toISOString(), ordinal: ordinal++, type, payload });

const meta = (originator = 'codex-tui') =>
  line(0, 'session_meta', { id: 'thread-1', cwd: '/repo', originator, source: 'vscode', thread_source: 'user', base_instructions: 'x'.repeat(2000) });
const context = (s, policy = 'on-request') => line(s, 'turn_context', { turn_id: 't1', cwd: '/repo/app', approval_policy: policy, model: 'gpt' });
const started = (s, turn = 't1', parent = null) =>
  line(s, 'event_msg', { type: 'task_started', turn_id: turn, root_turn_id: turn, turn_attribution: { turn_trigger: 'user', parent_turn_id: parent } });
const item = (s, it, turn = 't1') => line(s, 'event_msg', { type: 'item_completed', thread_id: 'thread-1', turn_id: turn, item: it });
const user = (s, text, turn) => item(s, { type: 'UserMessage', id: `u${s}`, content: [{ type: 'text', text }] }, turn);
const agent = (s, text, phase = 'final_answer', turn) => item(s, { type: 'AgentMessage', id: `m${s}`, content: [{ type: 'Text', text }], phase }, turn);
const command = (s, cmd, status = 'completed', exit = 0) =>
  item(s, { type: 'CommandExecution', id: `c${s}`, command: ['/bin/zsh', '-lc', cmd], status, exit_code: exit });
const exec = (s, id, code) => line(s, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: id, name: 'exec', input: code });
const output = (s, id) => line(s, 'response_item', { type: 'custom_tool_call_output', id: `o${s}`, call_id: id, output: 'Script completed' });
const complete = (s, turn = 't1') => line(s, 'event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'All done.', duration_ms: 5000 });
const aborted = (s, reason = 'interrupted') => line(s, 'event_msg', { type: 'turn_aborted', turn_id: 't1', reason, duration_ms: 3000 });
// Model input: injected context is role=user too, and must never count as a prompt.
const injected = (s) =>
  line(s, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/repo</cwd></environment_context>' }] });

function feed(lines) {
  const r = { a: null, meta: null, cwd: null, policy: null, escalation: null, subTurn: null };
  const rollout = new Rollout('/nonexistent', new Config({ file: null, env: {} }));
  for (const l of lines) ingestLine(rollout, l);
  Object.assign(r, rollout);
  return rollout;
}

test('a turn: the user request opens it, the final answer and task_complete close it', () => {
  const r = feed([
    meta(), started(1), context(1), injected(1), user(2, 'Add a dark mode toggle'),
    agent(3, 'I will add it to the header.', 'commentary'), command(5, 'npm test'), agent(8, 'Dark mode is in.'), complete(9),
  ]);
  assert.deepEqual(r.meta, { id: 'thread-1', cwd: '/repo', originator: 'codex-tui', threadSource: 'user' });
  assert.equal(r.cwd, '/repo/app');
  assert.equal(r.policy, 'on-request');
  const a = r.a;
  assert.equal(a.promptCount, 1);
  assert.equal(a.lastPrompt.text, 'Add a dark mode toggle');
  assert.equal(a.turn.key, 't1');
  assert.equal(a.turn.endedAt, T0 + 9000);
  assert.equal(a.turn.durationMs, 5000);
  assert.equal(a.lastReply.text, 'Dark mode is in.');
  assert.deepEqual(a.timeline.map((x) => (x.k === 'tool' ? `${x.tool.name}: ${x.tool.brief}` : x.k)), ['prompt', 'reply', 'Shell: npm test', 'reply']);
  assert.equal(a.pendingTools.size, 0);
});

test('a tool call is pending until its output; a turn end clears what is left', () => {
  const r = feed([meta(), started(1), user(2, 'go'), exec(3, 'call-1', 'text(await tools.exec_command({cmd:"npm run build"}))')]);
  assert.equal(r.a.pendingTools.get('call-1').brief, 'npm run build');
  ingestLine(r, output(4, 'call-1'));
  assert.equal(r.a.pendingTools.size, 0);
  ingestLine(r, exec(5, 'call-2', 'text(await tools.exec_command({cmd:"sleep 100"}))'));
  ingestLine(r, complete(6));
  assert.equal(r.a.pendingTools.size, 0, 'dangling call cleared at the end of the turn');
});

test('a call that asks to leave the sandbox is a possible approval wait, with its justification', () => {
  const code = 'text(await tools.exec_command({cmd:"touch ~/x.txt",sandbox_permissions:"require_escalated",justification:"Allow creating ~/x.txt in your home directory?"}))';
  const r = feed([meta(), started(1), context(1), user(2, 'touch ~/x.txt'), exec(3, 'call-9', code)]);
  assert.deepEqual(r.escalation, { callId: 'call-9', kind: 'sandbox', ts: T0 + 3000, justification: 'Allow creating ~/x.txt in your home directory?' });
  ingestLine(r, output(60, 'call-9'));
  assert.equal(r.escalation, null, 'its output means the user answered');

  const json = feed([meta(), started(1), user(2, 'x'), line(3, 'response_item', { type: 'function_call', call_id: 'f1', name: 'request_permissions', arguments: '{"justification":"Need network"}' })]);
  assert.equal(json.escalation.kind, 'permissions');
  assert.equal(json.escalation.justification, 'Need network');
});

test('whether Codex stops for the user depends on the approval policy', () => {
  const sandbox = { kind: 'sandbox' };
  const perms = { kind: 'permissions' };
  assert.equal(asksUser('on-request', sandbox), true);
  assert.equal(asksUser('never', sandbox), false);
  const granular = { granular: { sandbox_approval: false, request_permissions: true } };
  assert.equal(asksUser(granular, sandbox), false, 'sandbox escalations fail at once');
  assert.equal(asksUser(granular, perms), true);
  assert.equal(asksUser(null, sandbox), true);
});

test('an interrupt fails the turn; items that land after it do not move the conversation', () => {
  const r = feed([meta(), started(1), user(2, 'count to 60'), exec(3, 'c1', 'text(await tools.exec_command({cmd:"for i in {1..60}; do echo $i; sleep 1; done"}))'), aborted(20)]);
  assert.equal(r.a.turn.interrupted, true);
  assert.equal(r.a.timeline.at(-1).text, 'Interrupted by the user');
  const lastTs = r.a.lastTs;
  assert.equal(ingestLine(r, command(40, 'for i in {1..60}; do echo $i; sleep 1; done', 'failed', 130)), false);
  assert.equal(r.a.lastTs, lastTs);

  const other = feed([meta(), started(1), user(2, 'x'), aborted(5, 'replaced')]);
  assert.equal(other.a.turn.interrupted, false);
  assert.equal(other.a.turn.error, 'replaced');
});

test('a failed command counts as a tool error; a new turn starts fresh', () => {
  const r = feed([meta(), started(1), user(2, 'build'), command(3, 'git pull', 'failed', 128), complete(4), started(10, 't2'), user(11, 'again', 't2')]);
  assert.equal(r.a.turn.key, 't2');
  assert.equal(r.a.turn.toolErrors, 0);
  assert.equal(r.a.turn.endedAt, null);
  assert.equal(r.a.promptCount, 2);
  assert.equal(r.a.recentTools[0].error, true);
});

test("a subagent's turn is not the user's task", () => {
  const r = feed([meta(), started(1), user(2, 'main task'), started(3, 'sub', 't1'), user(4, 'subagent prompt', 'sub'), complete(5, 'sub')]);
  assert.equal(r.a.promptCount, 1);
  assert.equal(r.a.turn.key, 't1');
  assert.equal(r.a.turn.endedAt, null);
});

test('big model-input lines are skipped unparsed; a tail read still gets the session header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeplight-rollout-'));
  const file = path.join(dir, 'rollout.jsonl');
  const filler = line(1, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'y'.repeat(400_000) }] });
  fs.writeFileSync(file, [meta('Codex Desktop'), filler, filler, filler, started(2), user(3, 'tail prompt'), ''].join('\n'));
  // A 1 MB tail: the header line is far behind it.
  const config = new Config({ file: null, env: { BEEPLIGHT_TRANSCRIPT_INITIAL_TAIL_MB: '1' } });
  const r = new Rollout(file, config);
  assert.equal(r.poll(), true);
  assert.equal(r.meta.originator, 'Codex Desktop');
  assert.equal(r.a.lastPrompt.text, 'tail prompt');
  fs.rmSync(dir, { recursive: true, force: true });
});
