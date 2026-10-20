// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mathNeedsHorizontalScroll } = require('../src/quick-ask/math-overflow');
const { createLayoutBatch } = require('../src/quick-ask/layout-batch');

function scheduler() {
  const frames = new Map(); let next = 0;
  return {
    frame(callback) { const id = ++next; frames.set(id, callback); return id; },
    cancelFrame(id) { frames.delete(id); },
    get pending() { return frames.size; },
    tick() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); },
  };
}

test('many formula invalidations share one frame and every read precedes any write', () => {
  const clock = scheduler(), batch = createLayoutBatch(clock), trace = [];
  const tasks = Array.from({ length: 407 }, (_, index) => ({
    read() { trace.push(`read ${index}`); return index; },
    write(value) { trace.push(`write ${value}`); },
  }));
  for (let pass = 0; pass < 3; pass++) for (const task of tasks) batch.add(task);
  assert.equal(clock.pending, 1);
  assert.equal(trace.length, 0, 'registration and refresh do not synchronously measure');
  clock.tick();
  assert.deepEqual(trace, [...tasks.map((_, index) => `read ${index}`), ...tasks.map((_, index) => `write ${index}`)]);
  assert.equal(clock.pending, 0);
});

test('removing one answer keeps other work; removing the last task cancels its frame', () => {
  const clock = scheduler(), batch = createLayoutBatch(clock), trace = [];
  const first = { read: () => 1, write: value => trace.push(value) };
  const second = { read: () => 2, write: value => trace.push(value) };
  batch.add(first); batch.add(second); batch.remove(first);
  clock.tick();
  assert.deepEqual(trace, [2]);
  batch.add(first); batch.remove(first);
  assert.equal(clock.pending, 0);
  batch.add(second); batch.dispose(); clock.tick();
  assert.deepEqual(trace, [2], 'closing the owner leaves no queued layout writes');
});

test('an invalidation during a write is measured in the following frame', () => {
  const clock = scheduler(), batch = createLayoutBatch(clock), trace = [];
  const second = { read() { trace.push('read second'); return 2; }, write() { trace.push('write second'); } };
  const first = { read() { trace.push('read first'); return 1; }, write() { trace.push('write first'); batch.add(second); } };
  batch.add(first); clock.tick();
  assert.deepEqual(trace, ['read first', 'write first']);
  assert.equal(clock.pending, 1);
  clock.tick();
  assert.deepEqual(trace, ['read first', 'write first', 'read second', 'write second']);
});

test('a fixed-size equation gains and loses scrolling as its available pane width changes', () => {
  const contentWidth = 520;
  assert.deepEqual([640, 400, 300, 520, 640].map(width => mathNeedsHorizontalScroll(width, contentWidth)),
    [false, true, true, false, false]);
});

test('hidden/unmeasured formulas and rounding-only overflow do not reserve a scrollbar', () => {
  for (const [available, content] of [[0, 520], [400, 0], [400, 400.7], [400, 401], [NaN, 500], [400, Infinity]]) {
    assert.equal(mathNeedsHorizontalScroll(available, content), false);
  }
  assert.equal(mathNeedsHorizontalScroll(400, 402), true);
});
