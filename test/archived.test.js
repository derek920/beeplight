import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Collector } from '../src/core/collector.js';
import { ArchivedSessions } from '../src/sources/claude-code/archived.js';

function desktopDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeplight-archived-'));
  const org = path.join(dir, 'acct', 'org');
  fs.mkdirSync(org, { recursive: true });
  const file = path.join(org, 'archived-sessions.idx');
  let n = 0;
  const write = (ids) => {
    fs.writeFileSync(file, JSON.stringify({ v: 1, archived: ids }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + ++n * 1000)); // distinct mtimes
  };
  return { dir, file, write };
}

test('reads archived ids; un-archiving and deleting the index bring sessions back', () => {
  const d = desktopDir();
  const a = new ArchivedSessions(d.dir);
  assert.equal(a.poll().size, 0); // no index yet
  d.write(['local_a', 'local_b']);
  assert.deepEqual([...a.poll()].sort(), ['local_a', 'local_b']);
  d.write(['local_b']);
  assert.deepEqual([...a.poll()], ['local_b']);
  fs.rmSync(d.file);
  assert.equal(a.poll().size, 0);
});

test('a missing desktop app folder or a broken index archives nothing', () => {
  assert.equal(new ArchivedSessions('/nonexistent/beeplight').poll().size, 0);
  const d = desktopDir();
  fs.writeFileSync(d.file, '{oops');
  assert.equal(new ArchivedSessions(d.dir).poll().size, 0);
});

test('the board hides archived desktop sessions only', () => {
  const view = (id, hostSessionId) => ({ id, hostSessionId, state: 'doing', updatedAt: 1000, since: 1000 });
  const views = [view('a', 'local_a'), view('b', 'local_b'), view('c', null)];
  const ctx = {
    sessions: new Map(views.map((v) => [v.id, { sid: v.id, history: [], v }])),
    jobs: new Map(),
    archived: new Set(['local_a']),
    store: { unread: {}, isDismissed: () => false },
    boardIds: null,
    retainMs: () => 1e12,
    buildView: (s) => ({ ...s.v }),
    trackState() {},
    emit() {},
  };
  Collector.prototype.publish.call(ctx, 2000);
  assert.deepEqual([...ctx.boardIds].sort(), ['b', 'c']);
  assert.deepEqual(ctx.snapshot.sessions.map((v) => v.id).sort(), ['b', 'c']);
});
