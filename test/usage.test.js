import assert from 'node:assert/strict';
import test from 'node:test';
import { costOf, recordFromUsage, UsageIndex } from '../src/sources/claude-code/usage.js';

const T0 = new Date(2026, 9, 28, 10, 0, 0).getTime();
const min = (n) => T0 + n * 60_000;

function index(records) {
  const u = new UsageIndex('/nonexistent');
  const s = u.session('s1');
  for (const [t, usage] of records) s.records.push(recordFromUsage('claude-opus-5-5', usage, t));
  return u;
}

test('burn: 24 h in 3-minute bars of tokens per hour, split by cache', () => {
  const u = index([
    [min(-4), { input_tokens: 30, output_tokens: 600, cache_read_input_tokens: 3000, cache_creation_input_tokens: 300 }],
    [min(-5), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3000 }],
  ]);
  const b = u.burn('24h', min(0) + 1);
  assert.equal(b.cr.length, 480);
  assert.equal(b.from, min(3) - 24 * 3600_000);
  // 10:00 + 1 ms falls in the last bar (10:00–10:03); 9:55 and 9:56 fall in 9:54–9:57.
  const i = 480 - 3;
  assert.equal(b.cr[i], 120_000); // 6000 in 3 minutes
  assert.equal(b.cw[i], 6000);
  assert.equal(b.in[i], 600);
  assert.equal(b.out[i], 12_000);
  assert.deepEqual({ ...b.totals, cost: undefined }, { cr: 6000, cw: 300, in: 30, out: 600, cost: undefined });
});

test('burn: the line averages over its span', () => {
  const u = index([[min(-30), { input_tokens: 6000, output_tokens: 1200 }]]);
  const b = u.burn('24h', min(0) - 1); // the last bar (9:57–10:00) is all but full
  const last = b.avgIn.length - 1;
  assert.equal(b.avgIn[last], 6000);
  assert.equal(b.avgOut[last], 1200);
  assert.equal(b.avgIn[0], 0);
});

test('burn: the bar still filling counts only the time it has had', () => {
  const u = index([[min(0), { input_tokens: 0, output_tokens: 900 }]]);
  const b = u.burn('5h', min(0.5));
  assert.equal(b.out.length, 300);
  assert.equal(b.out[b.out.length - 1], 108_000); // 900 in half a minute
});

test('burn: 7 days in hourly bars, with cost per hour over the last 6 hours', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  const u = index([
    [min(-60 * 30), usage], // 30 hours ago: in the chart, outside the line's span
    [min(-150), usage],
    [min(-90), usage],
  ]);
  const b = u.burn('7d', min(0) - 1);
  assert.equal(b.cr.length, 168);
  assert.equal(b.out[168 - 30], 1000); // the last bar starts an hour ago
  const one = costOf('claude-opus-5-5', { in: 1000, out: 1000, cw5: 0, cw1: 0, cr: 0 });
  assert.equal(b.totals.cost, Math.round(3 * one * 100) / 100);
  assert.equal(b.costPerHour, Math.round(((2 * one) / 6) * 100) / 100);
  assert.equal(u.burn('nonsense', min(0)).range, '24h');
});

test('burn: today runs from midnight on an axis fixed to the whole day', () => {
  const u = index([
    [min(-11 * 60), { input_tokens: 0, output_tokens: 500 }], // 23:00 yesterday
    [min(-30), { input_tokens: 0, output_tokens: 300 }],
  ]);
  const b = u.burn('today', min(0) + 1);
  const midnight = new Date(2026, 9, 28).getTime();
  assert.equal(b.from, midnight);
  assert.equal(b.to, new Date(2026, 9, 29).getTime());
  assert.equal(b.out.length, 10 * 20 + 1); // 3-minute bars up to the one holding now
  assert.equal(b.totals.out, 300);
  assert.equal(b.out[(10 * 60 - 30) / 3], 6000);
});

test('daily: one bar per local day, with the trailing 7-day mean', () => {
  const day = (n, h = 12) => new Date(2026, 9, 28 + n, h).getTime();
  const u = new UsageIndex('/nonexistent');
  const s = u.session('s1');
  for (const [t, out] of [[day(-27), 700], [day(-1), 70], [day(0, 3), 7], [day(0, 9), 7], [day(-28), 999]]) {
    s.records.push(recordFromUsage('claude-opus-5-5', { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 100 }, t));
  }
  s.lastAt = day(0, 9);
  const d = u.daily(28, day(0, 10));
  assert.equal(d.out.length, 28);
  assert.equal(d.from, new Date(2026, 9, 1).getTime());
  assert.equal(d.out[0], 700);
  assert.equal(d.out[26], 70);
  assert.equal(d.out[27], 14); // today so far
  assert.equal(d.cr[27], 200);
  assert.equal(d.totals.out, 784); // the record from 28 days back is outside the span
  assert.equal(d.avgOut[0], 700);
  assert.equal(d.avgOut[27], Math.round((70 + 14) / 7)); // days 21..27, only the last two have data
  assert.equal(d.avgIn[27], Math.round(((100 + 1) * 3) / 7));
  assert.equal(u.burn('28d', day(0)).range, '24h'); // 28d goes through daily(), not burn()
});
