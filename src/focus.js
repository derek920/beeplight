import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { CLAUDE_BIN } from './config.js';
// `tr`, not `t`: this file names its focus targets `t`.
import { t as tr } from './i18n.js';
import { appleScriptString, HOST_SESSION_RE, JOB_SHORT_RE, SESSION_ID_RE, shellQuote } from './util.js';

const HAS_ITERM = fs.existsSync('/Applications/iTerm.app');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout).trim(), err: err ? String(stderr).trim() || err.message : null });
    });
  });
}

const osa = (script) => run('osascript', ['-e', script]);

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

async function runInNewTab(command) {
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

async function focusTty(kind, tty) {
  const r = await osa(kind === 'iterm' ? itermFocusScript(tty) : terminalFocusScript(tty));
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
  const r = await run('osascript', ['-e', script], 3000);
  return r.ok ? r.out : '';
}

const claudeCmd = () => (CLAUDE_BIN.includes('/') ? shellQuote(CLAUDE_BIN) : 'claude');

/**
 * Brings the place where a session runs to the front, or reopens it when it has ended.
 * @param {object} t target from Collector.focusTarget()
 */
export async function focusTarget(t) {
  if (t.entrypoint === 'claude-desktop' && HOST_SESSION_RE.test(t.hostSessionId || '')) {
    const r = await run('open', [`claude://code/continue?session=${t.hostSessionId}`]);
    return r.ok ? { ok: true, how: tr('Claude desktop app') } : { ok: false, error: r.err };
  }

  if (t.live && t.host) {
    const { kind, tty, appPath } = t.host;
    if ((kind === 'iterm' || kind === 'terminal') && tty) {
      const r = await focusTty(kind, tty);
      if (r.ok) return r;
    }
    if (kind === 'ide' && appPath && t.cwd) {
      const r = await run('open', ['-a', appPath, t.cwd]);
      if (r.ok) return { ok: true, how: t.host.app };
    }
    if (appPath) {
      const r = await run('open', ['-a', appPath]);
      if (r.ok) return { ok: true, how: tr("{app} (couldn't select the exact tab)", { app: t.host.app }) };
    }
    if (kind === 'tmux') return { ok: false, error: tr("The session runs in tmux, which can't be located yet") };
  }

  if (t.jobShort && JOB_SHORT_RE.test(t.jobShort)) {
    return runInNewTab(`${claudeCmd()} attach ${t.jobShort}`);
  }

  if (!t.live && SESSION_ID_RE.test(t.id) && t.cwd) {
    return runInNewTab(`cd ${shellQuote(t.cwd)} && ${claudeCmd()} --resume ${t.id}`);
  }

  return { ok: false, error: tr("Couldn't find this session's window") };
}
