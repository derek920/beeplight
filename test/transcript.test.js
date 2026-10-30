import assert from 'node:assert/strict';
import test from 'node:test';
import { setLang } from '../src/i18n.js';
import { emptyAnalysis, ingestLine, lastPendingTool, Transcript } from '../src/transcript.js';

// Timeline notes are asserted in Chinese.
setLang('zh-Hans');

const ts = (s) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();

const human = (uuid, text, s) =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', uuid, origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: ts(s) });
const assistant = (content, s, extra = {}) =>
  JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'assistant', message: { role: 'assistant', content }, timestamp: ts(s), ...extra });
const toolResult = (id, s, isError = false) =>
  JSON.stringify({ parentUuid: 'p', isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] }, timestamp: ts(s) });

function feed(lines) {
  const a = emptyAnalysis();
  for (const l of lines) ingestLine(a, l);
  return a;
}

test('a human prompt opens a turn', () => {
  const a = feed([human('u1', '修一下登录页', 1)]);
  assert.equal(a.promptCount, 1);
  assert.equal(a.turn.key, 'u1');
  assert.equal(a.lastPrompt.text, '修一下登录页');
});

test('task notifications, meta and peer messages are not prompts', () => {
  const a = feed([
    human('u1', '开始', 1),
    JSON.stringify({ type: 'user', isSidechain: false, origin: { kind: 'task-notification' }, message: { content: '<task-notification><status>completed</status><summary>build ok</summary></task-notification>' }, timestamp: ts(2) }),
    JSON.stringify({ type: 'user', isSidechain: false, isMeta: true, message: { content: 'Base directory for this skill' }, timestamp: ts(3) }),
    JSON.stringify({ type: 'user', isSidechain: false, origin: { kind: 'peer' }, message: { content: 'hi' }, timestamp: ts(4) }),
  ]);
  assert.equal(a.promptCount, 1);
  assert.equal(a.turn.key, 'u1');
  assert.match(a.timeline.at(-1).text, /后台任务完成：build ok/);
});

test('slash commands show as the command', () => {
  const a = feed([human('u1', '<command-message>init</command-message>\n<command-name>/init</command-name>\n<command-args></command-args>', 1)]);
  assert.equal(a.lastPrompt.text, '/init');
});

test('tool_use stays pending until its result, errors are counted', () => {
  const a = feed([
    human('u1', 'run tests', 1),
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }], 2),
  ]);
  assert.equal(lastPendingTool(a).brief, 'Run tests');
  ingestLine(a, toolResult('t1', 3, true));
  assert.equal(lastPendingTool(a), null);
  assert.equal(a.turn.toolErrors, 1);
});

test('mcp tool names are shortened', () => {
  const a = feed([human('u1', 'x', 1), assistant([{ type: 'tool_use', id: 't', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://a.b' } }], 2)]);
  assert.equal(lastPendingTool(a).name, 'navigate');
});

test('interrupt, api error and recovery', () => {
  const a = feed([human('u1', 'go', 1), assistant([{ type: 'text', text: 'API Error: 529 overloaded' }], 2, { isApiErrorMessage: true })]);
  assert.match(a.turn.error, /529/);
  ingestLine(a, assistant([{ type: 'text', text: '好了' }], 3));
  assert.equal(a.turn.error, null);
  ingestLine(a, JSON.stringify({ type: 'user', isSidechain: false, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: ts(4) }));
  assert.equal(a.turn.interrupted, true);
});

test('turn_duration closes the turn; a new prompt starts a fresh one', () => {
  const a = feed([human('u1', 'a', 1), JSON.stringify({ type: 'system', subtype: 'turn_duration', isSidechain: false, durationMs: 900, timestamp: ts(2) })]);
  assert.ok(a.turn.endedAt);
  ingestLine(a, human('u2', 'b', 3));
  assert.equal(a.turn.key, 'u2');
  assert.equal(a.turn.endedAt, null);
});

test('a wrap-up card with a question is captured on the turn', () => {
  const a = feed([
    human('u1', '整理实验数据', 1),
    assistant([{ type: 'tool_use', id: 'w1', name: 'mcp__ccd_turn__wrap_up', input: { recap: '看板已整理，click_id 口径还没拉', ask: '要接着补 click_id 口径吗？', actions: [{ label: '补口径', message: '...' }, { label: '先写文档', message: '...' }] } }], 2),
    assistant([{ type: 'text', text: '整理好了，详见上表。' }], 3),
  ]);
  assert.equal(a.turn.wrapUp.ask, '要接着补 click_id 口径吗？');
  assert.deepEqual(a.turn.wrapUp.actions, ['补口径', '先写文档']);
  assert.equal(lastPendingTool(a), null, 'wrap-up is not tracked as a running tool');
  assert.ok(a.timeline.some((x) => x.k === 'note' && x.text.includes('向用户提问：要接着补 click_id 口径吗？')));
});

test('sidechain lines and skipped types are ignored', () => {
  const a = feed([
    JSON.stringify({ type: 'user', isSidechain: true, origin: { kind: 'human' }, message: { content: 'sub' }, timestamp: ts(1) }),
    '{"type":"api-request-blob","message":"huge"}',
    'not json',
  ]);
  assert.equal(a.promptCount, 0);
});

test('a multi-byte character split across reads survives', () => {
  const t = new Transcript('/nonexistent');
  const buf = Buffer.from(human('u1', '中文标题', 1) + '\n', 'utf8');
  const cut = buf.indexOf(Buffer.from('文')) + 1; // inside the 3-byte sequence
  t.ingestBuffer(buf.subarray(0, cut));
  assert.equal(t.a.promptCount, 0);
  t.ingestBuffer(buf.subarray(cut));
  assert.equal(t.a.lastPrompt.text, '中文标题');
});

test('starting mid-file drops the partial first line', () => {
  const t = new Transcript('/nonexistent');
  t.skipPartial = true;
  t.ingestBuffer(Buffer.from(`ial":"garbage"}\n${human('u9', 'tail prompt', 5)}\n`));
  assert.equal(t.a.promptCount, 1);
  assert.equal(t.a.lastPrompt.uuid, 'u9');
});
