// Every runtime parameter, one row each. src/config/index.js loads them (default < <data dir>/config.json
// < environment), /api/config reads and edits them, and the Mac app's Advanced settings page is
// built from this table, so a new parameter needs only a row here (plus its Chinese label and help
// in src/lib/i18n.js).
//
// - The unit is part of the key (`…Ms`, `…Sec`, `…Minutes`, `…Hours`, `…MB`).
// - Each parameter can be set from the environment as BEEPLIGHT_<KEY IN UPPER SNAKE CASE>, e.g.
//   BEEPLIGHT_COLLECTOR_TICK_MS; `aliases` are older names that keep working.
// - `restart: true` is read once at startup; everything else applies within a second or so.
// - Not here on purpose: values other programs depend on (the 1 s meta event is the Mac app's
//   heartbeat; relay timings must match across devices) and parsing internals.

export const GROUPS = [
  { id: 'collector', label: 'Monitoring' },
  { id: 'summarizer', label: 'Titles and verdicts' },
  { id: 'limits', label: 'Usage limits' },
  { id: 'usage', label: 'Token usage' },
  { id: 'transcript', label: 'Transcripts' },
  { id: 'subagents', label: 'Subagents' },
  { id: 'seen', label: 'Read detection' },
  { id: 'lan', label: 'Phone access' },
  { id: 'relay', label: 'Devices' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'server', label: 'Service' },
];

export const PARAMS = [
  {
    key: 'collector.tickMs', type: 'int', default: 333, min: 100, max: 5000,
    label: 'Status check interval (ms)',
    help: 'How often every session is checked. Lower reacts faster and uses more CPU.',
  },
  {
    key: 'collector.psRefreshMs', type: 'int', default: 2000, min: 500, max: 60000,
    label: 'Process scan interval (ms)',
    help: "How often the process list is read to find each session's terminal and app.",
  },
  {
    key: 'collector.retainHours', type: 'number', default: 12, min: 1, max: 168, aliases: ['BEEPLIGHT_RETAIN_HOURS'],
    label: 'Keep finished tasks (hours)',
    help: 'Finished or quiet tasks leave the board after this long.',
  },

  {
    key: 'summarizer.model', type: 'string', default: 'haiku', pattern: /^[\w.:[\]-]{1,64}$/, aliases: ['BEEPLIGHT_MODEL'],
    label: 'Summary model',
    help: 'Model that writes task titles and judges results, passed to claude --model.',
  },
  {
    key: 'summarizer.concurrency', type: 'int', default: 2, min: 1, max: 8,
    label: 'Summaries at once',
    help: 'How many summary calls may run at the same time.',
  },
  {
    key: 'summarizer.timeoutSec', type: 'int', default: 45, min: 10, max: 600,
    label: 'Summary timeout (seconds)',
    help: 'A summary call that takes longer is stopped and retried later.',
  },
  {
    key: 'summarizer.hourlyCap', type: 'int', default: 120, min: 0, max: 2000,
    label: 'Titles per hour while running',
    help: 'Cap on summaries made while a turn is still running. Results at the end of a turn are never capped. 0 titles tasks only when a turn ends.',
  },
  {
    key: 'summarizer.newTurnDelaySec', type: 'number', default: 4, min: 0, max: 60,
    label: 'Wait before titling a new turn (seconds)',
    help: "Lets the first reply and tool calls arrive, so the title knows what the turn is about.",
  },
  {
    key: 'summarizer.endDelaySec', type: 'number', default: 1.2, min: 0, max: 30,
    label: 'Wait before judging a finished turn (seconds)',
    help: "Lets Claude's last lines reach the transcript before the result is judged.",
  },
  {
    key: 'summarizer.refreshMinutes', type: 'number', default: 5, min: 1, max: 120,
    label: 'Retitle long turns (minutes)',
    help: 'A turn still running after this long gets a fresh title this often.',
  },

  {
    key: 'limits.probeMinutes', type: 'number', default: 10, min: 0, max: 240, aliases: ['BEEPLIGHT_LIMITS_PROBE_MINUTES'],
    label: 'Check limits while active (minutes)',
    help: 'When no summary has brought fresh limit numbers, a tiny request fetches them this often. 0 turns these checks off.',
  },
  {
    key: 'limits.idleProbeMinutes', type: 'number', default: 60, min: 1, max: 1440,
    label: 'Check limits while idle (minutes)',
    help: 'The same check when no session has been active for 30 minutes.',
  },

  {
    key: 'usage.refreshSec', type: 'number', default: 5, min: 1, max: 300,
    label: 'Count token usage (seconds)',
    help: 'How often transcripts are scanned for new token usage.',
  },

  {
    key: 'transcript.initialTailMB', type: 'number', default: 4, min: 0.25, max: 256,
    label: 'Read of a long transcript (MB)',
    help: 'When a session is first seen, only this much of the end of its transcript is read.',
  },
  {
    key: 'transcript.maxReadMB', type: 'number', default: 8, min: 1, max: 256,
    label: 'Most read per check (MB)',
    help: 'Caps how much new transcript is read in one check, so a burst of output never stalls the service.',
  },

  {
    key: 'subagents.showFinishedMinutes', type: 'number', default: 10, min: 0, max: 1440,
    label: 'Show finished subagents (minutes)',
    help: "A finished subagent stays on its task's card this long.",
  },

  {
    key: 'seen.pollMs', type: 'int', default: 1500, min: 500, max: 60000,
    label: 'Front tab check (ms)',
    help: 'How often the front terminal tab is checked, to mark a task read once you have looked at it.',
  },

  {
    key: 'lan.syncSec', type: 'number', default: 10, min: 2, max: 600,
    label: 'Network address check (seconds)',
    help: 'How often new network connections (Wi-Fi, USB tethering) are picked up for phone access.',
  },

  {
    key: 'relay.deviceName', type: 'string', default: '', maxLength: 64, aliases: ['BEEPLIGHT_DEVICE_NAME'],
    label: 'Device name',
    help: "This Mac's name on your other devices. Empty uses the computer name.",
  },

  {
    key: 'claude.bin', type: 'string', default: '', maxLength: 1024, aliases: ['CLAUDE_BIN'],
    label: 'claude command',
    help: 'Full path to the claude executable. Empty finds it on PATH, in nvm and in the usual install folders.',
  },

  {
    key: 'server.port', type: 'int', default: 7333, min: 1024, max: 65535, restart: true, aliases: ['PORT'],
    label: 'Port',
    help: 'The service listens on 127.0.0.1 at this port. The Mac app always uses 7333.',
  },
];

/** BEEPLIGHT_COLLECTOR_TICK_MS for collector.tickMs. */
export function envName(key) {
  return 'BEEPLIGHT_' + key.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}
