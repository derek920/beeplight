import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from '../../config/index.js';
import { cleanTitle, HOST_SESSION_RE, JOB_SHORT_RE, pidAlive, projectSlug, SESSION_ID_RE } from '../../lib/util.js';
import { Jobs } from './jobs.js';
import { Registry } from './registry.js';
import { Subagents } from './subagents.js';
import { Transcript } from './transcript.js';

// Claude Code as an agent source (the interface is described in src/core/collector.js): its
// session registry is the live signal, its transcripts the conversation, `claude --bg` jobs the
// tasks without a process. Session ids stay bare UUIDs, as Claude Code writes them.
export class ClaudeCodeSource {
  id = 'claude-code';
  name = 'Claude Code';
  speaker = 'Claude';
  // Its activity drives Claude limit probes; its processes are the "Claude" share of the CPU.
  caps = { limits: true, cpu: 'claude' };

  /** @param {{ isOwnPid?: (pid: number) => boolean, config?: object }} opts */
  constructor({ isOwnPid = () => false, config, registry = new Registry(), jobs = new Jobs() } = {}) {
    this.isOwnPid = isOwnPid;
    this.config = config;
    this.registry = registry;
    this.jobs = jobs;
  }

  owns(sid) {
    return !sid.includes(':');
  }

  /** Live sessions: registry entries of genuine Claude processes, minus Beeplight's own. */
  poll(now, ps) {
    const out = new Map();
    for (const [sid, reg] of this.registry.poll()) {
      if (this.isOwnPid(reg.pid) || !isGenuine(reg, ps)) continue;
      out.set(sid, reg);
    }
    return out;
  }

  background() {
    return this.jobs.poll();
  }

  /** The session's transcript and subagents, once its transcript file exists. */
  open(s) {
    const file = findTranscript(s.sid, s.cwd);
    if (!file) return null;
    return {
      tx: new Transcript(file, this.config),
      subs: new Subagents(path.join(path.dirname(file), s.sid, 'subagents'), this.config),
    };
  }

  /** Title candidates, best first. */
  names(s, job) {
    const a = s.tx?.a;
    return [cleanTitle(a?.customTitle), job?.name, a?.aiTitle, registryName(s.reg)];
  }

  /** Where to restart a session that ended before Beeplight restarted, from its last view. */
  restore(sid, v) {
    return { pid: v.pid, cwd: v.cwd, status: v.lastRegStatus, entrypoint: v.entrypoint, hostSessionId: v.hostSessionId };
  }

  /** Steps to bring the session to the front (run by src/actions/focus.js). */
  focus(t) {
    if (t.entrypoint === 'claude-desktop' && HOST_SESSION_RE.test(t.hostSessionId || '')) {
      return [{ do: 'url', kind: 'claude-desktop', id: t.hostSessionId }];
    }
    const steps = [{ do: 'host' }];
    if (t.jobShort && JOB_SHORT_RE.test(t.jobShort)) steps.push({ do: 'newTab', cli: 'claude', args: ['attach', t.jobShort] });
    else if (!t.live && SESSION_ID_RE.test(t.id) && t.cwd) steps.push({ do: 'newTab', cli: 'claude', args: ['--resume', t.id], cwd: t.cwd });
    return steps;
  }
}

// Alive, and not a recycled pid left behind in a stale registry file.
function isGenuine(reg, ps) {
  if (!pidAlive(reg.pid)) return false;
  const p = ps.get(reg.pid);
  return !(p && reg.startedAt && p.start > reg.startedAt + 5000);
}

function findTranscript(sid, cwd) {
  const name = `${sid}.jsonl`;
  if (cwd) {
    const direct = path.join(PROJECTS_DIR, projectSlug(cwd), name);
    if (fs.existsSync(direct)) return direct;
  }
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(PROJECTS_DIR, d, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// The registry name is auto-derived (e.g. "monitor-8f") unless the user or the desktop app set it.
function registryName(reg) {
  if (!reg?.name || reg.nameSource === 'derived') return null;
  return cleanTitle(reg.name);
}
