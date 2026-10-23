// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createToolExecutor, MAX_CONCURRENT_CALLS, FILE_NOT_FOUND, FILE_READ_FAILED, CONTEXT_SPACE_EXHAUSTED,
} = require('../src/quick-ask/tool');

// A Vault double with the read-only capability the tool is allowed to use.
test('get-image rejects unauthorized and malformed paths before any read without a total-call budget', async () => {
  const reads = [];
  const executor = createToolExecutor({ images: { readForSend: async paths => { reads.push(paths); return [{ path: paths[0], url: 'data:image/png;base64,TEST' }]; } } });
  const question = executor.createQuestionState({ imageAllowlist: ['fig.png'], callLimit: 6 });
  for (const path of ['other.png', '../fig.png', '/fig.png', 'a/../fig.png', undefined]) {
    const result = await executor.executeCall({ name: 'get-image', arguments: { path } }, { question, normalizePath: () => 'fig.png' });
    assert.equal(result.ok, false);
    assert.equal(reads.length, 0);
  }
  const result = await executor.executeCall({ name: 'get-image', arguments: { path: 'fig.png' } }, { question });
  assert.equal(result.ok, true);
  assert.deepEqual(result.imagePaths, ['fig.png']);
  assert.equal(JSON.stringify(result).includes('data:image'), false);
  assert.equal(question.callLimit, undefined);
  assert.equal(question.reads.size, 0, 'image bytes are not cached in the question history');
  const limited = await executor.executeCall({ name: 'get-image', arguments: { path: 'fig.png' } }, { question });
  assert.equal(limited.ok, true);
  assert.equal(reads.length, 2);
});

test('get-image reuses validation failures, honors context and cancellation, and never updates file baselines', async () => {
  const { createToolLoop } = require('../src/quick-ask/tool-loop');
  let read;
  const executor = createToolExecutor({ images: { readForSend: paths => read(paths) } });
  const begin = () => executor.createQuestionState({ imageAllowlist: ['fig.png'] });
  const call = { name: 'get-image', arguments: { path: 'fig.png' } };
  read = () => { throw new Error('must not read'); };
  assert.match((await executor.executeCall(call, { question: begin(), fitsInContext: () => false })).output, /Context space/);
  const controller = new AbortController(); controller.abort();
  assert.match((await executor.executeCall(call, { question: begin(), signal: controller.signal })).output, /cancelled/);
  for (const code of ['IMAGE_SIZE', 'IMAGE_FORMAT', 'IMAGE_TOTAL', 'IMAGE_MISSING']) {
    read = () => { throw Object.assign(new Error('/private/path must not leak'), { code }); };
    const result = await executor.executeCall(call, { question: begin() });
    assert.equal(result.ok, false); assert.match(result.output, new RegExp(code));
    assert.equal(result.output.includes('/private'), false);
  }
  const duringRead = new AbortController();
  read = async () => { duringRead.abort(); return [{ path: 'fig.png', url: 'data:image/png;base64,TEST' }]; };
  const cancelled = await executor.executeCall(call, { question: begin(), signal: duringRead.signal });
  assert.equal(cancelled.images, undefined);
  read = async () => [{ path: 'fig.png', url: 'data:image/png;base64,TEST' }];
  const loop = createToolLoop({ executor, tracker: { applyFullFileResult() { assert.fail('image tool must not change Markdown baselines'); } }, config: { rendererVersion: 7 } });
  const result = await loop.runBatch([{ ...call, callId: 'img' }], loop.beginQuestion({ imageAllowlist: ['fig.png'] }));
  assert.equal(JSON.stringify(result.items).includes('data:image'), false);
  assert.match(result.items.at(-1).output, /^Image read:/, 'image results have no line-number prefixes');
});

function makeVault(files, { failPaths = [] } = {}) {
  const reads = [];
  return {
    reads,
    async readText(path) {
      reads.push(path);
      if (failPaths.includes(path)) throw new Error('simulated I/O failure');
      return Object.hasOwn(files, path) ? files[path] : null;
    },
  };
}

function makeExecutor(files, options = {}) {
  const vault = makeVault(files, options);
  const statuses = [];
  const executor = createToolExecutor({ vault, ...options, onStatus: (status) => statuses.push(status) });
  return { executor, vault, statuses };
}

test('an allowlisted path returns the current complete content', async () => {
  const { executor, vault } = makeExecutor({ 'notes/a.md': 'alpha\nbeta\n' });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md'], callLimit: 3 });
  const result = await executor.executeCall({ arguments: { path: 'notes/a.md' } }, { question });
  assert.equal(result.ok, true);
  assert.equal(result.output, 'alpha\nbeta\n');
  assert.equal(result.read, true);
  assert.deepEqual(vault.reads, ['notes/a.md']);
});

test('a non-allowlisted path and a missing allowlisted path return the same text', async () => {
  const { executor } = makeExecutor({ 'notes/a.md': 'alpha' });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md'], callLimit: 5 });
  const foreign = await executor.executeCall({ arguments: { path: 'notes/secret.md' } }, { question });
  const goneQuestion = executor.createQuestionState({ allowlist: ['notes/gone.md'], callLimit: 5 });
  const missing = await executor.executeCall({ arguments: { path: 'notes/gone.md' } }, { question: goneQuestion });
  assert.equal(foreign.output, FILE_NOT_FOUND, 'a non-allowlisted path does not disclose existence');
  assert.equal(missing.output, FILE_NOT_FOUND, 'an allowlisted missing path reports the same text');
  assert.equal(foreign.ok, false);
});

test('a read failure returns the normalized error without the underlying exception', async () => {
  const { executor } = makeExecutor({ 'notes/a.md': 'alpha' }, { failPaths: ['notes/a.md'] });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md'], callLimit: 3 });
  const result = await executor.executeCall({ arguments: { path: 'notes/a.md' } }, { question });
  assert.equal(result.output, FILE_READ_FAILED);
  assert.equal(result.output.includes('simulated'), false);
  assert.equal(result.output.includes('/'), false);
});

test('legacy per-question limits no longer reject additional calls', async () => {
  const { executor } = makeExecutor({ 'notes/a.md': 'alpha', 'notes/b.md': 'beta' });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md', 'notes/b.md'], callLimit: 1 });
  const first = await executor.executeCall({ arguments: { path: 'notes/a.md' } }, { question });
  const second = await executor.executeCall({ arguments: { path: 'notes/b.md' } }, { question });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.output, 'beta');
  assert.equal(question.callLimit, undefined);
});

test('the same normalized path is read once per question', async () => {
  const { executor, vault } = makeExecutor({ 'notes/a.md': 'alpha' });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md'], callLimit: 3 });
  const first = await executor.executeCall({ arguments: { path: 'notes/a.md' } }, { question });
  const second = await executor.executeCall({ arguments: { path: 'notes/a.md' } }, { question });
  assert.equal(first.output, 'alpha');
  assert.equal(second.output, 'alpha');
  assert.deepEqual(vault.reads, ['notes/a.md'], 'the file is read once');
  // A repeated path executes at most once per question, so it consumes one call.
  assert.equal(question.reads.size, 1);
});

test('the default scheduler executes at most three calls concurrently', async () => {
  const resolvers = [];
  let active = 0;
  let peak = 0;
  const vault = {
    async readText(path) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => resolvers.push(resolve));
      active -= 1;
      return `content of ${path}`;
    },
  };
  const executor = createToolExecutor({ vault });
  const allowlist = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
  const question = executor.createQuestionState({ allowlist, callLimit: 5 });
  const calls = allowlist.map((path) => executor.executeCall({ arguments: { path } }, { question }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(peak, MAX_CONCURRENT_CALLS);
  assert.equal(resolvers.length, MAX_CONCURRENT_CALLS, 'the rest wait in the queue');
  // Release one batch at a time; the queue must never exceed three at once.
  while (resolvers.length > 0) {
    resolvers.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const results = await Promise.all(calls);
  assert.equal(peak, MAX_CONCURRENT_CALLS, 'concurrency never exceeds three');
  assert.equal(results.every((result) => result.ok), true, 'every queued call eventually runs');
});

test('a result that cannot fit returns the context-space error without reading', async () => {
  const { executor } = makeExecutor({ 'notes/huge.md': 'x'.repeat(100) });
  const question = executor.createQuestionState({ allowlist: ['notes/huge.md'], callLimit: 3 });
  const result = await executor.executeCall(
    { arguments: { path: 'notes/huge.md' } },
    { question, fitsInContext: () => false },
  );
  assert.equal(result.output, CONTEXT_SPACE_EXHAUSTED);
  assert.equal(question.reads.size, 0, 'capacity failure does not read the file');
});

test('the host normalizePath decides the allowlist match, with no basename or fuzzy lookup', async () => {
  const { executor } = makeExecutor({ 'notes/a.md': 'alpha' });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md'], callLimit: 3 });
  const result = await executor.executeCall(
    { arguments: { path: './notes/../notes/a.md' } },
    { question, normalizePath: () => 'notes/a.md' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.path, 'notes/a.md');
});

test('tool status is reported for each call without becoming a chat message', async () => {
  const { executor, statuses } = makeExecutor({ 'notes/a.md': 'alpha' });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md'], callLimit: 3 });
  await executor.executeCall({ arguments: { path: 'notes/a.md' } }, { question });
  assert.deepEqual(statuses[0], { kind: 'reading', path: 'notes/a.md' });
  assert.deepEqual(statuses[1], { kind: 'read', path: 'notes/a.md' });
});

test('a malformed call is a normalized failure rather than a crash', async () => {
  const { executor } = makeExecutor({ 'notes/a.md': 'alpha' });
  const question = executor.createQuestionState({ allowlist: ['notes/a.md'], callLimit: 3 });
  const result = await executor.executeCall({ arguments: {} }, { question });
  assert.equal(result.ok, false);
  assert.equal(result.output, FILE_NOT_FOUND);
});
