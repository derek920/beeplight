import assert from 'node:assert/strict';
import test from 'node:test';
import { setLang } from '../src/lib/i18n.js';
import { emptyAnalysis, ingestLine, lastPendingTool, Transcript } from '../src/sources/claude-code/transcript.js';

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

// --- background commands -----------------------------------------------------------------------

const bgLaunch = (id, input, s) => assistant([{ type: 'tool_use', id, name: 'Bash', input: { run_in_background: true, ...input } }], s);
const bgStarted = (toolId, taskId, s, { viaResult = true } = {}) =>
  JSON.stringify({
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/x/${taskId}.output` }] },
    ...(viaResult ? { toolUseResult: { stdout: '', backgroundTaskId: taskId } } : {}),
    timestamp: ts(s),
  });
const notification = (taskId, status, summary, s) =>
  JSON.stringify({
    isSidechain: false,
    type: 'user',
    origin: { kind: 'task-notification' },
    message: { content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` },
    timestamp: ts(s),
  });

test('a command started in the background is tracked until its notification', () => {
  const a = feed([
    human('u1', '跑一下基准测试', 1),
    bgLaunch('t1', { command: 'npm run bench', description: 'Run the benchmark' }, 2),
    bgStarted('t1', 'b1', 3),
    bgLaunch('t2', { command: 'npm run dev' }, 4),
    bgStarted('t2', 'b2', 5, { viaResult: false }), // older versions: the id only in the text
  ]);
  assert.deepEqual([...a.background.keys()], ['b1', 'b2']);
  assert.deepEqual(
    { ...a.background.get('b1') },
    { id: 'b1', command: 'npm run bench', title: 'Run the benchmark', startedAt: Date.parse(ts(3)), endedAt: null, status: 'running', exitCode: null },
  );
  assert.equal(a.background.get('b2').title, 'npm run dev');

  ingestLine(a, notification('b1', 'completed', 'Background command "Run the benchmark" completed (exit code 0)', 9));
  assert.deepEqual([a.background.get('b1').status, a.background.get('b1').exitCode, a.background.get('b1').endedAt], ['completed', 0, Date.parse(ts(9))]);
  ingestLine(a, notification('b2', 'failed', 'Background command "npm run dev" failed with exit code 144', 10));
  assert.deepEqual([a.background.get('b2').status, a.background.get('b2').exitCode], ['failed', 144]);
  // A notification about a subagent (not one of ours) changes nothing.
  ingestLine(a, notification('a77', 'completed', 'Agent "Review" finished', 11));
  assert.equal(a.background.size, 2);
});

test('a background command ends as stopped when killed, or by a TaskStop call', () => {
  const a = feed([
    human('u1', '起服务', 1),
    bgLaunch('t1', { command: 'node server.js' }, 2),
    bgStarted('t1', 'b1', 3),
    bgLaunch('t2', { command: 'tail -f log' }, 4),
    bgStarted('t2', 'b2', 5),
    notification('b1', 'killed', 'Background command "node server.js" was stopped', 6),
    assistant([{ type: 'tool_use', id: 't3', name: 'TaskStop', input: { task_id: 'b2' } }], 7),
    toolResult('t3', 8),
  ]);
  assert.equal(a.background.get('b1').status, 'stopped');
  assert.equal(a.background.get('b2').status, 'stopped');
  assert.equal(a.background.get('b2').endedAt, Date.parse(ts(8)));
});

test('a foreground Bash call or a failed launch is not a background command', () => {
  const a = feed([
    human('u1', '测试', 1),
    assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], 2),
    toolResult('t1', 3),
    bgLaunch('t2', { command: 'npm run dev' }, 4),
    toolResult('t2', 5, true),
    // A foreground command whose output happens to read like a launch (e.g. grepping a transcript).
    assistant([{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'grep -r background logs' } }], 6),
    bgStarted('t3', 'b9', 7, { viaResult: false }),
  ]);
  assert.equal(a.background.size, 0);
});

test('a notification that arrives mid-turn, as a queued attachment, ends the command too', () => {
  const a = feed([human('u1', '测一下', 1), bgLaunch('t1', { command: 'scripts/device.sh', description: '真机测量' }, 2), bgStarted('t1', 'b1', 3)]);
  const prompt = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "真机测量" completed (exit code 0)</summary>\n</task-notification>';
  ingestLine(a, JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt }, timestamp: ts(9) }));
  assert.deepEqual([a.background.get('b1').status, a.background.get('b1').exitCode], ['completed', 0]);
  assert.match(a.timeline.at(-1).text, /后台任务完成：Background command "真机测量" completed/);
  // A message the user typed mid-turn is queued the same way, and is not a notification.
  ingestLine(a, JSON.stringify({ type: 'attachment', isSidechain: false, attachment: { type: 'queued_command', commandMode: 'prompt', prompt: '<task-notification>' }, timestamp: ts(10) }));
  assert.equal(a.timeline.length, 3);
});
