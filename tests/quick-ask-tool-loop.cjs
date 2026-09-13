// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createToolLoop, functionCallsFrom, TOOL_NAMES } = require('../src/quick-ask/tool-loop');
const { responsesToolContinuationItems, parseToolArguments } = require('../src/quick-ask/transport');
const { createToolExecutor, MAX_CONCURRENT_CALLS } = require('../src/quick-ask/tool');

function makeLoop({ files = { 'notes/a.md': 'alpha' }, allowlist = ['notes/a.md'], callLimit = 3, tracker = null } = {}) {
  const reads = [];
  const executor = createToolExecutor({
    vault: { async readText(path) { reads.push(path); return Object.hasOwn(files, path) ? files[path] : null; } },
  });
  const loop = createToolLoop({ executor, tracker, config: { callLimit } });
  return { loop, reads, executor };
}

function callFor(path, callId = 'call_1') {
  return { type: 'function_call', id: 'fc_1', call_id: callId, name: 'get-full-file', arguments: JSON.stringify({ path }) };
}

test('only get-full-file calls are collected from a completed attempt', () => {
  const output = [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    callFor('notes/a.md'),
    { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'some-other-tool', arguments: '{}' },
  ];
  const calls = functionCallsFrom(output);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callId, 'call_1');
  assert.deepEqual(calls[0].arguments, { path: 'notes/a.md' });
});

test('the accepted tool-name policy has one immutable exported source', () => {
  assert.equal(Object.isFrozen(TOOL_NAMES), true);
  assert.deepEqual(TOOL_NAMES, ['get-full-file', 'web_search']);
});

test('a malformed argument payload becomes an empty object instead of throwing', () => {
  assert.deepEqual(parseToolArguments('{not json'), {});
  assert.deepEqual(parseToolArguments(undefined), {});
  assert.deepEqual(parseToolArguments('{"path":"a.md"}'), { path: 'a.md' });
  assert.deepEqual(parseToolArguments({ path: 'a.md' }), { path: 'a.md' });
});

test('continuation items pair each function call with its output', () => {
  const calls = [{ id: 'fc_1', callId: 'call_1', name: 'get-full-file', arguments: '{"path":"notes/a.md"}' }];
  const items = responsesToolContinuationItems({ calls, outputs: ['alpha'] });
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'function_call');
  assert.equal(items[0].call_id, 'call_1');
  assert.equal(items[0].arguments, '{"path":"notes/a.md"}');
  assert.equal(items[1].type, 'function_call_output');
  assert.equal(items[1].call_id, 'call_1');
  assert.equal(items[1].output, 'alpha');
});

test('a batch executes its calls and returns the canonical continuation items', async () => {
  const { loop } = makeLoop();
  const question = loop.beginQuestion({ allowlist: ['notes/a.md'], callLimit: 3 });
  const { items, results } = await loop.runBatch(functionCallsFrom([callFor('notes/a.md')]), question);
  assert.equal(results[0].output, 'alpha');
  assert.deepEqual(items.map((item) => item.type), ['function_call', 'function_call_output']);
  assert.equal(items[0].arguments, '{"path":"notes/a.md"}', 'the domain call record is serialized into the wire call');
  assert.equal(question.statuses[0].kind, 'read');
});

test('a batch preserves raw function-call argument JSON byte-for-byte', async () => {
  const { loop } = makeLoop();
  const question = loop.beginQuestion({ allowlist: ['notes/a.md'], callLimit: 3 });
  const rawArguments = '{ "path" : "notes/a.md" }';
  const calls = [{
    id: 'fc_1', callId: 'call_1', name: 'get-full-file',
    arguments: { path: 'notes/a.md' }, rawArguments,
  }];
  const { items } = await loop.runBatch(calls, question);
  assert.equal(items[0].arguments, rawArguments);
});

test('a failed read reports the normalized error in the output item', async () => {
  const { loop } = makeLoop({ allowlist: ['notes/gone.md'] });
  const question = loop.beginQuestion({ allowlist: ['notes/gone.md'], callLimit: 3 });
  const { items } = await loop.runBatch(functionCallsFrom([callFor('notes/gone.md')]), question);
  assert.equal(items[1].output, '文件不存在');
  assert.equal(question.statuses[0].kind, 'error');
});

test('the question budget is the configured per-question limit', async () => {
  const { loop } = makeLoop({ files: { 'a.md': 'A', 'b.md': 'B' }, allowlist: ['a.md', 'b.md'], callLimit: 1 });
  const question = loop.beginQuestion({ allowlist: ['a.md', 'b.md'] });
  assert.equal(loop.remaining(question), 1);
  await loop.runBatch(functionCallsFrom([callFor('a.md')]), question);
  assert.equal(loop.remaining(question), 0);
  const { results } = await loop.runBatch(functionCallsFrom([callFor('b.md')]), question);
  assert.equal(results[0].ok, false, 'the budget is spent');
});

test('a successful read refreshes the tracker baseline without reviving a removed file', async () => {
  const applied = [];
  const tracker = { applyFullFileResult: (path, text) => applied.push({ path, text }) };
  const { loop } = makeLoop({ tracker });
  const question = loop.beginQuestion({ allowlist: ['notes/a.md'], callLimit: 3 });
  await loop.runBatch(functionCallsFrom([callFor('notes/a.md')]), question);
  assert.deepEqual(applied, [{ path: 'notes/a.md', text: 'alpha' }]);
});

test('a result that cannot fit reports the context-space error and consumes its call', async () => {
  const { loop } = makeLoop();
  const question = loop.beginQuestion({ allowlist: ['notes/a.md'], callLimit: 3 });
  const { items } = await loop.runBatch(functionCallsFrom([callFor('notes/a.md')]), question, { fitsInContext: () => false });
  assert.equal(items[1].output, '上下文空间不足，无法读取完整文件');
  assert.equal(loop.remaining(question), 2, 'the rejected attempt consumed exactly one call');
});

test('several calls in one batch are all answered', async () => {
  const { loop } = makeLoop({ files: { 'a.md': 'A', 'b.md': 'B' }, allowlist: ['a.md', 'b.md'], callLimit: 3 });
  const question = loop.beginQuestion({ allowlist: ['a.md', 'b.md'], callLimit: 3 });
  const calls = functionCallsFrom([callFor('a.md', 'call_a'), callFor('b.md', 'call_b')]);
  const { items, results } = await loop.runBatch(calls, question);
  assert.equal(results.length, 2);
  assert.equal(items.length, 4, 'each call is paired with its own output');
  assert.deepEqual(items.filter((item) => item.type === 'function_call_output').map((item) => item.output), ['A', 'B']);
});

test('the executor caps concurrency at three even for a wider batch', async () => {
  const { loop, executor } = makeLoop({ files: {}, allowlist: [], callLimit: 10 });
  assert.equal(executor.MAX_CONCURRENT_CALLS ?? MAX_CONCURRENT_CALLS, 3);
  const question = loop.beginQuestion({ allowlist: [], callLimit: 10 });
  assert.equal(loop.remaining(question), 10, 'the configured total may exceed the concurrency cap');
});
