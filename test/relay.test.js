import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { makeJoinCode, open, parseJoinCode, Relay, seal, spaceOf } from '../src/relay.js';

const fakeStore = () => ({
  flags: {},
  setFlag(name, value) {
    this.flags[name] = value;
  },
});

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('timed out');
}

const key = Buffer.alloc(32, 7).toString('base64url');

test('sealed summaries open only with the same key and device', () => {
  const p = seal(key, 'space:dev1', { name: 'Mac', sessions: [{ title: 'secret title' }] });
  assert.ok(!Buffer.from(p.data, 'base64url').toString('utf8').includes('secret'));
  assert.equal(open(key, 'space:dev1', p).sessions[0].title, 'secret title');
  assert.throws(() => open(key, 'space:dev2', p));
  assert.throws(() => open(Buffer.alloc(32, 8).toString('base64url'), 'space:dev1', p));
});

test('join codes carry the relay, token and key', () => {
  const code = makeJoinCode({ url: 'https://relay.example.com/', token: 'tok', key });
  assert.deepEqual(parseJoinCode(code), { url: 'https://relay.example.com', token: 'tok', key });
  assert.equal(parseJoinCode('nonsense'), null);
  assert.equal(spaceOf(key).length, 22);
});

test('two devices see each other through the relay, and only with the token', async (t) => {
  const port = 17000 + Math.floor(Math.random() * 2000);
  const relayProc = spawn(process.execPath, [path.join(import.meta.dirname, '../relay/server.js')], {
    env: { ...process.env, PORT: String(port), BEEPLIGHT_RELAY_TOKEN: 'test-token' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => relayProc.kill());
  await new Promise((r) => relayProc.stdout.once('data', r));
  const url = `http://127.0.0.1:${port}`;

  const bad = await fetch(`${url}/v1/spaces/${spaceOf(key)}/stream`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);

  const a = new Relay(fakeStore());
  const b = new Relay(fakeStore());
  t.after(() => {
    a.disconnect();
    b.disconnect();
  });
  const code = a.create({ url, token: 'test-token' });
  b.join(code);
  await until(() => a.status === 'connected' && b.status === 'connected');

  a.share([
    { id: 's1', title: 'Fix the login page', state: 'waiting', kind: 'prompt', label: 'Needs permission', detail: 'Bash · rm -rf build', cwd: '/Users/me/secret', lastPrompt: 'private prompt' },
    { id: 's2', title: 'SDK call', state: 'doing', sdk: true },
  ]);
  await until(() => b.remoteViews().length === 1);
  const [v] = b.remoteViews();
  assert.equal(v.title, 'Fix the login page');
  assert.equal(v.detail, 'Bash · rm -rf build');
  assert.equal(v.remote.online, true);
  assert.ok(v.id.endsWith('~s1'));
  // What stays on the device it came from.
  assert.equal(v.cwd, undefined);
  assert.equal(v.lastPrompt, undefined);
  assert.equal(b.info().devices.length, 1);

  await a.leave();
  await until(() => b.remoteViews().length === 0);
});
