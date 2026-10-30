import fs from 'node:fs';
import path from 'node:path';
import { JOBS_DIR } from './config.js';
import { readJson } from './util.js';

// Background sessions (`claude --bg`) keep a daemon-maintained state.json with
// state = working | blocked | done | failed plus a one-line detail.
export class Jobs {
  constructor(dir = JOBS_DIR) {
    this.dir = dir;
    this.files = new Map(); // file -> { mtimeMs, job }
  }

  // Returns Map<sessionId, job>.
  poll() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    const seen = new Set();
    for (const name of names) {
      const file = path.join(this.dir, name, 'state.json');
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      seen.add(file);
      const prev = this.files.get(file);
      if (prev && prev.mtimeMs === st.mtimeMs) continue;
      const d = readJson(file);
      if (!d?.sessionId) continue;
      this.files.set(file, {
        mtimeMs: st.mtimeMs,
        job: {
          short: d.daemonShort || name,
          sessionId: d.sessionId,
          state: d.state,
          detail: d.detail,
          needs: d.needs,
          suggestedReply: d.suggestedReply,
          name: d.name,
          cwd: d.cwd,
          createdAt: Date.parse(d.createdAt) || null,
          updatedAt: Date.parse(d.updatedAt) || st.mtimeMs,
        },
      });
    }
    for (const file of this.files.keys()) if (!seen.has(file)) this.files.delete(file);
    const out = new Map();
    for (const { job } of this.files.values()) out.set(job.sessionId, job);
    return out;
  }
}
