import fs from 'node:fs';
import path from 'node:path';

export function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function oneLine(s, n = 120) {
  return truncate(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
}

// Markdown → plain text, for showing a reply as a one-line fallback.
export function plainText(s) {
  return String(s ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ');
}

// Some tools prefix session names with a status ("🔵 Doing · …"); the board shows status itself.
export function cleanTitle(s) {
  if (!s) return null;
  return String(s).replace(/^[^\p{L}\p{N}]*(Doing|Waiting|Done)\s*·\s*/u, '').trim() || null;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file, data) {
  writeFileAtomic(file, JSON.stringify(data));
}

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Whether `file` is a path to an executable file. A bare name (the not-found fallback) is not. */
export function isExecutable(file) {
  if (!file || !String(file).includes('/')) return false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A task id short enough for logs and fallback titles: a Claude UUID's first 8 characters, a
 *  namespaced id's last 8 (UUIDv7 ids share their leading timestamp digits). */
export function shortId(id) {
  const s = String(id);
  return s.includes(':') ? s.slice(-8) : s.slice(0, 8);
}

// Same rule Claude Code uses for ~/.claude/projects/<slug>.
export function projectSlug(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function appleScriptString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HOST_SESSION_RE = /^local_[A-Za-z0-9-]{1,64}$/;
export const JOB_SHORT_RE = /^[0-9a-f]{6,12}$/;
