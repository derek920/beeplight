import assert from 'node:assert/strict';
import test from 'node:test';
import { setLang } from '../src/lib/i18n.js';
import { deriveStatus, endKey } from '../src/core/status.js';
import { emptyAnalysis } from '../src/sources/claude-code/transcript.js';

// The assertions below use the Chinese labels; the English ones are checked at the end.
setLang('zh-Hans');

function analysis({ pending, error, interrupted, lastTs = 100 } = {}) {
  const a = emptyAnalysis();
  a.promptCount = 1;
  a.lastPrompt = { uuid: 'u1', text: 'do it', ts: 10 };
  a.turn = { key: 'u1', startedAt: 10, endedAt: null, error: error ?? null, interrupted: !!interrupted, toolErrors: 0 };
  a.lastTs = lastTs;
  if (pending) a.pendingTools.set('t1', { id: 't1', name: 'Bash', brief: pending, ts: 50 });
  return a;
}

const reg = (status, extra = {}) => ({ status, statusUpdatedAt: 1000, ...extra });
const endSummary = (a, outcome, reason = 'r') => ({ kind: 'end', key: endKey(a), turnId: a.turn.key, outcome, reason });

test('registry waiting → Waiting with the pending tool as detail', () => {
  const s = deriveStatus({ live: true, reg: reg('waiting', { waitingFor: 'permission prompt' }), a: analysis({ pending: 'rm -rf build' }) });
  assert.equal(s.state, 'waiting');
  assert.equal(s.label, '等待授权');
  assert.equal(s.detail, 'Bash · rm -rf build');
});

test('registry busy → Doing, API retries take precedence in the detail', () => {
  const a = analysis({ pending: 'npm test' });
  assert.equal(deriveStatus({ live: true, reg: reg('busy'), a }).detail, 'Bash · npm test');
  a.apiRetry = { message: 'overloaded', attempt: 2, max: 10 };
  assert.match(deriveStatus({ live: true, reg: reg('busy'), a }).detail, /API 重试中 \(2\/10\)/);
});

test('idle without a verdict is a provisional success', () => {
  const s = deriveStatus({ live: true, reg: reg('idle'), a: analysis() });
  assert.deepEqual([s.state, s.outcome, s.pending], ['done', 'success', true]);
});

test('with original titles no verdict is coming, so the success is final', () => {
  const a = analysis();
  a.lastReply = { text: 'All **tests** pass', ts: 90 };
  const s = deriveStatus({ live: true, reg: reg('idle'), a, verdicts: false });
  assert.deepEqual([s.state, s.outcome, s.pending, s.detail], ['done', 'success', false, 'All tests pass']);
  // Hard failures still count without a verdict.
  assert.equal(deriveStatus({ live: true, reg: reg('idle'), a: analysis({ interrupted: true }), verdicts: false }).outcome, 'failed');
});

test('LLM verdicts map onto the board states', () => {
  const a = analysis();
  const cases = { blocked: ['waiting', null], working: ['doing', null], failed: ['done', 'failed'], done: ['done', 'success'] };
  for (const [outcome, [state, out]] of Object.entries(cases)) {
    const s = deriveStatus({ live: true, reg: reg('idle'), a, summary: endSummary(a, outcome) });
    assert.equal(s.state, state, outcome);
    assert.equal(s.outcome ?? null, out, outcome);
  }
});

test('a verdict from before Claude resumed work does not apply to a live session', () => {
  const a = analysis({ lastTs: 100 });
  const summary = endSummary(a, 'blocked');
  a.lastTs = 200; // more work happened in the same turn
  assert.equal(deriveStatus({ live: true, reg: reg('idle'), a, summary }).pending, true);
  // …but a closed session keeps the last verdict it got for this turn.
  assert.equal(deriveStatus({ live: false, lastRegStatus: 'idle', a, summary }).state, 'waiting');
});

test('hard failure signals win over the LLM', () => {
  const ok = (a) => endSummary(a, 'done');
  let a = analysis({ error: '529 overloaded' });
  assert.equal(deriveStatus({ live: true, reg: reg('idle'), a, summary: ok(a) }).label, 'API 错误');
  a = analysis({ interrupted: true });
  assert.equal(deriveStatus({ live: true, reg: reg('idle'), a, summary: ok(a) }).label, '已中断');
  a = analysis();
  const crashed = deriveStatus({ live: false, lastRegStatus: 'busy', a, summary: ok(a) });
  assert.deepEqual([crashed.outcome, crashed.label], ['failed', '中途退出']);
});

test('a question on the wrap-up card means Waiting, whatever the LLM said', () => {
  const a = analysis();
  a.turn.wrapUp = { recap: '还没拉 click_id 口径', ask: '要接着补 click_id 口径吗？', actions: ['补口径', '先写文档'] };
  const s = deriveStatus({ live: true, reg: reg('idle'), a, summary: endSummary(a, 'done') });
  assert.deepEqual([s.state, s.kind, s.label], ['waiting', 'question', '等你回复']);
  assert.equal(s.detail, '要接着补 click_id 口径吗？（补口径 / 先写文档）');
  // A recap without a question leaves the verdict to the summary.
  a.turn.wrapUp = { recap: '全部完成', ask: '', actions: [] };
  assert.equal(deriveStatus({ live: true, reg: reg('idle'), a, summary: endSummary(a, 'done') }).state, 'done');
});

// --- the turn is over, a background command still runs ("shell") ------------------------------

const bg = (title, extra = {}) => ({ id: title, title, state: 'running', service: false, ...extra });

test('a background command the turn waits for keeps the task in Doing', () => {
  const s = deriveStatus({ live: true, reg: reg('shell'), a: analysis(), background: [bg('真机对照测试')] });
  assert.deepEqual([s.state, s.label, s.detail, s.since], ['doing', '后台命令运行中', '真机对照测试', 1000]);
  const two = deriveStatus({ live: true, reg: reg('shell'), a: analysis(), background: [bg('构建'), bg('测试')] });
  assert.equal(two.detail, '构建，另有 1 条');
  // Claude Code says something runs, but its launch is older than the part of the transcript we read.
  assert.equal(deriveStatus({ live: true, reg: reg('shell'), a: analysis() }).detail, '有一条后台命令在运行');
  // Without a verdict coming it is still Doing: Claude Code's own reading of "shell".
  assert.equal(deriveStatus({ live: true, reg: reg('shell'), a: analysis(), background: [bg('构建')], verdicts: false }).state, 'doing');
});

test('a server or watcher left running does not keep the task in Doing', () => {
  const a = analysis();
  const server = bg('npm run dev', { service: true, ports: [5173] });
  const s = deriveStatus({ live: true, reg: reg('shell'), a, background: [server] });
  assert.deepEqual([s.state, s.outcome, s.pending], ['done', 'success', true]);
  assert.equal(deriveStatus({ live: true, reg: reg('shell'), a, background: [server], verdicts: false }).pending, false);
});

test('the verdict decides over a background command, and a closed session is not still working', () => {
  const a = analysis();
  // The model read the turn as done although a command still runs.
  assert.equal(deriveStatus({ live: true, reg: reg('shell'), a, summary: endSummary(a, 'done'), background: [bg('构建')] }).state, 'done');
  assert.equal(deriveStatus({ live: true, reg: reg('shell'), a, summary: endSummary(a, 'working') }).label, '后台进行中');
  const closed = deriveStatus({ live: false, lastRegStatus: 'shell', a, summary: endSummary(a, 'working', '等真机测完') });
  assert.deepEqual([closed.state, closed.outcome, closed.label, closed.detail], ['done', 'failed', '未完成', '等真机测完']);
});

test('background jobs use the daemon state when not live', () => {
  const s = deriveStatus({ live: false, job: { state: 'blocked', needs: 'confirm: reply?', updatedAt: 5 } });
  assert.deepEqual([s.state, s.detail], ['waiting', 'confirm: reply?']);
});

test('a session that never got a prompt is idle', () => {
  assert.equal(deriveStatus({ live: true, reg: reg('idle'), a: emptyAnalysis() }).state, 'idle');
});

test('labels follow the service language', () => {
  const s = () => deriveStatus({ live: true, reg: reg('waiting', { waitingFor: 'permission prompt' }), a: analysis() });
  try {
    setLang('en');
    assert.equal(s().label, 'Needs permission');
    const a = analysis();
    a.turn.wrapUp = { recap: '', ask: 'Fill in the click_id metric?', actions: ['Fill it in', 'Write the doc first'] };
    assert.equal(deriveStatus({ live: true, reg: reg('idle'), a }).detail, 'Fill in the click_id metric? (Fill it in / Write the doc first)');
  } finally {
    setLang('zh-Hans');
  }
  assert.equal(s().label, '等待授权');
});
