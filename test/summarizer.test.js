// The text sent to the summarizer model, pinned byte for byte: titles and verdicts of every
// session depend on it, and refactors must not move it. To accept an intended change, run
// UPDATE_GOLDEN=1 node --test test/summarizer.test.js and review the diff of test/fixtures/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setLang } from '../src/lib/i18n.js';
import { buildSummaryInput, systemPrompt } from '../src/services/summarizer.js';
import { emptyAnalysis, ingestLine } from '../src/sources/claude-code/transcript.js';

setLang('en');

const DIR = path.join(import.meta.dirname, 'fixtures', 'summarizer');

function golden(name, actual) {
  const file = path.join(DIR, name);
  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, actual);
  }
  assert.equal(actual, fs.readFileSync(file, 'utf8'), `${name} changed`);
}

const ts = (s) => new Date(Date.UTC(2026, 9, 28, 10, 0, s)).toISOString();
const human = (uuid, text, s) => ({ type: 'user', isSidechain: false, uuid, origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: ts(s) });
const assistant = (content, s) => ({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content }, timestamp: ts(s) });
const result = (id, s, isError = false) => ({
  type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] }, timestamp: ts(s),
});

function conversation() {
  const a = emptyAnalysis();
  const lines = [
    { type: 'user', isSidechain: false, isCompactSummary: true, message: { role: 'user', content: 'Earlier: set up the repo and CI.' }, timestamp: ts(0) },
    human('u1', 'Add login with email and password', 1),
    assistant([{ type: 'text', text: 'I will add a login form and an auth route.' }], 2),
    assistant([{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/repo/src/login.tsx' } }], 3),
    result('t1', 4),
    assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }], 5),
    result('t2', 6, true),
    { type: 'system', subtype: 'away_summary', isSidechain: false, content: 'Login form done; tests failing on the auth route. (disable recaps in /config)', timestamp: ts(7) },
    human('u2', 'Use bcrypt for the hashes', 8),
    assistant([{ type: 'text', text: 'Switched to bcrypt. Should I also add rate limiting to the login route?' }], 9),
    { type: 'system', subtype: 'turn_duration', isSidechain: false, durationMs: 8000, timestamp: ts(10) },
  ];
  for (const l of lines) ingestLine(a, JSON.stringify(l));
  return a;
}

test('system prompt, English and Chinese output', () => {
  golden('system-prompt.en.txt', systemPrompt('en'));
  golden('system-prompt.zh-Hans.txt', systemPrompt('zh-Hans'));
});

test('summary input for a session at each state', () => {
  const a = conversation();
  const names = ['Login work', null, 'Auth feature', 'Login work'];
  for (const state of ['busy', 'idle', 'ended']) {
    golden(`input.${state}.txt`, buildSummaryInput({ cwd: '/repo', a, names, state }));
  }
  golden('input.waiting.txt', buildSummaryInput({ cwd: '/repo', a, names, state: 'waiting', waitingFor: 'permission prompt' }));
});

test('a Codex session is described as Codex, everything else the same', () => {
  const codex = { name: 'Codex', speaker: 'Codex' };
  golden('system-prompt.codex.en.txt', systemPrompt('en', codex));
  golden('input.codex.busy.txt', buildSummaryInput({ cwd: '/repo', a: conversation(), names: ['Login work'], state: 'busy', speaker: 'Codex' }));
});
