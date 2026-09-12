const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionNavigation, createSessionActionQueue, adoptUnassignedDraft, sessionMenuEntries } = require('../src/quick-ask/session-navigation');

test('each session row manages its own id without first activating it, including duplicate titles', () => {
  const calls = [];
  const rows = sessionMenuEntries([{ id: 'a', title: 'Same' }, { id: 'b', title: 'Same' }], 'a', {
    select: id => calls.push(['select', id]), rename: id => calls.push(['rename', id]), remove: id => calls.push(['delete', id]),
  });
  rows[1].rename(); rows[1].remove();
  assert.deepEqual(calls, [['rename', 'b'], ['delete', 'b']]);
  assert.equal(rows[0].current, true); assert.equal(rows[1].current, false);
  rows[1].open(); assert.deepEqual(calls.at(-1), ['select', 'b']);
});

test('creating a session adopts unassigned text/context while reopening preserves existing drafts', () => {
  const draft = { composer: 'Explain [[paper.md]]', pending: { files: [], selections: [{ path: 'paper.md', text: 'quote' }] } };
  const drafts = new Map([[null, draft]]);
  adoptUnassignedDraft(drafts, 'new', draft);
  assert.deepEqual(drafts.get('new'), draft);
  assert.equal(drafts.has(null), false);
  adoptUnassignedDraft(drafts, 'new', { composer: '', pending: { files: [], selections: [] } });
  assert.deepEqual(drafts.get('new'), draft);
});

test('no session is distinct from an existing empty session', () => {
  const none = sessionNavigation();
  assert.equal(none.kind, 'none');
  assert.equal(none.canCreate, true);
  assert.equal(none.canManage, false);
  assert.equal(none.canSelect, false);
  const empty = sessionNavigation({ sessions: [{ id: 'a', title: '' }], activeSessionId: 'a' });
  assert.equal(empty.kind, 'session');
  assert.equal(empty.canCreate, false);
  assert.equal(empty.canManage, true);
  assert.equal(empty.canSelect, true);
});

test('deleting the last indexed session leaves an explicit non-actionable placeholder', () => {
  const remaining = sessionNavigation({ sessions: [], activeSessionId: 'deleted-id' });
  assert.equal(remaining.active, null);
  assert.equal(remaining.canManage, false);
  assert.equal(remaining.canCreate, true);
});

test('a single existing session remains manageable regardless of its title or draft', () => {
  for (const title of ['', 'New session', 'Renamed']) {
    const state = sessionNavigation({ sessions: [{ id: 'a', title }], activeSessionId: 'a', hasDraft: true });
    assert.equal(state.canManage, true);
    assert.equal(state.canCreate, true);
  }
});

test('a busy navigation action temporarily prevents conflicting actions', () => {
  const state = sessionNavigation({ sessions: [{ id: 'a' }], activeSessionId: 'a', hasHistory: true, busy: true });
  assert.equal(state.canManage, false);
  assert.equal(state.canCreate, false);
  assert.equal(state.canSelect, false);
});

test('navigation actions execute serially and a failure releases the queue', async () => {
  const queue = createSessionActionQueue();
  const steps = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const first = queue.run(async () => { steps.push('first'); await held; throw new Error('storage failed'); });
  const second = queue.run(async () => { steps.push('second'); return 'done'; });
  assert.equal(queue.busy, true);
  await Promise.resolve();
  assert.deepEqual(steps, ['first']);
  release();
  await assert.rejects(first, /storage failed/);
  assert.equal(await second, 'done');
  assert.equal(queue.busy, false);
  assert.deepEqual(steps, ['first', 'second']);
});
