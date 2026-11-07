import assert from 'node:assert/strict';
import test from 'node:test';
import { Limits } from '../src/services/limits.js';
import { Config } from '../src/config/index.js';

const store = { limits: null, save() {} };
const config = new Config({ file: null, env: {} });

test('the plan comes from the runner once and is part of the snapshot', async () => {
  let asked = 0;
  const runner = { available: () => true, plan: async () => (asked++, 'ultra'), run: async () => ({}) };
  const limits = new Limits({ ...store }, runner, config);
  assert.equal(limits.snapshot(0).plan, null);
  await limits.probe();
  await limits.probe();
  assert.equal(asked, 1);
  assert.equal(limits.snapshot(0).plan, 'ultra');
  limits.ingest({ unifiedWindows: { seven_day: { utilization: 0.2, resetsAt: 2 } } }, 1000);
  assert.equal(limits.snapshot(0).plan, 'ultra');
  assert.equal(limits.snapshot(0).fiveHour, null);
});
