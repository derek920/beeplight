import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { claudeBin } from '../config/index.js';
// `tr`, not `t`: this file names its focus targets `t`.
import { t as tr } from '../lib/i18n.js';
import { appleScriptString, HOST_SESSION_RE, shellQuote } from '../lib/util.js';

// Brings a task's window to the front by running the steps its agent source planned
// (source.focus(), e.g. src/sources/claude-code/index.js). Sources only describe what to do; the
// commands, URLs and every check on their arguments live here.

const HAS_ITERM = fs.existsSync('/Applications/iTerm.app');

function exec(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout).trim(), err: err ? String(stderr).trim() || err.message : null });
    });
  });
}


function itermFocusScript(tty) {
  return `tell application id "com.googlecode.iterm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is ${appleScriptString(tty)} then
          select w
          select t
          select s
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "notfound"
end tell`;
}

function terminalFocusScript(tty) {
  return `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is ${appleScriptString(tty)} then
        set selected of t to true
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
  return "notfound"
end tell`;
}

async function runInNewTab(run, command) {
  const osa = (script) => run('osascript', ['-e', script]);
  if (HAS_ITERM) {
    const r = await osa(`tell application id "com.googlecode.iterm2"
  activate
  if (count of windows) = 0 then
    set w to (create window with default profile)
  else
    set w to current window
    tell w to create tab with default profile
  end if
  tell current session of w to write text ${appleScriptString(command)}
end tell`);
    return r.ok ? { ok: true, how: tr('new iTerm2 tab') } : { ok: false, error: r.err };
  }
  const r = await osa(`tell application "Terminal"
  activate
  do script ${appleScriptString(command)}
end tell`);
  return r.ok ? { ok: true, how: tr('new Terminal window') } : { ok: false, error: r.err };
}

async function focusTty(run, kind, tty) {
  const r = await run('osascript', ['-e', kind === 'iterm' ? itermFocusScript(tty) : terminalFocusScript(tty)]);
  if (r.ok && r.out === 'ok') return { ok: true, how: `${kind === 'iterm' ? 'iTerm2' : 'Terminal'} ${tty.replace('/dev/', '')}`, appleEvents: true };
  if (r.ok) return { ok: false, error: tr("Couldn't find {tty} in the terminal", { tty }) };
  return { ok: false, error: r.err };
}

// TTY of the selected tab when iTerm2 or Terminal is the frontmost app, else ''. `is running`
// keeps this from launching a terminal that is not open.
export async function frontTerminalTty() {
  const parts = [];
  if (HAS_ITERM) {
    parts.push(`if application id "com.googlecode.iterm2" is running then
  tell application id "com.googlecode.iterm2"
    if frontmost then return tty of current session of current window
  end tell
end if`);
  }
  parts.push(`if application id "com.apple.Terminal" is running then
  tell application id "com.apple.Terminal"
    if frontmost then return tty of selected tab of front window
  end tell
end if`);
  const script = ['try', ...parts, 'end try', 'return ""'].join('\n');
  const r = await exec('osascript', ['-e', script], 3000);
  return r.ok ? r.out : '';
}

// The URLs a plan may open: [id check, URL, what to report].
const URLS = {
  'claude-desktop': [HOST_SESSION_RE, (id) => `claude://code/continue?session=${id}`, () => tr('Claude desktop app')],
};

// The commands a plan may run in a new terminal tab.
const CLIS = {
  claude: () => {
    const bin = claudeBin();
    return bin.includes('/') ? shellQuote(bin) : 'claude';
  },
};

// Arguments go into a shell command line unquoted, so they must be plain words.
const SAFE_ARG = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Brings the place where a task runs to the front, or reopens it when it has ended.
 * @param {object} plan from Collector.focusPlan(): { id, live, host, cwd, steps }
 * @param {Function} [run] runs a command (tests replace it)
 */
export async function focusTarget(plan, run = exec) {
  for (const step of plan.steps || []) {
    const r = await runStep(run, step, plan);
    if (r) return r;
  }
  return { ok: false, error: tr("Couldn't find this session's window") };
}

// A result ends the plan; null moves on to the next step.
async function runStep(run, step, p) {
  if (step.do === 'url') {
    const u = URLS[step.kind];
    if (!u || !u[0].test(step.id || '')) return null;
    const r = await run('open', [u[1](step.id)]);
    return r.ok ? { ok: true, how: u[2]() } : { ok: false, error: r.err };
  }

  if (step.do === 'host') {
    if (!p.live || !p.host) return null;
    const { kind, tty, appPath } = p.host;
    if ((kind === 'iterm' || kind === 'terminal') && tty) {
      const r = await focusTty(run, kind, tty);
      if (r.ok) return r;
    }
    if (kind === 'ide' && appPath && p.cwd) {
      const r = await run('open', ['-a', appPath, p.cwd]);
      if (r.ok) return { ok: true, how: p.host.app };
    }
    if (appPath) {
      const r = await run('open', ['-a', appPath]);
      if (r.ok) return { ok: true, how: tr("{app} (couldn't select the exact tab)", { app: p.host.app }) };
    }
    if (kind === 'tmux') return { ok: false, error: tr("The session runs in tmux, which can't be located yet") };
    return null;
  }

  if (step.do === 'newTab') {
    const cli = CLIS[step.cli];
    const args = step.args || [];
    if (!cli || !args.every((a) => SAFE_ARG.test(a))) return null;
    const command = [cli(), ...args].join(' ');
    return runInNewTab(run, step.cwd ? `cd ${shellQuote(step.cwd)} && ${command}` : command);
  }

  return null;
}
