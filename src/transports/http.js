import { t } from '../lib/i18n.js';

// The HTTP front door, shared by the loopback server and the phone-access listeners. Every request
// passes the same checks before its route runs, so a new route cannot skip them:
// - Host must be this Mac's loopback name or, with phone access on, one of its LAN addresses
//   (no DNS rebinding).
// - Anything under /api/ needs pairing, even a path that does not exist.
// - Each route declares its `access`: 'public' (the page shell, which loads before pairing),
//   'pairing' (POST /api/pair, for a phone that has no token yet), 'paired' (this Mac, or a phone
//   with the token) or 'local' (this Mac only: settings, and anything that reveals a secret).
// - Every POST needs `x-beeplight: 1`. A custom header forces a CORS preflight, so other web pages
//   cannot send one.
//
// A route is { method, path: string | RegExp, access, handle(ctx) }, where ctx is
// { req, res, url, local, paired, params (the RegExp's groups), body (parsed JSON of a POST) }.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The JSON body of a request, at most 10 kB; {} when there is none or it does not parse. */
export function readBody(req) {
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

export function createHandler({ routes, lan, port, log = console }) {
  const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  return async function handler(req, res) {
    const host = req.headers.host || '';
    const local = LOOPBACK.has(req.socket.remoteAddress) && localHosts.has(host);
    if (!local && !(lan.enabled && lan.allowedHost(host))) return json(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, `http://${host}`);
    const token = req.headers['x-beeplight-token'] || url.searchParams.get('t');
    // Only requests that present a token count toward the wrong-token lockout.
    const paired = local || (!!token && lan.checkToken(String(token), req.socket.remoteAddress));

    const onPath = routes.filter((r) => (r.path instanceof RegExp ? r.path.test(url.pathname) : r.path === url.pathname));
    const route = onPath.find((r) => r.method === req.method);
    if (url.pathname.startsWith('/api/') && !paired && route?.access !== 'pairing') {
      return json(res, 401, { error: t('Not paired. Open this page from the QR code under Phone Access on the Mac.') });
    }
    if (!route) return onPath.length ? json(res, 405, { error: 'method not allowed' }) : json(res, 404, { error: 'not found' });
    if (route.access === 'local' && !local) return json(res, 403, { error: t('This can only be changed on the Mac itself') });
    if (route.access === 'pairing' && local) return json(res, 400, { error: t("This Mac doesn't need pairing") });
    if (req.method === 'POST' && req.headers['x-beeplight'] !== '1') return json(res, 403, { error: 'missing header' });

    // Task ids such as codex:<uuid> arrive percent-encoded from the web page.
    let params = [];
    try {
      if (route.path instanceof RegExp) params = route.path.exec(url.pathname).slice(1).map((p) => (p == null ? p : decodeURIComponent(p)));
    } catch {
      return json(res, 400, { error: 'bad path' });
    }

    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      await route.handle({ req, res, url, local, paired, params, body });
    } catch (e) {
      // One broken request must not take the service down.
      log.error(`[http] ${req.method} ${url.pathname} failed:`, e);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    }
  };
}
