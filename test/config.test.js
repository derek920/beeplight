import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { Config } from '../src/config.js';
import { envName } from '../src/config-schema.js';
import { setLang } from '../src/i18n.js';

setLang('en');

const quiet = { warn() {}, log() {} };

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeplight-config-'));
  const file = path.join(dir, 'config.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const make = (opts = {}) => new Config({ file: null, env: {}, log: quiet, ...opts });

test('env names are derived from keys', () => {
  assert.equal(envName('collector.tickMs'), 'BEEPLIGHT_COLLECTOR_TICK_MS');
  assert.equal(envName('subagents.showFinishedMinutes'), 'BEEPLIGHT_SUBAGENTS_SHOW_FINISHED_MINUTES');
});

test('defaults, then the file, then the environment', () => {
  assert.equal(make().get('collector.tickMs'), 333);
  const file = tmpFile({ 'collector.tickMs': 500, 'summarizer.model': 'sonnet' });
  const c = make({ file, env: { BEEPLIGHT_COLLECTOR_TICK_MS: '250' } });
  assert.equal(c.get('collector.tickMs'), 250);
  assert.equal(c.get('summarizer.model'), 'sonnet');
  const d = c.describe().params.find((p) => p.key === 'collector.tickMs');
  assert.equal(d.source, 'env');
  assert.equal(d.env, 'BEEPLIGHT_COLLECTOR_TICK_MS');
});

test('older environment variable names still work', () => {
  const c = make({ env: { BEEPLIGHT_RETAIN_HOURS: '24', BEEPLIGHT_MODEL: 'sonnet', CLAUDE_BIN: '/opt/claude', BEEPLIGHT_LIMITS_PROBE_MINUTES: '0' } });
  assert.equal(c.get('collector.retainHours'), 24);
  assert.equal(c.get('summarizer.model'), 'sonnet');
  assert.equal(c.get('claude.bin'), '/opt/claude');
  assert.equal(c.get('limits.probeMinutes'), 0);
});

test('invalid values are ignored and reported, unknown keys are kept', () => {
  const file = tmpFile({ 'collector.tickMs': 5, 'summarizer.concurrency': 1.5, 'summarizer.model': 'a b', 'no.such': 1 });
  const c = make({ file, env: { BEEPLIGHT_SEEN_POLL_MS: 'soon' } });
  assert.equal(c.get('collector.tickMs'), 333);
  assert.equal(c.get('summarizer.concurrency'), 2);
  assert.equal(c.get('summarizer.model'), 'haiku');
  assert.equal(c.get('seen.pollMs'), 1500);
  assert.equal(c.describe().problems.length, 5);
  c.set({ 'collector.tickMs': 400 });
  // The bad entries the user did not touch stay in the file for them to fix.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    'collector.tickMs': 400,
    'no.such': 1,
    'summarizer.concurrency': 1.5,
    'summarizer.model': 'a b',
  });
});

test('set saves only what differs from the default, all or nothing', () => {
  const file = tmpFile();
  const c = make({ file });
  let r = c.set({ 'collector.tickMs': 50, 'summarizer.concurrency': 3 });
  assert.match(r.errors['collector.tickMs'], /between 100 and 5000/);
  assert.equal(c.get('summarizer.concurrency'), 2);
  assert.equal(fs.existsSync(file), false);

  r = c.set({ 'summarizer.concurrency': '3', 'collector.retainHours': 12, 'relay.deviceName': ' Studio ' });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.changed.sort(), ['relay.deviceName', 'summarizer.concurrency']);
  assert.equal(c.get('relay.deviceName'), 'Studio');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'relay.deviceName': 'Studio', 'summarizer.concurrency': 3 });

  c.set({ 'summarizer.concurrency': null });
  assert.equal(c.get('summarizer.concurrency'), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'relay.deviceName': 'Studio' });
  assert.match(c.set({ nope: 1 }).errors.nope, /unknown/);
  assert.throws(() => c.get('nope'), /unknown config key/);
});

test('restart-only parameters keep their startup value', () => {
  const file = tmpFile();
  const c = make({ file });
  c.set({ 'server.port': 7444 });
  assert.equal(c.get('server.port'), 7333);
  const d = c.describe().params.find((p) => p.key === 'server.port');
  assert.equal(d.configured, 7444);
  assert.equal(d.restartPending, true);
  assert.equal(make({ file }).get('server.port'), 7444);
});

test('change events, and a half-written file keeps the last good values', () => {
  const file = tmpFile({ 'collector.tickMs': 500 });
  const c = make({ file });
  const seen = [];
  c.on('change', (keys) => seen.push(keys));
  fs.writeFileSync(file, '{ "collector.tickMs": 6');
  assert.equal(c.readFile(), false);
  assert.equal(c.get('collector.tickMs'), 500);
  assert.equal(c.describe().problems.length, 1);
  fs.writeFileSync(file, JSON.stringify({ 'collector.tickMs': 600, 'server.port': 8000 }));
  assert.equal(c.readFile(), true);
  c.compute();
  assert.equal(c.get('collector.tickMs'), 600);
  // server.port is restart-only, so it is not announced as changed.
  assert.deepEqual(seen, [['collector.tickMs']]);
  assert.equal(c.describe().problems.length, 0);
});

test('every() re-arms its timer when the interval changes', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const c = make();
    let n = 0;
    const h = c.every('seen.pollMs', 1, () => n++);
    mock.timers.tick(1500 * 2);
    assert.equal(n, 2);
    c.set({ 'seen.pollMs': 500 });
    mock.timers.tick(500 * 3);
    assert.equal(n, 5);
    h.stop();
    mock.timers.tick(5000);
    assert.equal(n, 5);
  } finally {
    mock.timers.reset();
  }
});
