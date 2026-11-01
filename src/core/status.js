import { t } from '../lib/i18n.js';
import { lastPendingTool, toolLine } from '../sources/common/analysis.js';
import { oneLine, plainText } from '../lib/util.js';

// Board states: doing | waiting | done (outcome success | failed). `idle` = a session
// that never received a prompt; it is not a task and stays off the board.

const WAITING_LABELS = {
  'permission prompt': 'Needs permission',
  'input needed': 'Needs input',
  'dialog open': 'Dialog open',
  'goal proposal': 'Confirm goal',
  'sandbox request': 'Sandbox network request',
  'worker request': 'Worker request',
};

export function waitingLabel(waitingFor) {
  if (!waitingFor) return t('Needs confirmation');
  if (WAITING_LABELS[waitingFor]) return t(WAITING_LABELS[waitingFor]);
  if (waitingFor.startsWith('approve')) return t('Needs permission');
  return t('Needs confirmation');
}

// Key that identifies "this turn, ended at this point". It changes when Claude resumes
// work without a new prompt (e.g. after a background task notification).
export function endKey(a) {
  return a?.turn ? `${a.turn.key}@${a.lastTs}` : null;
}

// Picks the summary that may decide the outcome of the current turn end.
export function matchingEndSummary(summary, a, live) {
  if (!summary || summary.kind !== 'end' || !a?.turn) return null;
  if (summary.key === endKey(a)) return summary;
  // A closed session cannot move on; its last verdict for this turn still stands.
  if (!live && summary.turnId === a.turn.key) return summary;
  return null;
}

/**
 * @param {object} s
 * @param {boolean} s.live       process alive and registry entry present
 * @param {object}  [s.reg]      registry entry
 * @param {string}  [s.lastRegStatus] registry status last seen before the session ended
 * @param {object}  [s.job]      background job state
 * @param {object}  [s.a]        transcript analysis
 * @param {object}  [s.summary]  latest LLM summary for the session
 * @param {boolean} [s.verdicts] false when no LLM verdict will come (summarizer.titles = original, or
 *                               no summary model installed)
 * @param {number}  [s.runningAgents]
 */
export function deriveStatus({ live, reg, lastRegStatus, job, a, summary, verdicts = true, runningAgents = 0 }) {
  const pending = a ? lastPendingTool(a) : null;

  if (live && reg?.status === 'waiting') {
    const detail = reg.needs || (pending ? toolLine(pending) : reg.waitingFor || '');
    return { state: 'waiting', kind: 'prompt', label: waitingLabel(reg.waitingFor), detail, since: reg.statusUpdatedAt };
  }
  if (live && reg?.status === 'busy') {
    let detail;
    if (a?.apiRetry) {
      const n = a.apiRetry.attempt && a.apiRetry.max ? ` (${a.apiRetry.attempt}/${a.apiRetry.max})` : '';
      detail = t('Retrying API{n}: {msg}', { n, msg: a.apiRetry.message });
    } else if (pending && pending.name !== 'Agent' && pending.name !== 'Task') detail = toolLine(pending);
    else if (runningAgents) detail = t('Subagents running: {n}', { n: runningAgents });
    else if (pending) detail = toolLine(pending);
    else detail = t('Thinking…');
    return { state: 'doing', label: t('Running'), detail, since: reg.statusUpdatedAt };
  }

  // Background job that is not attached to a live process: trust the daemon's verdict.
  if (!live && job) {
    const since = job.updatedAt;
    switch (job.state) {
      case 'blocked':
        return { state: 'waiting', kind: 'question', label: t('Awaiting your reply'), detail: job.needs || job.detail || '', since };
      case 'failed':
        return { state: 'done', outcome: 'failed', label: t('Failed'), detail: job.detail || '', since };
      case 'working':
        return { state: 'doing', label: t('Running in background'), detail: job.detail || '', since };
      default:
        return { state: 'done', outcome: 'success', label: t('Done'), detail: job.detail || '', since };
    }
  }

  if (!a || a.promptCount === 0) return { state: 'idle', label: t('Idle'), detail: '', since: reg?.statusUpdatedAt ?? null };

  const turn = a.turn;
  const since = (live ? reg?.statusUpdatedAt : null) ?? turn?.endedAt ?? a.lastTs;

  if (!live && (lastRegStatus === 'busy' || lastRegStatus === 'waiting') && !turn?.interrupted) {
    return { state: 'done', outcome: 'failed', label: t('Exited mid-turn'), detail: t('The session was closed or crashed while running'), since };
  }
  if (turn?.error) return { state: 'done', outcome: 'failed', label: t('API error'), detail: turn.error, since };
  if (turn?.interrupted) return { state: 'done', outcome: 'failed', label: t('Interrupted'), detail: t('You interrupted this turn'), since };
  // An explicit question on the turn's wrap-up card is a hard signal, no LLM needed.
  const wrapAsk = turn?.wrapUp?.ask;
  if (wrapAsk) {
    const options = turn.wrapUp.actions?.join(' / ');
    const detail = options ? t('{ask} ({options})', { ask: wrapAsk, options }) : wrapAsk;
    return { state: 'waiting', kind: 'question', label: t('Awaiting your reply'), detail, since };
  }

  const verdict = matchingEndSummary(summary, a, live);
  if (verdict?.outcome) {
    const detail = verdict.reason || '';
    switch (verdict.outcome) {
      case 'blocked':
        return { state: 'waiting', kind: 'question', label: t('Awaiting your reply'), detail, since };
      case 'working':
        return { state: 'doing', label: t('Background work running'), detail, since };
      case 'failed':
        return { state: 'done', outcome: 'failed', label: t('Not finished'), detail, since };
      default:
        return { state: 'done', outcome: 'success', label: t('Done'), detail, since };
    }
  }
  // No verdict yet (summary in flight, or the summarizer failed), or none coming (original titles,
  // or no summary model).
  const waiting = !verdict && verdicts;
  return {
    state: 'done',
    outcome: 'success',
    label: t('Done'),
    detail: waiting ? t('Checking the result…') : oneLine(plainText(a.lastReply?.text), 120),
    since,
    pending: waiting,
  };
}
