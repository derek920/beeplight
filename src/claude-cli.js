import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { CLAUDE_BIN, LLM_CWD } from './config.js';
import { truncate } from './util.js';

// Env that would make a child believe it runs inside the parent's Claude Code session
// (it would then skip registering itself and saving its transcript).
const PARENT_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

// Flags shared by every headless call: no tools, no user/project settings, no MCP, no transcript.
export const BASE_ARGS = [
  '-p',
  '--no-session-persistence',
  '--tools', '',
  '--setting-sources', '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--output-format', 'stream-json',
  '--verbose',
];

/** Runs `claude -p` and parses its stream-json output. */
export class ClaudeRunner {
  constructor() {
    this.children = new Set();
    this.ownPids = new Set(); // our children also register in ~/.claude/sessions
    this.onRateLimit = null; // (rate_limit_info) => void
    this.onResult = null; // (result line) => void, for the monitor's own usage
    fs.mkdirSync(LLM_CWD, { recursive: true });
  }

  isOwnPid(pid) {
    return this.ownPids.has(pid);
  }

  /** @returns {Promise<object>} the `result` line */
  run(args, input, timeoutMs) {
    const env = { ...process.env, BEEPLIGHT_INTERNAL: '1' };
    for (const k of PARENT_SESSION_ENV) delete env[k];

    return new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, [...BASE_ARGS, ...args], { cwd: LLM_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child);
      if (child.pid) this.ownPids.add(child.pid);
      let buf = '';
      let stderr = '';
      let result = null;
      let timedOut = false;
      const started = Date.now();
      // SIGTERM first so the CLI can release its locks; SIGKILL if it ignores that.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }, timeoutMs);

      const onLine = (line) => {
        if (!line.trim()) return;
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          return;
        }
        if (d.type === 'rate_limit_event' && d.rate_limit_info) this.onRateLimit?.(d.rate_limit_info);
        else if (d.type === 'result') result = d;
      };
      child.stdout.on('data', (b) => {
        buf += b;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      child.stderr.on('data', (b) => (stderr += b));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        onLine(buf);
        this.children.delete(child);
        // The child's registry file can outlive it by a moment.
        setTimeout(() => this.ownPids.delete(child.pid), 10_000).unref();
        const secs = Math.round((Date.now() - started) / 1000);
        if (result) this.onResult?.(result);
        if (timedOut) return reject(new Error(`timed out after ${secs}s ${truncate(stderr, 300)}`));
        if (!result) return reject(new Error(`exit ${code ?? signal} after ${secs}s: no result ${truncate(stderr, 300)}`));
        if (result.is_error) return reject(new Error(`${result.subtype || 'error'}: ${truncate(String(result.result ?? ''), 300)}`));
        resolve(result);
      });
      // A CLI that exits before reading its input (not logged in, wrong binary) makes this write
      // fail with EPIPE; 'close' reports the failure, so don't let it crash the service.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }

  killAll() {
    for (const c of this.children) c.kill('SIGKILL');
  }
}
