import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ClaudeRunner } from './claude-cli.js';
import { Collector } from './collector.js';
import { CLAUDE_BIN, HOST, PORT, PUBLIC_DIR, TICK_MS } from './config.js';
import { focusTarget } from './focus.js';
import { LANG, t } from './i18n.js';
import { Lan } from './lan.js';
import { Limits } from './limits.js';
import { Relay } from './relay.js';
import { SeenWatcher } from './seen.js';
import { Store } from './store.js';
import { Summarizer } from './summarizer.js';
import { UsageIndex } from './usage.js';

const store = new Store();
const runner = new ClaudeRunner();
const limits = new Limits(store, runner);
const summarizer = new Summarizer(store, runner);
const usage = new UsageIndex();
const relay = new Relay(store);
const collector = new Collector({ store, summarizer, runner, usage, limits, relay });
const seen = new SeenWatcher({ collector, store });

const clients = new Set();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

collector.on('update', (snap) => {
  for (const res of clients) send(res, 'state', snap);
});
setInterval(() => {
  const meta = metaView();
  for (const res of clients) send(res, 'meta', meta);
}, 1000).unref();

// A phone left on as a status screen keeps its page for days and only reconnects when the service
// restarts; the page reloads itself when the files it was served from, or the language, have changed.
const PAGE_VERSION = (() => {
  const h = crypto.createHash('sha1').update(LANG);
  for (const f of fs.readdirSync(PUBLIC_DIR).sort()) {
    const p = path.join(PUBLIC_DIR, f);
    if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p));
  }
  return h.digest('hex').slice(0, 12);
})();

const metaView = () => ({ ...collector.meta(), page: PAGE_VERSION });

// The page shell is not sensitive and must load before pairing; everything under /api is.
const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/characters.json': ['characters.json', 'application/json; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
};

const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c.length + b.length < 10_000 ? c : ''));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function manifest(token) {
  return {
    name: 'Beeplight',
    short_name: 'Beeplight',
    // A home-screen web app on iOS has its own storage, so the pairing token rides in start_url.
    start_url: token ? `/?t=${token}` : '/',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'any',
    background_color: '#0b0f17',
    theme_color: '#0b0f17',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

async function handler(req, res) {
  const host = req.headers.host || '';
  const local = LOOPBACK.has(req.socket.remoteAddress) && LOCAL_HOSTS.has(host);
  // Reject DNS-rebinding style requests that reach us under another hostname.
  if (!local && !(lan.enabled && lan.allowedHost(host))) return json(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url, `http://${host}`);
  const token = req.headers['x-beeplight-token'] || url.searchParams.get('t');
  // Only requests that present a token count toward the wrong-token lockout.
  const paired = local || (!!token && lan.checkToken(String(token), req.socket.remoteAddress));

  if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(manifest(!local && paired ? lan.token : null)));
  }

  // Pairing by 6-digit code: the one API call allowed before pairing.
  if (req.method === 'POST' && url.pathname === '/api/pair') {
    if (local) return json(res, 400, { error: t("This Mac doesn't need pairing") });
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    const t = lan.redeemPin(String((await readBody(req)).pin || ''), req.socket.remoteAddress);
    return t ? json(res, 200, { ok: true, token: t }) : json(res, 401, { ok: false, error: t('Wrong or expired pairing code. Check the latest code under Phone Access on the Mac.') });
  }

  // The page shell carries the service's language, so the page matches the labels and titles
  // the service sends. A paired phone also gets the token baked into the manifest link, because
  // Safari reads the manifest at load and a home-screen app starts from its start_url with
  // empty storage.
  if (req.method === 'GET' && url.pathname === '/') {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) return json(res, 500, { error: err.message });
      let page = html.replace('<html lang="en">', `<html lang="${LANG}">`);
      if (!local && paired) page = page.replace('href="/manifest.webmanifest"', `href="/manifest.webmanifest?t=${lan.token}"`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    });
    return;
  }

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
      if (err) return json(res, 500, { error: err.message });
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  if (url.pathname.startsWith('/api/') && !paired) return json(res, 401, { error: t('Not paired. Open this page from the QR code under Phone Access on the Mac.') });

  // Turning LAN access on/off and reading the token stays on the Mac itself.
  if (url.pathname === '/api/lan' || url.pathname.startsWith('/api/lan/')) {
    if (!local) return json(res, 403, { error: t('This can only be changed on the Mac itself') });
    if (req.method === 'GET') return json(res, 200, lan.info());
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    if (req.method === 'POST' && url.pathname === '/api/lan') lan.setEnabled(!!(await readBody(req)).enabled);
    else if (req.method === 'POST' && url.pathname === '/api/lan/reset') lan.resetToken();
    else return json(res, 404, { error: 'not found' });
    return json(res, 200, lan.info());
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, { ...collector.snapshot, meta: metaView() });
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`retry: 1000\n\n`);
    send(res, 'state', collector.snapshot);
    send(res, 'meta', metaView());
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Syncing with your other devices through a relay. Local only: the info carries the join code,
  // which holds the group key.
  if (url.pathname === '/api/relay') {
    if (!local) return json(res, 403, { error: t('This can only be changed on the Mac itself') });
    if (req.method === 'GET') return json(res, 200, relay.info());
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    const b = await readBody(req);
    try {
      if (b.action === 'create') relay.create({ url: b.url, token: b.token });
      else if (b.action === 'join') relay.join(b.code);
      else if (b.action === 'leave') await relay.leave();
      else return json(res, 400, { error: 'unknown action' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    return json(res, 200, relay.info());
  }

  // The character chosen in the Mac app, so the phone's status screen shows the same one.
  if (req.method === 'POST' && url.pathname === '/api/character') {
    if (!local) return json(res, 403, { error: t('This can only be changed on the Mac itself') });
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    const id = String((await readBody(req)).id || '');
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return json(res, 400, { error: 'bad character id' });
    store.setFlag('character', id);
    return json(res, 200, { ok: true });
  }

  // Task titles: 'ai' (summarized by the LLM) or 'raw' (as Claude Code has them, no LLM calls).
  if (req.method === 'POST' && url.pathname === '/api/title-mode') {
    if (!local) return json(res, 403, { error: t('This can only be changed on the Mac itself') });
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    const mode = String((await readBody(req)).mode || '');
    if (mode !== 'ai' && mode !== 'raw') return json(res, 400, { error: 'bad title mode' });
    collector.setTitleMode(mode);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/read-all') {
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    collector.markAllRead();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/limits/refresh') {
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    await limits.probe();
    return json(res, 200, { ok: !limits.lastError, error: limits.lastError, limits: limits.snapshot(Date.now()) });
  }

  const m = /^\/api\/sessions\/([^/]+)\/(focus|dismiss|resummarize|read)$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    // A custom header forces a CORS preflight, so other web pages cannot trigger these.
    if (req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });
    const [, sid, action] = m;
    const remote = collector.snapshot.sessions.find((v) => v.id === sid)?.remote;
    if (remote) return json(res, 200, { ok: false, error: t('This task runs on {device}', { device: remote.name }) });
    if (action === 'focus') {
      const target = collector.focusTarget(sid);
      if (!target) return json(res, 404, { ok: false, error: t('Session not found') });
      const r = await focusTarget(target);
      // Opening a task is reading it.
      const via = local
        ? url.searchParams.get('via') || (String(req.headers['user-agent']).includes('Mozilla') ? 'web' : 'app')
        : 'phone';
      console.log(`[focus] ${new Date().toISOString()} ${sid.slice(0, 8)} from ${via} → ${r.ok ? r.how : r.error}`);
      if (r.ok) collector.markRead(sid, `opened from ${via} via ${r.how}`);
      if (r.appleEvents) store.setFlag('appleEventsOk', true);
      return json(res, 200, r);
    }
    if (action === 'read') {
      collector.markRead(sid, 'marked read');
      return json(res, 200, { ok: true });
    }
    if (action === 'dismiss') {
      store.dismiss(sid);
      collector.sig = '';
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: collector.resummarize(sid) });
  }

  json(res, 404, { error: 'not found' });
}

const lan = new Lan({ store, handler });
const server = http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`Beeplight running at http://localhost:${PORT} (checks every ${TICK_MS}ms, summarizer: ${CLAUDE_BIN})`);
  collector.start();
  seen.start();
  lan.start();
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is Beeplight already running?). Pick another with PORT=xxxx` : e);
  process.exit(1);
});

function shutdown() {
  collector.stop();
  runner.killAll();
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
