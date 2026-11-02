// The conversation analysis every agent source produces, whatever its transcript format: the
// prompts, the current turn, pending tools and a short timeline. deriveStatus(), the summarizer
// and the board read only this shape, so they never need to know which agent a task came from.

const TIMELINE_MAX = 80;
const BACKGROUND_MAX = 20;

export function emptyAnalysis() {
  return {
    promptCount: 0,
    firstPrompt: null, // first prompt seen (within the tail we read)
    lastPrompt: null, // { uuid, text, ts }
    recentPrompts: [], // last few prompts, kept even when the timeline window has moved past them
    lastReply: null, // { text, ts }
    turn: null, // { key, startedAt, endedAt, durationMs, error, interrupted, toolErrors }
    pendingTools: new Map(), // tool call id -> tool, cleared when its result lands
    recentTools: [],
    // Commands the agent left running in the background (they outlive the tool call, and often
    // the turn): task id -> { id, command, title, startedAt, endedAt, status, exitCode }, where
    // status is running | completed | failed | stopped. The newest BACKGROUND_MAX are kept.
    background: new Map(),
    timeline: [], // { k: 'prompt'|'reply'|'tool'|'note', text?, tool?, ts }
    apiRetry: null,
    aiTitle: null,
    customTitle: null,
    agentName: null,
    awaySummary: null,
    compactSummary: null,
    lastTs: 0, // timestamp of the newest timeline item; changes whenever the conversation moves
  };
}

export function pushTimeline(a, item) {
  a.timeline.push(item);
  if (a.timeline.length > TIMELINE_MAX) a.timeline.shift();
  if (item.ts > a.lastTs) a.lastTs = item.ts;
}

/** Records a background command; the oldest ones that have ended make room first. */
export function addBackground(a, cmd) {
  a.background.set(cmd.id, cmd);
  while (a.background.size > BACKGROUND_MAX) {
    const old = [...a.background.values()].find((c) => c.status !== 'running') ?? a.background.values().next().value;
    a.background.delete(old.id);
  }
}

/** A background command has ended: completed or failed (with its exit code), or stopped. */
export function endBackground(a, id, status, exitCode, ts) {
  const cmd = a.background.get(id);
  if (!cmd || cmd.status !== 'running') return false;
  Object.assign(cmd, { status, exitCode: exitCode ?? null, endedAt: ts });
  return true;
}

/** Background commands that have not ended, as far as the conversation says. */
export function runningBackground(a) {
  return a ? [...a.background.values()].filter((c) => c.status === 'running') : [];
}

/** The most recently started tool that has no result yet. */
export function lastPendingTool(a) {
  let last = null;
  for (const t of a.pendingTools.values()) if (!last || t.ts >= last.ts) last = t;
  return last;
}

/** "Bash · npm test": a tool and what it works on, for detail lines. */
export function toolLine(t) {
  return t.brief ? `${t.name} · ${t.brief}` : t.name;
}
