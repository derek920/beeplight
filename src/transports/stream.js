// Server-sent events on /api/stream: `state` (the board) whenever it changes, and `meta` (usage,
// today's totals, tick rate, page version) every second. The Mac app takes 3 s without a meta event
// as a lost connection, so that 1 s interval is part of the protocol, not a setting.

const format = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class EventStream {
  /** `snapshot()` and `meta()` give the current board and meta for a client that connects. */
  constructor({ snapshot, meta }) {
    this.snapshot = snapshot;
    this.meta = meta;
    this.clients = new Set();
  }

  start() {
    this.timer = setInterval(() => this.broadcast('meta', this.meta()), 1000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Serialized once, however many clients are listening. */
  broadcast(event, data) {
    if (!this.clients.size) return;
    const text = format(event, data);
    for (const res of this.clients) res.write(text);
  }

  open(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    res.write(format('state', this.snapshot()));
    res.write(format('meta', this.meta()));
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }
}
