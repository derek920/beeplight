import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { setLang } from '../src/lib/i18n.js';
import { apiRoutes } from '../src/transports/api.js';
import { createHandler, json } from '../src/transports/http.js';
import { webRoutes } from '../src/transports/web.js';
import { PUBLIC_DIR } from '../src/config/index.js';

setLang('en');

const PORT = 7333;
const PHONE_HOST = '192.168.1.5:7333';

function fakeLan(over = {}) {
  return {
    enabled: true,
    token: 'tok',
    allowedHost: (h) => h === PHONE_HOST,
    checkToken: (t) => t === 'tok',
    redeemPin: (pin) => (pin === '123456' ? 'tok' : null),
    ...over,
  };
}

function request({ method = 'GET', url = '/', host = `localhost:${PORT}`, ip = '127.0.0.1', headers = {}, body }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, { method, url, headers: { host, ...headers }, socket: { remoteAddress: ip } });
}

async function call(handler, opts) {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead(s) {
      this.status = s;
      this.headersSent = true;
    },
    write(c) {
      this.body += c;
    },
    end(c = '') {
      this.body += c;
    },
  };
  await handler(request(opts), res);
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null };
}

const ok = ({ res }) => json(res, 200, { ok: true });
const routes = [
  { method: 'GET', path: '/', access: 'public', handle: ok },
  { method: 'GET', path: '/api/thing', access: 'paired', handle: ok },
  { method: 'POST', path: '/api/thing', access: 'paired', handle: ({ res, body }) => json(res, 200, body) },
  { method: 'GET', path: '/api/secret', access: 'local', handle: ok },
  { method: 'GET', path: /^\/api\/items\/([^/]+)$/, access: 'paired', handle: ({ res, params }) => json(res, 200, { id: params[0] }) },
  {
    method: 'GET', path: '/api/boom', access: 'paired',
    handle: () => {
      throw new Error('boom');
    },
  },
];
const quiet = { error() {} };
const phone = (o) => ({ host: PHONE_HOST, ip: '192.168.1.9', ...o });

test('requests under another host name are refused (DNS rebinding)', async () => {
  const h = createHandler({ routes, lan: fakeLan({ enabled: false }), port: PORT, log: quiet });
  assert.equal((await call(h, { host: 'evil.example:7333' })).status, 403);
  assert.equal((await call(h, phone({}))).status, 403, 'phone access off');
  const on = createHandler({ routes, lan: fakeLan(), port: PORT, log: quiet });
  assert.equal((await call(on, { host: 'evil.example:7333' })).status, 403);
  assert.equal((await call(on, phone({}))).status, 200);
});

test('the API needs pairing, and does not reveal which paths exist', async () => {
  const h = createHandler({ routes, lan: fakeLan(), port: PORT, log: quiet });
  assert.equal((await call(h, phone({ url: '/' }))).status, 200);
  assert.equal((await call(h, phone({ url: '/api/thing' }))).status, 401);
  assert.equal((await call(h, phone({ url: '/api/nope' }))).status, 401);
  assert.equal((await call(h, phone({ url: '/api/thing?t=wrong' }))).status, 401);
  assert.equal((await call(h, phone({ url: '/api/thing?t=tok' }))).status, 200);
  assert.equal((await call(h, phone({ url: '/api/thing', headers: { 'x-beeplight-token': 'tok' } }))).status, 200);
  assert.equal((await call(h, phone({ url: '/api/nope?t=tok' }))).status, 404);
  assert.equal((await call(h, { url: '/api/thing' })).status, 200, 'this Mac needs no token');
});

test('local routes refuse a paired phone', async () => {
  const h = createHandler({ routes, lan: fakeLan(), port: PORT, log: quiet });
  assert.equal((await call(h, phone({ url: '/api/secret?t=tok' }))).status, 403);
  assert.equal((await call(h, { url: '/api/secret' })).status, 200);
  // Loopback address alone is not enough: the Host must be the loopback name too.
  assert.equal((await call(h, { url: '/api/secret?t=tok', host: PHONE_HOST })).status, 403);
});

test('every POST needs the x-beeplight header', async () => {
  const h = createHandler({ routes, lan: fakeLan(), port: PORT, log: quiet });
  assert.equal((await call(h, { method: 'POST', url: '/api/thing', body: { a: 1 } })).status, 403);
  const r = await call(h, { method: 'POST', url: '/api/thing', headers: { 'x-beeplight': '1' }, body: { a: 1 } });
  assert.deepEqual(r, { status: 200, json: { a: 1 } });
});

test('path parameters, wrong methods, and a failing route', async () => {
  const h = createHandler({ routes, lan: fakeLan(), port: PORT, log: quiet });
  assert.deepEqual((await call(h, { url: '/api/items/abc' })).json, { id: 'abc' });
  assert.equal((await call(h, { method: 'DELETE', url: '/api/thing', headers: { 'x-beeplight': '1' } })).status, 405);
  assert.equal((await call(h, { url: '/api/boom' })).status, 500);
  assert.equal((await call(h, { url: '/api/thing' })).status, 200, 'still serving after a failure');
});

test('path parameters arrive decoded; a malformed escape is a 400', async () => {
  const handler = createHandler({ port: PORT, lan: fakeLan(), routes });
  assert.deepEqual((await call(handler, { url: '/api/items/codex%3A01a1960a-b257' })).json, { id: 'codex:01a1960a-b257' });
  assert.equal((await call(handler, { url: '/api/items/%E0%A4%A' })).status, 400);
});

test('cleaning up stored data is for this Mac only and reports what it did', async () => {
  const lan = fakeLan();
  const store = { prune: () => 3, flush: () => 64 * 1024 };
  const h = createHandler({ routes: apiRoutes({ lan, store }), lan, port: PORT, log: quiet });
  const prune = (o) => call(h, { method: 'POST', url: '/api/store/prune', headers: { 'x-beeplight': '1' }, ...o });
  assert.equal((await prune(phone({ url: '/api/store/prune?t=tok' }))).status, 403);
  const r = await prune({});
  assert.equal(r.status, 200);
  assert.equal(r.json.removed, 3);
  assert.equal(r.json.message, 'Removed 3 entries. The data file is now 64 KB.');
});

test('limit details: a paired phone may ask, a bad window or step is a 400', async () => {
  const lan = fakeLan();
  const asked = [];
  const collector = {
    usageDetail: (window, step) => {
      asked.push([window, step]);
      return window === '5h' && (step === null || step === '30m') ? { window, step } : null;
    },
  };
  const h = createHandler({ routes: apiRoutes({ lan, collector }), lan, port: PORT, log: quiet });
  assert.equal((await call(h, { url: '/api/usage/detail?window=5h&step=30m' })).status, 200);
  assert.equal((await call(h, phone({ url: '/api/usage/detail?window=5h&t=tok' }))).status, 200);
  assert.equal((await call(h, phone({ url: '/api/usage/detail?window=5h' }))).status, 401);
  assert.equal((await call(h, { url: '/api/usage/detail?window=1y' })).status, 400);
  assert.deepEqual(asked, [['5h', '30m'], ['5h', null], ['1y', null]]);
});

test('pairing by code: refused on this Mac, wrong code answers 401 instead of crashing', async () => {
  const lan = fakeLan();
  const h = createHandler({ routes: apiRoutes({ lan }), lan, port: PORT, log: quiet });
  const pair = (o) => call(h, { method: 'POST', url: '/api/pair', headers: { 'x-beeplight': '1' }, ...o });
  assert.equal((await pair({ body: { pin: '123456' } })).status, 400);
  const wrong = await pair(phone({ body: { pin: '000000' } }));
  assert.equal(wrong.status, 401);
  assert.match(wrong.json.error, /Wrong or expired pairing code/);
  assert.deepEqual((await pair(phone({ body: { pin: '123456' } }))).json, { ok: true, token: 'tok' });
  assert.equal((await call(h, phone({ method: 'POST', url: '/api/pair', body: { pin: '123456' } }))).status, 403, 'header still required');
});

test('every manifest icon is served at its stated size, with separate any and maskable icons', async () => {
  const lan = fakeLan();
  const h = createHandler({ routes: webRoutes({ dir: PUBLIC_DIR, lan }), lan, port: PORT, log: quiet });
  const get = async (url) => {
    const res = { status: 0, type: '', chunks: [], writeHead(s, hd) { this.status = s; this.type = hd['content-type']; }, end(c) { if (c) this.chunks.push(Buffer.from(c)); } };
    await h(request({ url }), res);
    return { status: res.status, type: res.type, body: Buffer.concat(res.chunks) };
  };
  const { icons } = JSON.parse((await get('/manifest.webmanifest')).body);
  // A maskable icon fills the square and an "any" one keeps a margin, so no file can be both.
  assert.deepEqual([...new Set(icons.map((i) => i.purpose))].sort(), ['any', 'maskable']);
  for (const icon of icons) {
    const res = await get(icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.type, 'image/png', icon.src);
    // PNG header: width and height are the big-endian words at bytes 16 and 20.
    assert.equal(`${res.body.readUInt32BE(16)}x${res.body.readUInt32BE(20)}`, icon.sizes, icon.src);
  }
});

test('the page carries the theme and preset packs inline', async () => {
  const lan = fakeLan();
  const h = createHandler({ routes: webRoutes({ dir: PUBLIC_DIR, lan }), lan, port: PORT, log: quiet });
  const res = { body: '', writeHead() {}, end(c = '') { this.body += c; } };
  await h(request({ url: '/' }), res);
  const m = /<script id="packs" type="application\/json">(.*?)<\/script>/s.exec(res.body);
  assert.ok(m, 'packs script element');
  const packs = JSON.parse(m[1]);
  assert.ok(packs.themes.themes.some((t) => t.id === 'neon'));
  assert.ok(packs.presets.presets.some((p) => p.id === 'minimal'));
});
