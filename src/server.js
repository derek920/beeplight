import http from 'node:http';
import { focusTarget } from './actions/focus.js';
import { SeenWatcher } from './actions/seen.js';
import { claudeBin, config, HOST, PORT, PUBLIC_DIR } from './config/index.js';
import { Collector } from './core/collector.js';
import { CpuMeter } from './core/cpu.js';
import { Store } from './core/store.js';
import { ClaudeRunner } from './services/claude-cli.js';
import { Limits } from './services/limits.js';
import { Summarizer } from './services/summarizer.js';
import { UsageIndex } from './sources/claude-code/usage.js';
import { apiRoutes } from './transports/api.js';
import { createHandler } from './transports/http.js';
import { Lan } from './transports/lan.js';
import { Relay } from './transports/relay.js';
import { EventStream } from './transports/stream.js';
import { pageVersion, webRoutes } from './transports/web.js';

// The entry point, and the one module that knows all the others: it builds them and wires them
// together. Each layer imports only from the layers it builds on (test/architecture.test.js):
//
//   lib         util, i18n
//   config      runtime parameters and paths
//   sources     what Claude Code writes (claude-code/: reverse-engineered, the first thing a
//               Claude Code update breaks) and the process list (system/)
//   services    claude -p calls: titles and verdicts, plan limits
//   core        sessions, their state and the board; the persisted store; CPU use
//   actions     on this Mac: bring a task's window to the front, notice a tab was looked at
//   transports  HTTP, the event stream, phone access, the relay to other devices
//
// actions and transports get the core objects they need from here, not by importing core.

const store = new Store();
const runner = new ClaudeRunner();
const limits = new Limits(store, runner);
const summarizer = new Summarizer(store, runner);
const usage = new UsageIndex();
const relay = new Relay(store);
const cpu = new CpuMeter();
const collector = new Collector({ store, summarizer, runner, usage, limits, relay, cpu });
const seen = new SeenWatcher({ collector, store });

const page = pageVersion(PUBLIC_DIR);
const meta = () => ({ ...collector.meta(), page });
const stream = new EventStream({ snapshot: () => collector.snapshot, meta });
collector.on('update', (snap) => stream.broadcast('state', snap));

// Phone access serves the same handler on each network address.
let handler;
const lan = new Lan({ store, handler: (req, res) => handler(req, res) });
handler = createHandler({
  port: PORT,
  lan,
  routes: [
    ...webRoutes({ dir: PUBLIC_DIR, lan }),
    ...apiRoutes({ collector, store, config, lan, relay, limits, stream, meta, focus: focusTarget }),
  ],
});

const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`Beeplight running at http://localhost:${PORT} (checks every ${config.get('collector.tickMs')}ms, summarizer: ${claudeBin()}, config: ${config.file})`);
  config.watch();
  store.start();
  collector.start();
  stream.start();
  seen.start();
  lan.start();
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is Beeplight already running?). Pick another with PORT=xxxx` : e);
  process.exit(1);
});

function shutdown() {
  collector.stop();
  runner.killAll();
  store.flush();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
