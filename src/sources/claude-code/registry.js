import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from '../../config/index.js';
import { readJson } from '../../lib/util.js';

// ~/.claude/sessions/<pid>.json is written by every running Claude Code process.
// Its `status` (busy | idle | waiting) and `waitingFor` are the primary live signal.
export class Registry {
  constructor(dir = SESSIONS_DIR) {
    this.dir = dir;
    this.files = new Map(); // file -> { mtimeMs, size, entry }
  }

  // Returns Map<sessionId, entry>. Only re-reads files whose mtime/size changed.
  poll() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    const seen = new Set();
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const file = path.join(this.dir, name);
      seen.add(file);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const prev = this.files.get(file);
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) continue;
      const d = readJson(file);
      // A half-written file parses as null; keep the previous entry until the next tick.
      if (!d) continue;
      this.files.set(file, { mtimeMs: st.mtimeMs, size: st.size, entry: normalize(d) });
    }
    for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);

    const bySession = new Map();
    for (const { entry } of this.files.values()) {
      if (!entry.sessionId) continue;
      const other = bySession.get(entry.sessionId);
      // Two pids can claim one session briefly (resume in a new process); keep the newest.
      if (!other || (entry.updatedAt ?? 0) > (other.updatedAt ?? 0)) bySession.set(entry.sessionId, entry);
    }
    return bySession;
  }
}

function normalize(d) {
  return {
    pid: Number(d.pid),
    sessionId: d.sessionId,
    cwd: d.cwd,
    kind: d.kind || 'interactive',
    entrypoint: d.entrypoint || 'cli',
    name: d.name,
    nameSource: d.nameSource,
    status: d.status,
    waitingFor: d.waitingFor,
    needs: d.needs,
    detail: d.detail,
    jobId: d.jobId,
    hostSessionId: d.hostSessionId,
    startedAt: d.startedAt,
    updatedAt: d.updatedAt,
    statusUpdatedAt: d.statusUpdatedAt ?? d.updatedAt,
    version: d.version,
  };
}
