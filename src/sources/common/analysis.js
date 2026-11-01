// The conversation analysis every agent source produces, whatever its transcript format: the
// prompts, the current turn, pending tools and a short timeline. deriveStatus(), the summarizer
// and the board read only this shape, so they never need to know which agent a task came from.

const TIMELINE_MAX = 80;

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
