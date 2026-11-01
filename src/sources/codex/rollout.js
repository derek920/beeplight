import fs from 'node:fs';
import { t } from '../../lib/i18n.js';
import { oneLine } from '../../lib/util.js';
import { emptyAnalysis, pushTimeline } from '../common/analysis.js';
import { JsonlTail } from '../common/jsonl-tail.js';

// A Codex thread's rollout (~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl) → the
// shared analysis (src/sources/common/analysis.js). The format is reverse-engineered from Codex
// 0.166; parse it only here. Each line is {timestamp, ordinal, type, payload}:
//   session_meta                 first line: cwd, originator ("Codex Desktop" | "codex-tui"), thread_source
//   turn_context                 the turn's cwd and approval_policy
//   event_msg/task_started       a turn starts (turn_attribution.parent_turn_id: started by a subagent)
//   event_msg/item_completed     UserMessage (the user's request), AgentMessage (phase commentary |
//                                final_answer), CommandExecution, Extension (web search), Reasoning
//   event_msg/task_complete      the turn ended; event_msg/turn_aborted: interrupted
//   response_item/*              raw model input and output: tool calls (custom_tool_call, function_call)
//                                and their *_output by call_id. Injected context is role=user here
//                                too, so prompts come only from UserMessage items.
// Waiting for the user's approval is not written anywhere. The only trace is a tool call that asks
// to leave the sandbox (sandbox_permissions "require_escalated", or request_permissions) and has
// no output yet: `escalation` holds it.

const RECENT_TOOLS_MAX = 20;
const RECENT_PROMPTS_MAX = 4;
const HEAD_BYTES = 256 * 1024;
const MAX_LINE = 1024 * 1024;

// Read type and payload type off the line's start, so the big lines (model input, tool schemas,
// world state: 10–45 KB each) are skipped without JSON.parse.
const PREFIX = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"([a-z_]+)","payload":\{(?:"type":"([A-Za-z_]+)")?/;
const SKIP = new Set([
  'world_state/',
  'token_usage_record/',
  'response_item/message',
  'response_item/reasoning',
  'response_item/additional_tools',
  'event_msg/token_count',
  'event_msg/thread_settings_applied',
]);
const CALL_ID = /"call_id":"([^"]+)"/;

export class Rollout extends JsonlTail {
  constructor(file, config) {
    super(file, config);
    this.reset();
  }

  reset() {
    this.a = emptyAnalysis();
    this.meta = null; // { id, cwd, originator, threadSource }
    this.cwd = null; // the latest turn's cwd
    this.policy = null; // the latest turn's approval_policy
    this.escalation = null; // { callId, ts, justification }
    this.subTurn = null; // a turn a subagent started; its items are not the user's task
  }

  onReset() {
    this.reset();
  }

  poll() {
    // A tail read skips the first line, and with it the thread's cwd and origin.
    if (!this.meta && this.ino === null) this.readHead();
    return super.poll();
  }

  readHead() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.allocUnsafe(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      const nl = buf.subarray(0, n).indexOf(10);
      if (nl > 0) ingestLine(this, buf.toString('utf8', 0, nl));
    } catch {
      // Not there yet, or unreadable: the tail read tries again.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  onLine(line) {
    return ingestLine(this, line);
  }
}

/** One rollout line into the parser state `r` ({ a, meta, cwd, policy, escalation, subTurn }). */
export function ingestLine(r, line) {
  const m = PREFIX.exec(line.slice(0, 200));
  const kind = m ? `${m[1]}/${m[2] ?? ''}` : null;
  if (kind && SKIP.has(kind)) return false;
  if (kind && /^response_item\/\w+_output$/.test(kind)) return onOutput(r, CALL_ID.exec(line.slice(0, 600))?.[1]);
  if (line.length > MAX_LINE && kind !== 'session_meta/') return false;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return false;
  }
  const p = d.payload || {};
  const ts = Date.parse(d.timestamp) || 0;
  switch (d.type) {
    case 'session_meta':
      r.meta = { id: p.id, cwd: p.cwd, originator: p.originator, threadSource: p.thread_source };
      return true;
    case 'turn_context':
      r.cwd = p.cwd || r.cwd;
      r.policy = p.approval_policy ?? r.policy;
      return false;
    case 'response_item':
      return p.type === 'custom_tool_call' || p.type === 'function_call' ? onCall(r, p, ts) : false;
    case 'event_msg':
      return onEvent(r, p, ts);
    default:
      return false;
  }
}

function onEvent(r, p, ts) {
  const a = r.a;
  switch (p.type) {
    case 'task_started':
      if (p.turn_attribution?.parent_turn_id) {
        r.subTurn = p.turn_id;
        return false;
      }
      a.turn = { key: p.turn_id, startedAt: ts, endedAt: null, durationMs: null, error: null, interrupted: false, toolErrors: 0 };
      a.pendingTools.clear();
      a.apiRetry = null;
      r.escalation = null;
      return true;
    case 'item_completed':
      if (p.turn_id && p.turn_id === r.subTurn) return false;
      // Items that land after their turn ended (a command's late result) don't move the turn.
      if (a.turn?.endedAt != null && p.turn_id === a.turn.key) return false;
      return onItem(r, p.item || {}, ts, p.turn_id);
    case 'task_complete':
    case 'turn_aborted':
      if (p.turn_id && p.turn_id === r.subTurn) {
        r.subTurn = null;
        return false;
      }
      return onTurnEnd(r, p, ts);
    case 'error': {
      const msg = oneLine(p.message || t('API error'), 300);
      if (a.turn) a.turn.error = msg;
      pushTimeline(a, { k: 'note', text: t('API error: {msg}', { msg }), ts });
      return true;
    }
    default:
      return false;
  }
}

function onItem(r, item, ts, turnId) {
  const a = r.a;
  switch (item.type) {
    case 'UserMessage': {
      const text = textOf(item.content).trim();
      if (!text) return false;
      const p = { uuid: item.id || `ts-${ts}`, text, ts };
      a.promptCount++;
      if (!a.firstPrompt) a.firstPrompt = p;
      a.lastPrompt = p;
      a.recentPrompts.push(p);
      if (a.recentPrompts.length > RECENT_PROMPTS_MAX) a.recentPrompts.shift();
      // The tail may start mid-turn, after its task_started.
      if (!a.turn || a.turn.endedAt != null) {
        a.turn = { key: turnId || p.uuid, startedAt: ts, endedAt: null, durationMs: null, error: null, interrupted: false, toolErrors: 0 };
      }
      pushTimeline(a, { k: 'prompt', text, ts, uuid: p.uuid });
      return true;
    }
    case 'AgentMessage': {
      const text = textOf(item.content).trim();
      if (!text) return false;
      a.lastReply = { text, ts };
      pushTimeline(a, { k: 'reply', text, ts });
      if (a.turn) a.turn.error = null;
      return true;
    }
    case 'CommandExecution': {
      const error = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0);
      if (error && a.turn) a.turn.toolErrors++;
      addTool(a, { id: item.id, name: 'Shell', brief: oneLine(commandText(item.command), 90), ts, done: true, error });
      return true;
    }
    case 'Extension': {
      // kind "web.search"; action.type is search (query) or openPage (url).
      const name = /search/i.test(item.kind || '') ? t('Web search') : String(item.kind || 'tool');
      const brief = item.query || item.action?.url || item.action?.query || item.action?.queries?.[0] || '';
      addTool(a, { id: item.id, name, brief: oneLine(brief, 90), ts, done: true, error: false });
      return true;
    }
    default:
      return false;
  }
}

// A tool call: pending until its *_output lands. One that asks to leave the sandbox may be
// waiting for the user's approval.
function onCall(r, p, ts) {
  const id = p.call_id;
  if (!id) return false;
  const args = String(p.input ?? p.arguments ?? '');
  const cmd = /\bcmd\s*"?\s*:\s*"((?:[^"\\]|\\.){0,300})"/.exec(args.slice(0, 4096))?.[1];
  const tool = cmd
    ? { id, name: 'Shell', brief: oneLine(unescape(cmd), 90), ts, done: false, error: false }
    : { id, name: p.name || 'tool', brief: '', ts, done: false, error: false };
  r.a.pendingTools.set(id, tool);
  const kind = p.name === 'request_permissions' ? 'permissions' : args.includes('require_escalated') ? 'sandbox' : null;
  if (kind) {
    const why = /\bjustification\s*"?\s*:\s*"((?:[^"\\]|\\.){0,400})"/.exec(args)?.[1];
    r.escalation = { callId: id, kind, ts, justification: why ? oneLine(unescape(why), 200) : '' };
  }
  return true;
}

function onOutput(r, callId) {
  if (!callId) return false;
  if (r.escalation?.callId === callId) r.escalation = null;
  return r.a.pendingTools.delete(callId);
}

function onTurnEnd(r, p, ts) {
  const a = r.a;
  if (!a.turn) return false;
  a.turn.endedAt = ts;
  a.turn.durationMs = p.duration_ms ?? null;
  a.pendingTools.clear();
  r.escalation = null;
  if (p.type === 'turn_aborted') {
    if (p.reason === 'interrupted') {
      a.turn.interrupted = true;
      pushTimeline(a, { k: 'note', text: t('Interrupted by the user'), ts });
    } else {
      a.turn.error = oneLine(p.reason || t('Turn aborted'), 300);
      pushTimeline(a, { k: 'note', text: a.turn.error, ts });
    }
  } else if (p.last_agent_message && !(a.lastReply && a.lastReply.ts >= a.turn.startedAt)) {
    // The final answer normally arrives as an AgentMessage; the tail may have missed it.
    a.lastReply = { text: String(p.last_agent_message), ts };
  }
  return true;
}

function addTool(a, tool) {
  a.recentTools.push(tool);
  if (a.recentTools.length > RECENT_TOOLS_MAX) a.recentTools.shift();
  pushTimeline(a, { k: 'tool', tool, ts: tool.ts });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
}

// ["/bin/zsh", "-lc", "npm test"] → "npm test"
function commandText(command) {
  if (Array.isArray(command)) return String(command[command.length - 1] ?? '');
  return String(command ?? '');
}

function unescape(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}
