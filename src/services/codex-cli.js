import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { codexBin, LLM_CWD } from '../config/index.js';
import { isExecutable, truncate } from '../lib/util.js';

// Runs one `codex exec` for the summarizer when Claude isn't available: the user's own Codex
// login and model, no saved session (--ephemeral), none of the user's config or rules, a
// read-only sandbox, an empty working folder, and the answer shaped by a JSON schema.
// Codex prints JSONL events with --json; the answer is the last agent_message.

export class CodexRunner {
  constructor() {
    this.children = new Set();
    this.ownPids = new Set();
    fs.mkdirSync(LLM_CWD, { recursive: true });
  }

  /** Whether there is a codex to run. */
  available() {
    return isExecutable(codexBin());
  }

  isOwnPid(pid) {
    return this.ownPids.has(pid);
  }

  /** @returns {Promise<object>} the answer, parsed from JSON */
  run({ instructions, input, schema, model, timeoutMs }) {
    const schemaFile = path.join(LLM_CWD, 'codex-schema.json');
    fs.writeFileSync(schemaFile, schema);
    const args = [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--output-schema', schemaFile, '--json', '--color', 'never',
      ...(model ? ['-m', model] : []),
      '-',
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(codexBin(), args, { cwd: LLM_CWD, env: { ...process.env, BEEPLIGHT_INTERNAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      this.children.add(child);
      if (child.pid) this.ownPids.add(child.pid);
      let buf = '';
      let stderr = '';
      let answer = null;
      let failure = null;
      let timedOut = false;
      const started = Date.now();
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }, timeoutMs);

      const onLine = (line) => {
        let d;
        try {
          d = JSON.parse(line);
        } catch {
          return;
        }
        if (d.type === 'item.completed' && d.item?.type === 'agent_message') answer = d.item.text;
        else if (d.type === 'turn.failed' || d.type === 'error') failure = d.error?.message || d.message || 'failed';
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
        setTimeout(() => this.ownPids.delete(child.pid), 10_000).unref();
        const secs = Math.round((Date.now() - started) / 1000);
        if (timedOut) return reject(new Error(`codex timed out after ${secs}s ${truncate(stderr, 300)}`));
        if (failure) return reject(new Error(`codex: ${truncate(failure, 300)}`));
        if (!answer) return reject(new Error(`codex exit ${code ?? signal} after ${secs}s: no answer ${truncate(stderr, 300)}`));
        try {
          resolve(JSON.parse(answer));
        } catch {
          reject(new Error(`codex answer is not JSON: ${truncate(answer, 200)}`));
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(`${instructions}\n\n---\n\n${input}`);
    });
  }

  killAll() {
    for (const c of this.children) c.kill('SIGKILL');
  }
}
