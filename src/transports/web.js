import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LANG } from '../lib/i18n.js';

// The page shell from public/: the page, its scripts and styles, icons and the web app manifest.
// None of it is sensitive, and it has to load before a phone is paired.

const FILES = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/characters.json': ['characters.json', 'application/json; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
};

/**
 * A hash of the files in `dir` and the language. A phone left on as a status screen keeps its page
 * for days and only reconnects when the service restarts; the page reloads itself when this changes.
 */
export function pageVersion(dir) {
  const h = crypto.createHash('sha1').update(LANG);
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p));
  }
  return h.digest('hex').slice(0, 12);
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

const PACKS_TAG = '<script id="packs" type="application/json"></script>';

/** The theme and preset packs for the page, as JSON safe to put inside a script element. */
async function packs(dir) {
  const read = async (name) => {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(dir, `${name}.json`), 'utf8'));
    } catch {
      return null;
    }
  };
  return JSON.stringify({ themes: await read('themes'), presets: await read('presets') }).replace(/</g, '\\u003c');
}

function send(res, type, body) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export function webRoutes({ dir, lan }) {
  // A paired phone, as opposed to this Mac.
  const phoneToken = ({ local, paired }) => (!local && paired ? lan.token : null);
  return [
    {
      // The shell carries the service's language, so the page matches the labels and titles the
      // service sends. A paired phone also gets the token in the manifest link: Safari reads the
      // manifest at load, and a home-screen app starts from its start_url with empty storage.
      method: 'GET', path: '/', access: 'public',
      handle: async (ctx) => {
        let page = (await fs.promises.readFile(path.join(dir, 'index.html'), 'utf8')).replace('<html lang="en">', `<html lang="${LANG}">`);
        // The packs go into the page so the theme applies before the first paint.
        const inlined = await packs(dir);
        page = page.replace(PACKS_TAG, () => `<script id="packs" type="application/json">${inlined}</script>`);
        const token = phoneToken(ctx);
        if (token) page = page.replace('href="/manifest.webmanifest"', `href="/manifest.webmanifest?t=${token}"`);
        send(ctx.res, 'text/html; charset=utf-8', page);
      },
    },
    {
      method: 'GET', path: '/manifest.webmanifest', access: 'public',
      handle: (ctx) => send(ctx.res, 'application/manifest+json; charset=utf-8', JSON.stringify(manifest(phoneToken(ctx)))),
    },
    ...Object.entries(FILES).map(([p, [file, type]]) => ({
      method: 'GET', path: p, access: 'public',
      handle: async ({ res }) => send(res, type, await fs.promises.readFile(path.join(dir, file))),
    })),
  ];
}
