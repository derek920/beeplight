import { frontTerminalTty } from './focus.js';

const POLL_MS = 1500;

// Clears a task's unread mark when the user looks at its terminal tab themselves: the tab must
// be frontmost on two polls in a row, so flicking past it does not count. Starts only after a
// jump has succeeded once, i.e. the user already allowed AppleScript control of the terminal;
// polling must never be what triggers that permission prompt.
export class SeenWatcher {
  constructor({ collector, store }) {
    this.collector = collector;
    this.store = store;
    this.candidate = null;
    this.busy = false;
  }

  start() {
    this.timer = setInterval(() => this.check(), POLL_MS);
    this.timer.unref();
  }

  async check() {
    if (this.busy || !this.store.flags.appleEventsOk) return;
    const targets = this.collector.unreadTerminalTargets();
    if (!targets.length) {
      this.candidate = null;
      return;
    }
    this.busy = true;
    try {
      const tty = await frontTerminalTty();
      const hit = tty && targets.find((t) => t.tty === tty);
      if (hit && this.candidate === hit.sid) {
        this.collector.markRead(hit.sid, `looked at ${hit.tty}`);
        this.candidate = null;
      } else {
        this.candidate = hit ? hit.sid : null;
      }
    } finally {
      this.busy = false;
    }
  }
}
