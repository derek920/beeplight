import { t } from '../lib/i18n.js';
import { json } from './http.js';

// Every /api/ route. Who may call each one is its `access`, checked in http.js before it runs; the
// handlers only act, through the modules server.js hands in.

export function apiRoutes({ collector, store, config, lan, relay, limits, stream, meta, focus }) {
  return [
    {
      // Pairing by 6-digit code: the one API call allowed before pairing.
      method: 'POST', path: '/api/pair', access: 'pairing',
      handle: ({ req, res, body }) => {
        const token = lan.redeemPin(String(body.pin || ''), req.socket.remoteAddress);
        if (token) return json(res, 200, { ok: true, token });
        json(res, 401, { ok: false, error: t('Wrong or expired pairing code. Check the latest code under Phone Access on the Mac.') });
      },
    },

    // The board.
    { method: 'GET', path: '/api/state', access: 'paired', handle: ({ res }) => json(res, 200, { ...collector.snapshot, meta: meta() }) },
    { method: 'GET', path: '/api/stream', access: 'paired', handle: ({ req, res }) => stream.open(req, res) },
    {
      method: 'POST', path: /^\/api\/sessions\/([^/]+)\/(focus|dismiss|resummarize|read)$/, access: 'paired',
      handle: (ctx) => session(ctx),
    },
    {
      method: 'POST', path: '/api/read-all', access: 'paired',
      handle: ({ res }) => {
        collector.markAllRead();
        json(res, 200, { ok: true });
      },
    },
    {
      method: 'POST', path: '/api/limits/refresh', access: 'paired',
      handle: async ({ res }) => {
        await limits.probe();
        json(res, 200, { ok: !limits.lastError, error: limits.lastError, limits: limits.snapshot(Date.now()) });
      },
    },

    // Settings of this Mac, local only. Phone access hands out the pairing token, and the relay
    // info carries the join code, which holds the group key.
    { method: 'GET', path: '/api/lan', access: 'local', handle: ({ res }) => json(res, 200, lan.info()) },
    {
      method: 'POST', path: '/api/lan', access: 'local',
      handle: ({ res, body }) => {
        lan.setEnabled(!!body.enabled);
        json(res, 200, lan.info());
      },
    },
    {
      method: 'POST', path: '/api/lan/reset', access: 'local',
      handle: ({ res }) => {
        lan.resetToken();
        json(res, 200, lan.info());
      },
    },
    // Runtime parameters (src/config/schema.js).
    { method: 'GET', path: '/api/config', access: 'local', handle: ({ res }) => json(res, 200, config.describe()) },
    {
      method: 'POST', path: '/api/config', access: 'local',
      handle: ({ res, body }) => {
        const { errors } = config.set(body.set);
        json(res, Object.keys(errors).length ? 400 : 200, { ...config.describe(), errors });
      },
    },
    // Syncing with your other devices through a relay.
    { method: 'GET', path: '/api/relay', access: 'local', handle: ({ res }) => json(res, 200, relay.info()) },
    {
      method: 'POST', path: '/api/relay', access: 'local',
      handle: async ({ res, body: b }) => {
        try {
          if (b.action === 'create') relay.create({ url: b.url, token: b.token });
          else if (b.action === 'join') relay.join(b.code);
          else if (b.action === 'leave') await relay.leave();
          else return json(res, 400, { error: 'unknown action' });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        json(res, 200, relay.info());
      },
    },
    {
      // The character chosen in the Mac app, so the phone's status screen shows the same one.
      method: 'POST', path: '/api/character', access: 'local',
      handle: ({ res, body }) => {
        const id = String(body.id || '');
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) return json(res, 400, { error: 'bad character id' });
        store.setFlag('character', id);
        json(res, 200, { ok: true });
      },
    },
  ];

  async function session({ req, res, url, local, params: [sid, action] }) {
    // Another device's task is read-only here.
    const remote = collector.snapshot.sessions.find((v) => v.id === sid)?.remote;
    if (remote) return json(res, 200, { ok: false, error: t('This task runs on {device}', { device: remote.name }) });
    if (action === 'focus') {
      const target = collector.focusTarget(sid);
      if (!target) return json(res, 404, { ok: false, error: t('Session not found') });
      const r = await focus(target);
      const via = local
        ? url.searchParams.get('via') || (String(req.headers['user-agent']).includes('Mozilla') ? 'web' : 'app')
        : 'phone';
      console.log(`[focus] ${new Date().toISOString()} ${sid.slice(0, 8)} from ${via} → ${r.ok ? r.how : r.error}`);
      // Opening a task is reading it.
      if (r.ok) collector.markRead(sid, `opened from ${via} via ${r.how}`);
      if (r.appleEvents) store.setFlag('appleEventsOk', true);
      return json(res, 200, r);
    }
    if (action === 'read') {
      collector.markRead(sid, 'marked read');
      return json(res, 200, { ok: true });
    }
    if (action === 'dismiss') {
      collector.dismiss(sid);
      return json(res, 200, { ok: true });
    }
    json(res, 200, { ok: collector.resummarize(sid) });
  }
}
