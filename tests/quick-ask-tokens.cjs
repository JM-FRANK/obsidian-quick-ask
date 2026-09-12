const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTokens, formatPercent,
  CHARACTERS_PER_TOKEN, estimateText, estimateItem, estimateItems, priceProspectiveRequest,
  capacityBudget, contextOccupancy, occupancyColor, shouldCompact,
  createTurnUsage, createSessionUsage, OCCUPANCY_COMPACTION_RATIO,
} = require('../src/quick-ask/tokens');

test('the local estimator uses four characters per token plus structural overhead', () => {
  assert.equal(CHARACTERS_PER_TOKEN, 4);
  assert.equal(estimateText('x'.repeat(400)), 100);
  assert.equal(estimateText(''), 0);
  assert.equal(estimateText(undefined), 0);
});

test('an item estimate adds a role and block overhead on top of its text', () => {
  const bare = estimateItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] });
  assert.equal(bare > 0, true, 'structural overhead is counted even with no text');
  const longer = estimateItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(400) }] });
  assert.equal(longer - bare, 100);
  assert.equal(estimateItems([{ type: 'message', content: [{ text: 'x'.repeat(40) }] }]) > 0, true);
  assert.equal(estimateItems([]), 0);
});

test('a Context mutation is priced from its own text or diff payload', () => {
  const file = estimateItem({ kind: 'file', path: 'a.md', text: 'x'.repeat(400) });
  const diff = estimateItem({ kind: 'diff', path: 'a.md', diff: 'y'.repeat(200) });
  assert.equal(file > diff, true, 'a longer payload costs more');
});

test('the whole prospective request is priced with the answer reserve included', () => {
  const price = priceProspectiveRequest({
    instructions: 'x'.repeat(400),
    tools: [{ type: 'function', name: 'get-full-file', parameters: {} }],
    items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'y'.repeat(400) }] }],
    additions: [{ kind: 'file', path: 'a.md', text: 'z'.repeat(400) }],
    question: 'q'.repeat(40),
    reserveTokens: 16384,
  });
  assert.equal(price.estimated, true);
  assert.equal(price.components.reserve, 16384);
  assert.equal(price.components.instructions >= 100, true);
  assert.equal(price.total, Object.values(price.components).reduce((sum, value) => sum + value, 0));
});

test('the effective input budget subtracts the fixed reserve and the 90 percent threshold uses capacity', () => {
  const budget = capacityBudget(262144, { reserveTokens: 16384 });
  assert.equal(budget.configured, true);
  assert.equal(budget.inputBudget, 245760);
  assert.equal(budget.compactionThreshold, Math.floor(262144 * OCCUPANCY_COMPACTION_RATIO));
  assert.equal(budget.compactionThreshold, 235929);
});

test('a cleared capacity has no budget, no threshold, and no percentage', () => {
  const budget = capacityBudget(null, { reserveTokens: 16384 });
  assert.equal(budget.configured, false);
  assert.equal(budget.inputBudget, null);
  assert.equal(budget.compactionThreshold, null);
  assert.equal(occupancyColor(1000, null), 'none');
  assert.equal(shouldCompact({ occupancyTokens: 999999, capacityTokens: null }), false);
});

test('occupancy is exact only after a provider anchor and otherwise estimated', () => {
  const estimated = contextOccupancy({ prospectiveTokens: 5000 });
  assert.equal(estimated.exact, false);
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.tokens, 5000);

  const anchored = contextOccupancy({ anchor: { inputTokens: 10000 }, deltaTokens: -2000 });
  assert.equal(anchored.exact, true);
  assert.equal(anchored.tokens, 8000);
  assert.equal(contextOccupancy({ anchor: { inputTokens: 100 }, deltaTokens: -500 }).tokens, 0, 'occupancy never goes negative');
});

test('the occupancy ring colors normally below 80, warns to 99, and errors at 100', () => {
  const capacity = 1000;
  assert.equal(occupancyColor(799, capacity), 'normal');
  assert.equal(occupancyColor(800, capacity), 'warning');
  assert.equal(occupancyColor(999, capacity), 'warning');
  assert.equal(occupancyColor(1000, capacity), 'error');
  assert.equal(occupancyColor(1200, capacity), 'error');
});

test('compaction triggers at the 90 percent threshold only at a request boundary', () => {
  const capacity = 1000;
  assert.equal(shouldCompact({ occupancyTokens: 899, capacityTokens: capacity }), false);
  assert.equal(shouldCompact({ occupancyTokens: 900, capacityTokens: capacity }), true);
  assert.equal(shouldCompact({ occupancyTokens: 950, capacityTokens: capacity, boundary: false }), false,
    'never while a request or tool continuation is streaming');
});

test('turn usage folds every attempt and a terminal sample replaces its streaming sample', () => {
  const usage = createTurnUsage();
  usage.record({ source: 'stream', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } }, { attemptId: 'a1' });
  usage.record({ source: 'terminal', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }, { attemptId: 'a1' });
  usage.record({ source: 'terminal', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }, { attemptId: 'a2' });
  const totals = usage.totals();
  assert.equal(totals.attempts, 2);
  assert.equal(totals.input, 32);
  assert.equal(totals.output, 8);
  assert.equal(totals.total, 40);
});

test('reasoning tokens are an output subset and are never added to output twice', () => {
  const usage = createTurnUsage();
  usage.record({ source: 'terminal', usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110, reasoning_tokens: 60 } }, { attemptId: 'a1' });
  const totals = usage.totals();
  assert.equal(totals.output, 100);
  assert.equal(totals.reasoning, 60);
  assert.equal(totals.total, 110);
});

test('optional usage fields appear only when every included attempt reported them', () => {
  const usage = createTurnUsage();
  usage.record({ source: 'terminal', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, reasoning_tokens: 1 } }, { attemptId: 'a1' });
  usage.record({ source: 'terminal', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }, { attemptId: 'a2' });
  const inconsistent = usage.totals();
  assert.equal(inconsistent.reasoning, undefined, 'an inconsistent field is omitted rather than zeroed');
  assert.equal(Object.hasOwn(inconsistent, 'reasoning'), false);

  const cached = createTurnUsage();
  cached.record({ source: 'terminal', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 4 } } }, { attemptId: 'a1' });
  cached.record({ source: 'terminal', usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 6 } } }, { attemptId: 'a2' });
  assert.equal(cached.totals().cachedInput, 10);
});

test('a tool continuation attempt counts toward the same turn', () => {
  const usage = createTurnUsage();
  usage.record({ source: 'terminal', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }, { attemptId: 'initial' });
  usage.record({ source: 'terminal', usage: { input_tokens: 30, output_tokens: 4, total_tokens: 34 } }, { attemptId: 'tool-1' });
  assert.equal(usage.totals().total, 46);
  assert.equal(usage.attempts(), 2);
});

test('session usage folds settled turns over the durable log', () => {
  const session = createSessionUsage();
  session.addTurn({ total: 100 });
  session.addTurn({ total: 250 });
  assert.equal(session.total(), 350);
  assert.equal(session.turns(), 2);
});

test('a turn with no usage reports no totals instead of zeros', () => {
  const usage = createTurnUsage();
  assert.deepEqual(usage.totals(), { attempts: 0 });
});

test('token text is compact and marked as approximate by the caller', () => {
  assert.equal(formatTokens(15800), '15.8K tok');
  assert.equal(formatTokens(940), '940 tok');
  assert.equal(formatTokens(2500000), '2.5M tok');
  assert.equal(formatTokens(0), '0 tok');
  assert.equal(formatTokens(undefined), '0 tok');
  assert.equal(formatPercent(0.8), '80%');
  assert.equal(formatPercent(null), null);
});
