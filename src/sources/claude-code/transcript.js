import path from 'node:path';
import { t } from '../../lib/i18n.js';
import { oneLine } from '../../lib/util.js';
import { addBackground, emptyAnalysis, endBackground, pushTimeline } from '../common/analysis.js';
import { JsonlTail } from '../common/jsonl-tail.js';

// Claude Code's transcript (~/.claude/projects/<slug>/<sessionId>.jsonl) → the shared analysis
// (src/sources/common/analysis.js). The line format is reverse-engineered; parse it only here.
export { emptyAnalysis, lastPendingTool, toolLine } from '../common/analysis.js';

const RECENT_TOOLS_MAX = 20;
const RECENT_PROMPTS_MAX = 4;

// Line types with nothing for us, rejected on the prefix before paying for JSON.parse
// (api-request-blob lines carry the whole system prompt).
const SKIP_PREFIX =
  /^\{"type":"(api-request|file-history|atis-latch|mode|permission-mode|tools-used|cost-state|queue-operation|bridge-session|artifact-|frame-link|relocated|last-prompt)/;

export class Transcript extends JsonlTail {
  constructor(file, config) {
    super(file, config);
    this.a = emptyAnalysis();
  }

  onLine(line) {
    return ingestLine(this.a, line);
  }

  onReset() {
    this.a = emptyAnalysis();
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
    case 'attachment':
      return onAttachment(a, d, ts);
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
      if (!t.error) onToolOutcome(a, t, b, d.toolUseResult, ts);
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
  if (origin === 'task-notification' || text.startsWith('<task-notification>')) return onNotification(a, text, ts);
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
      // What a background launch or a stop needs once its result is in.
      const i = b.input && typeof b.input === 'object' ? b.input : {};
      if (b.name === 'Bash') t.bash = { command: oneLine(i.command, 300), description: oneLine(i.description, 90), background: !!i.run_in_background };
      else if (STOP_TOOLS.has(b.name)) t.stops = String(i.task_id || i.shell_id || '');
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

// Background commands. A Bash call started with run_in_background (or sent to the background with
// ctrl+b) returns at once with the task id; the end comes later as a task notification ("completed
// (exit code 0)", "failed with exit code 1", "was stopped"), or as the result of a TaskStop call.
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);
const BG_LAUNCH = /^Command running in background with ID: ([A-Za-z0-9_-]+)/;

function onToolOutcome(a, t, block, result, ts) {
  if (t.bash) {
    // The result's text alone is not proof: a foreground command can print the same words.
    const id = result?.backgroundTaskId || (t.bash.background ? BG_LAUNCH.exec(textOf(block.content).trimStart())?.[1] : null);
    if (!id) return;
    const { command, description } = t.bash;
    addBackground(a, { id, command, title: description || oneLine(command, 80), startedAt: ts, endedAt: null, status: 'running', exitCode: null });
  } else if (t.stops) {
    endBackground(a, t.stops, 'stopped', null, ts);
  }
}

// A task notification: a user message when the session was idle, or a queued_command attachment
// when it arrived mid-turn.
function onNotification(a, text, ts) {
  for (const [, block] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) endFromNotification(a, block, ts);
  const status = /<status>([^<]*)<\/status>/.exec(text)?.[1];
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1];
  const key = status === 'completed' ? 'Background task finished: {summary}'
    : status === 'failed' ? 'Background task failed: {summary}' : 'Background task {status}: {summary}';
  pushTimeline(a, { k: 'note', text: t(key, { status: status || '', summary: oneLine(summary, 160) }), ts });
  return true;
}

function onAttachment(a, d, ts) {
  const at = d.attachment;
  if (at?.type !== 'queued_command' || at.commandMode !== 'task-notification' || typeof at.prompt !== 'string') return false;
  return onNotification(a, at.prompt, ts);
}

function endFromNotification(a, block, ts) {
  const id = /<task-id>([^<]*)<\/task-id>/.exec(block)?.[1];
  if (!id || !a.background.has(id)) return;
  const status = /<status>([^<]*)<\/status>/.exec(block)?.[1];
  const code = /exit code (-?\d+)/.exec(/<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] || '')?.[1];
  const ended = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped';
  endBackground(a, id, ended, code != null ? Number(code) : null, ts);
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
