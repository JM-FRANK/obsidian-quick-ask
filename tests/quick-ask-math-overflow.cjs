// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mathNeedsHorizontalScroll } = require('../src/quick-ask/math-overflow');

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
