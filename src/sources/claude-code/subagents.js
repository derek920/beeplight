import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig } from '../../config/index.js';
import { readJson } from '../../lib/util.js';
import { displayToolName, toolBrief, toolLine } from './transcript.js';

const TAIL_BYTES = 64 * 1024;
const STALE_MS = 15 * 60_000;

// Subagents of a session live in <project>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json).
export class Subagents {
  constructor(dir, config = defaultConfig) {
    this.dir = dir;
    this.config = config;
    this.items = new Map();
  }

  poll() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return false;
    }
    let changed = false;
    for (const name of names) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (!m) continue;
      const file = path.join(this.dir, name);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      let it = this.items.get(m[1]);
      if (!it) {
        const meta = readJson(file.replace(/\.jsonl$/, '.meta.json')) || {};
        it = { id: m[1], type: meta.agentType || 'agent', description: meta.description || '', startedAt: st.birthtimeMs, size: -1 };
        this.items.set(m[1], it);
      }
      if (st.size === it.size) continue;
      it.size = st.size;
      it.mtime = st.mtimeMs;
      Object.assign(it, readTailState(file, st.size));
      changed = true;
    }
    return changed;
  }

  list(now, parentAlive) {
    const out = [];
    const showFinished = this.config.get('subagents.showFinishedMinutes') * 60_000;
    for (const it of this.items.values()) {
      const running = parentAlive && !it.finished && now - it.mtime < STALE_MS;
      if (!running && now - it.mtime > showFinished) continue;
      out.push({
        id: it.id,
        type: it.type,
        description: it.description,
        running,
        activity: running ? it.activity : null,
        startedAt: it.startedAt,
        updatedAt: it.mtime,
      });
    }
    return out.sort((x, y) => Number(y.running) - Number(x.running) || y.updatedAt - x.updatedAt);
  }
}

function readTailState(file, size) {
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.allocUnsafe(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  let finished = false;
  let activity = null;
  // Walk back to the newest parseable user/assistant entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (d.type !== 'assistant' && d.type !== 'user') continue;
    if (d.type === 'assistant') {
      const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
      const tool = blocks.findLast((b) => b?.type === 'tool_use');
      if (tool) activity = toolLine({ name: displayToolName(tool.name), brief: toolBrief(tool.name, tool.input) });
      finished = !tool && d.message?.stop_reason === 'end_turn';
    }
    break;
  }
  return { finished, activity };
}
