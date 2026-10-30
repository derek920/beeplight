// Beeplight relay: a mailbox that lets the Beeplight on each of your devices see the others' tasks.
// Each device keeps one sealed blob here (its latest task summary, end-to-end encrypted with a key
// only the devices know) and streams everyone else's. The relay sees device ids, sizes and times,
// never titles or states. Zero dependencies; run it behind HTTPS (see README).
//
//   BEEPLIGHT_RELAY_TOKEN=<secret> node relay/server.js
//
// PORT (7350) and HOST (127.0.0.1; 0.0.0.0 to accept other machines) pick the address.

import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT) || 7350;
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.BEEPLIGHT_RELAY_TOKEN || crypto.randomBytes(18).toString('base64url');
if (!process.env.BEEPLIGHT_RELAY_TOKEN) console.log(`[relay] no BEEPLIGHT_RELAY_TOKEN set; this run's token: ${TOKEN}`);

const MAX_BODY = 256 * 1024;
const MAX_DEVICES = 16;
const MAX_SPACES = 200;
const DEVICE_TTL_MS = 24 * 3600_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const B64_RE = /^[A-Za-z0-9+/=_-]+$/;

/** space id → { devices: Map<device id, { payload, at }>, clients: Set<res> } */
const spaces = new Map();

function space(id, create) {
  let s = spaces.get(id);
  if (!s && create) {
    if (spaces.size >= MAX_SPACES) return null;
    s = { devices: new Map(), clients: new Set() };
    spaces.set(id, s);
  }
  return s;
}

function authorized(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1]).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(s, event, data) {
  for (const res of s.clients) send(res, event, data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay');
  if (url.pathname === '/v1/health') return json(res, 200, { ok: true });
  if (!authorized(req)) return json(res, 401, { error: 'bad token' });

  // /v1/spaces/<space>/stream and /v1/spaces/<space>/devices/<device>
  const m = /^\/v1\/spaces\/([^/]+)\/(stream|devices\/([^/]+))$/.exec(url.pathname);
  if (!m || !ID_RE.test(m[1]) || (m[3] && !ID_RE.test(m[3]))) return json(res, 404, { error: 'not found' });
  const [, spaceId, what, deviceId] = m;

  if (what === 'stream' && req.method === 'GET') {
    const s = space(spaceId, true);
    if (!s) return json(res, 503, { error: 'relay full' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    send(res, 'tick', { now: Date.now() });
    for (const [device, d] of s.devices) send(res, 'device', { device, at: d.at, payload: d.payload });
    s.clients.add(res);
    req.on('close', () => s.clients.delete(res));
    return;
  }

  if (deviceId && req.method === 'PUT') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const p = { v: body.v, iv: body.iv, data: body.data };
    if (p.v !== 1 || typeof p.iv !== 'string' || typeof p.data !== 'string' || !B64_RE.test(p.iv) || !B64_RE.test(p.data)) {
      return json(res, 400, { error: 'bad payload' });
    }
    const s = space(spaceId, true);
    if (!s) return json(res, 503, { error: 'relay full' });
    if (!s.devices.has(deviceId) && s.devices.size >= MAX_DEVICES) return json(res, 409, { error: 'too many devices' });
    const at = Date.now();
    s.devices.set(deviceId, { payload: p, at });
    broadcast(s, 'device', { device: deviceId, at, payload: p });
    return json(res, 200, { ok: true, at });
  }

  if (deviceId && req.method === 'DELETE') {
    const s = space(spaceId, false);
    if (s?.devices.delete(deviceId)) broadcast(s, 'gone', { device: deviceId });
    return json(res, 200, { ok: true });
  }

  json(res, 405, { error: 'method not allowed' });
});

// Server time with every heartbeat, so devices can judge "online" without trusting their clocks.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of spaces) {
    for (const [device, d] of s.devices) {
      if (now - d.at > DEVICE_TTL_MS) {
        s.devices.delete(device);
        broadcast(s, 'gone', { device });
      }
    }
    if (!s.devices.size && !s.clients.size) spaces.delete(id);
    else broadcast(s, 'tick', { now });
  }
}, 20_000).unref();

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `[relay] port ${PORT} is already in use` : e);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`[relay] listening on http://${HOST}:${PORT}`));
