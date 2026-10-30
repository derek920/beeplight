import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const JOBS_DIR = path.join(CLAUDE_DIR, 'jobs');

export const ROOT_DIR = path.resolve(import.meta.dirname, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DATA_DIR = process.env.BEEPLIGHT_DATA_DIR || path.join(ROOT_DIR, 'data');
export const STORE_FILE = path.join(DATA_DIR, 'state.json');
// Empty cwd for summarizer calls so no project CLAUDE.md / settings get loaded.
export const LLM_CWD = path.join(DATA_DIR, 'llm-cwd');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.PORT) || 7333;

// The user asked for 3 status checks per second.
export const TICK_MS = Math.round(1000 / 3);
export const PS_REFRESH_MS = 2000;

// Ended sessions and finished background jobs stay on the board this long.
export const RETAIN_ENDED_MS = Number(process.env.BEEPLIGHT_RETAIN_HOURS || 12) * 3600_000;

export const SUMMARY_MODEL = process.env.BEEPLIGHT_MODEL || 'haiku';
export const SUMMARY_CONCURRENCY = 2;
export const SUMMARY_TIMEOUT_MS = 45_000;
// Hard cap on non-essential (mid-turn) summaries per hour; turn-end summaries are always allowed.
export const SUMMARY_HOURLY_CAP = 120;

export const CLAUDE_BIN = resolveClaudeBin();

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
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
