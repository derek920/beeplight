import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Config } from '../src/config/index.js';
import { Subagents } from '../src/sources/claude-code/subagents.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beeplight-subagents-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const entry = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content, ...extra }, timestamp: new Date().toISOString() });
const toolUse = (name, input = {}) => entry('assistant', [{ type: 'tool_use', id: `t-${name}`, name, input }], { stop_reason: 'tool_use' });
const result = (name) => entry('user', [{ type: 'tool_result', tool_use_id: `t-${name}`, content: 'ok' }]);

function running(lines) {
  const dir = fs.mkdtempSync(path.join(TMP, 'subagents-'));
  fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), lines.join('\n') + '\n');
  const subs = new Subagents(dir, new Config({ file: null, env: {} }));
  subs.poll();
  const [it] = subs.list(Date.now(), true);
  return { running: it.running, activity: it.activity };
}

test('a subagent is running while it works, and finished after its reply or its hand-back', () => {
  assert.deepEqual(running([toolUse('Read', { file_path: '/x/a.js' })]), { running: true, activity: 'Read · a.js' });
  assert.deepEqual(running([toolUse('Read', { file_path: '/x/a.js' }), result('Read')]), { running: true, activity: null });
  assert.equal(running([entry('assistant', [{ type: 'text', text: 'done' }], { stop_reason: 'end_turn' })]).running, false);
  // Newer Claude Code: the subagent ends by calling SubagentHandback, and its result comes last.
  assert.equal(running([toolUse('SubagentHandback', { report: 'done' })]).running, false);
  assert.equal(running([toolUse('SubagentHandback', { report: 'done' }), result('SubagentHandback')]).running, false);
});
