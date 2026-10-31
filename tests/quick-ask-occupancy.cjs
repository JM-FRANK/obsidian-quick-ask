// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inputUsage, occupancyAnchor, calibratedOccupancy } = require('../src/quick-ask/occupancy');
const { estimateItem, createTurnUsage } = require('../src/quick-ask/tokens');

test('provider totals include cache once and reject missing/invalid counts', () => {
  for (const usage of [
    { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } },
    { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 } },
    { promptTokenCount: 1000, cachedContentTokenCount: 800 },
    { input_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 800 },
  ]) assert.equal(inputUsage(usage), 1000);
  for (const usage of [null, {}, { prompt_tokens: -1 }, { input_tokens: NaN }]) assert.equal(inputUsage(usage), null);
  assert.equal(inputUsage({ prompt_tokens: 0 }), 0);
});

test('a provider count wins over a larger heuristic and only signed changes are estimated', () => {
  const anchor = occupancyAnchor({ prompt_tokens: 1000 }, { localTokens: 5000 });
  assert.equal(calibratedOccupancy(anchor, 5000).tokens, 1000);
  assert.equal(calibratedOccupancy(anchor, 5000).exact, true);
  assert.equal(calibratedOccupancy(anchor, 5100).tokens, 1100);
  assert.equal(calibratedOccupancy(anchor, 5100).estimated, true);
  assert.equal(calibratedOccupancy(anchor, 4900).tokens, 900);
  assert.equal(calibratedOccupancy(anchor, 0).tokens, 0);
});

test('vision input totals need no separate image subtotal to calibrate retained images', () => {
  const anchor = occupancyAnchor({ input_tokens: 3000 }, { localTokens: 1000, imageKeys: ['fig.png'] });
  const result = calibratedOccupancy(anchor, 1050, ['fig.png']);
  assert.equal(result.tokens, 3050);
  assert.equal(result.estimated, true);
  assert.equal(calibratedOccupancy(anchor, 1050, ['other.png']).source, undefined);
  assert.equal(calibratedOccupancy(anchor, 1050).source, undefined);
});

test('one-shot image requests fall back to text after replay without subtracting subtotals', () => {
  const request = { localTokens: 1000, transientImages: 1 };
  const anchor = occupancyAnchor({ prompt_tokens: 3000, prompt_tokens_details: { image_tokens: 2000 } }, request);
  assert.equal(Object.hasOwn(anchor, 'imageTokens'), false);
  assert.deepEqual(calibratedOccupancy(anchor, 1100), { tokens: 1100, exact: false, estimated: true });
  assert.equal(calibratedOccupancy({ ...anchor, imageTokens: 2000 }, 1100).source, undefined,
    'old image subtotals are ignored without rewriting the anchor');
  assert.equal(calibratedOccupancy(anchor, 1100, [], 1).source, undefined,
    'another attachment cannot inherit the previous request total');
});

test('image detail fields never alter the provider total or become persisted counters', () => {
  const request = { localTokens: 1000, imageKeys: ['fig.png'] };
  const expected = { tokens: 3050, exact: false, estimated: true, source: 'provider' };
  for (const usage of [
    { input_tokens: 3000, input_tokens_details: { image_tokens: 2000, cached_tokens: 500 } },
    { prompt_tokens: 3000, prompt_tokens_details: { image_tokens: 4000 } },
    { promptTokenCount: 3000, promptTokensDetails: [{ modality: 'IMAGE', tokenCount: 2000 }] },
  ]) {
    const anchor = occupancyAnchor(usage, request);
    assert.equal(Object.hasOwn(anchor, 'imageTokens'), false);
    assert.deepEqual(calibratedOccupancy(anchor, 1050, ['fig.png']), expected);
  }
});

test('legacy anchors fall back to local estimates without image-specific counters', () => {
  const result = calibratedOccupancy({ inputTokens: 99999 }, 100, ['fig.png']);
  assert.equal(result.tokens, 100);
  assert.deepEqual(result, { tokens: 100, exact: false, estimated: true });
  assert.equal(result.exact, false);
});

test('CC text estimation ignores image URLs and base64 regardless of payload length', () => {
  const message = url => ({ role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url } }] });
  assert.equal(estimateItem(message('data:image/png;base64,a')), estimateItem(message('data:image/png;base64,' + 'a'.repeat(100000))));
  const tool = text => ({ type: 'function_call_output', output: [{ type: 'input_text', text }, { type: 'input_image', image_url: 'data:image/png;base64,abc' }] });
  assert.ok(estimateItem(tool('Description '.repeat(100))) > estimateItem(tool('')));
});

test('billing uses the same normalized input total without treating cache reads as extra', () => {
  const usage = createTurnUsage();
  usage.record({ source: 'terminal', usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 20, total_tokens: 1020 } });
  assert.equal(usage.totals().input, 1000);
  assert.equal(usage.totals().total, 1020);
});
