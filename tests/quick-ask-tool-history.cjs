// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toolHistory, toolSummary, updateToolGroups } = require('../src/quick-ask/tool-history');
const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');
const { createToolLoop } = require('../src/quick-ask/tool-loop');
const { createToolExecutor } = require('../src/quick-ask/tool');
const record = (kind, payload = {}) => ({ kind, payload });
const begin = id => record('turn/started', { turnId: id });
const started = (id, name = 'get-image') => record('turn/tool-started', { turnId: 't', batchId: 'local-0', callId: id, name, arguments: { path: 'fig.png', sourcePath: null }, status: 'running' });
const ended = (id, summary = { image: true, path: 'fig.png' }) => record('turn/tool-finished', { ...started(id).payload, status: 'complete', summary });
const call = (id, name = 'get-image') => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify({ path: 'fig.png', sourcePath: null }) });
const output = (id, text = 'Image read: fig.png.') => ({ type: 'function_call_output', call_id: id, output: text });

test('presentation metadata and canonical results reconcile to one ordered call per batch', () => {
  assert.deepEqual(conversationFromRecords(null), []);
  const records = [begin('t'), started('a'), ended('a'), started('b'), ended('b'),
    record('item/output', { item: call('a'), tool: true }), record('item/output', { item: output('a'), tool: true }),
    record('item/output', { item: call('b'), tool: true }), record('item/output', { item: output('b'), tool: true }),
    record('turn/finished', { state: 'complete' })];
  const original = JSON.stringify(records), groups = toolHistory(records);
  assert.equal(groups.length, 1); assert.deepEqual(groups[0].calls.map(call => call.callId), ['a', 'b']);
  assert.ok(groups[0].calls.every(call => call.status === 'complete'));
  assert.equal(JSON.stringify(records), original);
});

for (const protocol of ['responses', 'chat-completions']) test(`${protocol}: legacy call/result history renders without file reads or log rewrites`, () => {
  const nativeCall = protocol === 'responses' ? call('a', 'get-full-file') : { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'get-full-file', arguments: '{"path":"a.md"}' } }] };
  const nativeOutput = protocol === 'responses' ? output('a', 'alpha') : { role: 'tool', tool_call_id: 'a', content: 'alpha' };
  const records = [begin('t'), record('item/input', { item: { role: 'user', content: 'Question' } }),
    record('item/output', { item: nativeCall, tool: true }), record('item/output', { item: nativeOutput, tool: true }),
    record('item/output', { item: { role: 'assistant', content: 'Answer' } }), record('turn/finished', { state: 'complete' })];
  const messages = conversationFromRecords(records);
  assert.deepEqual(messages.map(message => message.kind ?? message.role), ['user', 'tools', 'assistant']);
  assert.equal(messages[1].calls[0].summary.characters, 5);
  assert.equal(JSON.stringify(messages[1]).includes('alpha'), false);
});

test('pending calls become interrupted on restart, cancelled on stop, and retain completed siblings', () => {
  const partial = [begin('t'), started('a'), ended('a'), started('b')];
  assert.deepEqual(toolHistory(partial)[0].calls.map(call => call.status), ['complete', 'interrupted']);
  assert.deepEqual(toolHistory(partial, { runningTurnIds: new Set(['t']) })[0].calls.map(call => call.status), ['complete', 'running']);
  assert.deepEqual(toolHistory([...partial, record('turn/finished', { state: 'stopped' })])[0].calls.map(call => call.status), ['complete', 'cancelled']);
});

test('call IDs stay scoped to their own turn and a failed call never changes a completed earlier turn', () => {
  const groups = toolHistory([begin('t'), started('a'), ended('a'), record('turn/finished', { state: 'complete' }),
    begin('next'), { ...started('a'), payload: { ...started('a').payload, turnId: 'next' } }, record('turn/finished', { state: 'failed' })]);
  assert.equal(groups.length, 2); assert.equal(groups[0].calls[0].status, 'complete');
  assert.equal(groups[1].calls[0].status, 'interrupted');
});

test('new and legacy local search records reconcile sources without another search row', () => {
  const start = started('a', 'web_search'); start.payload.arguments = { query: 'fact' };
  const end = record('turn/tool-finished', { ...start.payload, status: 'complete', summary: { sources: [{ url: 'https://example.org', title: 'Evidence' }] } });
  const records = [begin('t'), start, record('search/result', { query: 'fact', status: 'complete', sources: [{ url: 'https://example.org' }] }), end,
    record('item/output', { item: { ...call('a', 'web_search'), arguments: '{"query":"fact"}' }, tool: true }),
    record('item/output', { item: output('a', '{"ok":true,"sources":[]}'), tool: true })];
  const groups = toolHistory(records); assert.equal(groups.length, 1); assert.equal(groups[0].calls.length, 1);
  assert.equal(groups[0].calls[0].summary.sources[0].title, 'Evidence');
});

test('server search is an observed operation with only returned query/source facts', () => {
  const start = started('server-search', 'web_search'); Object.assign(start.payload, { batchId: 'server', server: true, arguments: {} });
  const end = record('turn/tool-finished', { ...start.payload, status: 'complete', summary: { sources: [] } });
  const groups = toolHistory([begin('t'), start, end,
    record('item/output', { item: { id: 'server-1', type: 'web_search_call', status: 'completed', action: { query: 'returned query' } } }),
    record('turn/finished', { state: 'complete', searchStatuses: [{ status: 'complete' }], sources: [{ url: 'https://example.org' }] })]);
  assert.equal(groups.length, 1); assert.equal(groups[0].calls.length, 1);
  assert.equal(groups[0].calls[0].arguments.query, 'returned query');
  assert.equal(groups[0].calls[0].summary.sources.length, 1);
  const legacy = toolHistory([begin('t'), record('turn/finished', { state: 'complete', searchStatuses: [{ status: 'complete' }], sources: [] })]);
  assert.deepEqual(legacy[0].calls[0].arguments, {});
});

test('legacy search/result preceding native calls is matched by query without duplicate entries', () => {
  const sources = [{ url: 'https://example.org', title: 'Evidence' }];
  const groups = toolHistory([begin('t'), record('search/result', { query: 'fact', provider: 'duckduckgo', status: 'complete', sources }),
    record('item/output', { item: { ...call('a', 'web_search'), arguments: '{"query":"fact"}' }, tool: true }),
    record('item/output', { item: output('a', JSON.stringify({ ok: true, sources })), tool: true }),
    record('turn/finished', { state: 'complete', searchStatuses: [{ status: 'complete' }] })]);
  assert.equal(groups.length, 1); assert.equal(groups[0].calls.length, 1);
  assert.equal(groups[0].calls[0].callId, 'a');
});

test('summaries contain bounded facts and error text, never full document/image payloads or credentials', () => {
  const content = 'secret document text';
  assert.deepEqual(toolSummary('get-full-file', { ok: true, path: 'a.md', output: content }), { path: 'a.md', characters: content.length });
  assert.equal(JSON.stringify(toolSummary('get-image', { ok: true, path: 'a.png', bytes: 'base64', output: 'ok' })).includes('base64'), false);
  const result = updateToolGroups([], { turnId: 't', batchId: '0', callId: 'a', name: 'get-image', arguments: { path: 'a.png', apiKey: 'secret' }, status: 'running' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(toolSummary('get-image', { ok: false, output: 'x'.repeat(5000) }).error.length, 2000);
  assert.deepEqual(toolSummary('web_search', { ok: false, result: { ok: false, code: 'NETWORK', sources: [] },
    output: '{"untrusted":true,"ok":false,"code":"NETWORK","sources":[]}' }), { error: 'NETWORK' });
});

test('legacy success text containing cancelled and malformed optional metadata do not break the display', () => {
  const legacy = toolHistory([begin('t'), record('item/output', { item: call('a') }),
    record('item/output', { item: output('a', 'Image read: cancelled.png.') })]);
  assert.equal(legacy[0].calls[0].status, 'complete');
  const malformed = ended('a', { sources: {}, characters: -1, path: {}, error: {}, image: 'yes' });
  assert.deepEqual(toolHistory([begin('t'), started('a'), malformed])[0].calls[0].summary, {});
});

test('per-call callbacks bracket execution in order without changing canonical tool outputs or budget', async () => {
  const facts = [];
  const executor = createToolExecutor({ vault: { readText: async path => { facts.push(`read:${path}`); return 'alpha'; } } });
  const loop = createToolLoop({ executor });
  const question = loop.beginQuestion({ allowlist: ['a.md'] });
  const calls = ['a', 'b'].map(callId => ({ callId, name: 'get-full-file', arguments: { path: 'a.md' } }));
  const result = await loop.runBatch(calls, question, {
    onCallStart: async call => facts.push(`start:${call.callId}`),
    onCallEnd: async (call, _index, result) => facts.push(`end:${call.callId}:${result.ok}`),
  });
  assert.ok(facts.indexOf('start:a') < facts.indexOf('end:a:true'));
  assert.ok(facts.indexOf('start:b') < facts.indexOf('end:b:true'));
  assert.equal(facts.filter(value => value === 'read:a.md').length, 1);
  assert.equal(question.state.reads.size, 1);
  assert.deepEqual(result.items.filter(item => item.type === 'function_call_output').map(item => item.output), ['alpha', 'alpha']);
});

test('stopping an in-flight tool records cancellation without reading the next image or exposing image bytes', async () => {
  const controller = new AbortController(), facts = [];
  let reads = 0;
  const executor = createToolExecutor({ images: { readForSend: async ([path]) => {
    reads++; controller.abort(); return [{ path, url: 'data:image/png;base64,SECRET' }];
  } } });
  const loop = createToolLoop({ executor });
  const question = loop.beginQuestion({ imageAllowlist: ['a.png', 'b.png'] });
  const result = await loop.runBatch(['a', 'b'].map(id => ({ callId: id, name: 'get-image', arguments: { path: `${id}.png` } })), question, {
    signal: controller.signal,
    onCallStart: async call => facts.push(`${call.callId}:running`),
    onCallEnd: async (call, _index, result) => facts.push(`${call.callId}:${result.ok ? 'complete' : controller.signal.aborted ? 'cancelled' : 'failed'}`),
  });
  assert.ok(facts.includes('a:cancelled') && facts.includes('b:cancelled'));
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});
