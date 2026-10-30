import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envName, GROUPS, PARAMS } from './schema.js';
import { t } from '../lib/i18n.js';
import { writeFileAtomic } from '../lib/util.js';

// Where things are. These come from the environment only: the parameter file itself lives in DATA_DIR.
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const JOBS_DIR = path.join(CLAUDE_DIR, 'jobs');

export const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DATA_DIR = process.env.BEEPLIGHT_DATA_DIR || path.join(ROOT_DIR, 'data');
export const STORE_FILE = path.join(DATA_DIR, 'state.json');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// Empty cwd for summarizer calls so no project CLAUDE.md / settings get loaded.
export const LLM_CWD = path.join(DATA_DIR, 'llm-cwd');

export const HOST = '127.0.0.1';

/**
 * Runtime parameters (src/config/schema.js): the default, overridden by the config file,
 * overridden by the environment. Modules call `get()` when they use a value (a map lookup, cheap
 * enough for every tick), so changes apply without a restart, except for `restart` parameters,
 * which keep their startup value. Emits 'change' with the keys whose value changed.
 */
export class Config extends EventEmitter {
  /** `file: null` keeps everything in memory (tests). */
  constructor({ file = CONFIG_FILE, env = process.env, params = PARAMS, log = console } = {}) {
    super();
    this.setMaxListeners(50);
    this.file = file;
    this.log = log;
    this.params = new Map(params.map((p) => [p.key, p]));
    this.env = {}; // key → { value, name }
    this.saved = {}; // key → valid value from the file
    this.kept = {}; // unknown keys and invalid values in the file, kept as they are when saving
    this.envProblems = [];
    this.fileProblems = [];
    this.values = new Map();
    this.startup = new Map(); // restart-only parameters, frozen at their startup value
    this.lastText = null; // the file as last read or written, so a watch ignores our own writes
    this.readEnv(env);
    this.readFile();
    this.compute(false);
    for (const p of this.params.values()) if (p.restart) this.startup.set(p.key, this.values.get(p.key));
  }

  get(key) {
    if (this.startup.has(key)) return this.startup.get(key);
    const v = this.values.get(key);
    if (v === undefined) throw new Error(`unknown config key: ${key}`);
    return v;
  }

  /** @returns {{ value?: any, error?: string }} */
  check(p, raw) {
    if (p.type === 'int' || p.type === 'number') {
      const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: t('must be a number') };
      if (p.type === 'int' && !Number.isInteger(v)) return { error: t('must be a whole number') };
      if (v < p.min || v > p.max) return { error: t('must be between {min} and {max}', { min: p.min, max: p.max }) };
      return { value: v };
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') return { error: t('must be text') };
    const v = String(raw).trim();
    if (p.maxLength && v.length > p.maxLength) return { error: t('must be at most {n} characters', { n: p.maxLength }) };
    if (p.pattern && !p.pattern.test(v)) return { error: t('has characters that are not allowed') };
    return { value: v };
  }

  readEnv(env) {
    for (const p of this.params.values()) {
      const name = [envName(p.key), ...(p.aliases || [])].find((n) => env[n] !== undefined && env[n] !== '');
      if (!name) continue;
      const r = this.check(p, env[name]);
      if (r.error) this.problem(this.envProblems, `${name}=${env[name]}`, r.error);
      else this.env[p.key] = { value: r.value, name };
    }
  }

  /** @returns {boolean} whether the file changed since it was last read or written */
  readFile() {
    if (!this.file) return false;
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') this.problem(this.fileProblems, this.file, e.message);
    }
    if (text === this.lastText) return false;
    this.lastText = text;
    this.fileProblems = [];
    let data = {};
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        // A half-saved edit: keep the last good values.
        this.problem(this.fileProblems, path.basename(this.file), t('not valid JSON: {msg}', { msg: e.message }));
        return false;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        this.problem(this.fileProblems, path.basename(this.file), t('must be an object of settings'));
        return false;
      }
    }
    this.saved = {};
    this.kept = {};
    for (const [k, raw] of Object.entries(data)) {
      const p = this.params.get(k);
      const r = p ? this.check(p, raw) : { error: t('unknown setting') };
      if (r.error) {
        this.kept[k] = raw;
        this.problem(this.fileProblems, `${k}: ${JSON.stringify(raw)}`, r.error);
      } else {
        this.saved[k] = r.value;
      }
    }
    return true;
  }

  problem(list, where, error) {
    list.push({ where, error });
    this.log.warn?.(`[config] ignored ${where}: ${error}`);
  }

  /** @returns {string[]} keys whose value changed */
  compute(emit = true) {
    const changed = [];
    for (const p of this.params.values()) {
      const v = this.env[p.key]?.value ?? this.saved[p.key] ?? p.default;
      if (this.values.get(p.key) !== v) {
        this.values.set(p.key, v);
        changed.push(p.key);
      }
    }
    const live = changed.filter((k) => !this.startup.has(k));
    if (emit && live.length) this.emit('change', live);
    return changed;
  }

  /**
   * Saves `{ key: value }` to the file; null, or the default, removes a key so it follows the
   * default again. All or nothing: when any value is invalid, nothing is saved.
   * @returns {{ errors: Record<string, string>, changed: string[] }}
   */
  set(patch) {
    const errors = {};
    const saved = { ...this.saved };
    const kept = { ...this.kept };
    for (const [k, raw] of Object.entries(patch || {})) {
      const p = this.params.get(k);
      if (!p) {
        errors[k] = t('unknown setting');
        continue;
      }
      delete kept[k];
      const r = raw === null ? { value: p.default } : this.check(p, raw);
      if (r.error) errors[k] = r.error;
      else if (r.value === p.default) delete saved[k];
      else saved[k] = r.value;
    }
    if (Object.keys(errors).length) return { errors, changed: [] };
    if (this.file) {
      const all = { ...kept, ...saved };
      const text = JSON.stringify(Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]])), null, 2) + '\n';
      writeFileAtomic(this.file, text);
      this.lastText = text;
    }
    this.saved = saved;
    this.kept = kept;
    const changed = this.compute();
    if (changed.length) this.log.log?.(`[config] set ${changed.map((k) => `${k}=${JSON.stringify(this.values.get(k))}`).join(', ')}`);
    return { errors, changed };
  }

  /**
   * Picks up edits made to the file by hand. Polls its modification time every 2 s (one stat call):
   * fs.watch misses the rename an editor's atomic save does.
   */
  watch() {
    if (!this.file || this.watching) return;
    this.watching = true;
    fs.watchFile(this.file, { interval: 2000, persistent: false }, () => {
      if (!this.readFile()) return;
      const changed = this.compute();
      this.log.log?.(`[config] reloaded ${path.basename(this.file)}${changed.length ? `: ${changed.join(', ')}` : ''}`);
    });
  }

  /** setInterval every get(key) × scale ms, re-armed when the parameter changes. */
  every(key, scale, fn, { unref = false } = {}) {
    let timer;
    const arm = () => {
      clearInterval(timer);
      timer = setInterval(fn, this.get(key) * scale);
      if (unref) timer.unref();
    };
    const onChange = (keys) => keys.includes(key) && arm();
    arm();
    this.on('change', onChange);
    return {
      stop: () => {
        clearInterval(timer);
        this.off('change', onChange);
      },
    };
  }

  /** Everything the settings page shows, in the service's language. */
  describe() {
    return {
      file: this.file,
      groups: GROUPS.map((g) => ({
        id: g.id,
        label: t(g.label),
        actions: (g.actions || []).map((a) => ({ id: a.id, label: t(a.label), help: t(a.help), path: a.path })),
      })),
      params: [...this.params.values()].map((p) => {
        const env = this.env[p.key]?.name ?? null;
        const value = this.get(p.key);
        const configured = this.values.get(p.key);
        return {
          key: p.key,
          group: p.key.split('.')[0],
          type: p.type,
          label: t(p.label),
          help: t(p.help),
          value,
          configured,
          default: p.default,
          min: p.min ?? null,
          max: p.max ?? null,
          maxLength: p.maxLength ?? null,
          source: env ? 'env' : p.key in this.saved ? 'file' : 'default',
          env,
          envNames: [envName(p.key), ...(p.aliases || [])],
          restart: !!p.restart,
          restartPending: value !== configured,
        };
      }),
      problems: [...this.envProblems, ...this.fileProblems],
    };
  }
}

export const config = new Config();

export const PORT = config.get('server.port');

let foundBin;

/** The claude executable: the claude.bin parameter, else the first one found (looked up once). */
export function claudeBin(cfg = config) {
  return cfg.get('claude.bin') || (foundBin ??= findClaudeBin());
}

function findClaudeBin() {
  const candidates = [
    ...(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, 'claude')),
    // nvm installs put claude next to node; launchd has no nvm PATH.
    path.join(path.dirname(process.execPath), 'claude'),
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(CLAUDE_DIR, 'local', 'claude'),
    // The Mac app runs its bundled node, so an nvm-installed claude isn't next to it.
    ...nvmBins('claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {}
  }
  return 'claude';
}

/** `~/.nvm/versions/node/<v>/bin/<name>`, newest version first. */
function nvmBins(name) {
  const dir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(dir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(dir, v, 'bin', name));
  } catch {
    return [];
  }
}
