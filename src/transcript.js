import fs from 'node:fs';
import path from 'node:path';
import { config as defaultConfig } from './config.js';
import { t } from './i18n.js';
import { oneLine } from './util.js';

// Transcripts can be >100MB; on first sight only the tail is needed for the current task.
const MB = 1024 * 1024;
const TIMELINE_MAX = 80;
const RECENT_TOOLS_MAX = 20;
const RECENT_PROMPTS_MAX = 4;

// Line types with nothing for us, rejected on the prefix before paying for JSON.parse
// (api-request-blob lines carry the whole system prompt).
const SKIP_PREFIX =
  /^\{"type":"(api-request|file-history|atis-latch|mode|permission-mode|tools-used|cost-state|queue-operation|bridge-session|artifact-|frame-link|relocated|last-prompt)/;

export function emptyAnalysis() {
  return {
    promptCount: 0,
    firstPrompt: null, // first prompt seen (within the tail we read)
    lastPrompt: null, // { uuid, text, ts }
    recentPrompts: [], // last few prompts, kept even when the timeline window has moved past them
    lastReply: null, // { text, ts }
    turn: null, // { key, startedAt, endedAt, durationMs, error, interrupted, toolErrors }
    pendingTools: new Map(), // tool_use id -> tool, cleared when its tool_result lands
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

export class Transcript {
  constructor(file, config = defaultConfig) {
    this.file = file;
    this.config = config;
    this.offset = 0;
    this.ino = null;
    this.remainder = Buffer.alloc(0);
    this.skipPartial = false;
    this.a = emptyAnalysis();
    this.version = 0;
  }

  // Reads whatever was appended since the last call. Returns true if the analysis changed.
  poll() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (this.ino !== null && (st.ino !== this.ino || st.size < this.offset)) {
      // Rewritten or replaced: start over.
      this.ino = null;
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      this.a = emptyAnalysis();
      this.version++;
    }
    if (this.ino === null) {
      this.ino = st.ino;
      // Some transcripts pass 100 MB; the recent end is what matters.
      const tail = Math.floor(this.config.get('transcript.initialTailMB') * MB);
      if (st.size > tail) {
        this.offset = st.size - tail;
        this.skipPartial = true;
      }
    }
    if (st.size <= this.offset) return false;

    const len = Math.min(st.size - this.offset, Math.floor(this.config.get('transcript.maxReadMB') * MB));
    const buf = Buffer.allocUnsafe(len);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += len;
    return this.ingestBuffer(buf);
  }

  ingestBuffer(buf) {
    const data = this.remainder.length ? Buffer.concat([this.remainder, buf]) : buf;
    let start = 0;
    if (this.skipPartial) {
      const nl = data.indexOf(10);
      if (nl < 0) {
        this.remainder = Buffer.from(data);
        return false;
      }
      start = nl + 1;
      this.skipPartial = false;
    }
    const last = data.lastIndexOf(10);
    if (last < start) {
      this.remainder = Buffer.from(data.subarray(start));
      return false;
    }
    // Split on the byte, not the string, so a multi-byte char is never cut in half.
    this.remainder = Buffer.from(data.subarray(last + 1));
    let changed = false;
    for (const line of data.toString('utf8', start, last).split('\n')) {
      if (line && ingestLine(this.a, line)) changed = true;
    }
    if (changed) this.version++;
    return changed;
  }
}

export function ingestLine(a, line) {
  if (SKIP_PREFIX.test(line.slice(0, 48))) return false;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return false;
  }
  switch (d.type) {
    case 'ai-title':
      a.aiTitle = d.aiTitle || a.aiTitle;
      return true;
    case 'custom-title':
      a.customTitle = d.customTitle || a.customTitle;
      return true;
    case 'agent-name':
      a.agentName = d.agentName || a.agentName;
      return true;
  }
  if (d.isSidechain) return false;
  const ts = d.timestamp ? Date.parse(d.timestamp) || 0 : 0;
  switch (d.type) {
    case 'user':
      return onUser(a, d, ts);
    case 'assistant':
      return onAssistant(a, d, ts);
    case 'system':
      return onSystem(a, d, ts);
    default:
      return false;
  }
}

function onUser(a, d, ts) {
  const c = d.message?.content;
  if (d.isCompactSummary) {
    a.compactSummary = textOf(c);
    return true;
  }
  if (typeof c === 'string') return onUserText(a, d, c.trim(), ts);
  if (!Array.isArray(c)) return false;
  let changed = false;
  for (const b of c) {
    if (b?.type !== 'tool_result') continue;
    const t = a.pendingTools.get(b.tool_use_id);
    if (t) {
      t.done = true;
      t.error = !!b.is_error;
      a.pendingTools.delete(b.tool_use_id);
      if (t.error && a.turn) a.turn.toolErrors++;
      changed = true;
    }
  }
  const text = c
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (text) changed = onUserText(a, d, text, ts) || changed;
  return changed;
}

function onUserText(a, d, text, ts) {
  if (text.startsWith('[Request interrupted by user')) {
    if (a.turn) a.turn.interrupted = true;
    a.pendingTools.clear();
    pushTimeline(a, { k: 'note', text: t('Interrupted by the user'), ts });
    return true;
  }
  const origin = d.origin?.kind;
  if (origin === 'task-notification' || text.startsWith('<task-notification>')) {
    const status = /<status>([^<]*)<\/status>/.exec(text)?.[1];
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1];
    const key = status === 'completed' ? 'Background task finished: {summary}'
      : status === 'failed' ? 'Background task failed: {summary}' : 'Background task {status}: {summary}';
    pushTimeline(a, { k: 'note', text: t(key, { status: status || '', summary: oneLine(summary, 160) }), ts });
    return true;
  }
  if (d.isMeta) return false;
  // auto-continuation, peer messages and other system-originated turns are not the user's task.
  if (origin && origin !== 'human') return false;
  if (/^<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat|system-reminder)/.test(text)) {
    return false;
  }
  let shown = text;
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    shown = cmd[1].trim() + (args ? ` ${args}` : '');
  }
  shown = shown.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!shown) return false;

  const p = { uuid: d.uuid || `ts-${ts}`, text: shown, ts };
  a.promptCount++;
  if (!a.firstPrompt) a.firstPrompt = p;
  a.lastPrompt = p;
  a.recentPrompts.push(p);
  if (a.recentPrompts.length > RECENT_PROMPTS_MAX) a.recentPrompts.shift();
  a.turn = { key: p.uuid, startedAt: ts, endedAt: null, durationMs: null, error: null, interrupted: false, toolErrors: 0 };
  a.pendingTools.clear();
  a.apiRetry = null;
  pushTimeline(a, { k: 'prompt', text: shown, ts, uuid: p.uuid });
  return true;
}

function onAssistant(a, d, ts) {
  const m = d.message;
  if (!m) return false;
  if (d.isApiErrorMessage) {
    const msg = oneLine(textOf(m.content) || d.error || t('API error'), 300);
    if (a.turn) a.turn.error = msg;
    pushTimeline(a, { k: 'note', text: t('API error: {msg}', { msg }), ts });
    return true;
  }
  let changed = false;
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b?.type === 'text' && b.text?.trim()) {
      const text = b.text.trim();
      a.lastReply = { text, ts };
      pushTimeline(a, { k: 'reply', text, ts });
      changed = true;
    } else if (b?.type === 'tool_use' && displayToolName(b.name) === 'wrap_up') {
      // The desktop app ends a turn with a wrap-up card: recap, and optionally a question for
      // the user with suggested replies. The question lives only here, not in the reply text.
      const i = b.input || {};
      const wrapUp = {
        recap: oneLine(i.recap, 400),
        ask: oneLine(i.ask, 200),
        actions: (Array.isArray(i.actions) ? i.actions : []).map((x) => oneLine(x?.label, 40)).filter(Boolean),
      };
      if (a.turn) a.turn.wrapUp = wrapUp;
      const options = wrapUp.actions.length ? t(' (options: {actions})', { actions: wrapUp.actions.join(' / ') }) : '';
      const asked = wrapUp.ask ? t('; asked the user: {ask}', { ask: wrapUp.ask }) + options : '';
      pushTimeline(a, { k: 'note', text: t('Wrap-up: {recap}', { recap: wrapUp.recap }) + asked, ts });
      changed = true;
    } else if (b?.type === 'tool_use') {
      const t = { id: b.id, name: displayToolName(b.name), brief: toolBrief(b.name, b.input), ts, done: false, error: false };
      a.pendingTools.set(b.id, t);
      a.recentTools.push(t);
      if (a.recentTools.length > RECENT_TOOLS_MAX) a.recentTools.shift();
      pushTimeline(a, { k: 'tool', tool: t, ts });
      changed = true;
    }
  }
  if (changed) {
    // A real response after a retried/failed request means the turn recovered.
    if (a.turn) a.turn.error = null;
    a.apiRetry = null;
  }
  return changed;
}

function onSystem(a, d, ts) {
  switch (d.subtype) {
    case 'turn_duration':
      if (a.turn) {
        a.turn.endedAt = ts;
        a.turn.durationMs = d.durationMs ?? null;
      }
      return true;
    case 'api_error':
      a.apiRetry = {
        message: oneLine(d.error?.formatted || d.error?.message || t('API error'), 160),
        attempt: d.retryAttempt ?? null,
        max: d.maxRetries ?? null,
        ts,
      };
      return true;
    case 'away_summary':
      if (typeof d.content === 'string') {
        a.awaySummary = { text: d.content.replace(/\s*\(disable recaps in \/config\)\s*$/, ''), ts };
        return true;
      }
      return false;
    default:
      return false;
  }
}

function pushTimeline(a, item) {
  a.timeline.push(item);
  if (a.timeline.length > TIMELINE_MAX) a.timeline.shift();
  if (item.ts > a.lastTs) a.lastTs = item.ts;
}

function textOf(c) {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export function displayToolName(name = '') {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return parts.slice(2).join('__') || name;
  }
  return name;
}

export function toolBrief(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  let s;
  if (name === 'Bash') s = i.description || i.command;
  else if (i.file_path) s = path.basename(String(i.file_path));
  else if (i.notebook_path) s = path.basename(String(i.notebook_path));
  else s = i.description || i.pattern || i.url || i.query || i.command || i.skill || i.prompt || i.subject || i.action || i.path || '';
  return oneLine(s, 90);
}

export function lastPendingTool(a) {
  let last = null;
  for (const t of a.pendingTools.values()) if (!last || t.ts >= last.ts) last = t;
  return last;
}

export function toolLine(t) {
  return t.brief ? `${t.name} · ${t.brief}` : t.name;
}

