// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createToolExecutor } = require('../src/quick-ask/tool');
const { createToolLoop } = require('../src/quick-ask/tool-loop');
const { toolHistory, toolImagePath } = require('../src/quick-ask/tool-history');
const { normalizeQuickAskSettings, sessionConfigSnapshot, applyQuickAskPatch } = require('../src/quick-ask/settings');
const tick = () => new Promise(resolve => setImmediate(resolve));
function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
const call = (id, name = 'get-full-file', args = { path: `${id}.md` }) => ({ callId: id, name, arguments: args });

test('two session loops share one cap for file, image and search and retain result order', async () => {
  let active = 0, peak = 0;
  const pending = [], starts = [];
  const work = async kind => {
    active++; peak = Math.max(peak, active); starts.push(kind);
    const gate = barrier(); pending.push(gate); await gate.promise; active--;
  };
  const executor = createToolExecutor({ maxConcurrent: 3,
    vault: { readText: async path => { await work(path); return path; } },
    images: { readForSend: async ([path]) => { await work(path); return [{ path }]; } },
  });
  const a = createToolLoop({ executor }), b = createToolLoop({ executor });
  const args = { search: async () => { await work('search'); return { ok: true, sources: [] }; } };
  const first = a.runBatch([call('a'), call('pic', 'get-image', { path: 'pic.png' }), call('search', 'web_search', { query: 'q' })],
    a.beginQuestion({ allowlist: ['a.md'], imageAllowlist: ['pic.png'] }), args);
  const second = b.runBatch([call('b'), call('c')], b.beginQuestion({ allowlist: ['b.md', 'c.md'] }), args);
  await tick(); assert.equal(active, 3); assert.deepEqual(starts, ['a.md', 'pic.png', 'search']);
  pending[2].release(); await tick(); assert.equal(active, 3); assert.equal(starts.at(-1), 'b.md');
  pending[0].release(); await tick(); assert.equal(active, 3); assert.equal(starts.at(-1), 'c.md');
  for (const gate of pending) gate.release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(peak, 3);
  assert.deepEqual(one.results.map(result => result.path ?? 'search'), ['a.md', 'pic.png', 'search']);
  assert.deepEqual(two.results.map(result => result.path), ['b.md', 'c.md']);
});

for (const protocol of ['responses', 'chat-completions']) test(`${protocol}: failures and reverse completion do not reorder or cancel siblings`, async () => {
  const gate = barrier(), ended = [];
  const executor = createToolExecutor({ vault: { readText: async path => {
    if (path === 'slow.md') await gate.promise;
    return path;
  } } });
  const loop = createToolLoop({ executor, config: { protocol } });
  const task = loop.runBatch([call('slow'), call('search', 'web_search', { query: 'q' }), call('fast')],
    loop.beginQuestion({ allowlist: ['slow.md', 'fast.md'] }), {
      search: async () => { throw new Error('must not leak secret provider details'); },
      onCallEnd: async call => ended.push(call.callId),
    });
  await tick(); assert.ok(ended.includes('search') && ended.includes('fast')); assert.ok(!ended.includes('slow'));
  gate.release(); const result = await task;
  assert.deepEqual(result.results.map(value => value.ok), [true, false, true]);
  assert.equal(JSON.stringify(result).includes('secret provider'), false);
  const outputs = result.items.filter(item => item.type === 'function_call_output' || item.role === 'tool');
  assert.deepEqual(outputs.map(item => item.call_id ?? item.tool_call_id), ['slow', 'search', 'fast']);
});

test('cancelling a queued session releases it without source reads or blocking another session', async () => {
  const gate = barrier(), reads = [], started = [], controller = new AbortController();
  const executor = createToolExecutor({ maxConcurrent: 1, vault: { readText: async path => {
    reads.push(path); if (path === 'held.md') await gate.promise; return path;
  } } });
  const loop = createToolLoop({ executor });
  const held = loop.runBatch([call('held')], loop.beginQuestion({ allowlist: ['held.md'] }));
  const cancelled = loop.runBatch([call('cancel')], loop.beginQuestion({ allowlist: ['cancel.md'] }), {
    signal: controller.signal, onCallStart: async () => started.push('cancel'),
  });
  const next = loop.runBatch([call('next')], loop.beginQuestion({ allowlist: ['next.md'] }));
  await tick(); controller.abort();
  assert.equal((await cancelled).results[0].output, 'Cancelled');
  assert.deepEqual(started, []); assert.deepEqual(reads, ['held.md']);
  gate.release(); await Promise.all([held, next]); assert.deepEqual(reads, ['held.md', 'next.md']);
});

test('live cap changes apply to the shared queue without cancelling active work', async () => {
  let limit = 1; const gates = [], starts = [];
  const executor = createToolExecutor({ getMaxConcurrent: () => limit, vault: { readText: async path => {
    starts.push(path); const gate = barrier(); gates.push(gate); await gate.promise; return path;
  } } });
  const question = executor.createQuestionState({ allowlist: ['a.md', 'b.md', 'c.md', 'd.md'] });
  const tasks = ['a', 'b', 'c', 'd'].map(id => executor.executeCall(call(id), { question }));
  await tick(); assert.equal(starts.length, 1);
  limit = 3; executor.refreshConcurrency(); await tick(); assert.equal(starts.length, 3);
  limit = 1; gates[0].release(); await tick(); assert.equal(starts.length, 3);
  gates[1].release(); await tick(); assert.equal(starts.length, 3);
  gates[2].release(); await tick(); assert.equal(starts.length, 4);
  gates[3].release(); await Promise.all(tasks);
});

test('concurrent duplicates share one pending file read and keep every tool result', async () => {
  let reads = 0; const gate = barrier();
  const executor = createToolExecutor({ vault: { readText: async () => { reads++; await gate.promise; return 'exact contents'; } } });
  const loop = createToolLoop({ executor });
  const task = loop.runBatch([call('1', 'get-full-file', { path: 'a.md' }), call('2', 'get-full-file', { path: 'a.md' })], loop.beginQuestion({ allowlist: ['a.md'] }));
  await tick(); assert.equal(reads, 1); gate.release();
  const result = await task; assert.equal(result.results.length, 2); assert.ok(result.results.every(value => value.output === 'exact contents'));
});

test('global concurrency ignores old total limits and is not frozen in session snapshots', () => {
  assert.equal(normalizeQuickAskSettings({ callLimit: 1, fullFileCallLimit: 1 }).toolConcurrency, 3);
  const settings = normalizeQuickAskSettings({ toolConcurrency: 7, callLimit: 1 });
  assert.equal(settings.callLimit, undefined); assert.equal(settings.toolConcurrency, 7);
  const snapshot = sessionConfigSnapshot(settings);
  assert.equal(snapshot.toolConcurrency, undefined); assert.equal(snapshot.callLimit, undefined);
  applyQuickAskPatch(settings, { toolConcurrency: 10 }); assert.equal(settings.toolConcurrency, 10);
  applyQuickAskPatch(settings, { toolConcurrency: 0 }); assert.equal(settings.toolConcurrency, 3);
});

test('image detail uses a single exact Vault path and queued history becomes interrupted after restart', () => {
  assert.equal(toolImagePath({ arguments: { sourcePath: 'folder/paper.md', path: 'attachments/a.png' }, summary: { path: 'folder/attachments/a.png' } }), 'folder/attachments/a.png');
  assert.equal(toolImagePath({ arguments: { sourcePath: 'folder/paper.md', path: 'attachments/a.png' } }), null);
  assert.equal(toolImagePath({ arguments: { sourcePath: null, path: 'folder/a.png' } }), 'folder/a.png');
  const records = [{ kind: 'turn/started', payload: { turnId: 't' } }, { kind: 'turn/tool-started', payload: { turnId: 't', batchId: 'b', callId: 'a', name: 'get-image', status: 'queued' } }];
  assert.equal(toolHistory(records, { runningTurnIds: new Set(['t']) })[0].calls[0].status, 'queued');
  assert.equal(toolHistory(records)[0].calls[0].status, 'interrupted');
});
