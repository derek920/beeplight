import fs from 'node:fs';
import path from 'node:path';
import { DESKTOP_SESSIONS_DIR } from '../../config/index.js';
import { readJson } from '../../lib/util.js';

// Sessions the user archived in Claude's desktop app. The app keeps a small index per account and
// organisation, <dir>/<account>/<org>/archived-sessions.idx = {"v":1,"archived":["local_<uuid>",…]},
// listing the app's own session ids, which are the registry's `hostSessionId`. Un-archiving
// removes the id from the list, so the session comes back by itself. Sessions the app does not
// know (terminal ones) are never in it.
export class ArchivedSessions {
  constructor(dir = DESKTOP_SESSIONS_DIR) {
    this.dir = dir;
    this.files = new Map(); // file -> { mtimeMs, ids }
    this.ids = new Set();
  }

  /** @returns {Set<string>} archived desktop session ids; only re-reads index files that changed. */
  poll() {
    const seen = new Set();
    let changed = false;
    for (const account of subdirs(this.dir)) {
      for (const org of subdirs(path.join(this.dir, account))) {
        const file = path.join(this.dir, account, org, 'archived-sessions.idx');
        let st;
        try {
          st = fs.statSync(file);
        } catch {
          continue;
        }
        seen.add(file);
        if (this.files.get(file)?.mtimeMs === st.mtimeMs) continue;
        const list = readJson(file)?.archived;
        this.files.set(file, { mtimeMs: st.mtimeMs, ids: Array.isArray(list) ? list : [] });
        changed = true;
      }
    }
    for (const file of this.files.keys()) {
      if (!seen.has(file)) {
        this.files.delete(file);
        changed = true;
      }
    }
    if (changed) this.ids = new Set([...this.files.values()].flatMap((f) => f.ids));
    return this.ids;
  }
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}
