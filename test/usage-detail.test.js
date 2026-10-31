import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDetail, edges, modelName, STEPS } from '../src/core/usage-detail.js';
import { recordFromUsage, UsageIndex } from '../src/sources/claude-code/usage.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Today at h:m on the local clock. */
function at(h, m = 0) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return +d;
}

test('buckets follow the local clock; the first and last may be partial', () => {
  const from = at(10, 10);
  assert.deepEqual(edges(from, from + 40 * MIN, STEPS['5h']['10m']), [from, at(10, 20), at(10, 30), at(10, 40), at(10, 50)]);
  assert.deepEqual(edges(from, at(12, 30), STEPS['5h']['1h']), [from, at(11), at(12), at(12, 30)]);
  // A window starting on a boundary has no empty first bucket.
  assert.deepEqual(edges(at(11), at(12), STEPS['5h']['30m']), [at(11), at(11, 30), at(12)]);
  const week = edges(from, from + 7 * 24 * HOUR, STEPS['7d']['1d']);
  assert.equal(week.length, 9, 'seven midnights inside, plus both ends');
  assert.equal(new Date(week[1]).getHours(), 0);
  assert.ok(week.every((t, i) => i === 0 || t > week[i - 1]));
});

test('model ids become short names', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelName('claude-haiku-5-5-20261001'), 'Haiku 5.5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(modelName('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(modelName('mystery'), 'mystery');
});

test('the detail view splits a window by bucket, model, project and session', () => {
  const start = at(10);
  const end = start + 5 * HOUR;
  const now = start + 2 * HOUR;
  const usage = new UsageIndex('/nonexistent');
  const add = (sid, cwd, model, t, out) => {
    const s = usage.session(sid);
    s.cwd = cwd;
    s.aiTitle = `title ${sid}`;
    s.records.push(recordFromUsage(model, { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 1000 }, t));
    s.lastAt = Math.max(s.lastAt, t);
  };
  add('a', '/w/site', 'claude-opus-5-5', start + 5 * MIN, 2000);
  add('a', '/w/site', 'claude-opus-5-5-20261001', start + 70 * MIN, 2000);
  add('b', '/w/site', 'claude-haiku-5-5', start + 75 * MIN, 500);
  add('c', '/w/app', 'claude-opus-5-5', start + 80 * MIN, 8000);
  add('c', '/w/app', 'claude-opus-5-5', start - HOUR, 9999); // before the window
  const limits = {
    windows: () => ({ fiveHour: { start, end, aligned: true } }),
    snapshot: () => ({ fiveHour: { utilization: 0.4, resetsAt: end } }),
    history: () => [{ t: start + HOUR, u: 0.1 }, { t: now, u: 0.4 }],
  };
  const d = buildDetail({ usage, limits, titleOf: (s) => s.title, live: (sid) => sid === 'c' }, { window: '5h', step: '1h', now });

  assert.deepEqual(d.steps, ['10m', '30m', '1h']);
  assert.equal(d.buckets.length, 5);
  assert.deepEqual(d.buckets.map((b) => b.requests), [1, 3, 0, 0, 0]);
  assert.deepEqual(d.buckets[1].top.map((x) => x.sid), ['c', 'a', 'b'], 'by cost, most first');
  assert.equal(d.total.requests, 4);
  assert.equal(d.total.out, 12500);
  assert.equal(d.total.cr, 4000);
  assert.deepEqual(d.models.map((m) => [m.model, m.requests]), [['Opus 5.5', 3], ['Haiku 5.5', 1]], 'dated ids merge');
  assert.deepEqual(d.projects.map((p) => [p.project, p.sessions]), [['app', 1], ['site', 2]]);
  assert.deepEqual(d.sessions.map((s) => s.sid), ['c', 'a', 'b']);
  assert.equal(d.sessions[0].live, true);
  const shares = d.sessions.reduce((sum, s) => sum + s.share, 0);
  assert.ok(Math.abs(shares - 0.4) < 1e-3, 'session shares add up to the limit used');
  assert.equal(d.utilization.length, 2);
});
