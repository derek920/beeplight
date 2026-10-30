import assert from 'node:assert/strict';
import test from 'node:test';
import { Collector } from '../src/collector.js';
import { emptyDay, Timeline } from '../src/timeline.js';

const T0 = new Date(2026, 9, 28, 10, 0, 0).getTime();
const min = (n) => T0 + n * 60_000;

function harness() {
  const unread = {};
  const ctx = {
    timeline: new Timeline(emptyDay(T0)),
    store: {
      unread,
      setHistory() {},
      markUnread(sid, at, outcome) {
        unread[sid] = { at, outcome };
      },
      markRead(sid) {
        const had = !!unread[sid];
        delete unread[sid];
        return had;
      },
    },
  };
  const s = { sid: 's1', history: [] };
  const see = (v, at) => Collector.prototype.trackState.call(ctx, s, v, at);
  return { unread, see };
}

test('doing → done marks the task unread; new work clears it', () => {
  const { unread, see } = harness();
  see({ state: 'doing', since: min(0) }, min(0));
  assert.equal(unread.s1, undefined);
  see({ state: 'done', outcome: 'success', since: min(5) }, min(5));
  assert.deepEqual(unread.s1, { at: min(5), outcome: 'success' });
  see({ state: 'doing', since: min(9) }, min(9));
  assert.equal(unread.s1, undefined);
});

test('a session first seen already done is not news', () => {
  const { unread, see } = harness();
  see({ state: 'done', outcome: 'success', since: min(0) }, min(0));
  assert.equal(unread.s1, undefined);
});

test('nothing is unread until the verdict is in, and a question is not a finish', () => {
  const { unread, see } = harness();
  see({ state: 'doing', since: min(0) }, min(0));
  see({ state: 'done', outcome: 'success', pending: true, since: min(3) }, min(3));
  assert.equal(unread.s1, undefined, 'pending verdict');
  see({ state: 'waiting', kind: 'question', since: min(3) }, min(3.1));
  assert.equal(unread.s1, undefined, 'turn ended on a question → Waiting, not unread Done');

  const b = harness();
  b.see({ state: 'doing', since: min(0) }, min(0));
  b.see({ state: 'done', outcome: 'success', pending: true, since: min(3) }, min(3));
  b.see({ state: 'done', outcome: 'failed', since: min(3) }, min(3.1));
  assert.deepEqual(b.unread.s1, { at: min(3), outcome: 'failed' });
});

test('repeated views of a finished task keep it unread', () => {
  const { unread, see } = harness();
  see({ state: 'doing', since: min(0) }, min(0));
  see({ state: 'done', outcome: 'success', since: min(2) }, min(2));
  delete unread.s1; // the user opened it
  see({ state: 'done', outcome: 'success', since: min(2) }, min(3));
  assert.equal(unread.s1, undefined, 'not re-marked without a new finish');
});
