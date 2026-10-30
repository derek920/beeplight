import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyDay, Timeline } from '../src/core/timeline.js';

const T0 = new Date(2026, 9, 28, 10, 0, 0).getTime();
const min = (n) => T0 + n * 60_000;

test('transitions build a trajectory and today’s totals', () => {
  const tl = new Timeline(emptyDay(T0));
  const h = [];
  tl.track(h, { state: 'doing', since: min(0) }, min(0));
  tl.track(h, { state: 'waiting', kind: 'prompt', since: min(5) }, min(5));
  tl.track(h, { state: 'doing', since: min(7) }, min(7));
  tl.track(h, { state: 'done', outcome: 'success', since: min(10) }, min(10));
  assert.deepEqual(h.map((e) => e.k), ['doing', 'waiting', 'doing', 'done:success']);
  assert.equal(tl.daily.workMs, 8 * 60_000);
  assert.equal(tl.daily.waitMs, 2 * 60_000);
  assert.equal(tl.daily.longestWaitMs, 2 * 60_000);
  assert.equal(tl.daily.done, 1);
});

test('repeated views of the same state do not add entries', () => {
  const tl = new Timeline(emptyDay(T0));
  const h = [];
  assert.equal(tl.track(h, { state: 'doing', since: min(0) }, min(0)), true);
  assert.equal(tl.track(h, { state: 'doing', since: min(0) }, min(1)), false);
  assert.equal(h.length, 1);
});

test('a provisional done is rewritten by the verdict instead of leaving a sliver', () => {
  const tl = new Timeline(emptyDay(T0));
  const h = [];
  tl.track(h, { state: 'doing', since: min(0) }, min(0));
  tl.track(h, { state: 'done', outcome: 'success', pending: true, since: min(4) }, min(4));
  assert.equal(tl.daily.done, 0, 'not counted while pending');
  tl.track(h, { state: 'waiting', kind: 'question', since: min(4) }, min(4.1));
  assert.deepEqual(h.map((e) => e.k), ['doing', 'waiting:q']);
  assert.equal(tl.daily.done, 0);
  // …and a pending verdict that confirms success is counted once.
  const h2 = [];
  tl.track(h2, { state: 'done', outcome: 'success', pending: true, since: min(5) }, min(5));
  tl.track(h2, { state: 'done', outcome: 'success', since: min(5) }, min(5.1));
  tl.track(h2, { state: 'done', outcome: 'success', since: min(5) }, min(6));
  assert.equal(tl.daily.done, 1);
});

test('questions are drawn as waiting but not counted as time blocked on you', () => {
  const tl = new Timeline(emptyDay(T0));
  const h = [];
  tl.track(h, { state: 'waiting', kind: 'question', since: min(0) }, min(0));
  tl.track(h, { state: 'doing', since: min(30) }, min(30));
  assert.equal(tl.daily.waitMs, 0);
  assert.equal(tl.today([h], min(31)).workMs, 60_000);
});

test('open segments count toward today, clipped at midnight', () => {
  const tl = new Timeline(emptyDay(T0));
  const yesterday = new Date(2026, 9, 27, 23, 0, 0).getTime();
  const h = [{ k: 'waiting', t: yesterday }];
  const d = tl.today([h], min(0)); // 10:00 today
  assert.equal(d.waitMs, 10 * 3600_000);
  assert.equal(d.longestWaitMs, 11 * 3600_000);
});

test('finishes observed long after the fact are not counted as today’s', () => {
  const tl = new Timeline(emptyDay(T0));
  tl.track([], { state: 'done', outcome: 'success', since: T0 - 3 * 86400_000 }, T0);
  assert.equal(tl.daily.done, 0);
});
