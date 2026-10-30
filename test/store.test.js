import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Config } from '../src/config/index.js';
import { Store } from '../src/core/store.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const quiet = { warn() {}, log() {} };

function storeFile(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeplight-store-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

function sample(now) {
  return {
    summaries: { old: { at: now - 31 * DAY }, kept: { at: now - 29 * DAY } },
    dismissed: { old: now - 31 * DAY, kept: now - DAY },
    histories: { old: [{ k: 'doing', t: now - 31 * DAY }], kept: [{ k: 'doing', t: now - DAY }], placeholder: [] },
    ended: { old: { endedAt: now - 13 * HOUR }, kept: { endedAt: now - HOUR } },
    unread: { old: { at: now - 13 * HOUR }, kept: { at: now - HOUR } },
    flags: { character: 'robot', lanToken: 'tok' },
  };
}

const keys = (s) => ({
  summaries: Object.keys(s.summaries),
  dismissed: Object.keys(s.dismissed),
  histories: Object.keys(s.histories),
  ended: Object.keys(s.ended),
  unread: Object.keys(s.unread),
});

test('history is kept at most store.keepDays, board data for collector.retainHours, settings stay', () => {
  const s = new Store(storeFile(sample(Date.now())), new Config({ file: null, env: {}, log: quiet }));
  assert.deepEqual(keys(s), { summaries: ['kept'], dismissed: ['kept'], histories: ['kept'], ended: ['kept'], unread: ['kept'] });
  assert.deepEqual(s.flags, { character: 'robot', lanToken: 'tok' });
});

test('store.keepDays is capped at 30', () => {
  const config = new Config({ file: null, env: {}, log: quiet });
  assert.match(config.set({ 'store.keepDays': 31 }).errors['store.keepDays'], /between 1 and 30/);
});

test('a shorter keepDays wins over retainHours, and changing it prunes at once', () => {
  const now = Date.now();
  const config = new Config({ file: null, env: { BEEPLIGHT_COLLECTOR_RETAIN_HOURS: '48' }, log: quiet });
  const s = new Store(storeFile({ ...sample(now), ended: { a: { endedAt: now - 30 * HOUR }, b: { endedAt: now - HOUR } } }), config);
  assert.deepEqual(Object.keys(s.ended), ['a', 'b']);
  s.start();
  config.set({ 'store.keepDays': 1 });
  // Board data now goes after 1 day instead of 48 h; the day-old history is past the limit too.
  assert.deepEqual(keys(s), { summaries: [], dismissed: [], histories: [], ended: ['b'], unread: ['old', 'kept'] });
  clearInterval(s.pruneTimer);
});

test('prune counts what it removed, and flush reports the size it wrote', () => {
  const now = Date.now();
  const file = storeFile(sample(now));
  const s = new Store(file, new Config({ file: null, env: {}, log: quiet }));
  assert.equal(s.prune('requested'), 0);
  s.summaries.stale = { at: now - 40 * DAY };
  s.histories.stale = [{ k: 'doing', t: now - 40 * DAY }];
  assert.equal(s.prune('requested'), 2);
  const bytes = s.flush();
  assert.equal(bytes, fs.statSync(file).size);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).summaries), ['kept']);
});
