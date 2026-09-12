const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSummaryInstruction, frameSummary, truncateToolResult, chooseRetainedTail,
  selectCompactionRange, isStructurallyBalanced, shrinkGate, CompactionTransaction,
  replayCompactionSurface, requestOfficialCompaction, measureItems, measureText,
  TOOL_RESULT_CHARACTER_LIMIT, RETAIN_RATIO, SUMMARY_SECTIONS, SUMMARY_PREAMBLE, COMPACT_ENDPOINT,
} = require('../src/quick-ask/compaction');

function message(text, role = 'user') {
  return { type: 'message', role, content: [{ type: 'input_text', text }] };
}

function call(callId, path = 'a.md') {
  return { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'get-full-file', arguments: JSON.stringify({ path }) };
}

function callOutput(callId, output = 'alpha') {
  return { type: 'function_call_output', call_id: callId, output };
}

function makeStore() {
  const records = [];
  return {
    records,
    async append(_id, kind, payload) { records.push({ seq: records.length, kind, payload }); return records[records.length - 1]; },
  };
}

test('the fallback instruction names exactly the pinned sections without asking for a file list', () => {
  const instruction = buildSummaryInstruction();
  for (const section of SUMMARY_SECTIONS) assert.match(instruction, new RegExp(`## ${section.replace(/[&]/g, '\\&')}`));
  assert.match(instruction, /Do not list a file inventory/);
  assert.equal(instruction.includes('<referenced-files>'), false, 'the inventory is appended by Quick Ask, not the model');
  assert.equal(instruction.includes('An earlier compacted summary'), false, 'no consolidation is asked for without one');
});

test('an earlier checkpoint in the range is consolidated rather than nested', () => {
  const instruction = buildSummaryInstruction({ hasEarlierCheckpoint: true });
  assert.match(instruction, /An earlier compacted summary is included above/);
  assert.match(instruction, /do not nest or quote the earlier summary/);
});

test('a framed checkpoint carries the preamble and the deterministic inventory', () => {
  const framed = frameSummary('## Goal\nAnswer the question.', { allowlist: ['notes/a.md', 'papers/b.md'] });
  assert.match(framed, /^<compacted-summary>\n/);
  assert.match(framed, /\n<\/compacted-summary>$/);
  assert.match(framed, /## Goal/);
  assert.equal(framed.includes(SUMMARY_PREAMBLE), true, 'the fixed preamble frames the checkpoint');
  assert.match(framed, /<referenced-files>/);
  assert.match(framed, /- notes\/a\.md/);
  assert.match(framed, /- papers\/b\.md/);
  assert.equal((framed.match(/<referenced-files>/g) ?? []).length, 1, 'the inventory is deterministic');
});

test('a long tool result is truncated only for the summarization request', () => {
  const long = 'x'.repeat(TOOL_RESULT_CHARACTER_LIMIT + 500);
  const truncated = truncateToolResult(long);
  assert.equal(truncated.length < long.length, true);
  assert.match(truncated, /\[500 characters omitted\]/);
  assert.equal(truncateToolResult('short'), 'short', 'a short result is returned unchanged');
  assert.equal(truncated.slice(0, TOOL_RESULT_CHARACTER_LIMIT), long.slice(0, TOOL_RESULT_CHARACTER_LIMIT));
});

test('the retained tail targets 16 percent of the capacity from newest to oldest', () => {
  assert.equal(RETAIN_RATIO, 0.16);
  const items = [message('a'.repeat(4000)), message('b'.repeat(4000)), message('c'.repeat(400))];
  const tail = chooseRetainedTail({ items, capacityTokens: 4000 });
  assert.equal(tail.budget, Math.floor(4000 * 0.16));
  assert.equal(tail.items.length >= 1, true);
  assert.equal(tail.items.at(-1), items.at(-1), 'the newest item is always retained');
});

test('a function call is never split from its output in the retained tail', () => {
  const items = [message('old'), call('c1'), callOutput('c1'), message('newest')];
  const tail = chooseRetainedTail({ items, capacityTokens: 100000 });
  const types = tail.items.map((item) => item.type);
  if (types.includes('function_call_output')) {
    assert.equal(types.includes('function_call'), true, 'the pair travels together');
  }
});

test('the selected older prefix is structurally balanced only with paired calls', () => {
  assert.equal(isStructurallyBalanced([call('c1'), callOutput('c1')]), true);
  assert.equal(isStructurallyBalanced([call('c1')]), false, 'a call without its output is not balanced');
  assert.equal(isStructurallyBalanced([callOutput('c2')]), false, 'an orphaned output is not balanced');
  // The newest turn (here its single trailing message) is always retained, so
  // the compactable prefix is the pair before it.
  const range = selectCompactionRange({ items: [call('c1'), callOutput('c1'), message('tail')], retained: [] });
  assert.equal(range.items.length, 2);
  assert.equal(range.retainedFrom, 2);
  assert.equal(range.balanced, true);
});

test('the shrink gate rejects a checkpoint that is not smaller', () => {
  assert.equal(shrinkGate({ before: 1000, after: 400 }), true);
  assert.equal(shrinkGate({ before: 400, after: 400 }), false);
  assert.equal(shrinkGate({ before: 400, after: 900 }), false);
  assert.equal(shrinkGate({ before: Number.NaN, after: 1 }), false);
});

test('a successful bracket records start, checkpoint, and end in order', async () => {
  const sessionStore = makeStore();
  const transaction = new CompactionTransaction({ sessionStore, sessionId: 's1', now: () => '2026-09-12T00:00:00.000Z' });
  await transaction.start({
    range: { from: 0, to: 3 }, mode: 'fallback', shadowedIds: ['item-1', 'item-2'],
    estimatedBefore: 1000, provider: 'https://api.openai.com/v1', model: 'gpt-5',
  });
  const result = await transaction.commit({ checkpoint: { framed: '<compacted-summary>…</compacted-summary>' }, estimatedAfter: 300, usage: { total_tokens: 50 } });
  assert.equal(result.status, 'committed');
  assert.deepEqual(sessionStore.records.map((record) => record.kind), ['compaction/start', 'compaction/checkpoint', 'compaction/end']);
  assert.equal(sessionStore.records[2].payload.ok, true);
  const start = sessionStore.records[0].payload;
  assert.deepEqual(start.shadowedIds, ['item-1', 'item-2']);
  assert.equal(start.estimatedBefore, 1000);
  assert.equal(sessionStore.records[1].payload.estimatedAfter, 300);
});

test('a rejected replacement closes the bracket as a failure and keeps the old surface', async () => {
  const sessionStore = makeStore();
  const transaction = new CompactionTransaction({ sessionStore, sessionId: 's1' });
  await transaction.start({ range: { from: 0, to: 1 }, mode: 'fallback', estimatedBefore: 300 });
  const result = await transaction.commit({ checkpoint: {}, estimatedAfter: 900 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'no-shrink');
  const end = sessionStore.records.at(-1);
  assert.equal(end.kind, 'compaction/end');
  assert.equal(end.payload.ok, false);
  assert.equal(sessionStore.records.some((record) => record.kind === 'compaction/checkpoint'), false);
});

test('a provider failure closes the bracket with the normalized error', async () => {
  const sessionStore = makeStore();
  const transaction = new CompactionTransaction({ sessionStore, sessionId: 's1' });
  await transaction.start({ range: { from: 0, to: 1 }, mode: 'official', estimatedBefore: 500 });
  await transaction.fail({ code: 'SERVER', message: 'upstream failed' });
  const end = sessionStore.records.at(-1).payload;
  assert.equal(end.ok, false);
  assert.deepEqual(end.error, { code: 'SERVER', message: 'upstream failed' });
});

test('only a complete successful bracket activates a compacted surface', () => {
  const complete = [
    { seq: 0, kind: 'compaction/start', payload: {} },
    { seq: 1, kind: 'compaction/checkpoint', payload: { mode: 'official' } },
    { seq: 2, kind: 'compaction/end', payload: { ok: true } },
  ];
  const replay = replayCompactionSurface(complete);
  assert.equal(replay.active?.payload.mode, 'official');
  assert.equal(replay.interrupted, false);

  const failed = [
    { seq: 0, kind: 'compaction/start', payload: {} },
    { seq: 1, kind: 'compaction/checkpoint', payload: { mode: 'fallback' } },
    { seq: 2, kind: 'compaction/end', payload: { ok: false } },
  ];
  assert.equal(replayCompactionSurface(failed).active, null, 'a failed bracket never shadows the prior items');
});

test('an unmatched start is an interruption and never activates its body', () => {
  const records = [
    { seq: 0, kind: 'message' },
    { seq: 1, kind: 'compaction/start', payload: {} },
    { seq: 2, kind: 'compaction/checkpoint', payload: { mode: 'official', checkpoint: { output: ['opaque'] } } },
  ];
  const replay = replayCompactionSurface(records);
  assert.equal(replay.active, null);
  assert.equal(replay.interrupted, true);
  assert.equal(replay.interruptions.length, 1);
});

test('an explicit unsupported compact endpoint is a capability result, not an error', async () => {
  const calls = [];
  const network = { request: async (options) => { calls.push(options); return { status: 404, text: 'not found' }; } };
  const result = await requestOfficialCompaction({ network, baseUrl: 'https://api.example.com/v1', apiKey: 'sk', body: {} });
  assert.equal(result.supported, false);
  assert.equal(calls[0].url, `https://api.example.com/v1${COMPACT_ENDPOINT}`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk');
});

test('a transport or server failure stays an ordinary error rather than a capability result', async () => {
  const network = { request: async () => ({ status: 503, text: 'busy' }) };
  const result = await requestOfficialCompaction({ network, baseUrl: 'https://api.example.com/v1', apiKey: 'sk', body: {} });
  assert.equal(result.supported, null);
  assert.equal(result.status, 503);
});

test('the official result preserves opaque output items exactly', async () => {
  const output = [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-blob' }];
  const network = { request: async () => ({ status: 200, json: { output, usage: { total_tokens: 12 } } }) };
  const result = await requestOfficialCompaction({ network, baseUrl: 'https://api.example.com/v1', apiKey: 'sk', body: {} });
  assert.equal(result.supported, true);
  assert.deepEqual(result.output, output);
  assert.equal(result.usage.total_tokens, 12);
});

test('measurement helpers estimate items and text without provider usage', () => {
  assert.equal(measureText('x'.repeat(40)) > 0, true);
  assert.equal(measureItems([message('hello')]) > 0, true);
  assert.equal(measureItems([]), 0);
});

test('an empty or malformed successful compact response never becomes a replacement', async () => {
  for (const json of [{}, { output: [] }, { output: 'not-items' }]) {
    const result = await requestOfficialCompaction({ network: { request: async () => ({ status: 200, json }) },
      baseUrl: 'https://example.test/v1', apiKey: 'fixture', body: {} });
    assert.equal(result.supported, null);
    assert.equal(result.error.code, 'PROTOCOL');
  }
});
