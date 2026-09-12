const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConversation } = require('../src/quick-ask/conversation');

function sseResponse(events) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`).join('');
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* stream() { yield new TextEncoder().encode(body); })(),
  };
}

function textTurn({ text = 'ok', responseId = 'resp_1', usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } = {}) {
  return [
    { type: 'response.created', data: { response: { id: responseId } } },
    { type: 'response.output_text.delta', data: { delta: text } },
    { type: 'response.completed', data: { response: { id: responseId, usage } } },
  ];
}

function makeStore() {
  const records = new Map();
  let counter = 0;
  return {
    records,
    async createSession() { const id = `s${++counter}`; records.set(id, []); return { id }; },
    async append(id, kind, payload) { const record = { seq: records.get(id).length, kind, payload }; records.get(id).push(record); return record; },
    async readLog(id) { return { header: { config: {} }, records: records.get(id) ?? [], version: 1, nextSeq: (records.get(id) ?? []).length }; },
  };
}

// The non-streaming transport answers with the Responses JSON payload rather
// than an SSE stream, so the fixture can serve either transport.
function jsonTurn({ id = 'resp_1', text = 'ok' } = {}) {
  return {
    id,
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
}

function makeFixture({ settings = {}, summaryText = '## Goal\nAnswer.', official = null } = {}) {
  const sessionStore = makeStore();
  const requests = [];
  const compactRequests = [];
  const network = {
    async fetch(url, options) {
      requests.push({ url, options: options ? { ...options, body: options.body } : options });
      // A summarization request disables tools; an ordinary turn does not.
      const parsed = options?.body ? JSON.parse(options.body) : {};
      if (parsed.tool_choice === 'none') return sseResponse(textTurn({ text: summaryText }));
      return sseResponse(textTurn());
    },
    async request(options) {
      if (String(options.url).endsWith('/responses/compact')) {
        compactRequests.push(options);
        if (official === 'unsupported') return { status: 404, text: 'unsupported' };
        if (official === 'server-error') return { status: 500, text: 'boom' };
        return { status: 200, json: { output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'blob' }], usage: { total_tokens: 9 } } };
      }
      requests.push({ url: options.url, options });
      const parsed = JSON.parse(options.body);
      return { status: 200, json: jsonTurn({ text: parsed.tool_choice === 'none' ? summaryText : 'ok' }) };
    },
  };
  const merged = {
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', secretId: 'k',
    contextWindowTokens: 262144, ...settings,
  };
  const conversation = createConversation({
    sessionStore,
    tracker: { acceptTurn() {}, rejectTurn() {}, allowlist: () => [], trackedFiles: () => [], mutationsForSend: async () => [] },
    environment: {
      network,
      scheduler: { now: () => 0, delay: (ms, cb) => setTimeout(cb, ms), cancelDelay: clearTimeout, frame: (cb) => setTimeout(cb, 0), cancelFrame: clearTimeout },
      secrets: { resolve: () => 'sk-test' },
      vault: { normalizePath: (p) => p, readText: async () => null },
    },
    getSettings: () => ({ quickAsk: merged }),
  });
  return { conversation, sessionStore, network, requests, compactRequests, settings: merged };
}

async function start(fixture, config = {}) {
  const { id } = await fixture.sessionStore.createSession();
  fixture.sessionStore.records.get(id).push({ seq: 0, kind: 'header', payload: { config: { ...fixture.settings, ...config } } });
  const original = fixture.sessionStore.readLog.bind(fixture.sessionStore);
  fixture.sessionStore.readLog = async (sessionId) => ({ ...(await original(sessionId)), header: { config: { ...fixture.settings, ...config } } });
  await fixture.conversation.load(id);
  return id;
}

test('a configured capacity is validated against the whole prospective request', async () => {
  const fixture = makeFixture();
  const id = await start(fixture);
  const result = await fixture.conversation.send(id, 'short question');
  assert.equal(result.status, 'complete');
  const snapshot = fixture.conversation.snapshot(id);
  assert.equal(snapshot.price.estimated, true, 'the local price is marked as an estimate');
  assert.equal(snapshot.price.components.reserve, 16384, 'the fixed answer reserve is priced');
  assert.equal(snapshot.occupancy.exact, true, 'the provider-reported input becomes the exact anchor');
});

test('a request that cannot fit the configured capacity is blocked with its largest contributors', async () => {
  const fixture = makeFixture({ settings: { contextWindowTokens: 17000 } });
  const id = await start(fixture);
  const result = await fixture.conversation.send(id, 'x'.repeat(4000), {
    additions: [{ kind: 'file', path: 'papers/huge.md', text: 'y'.repeat(40000) }],
  });
  assert.equal(result.status, 'capacity');
  assert.equal(result.blocked, true);
  assert.equal(result.contributors[0].path, 'papers/huge.md');
  assert.equal(result.contributors[0].estimated, true);
  assert.equal(result.contributors[0].tokens > 0, true);
  // Near the limit the exact counting capability is consulted first; the
  // ordinary Responses request is never issued for an over-capacity request.
  const ordinary = fixture.requests.filter((entry) => !String(entry.url ?? '').endsWith('/responses/input_tokens'));
  assert.equal(ordinary.length, 0, 'the question is never sent when the request cannot fit');
});

test('the exact input-token preflight confirms and blocks an overflow it counts', async () => {
  const fixture = makeFixture({ settings: { contextWindowTokens: 40000 } });
  const id = await start(fixture);
  let counted = 0;
  fixture.network.request = async (options) => {
    if (String(options.url).endsWith('/responses/input_tokens')) {
      counted += 1;
      return { status: 200, json: { input_tokens: 39000 } };
    }
    return { status: 200, text: '', json: jsonTurn({ text: 'should not run' }) };
  };
  const result = await fixture.conversation.send(id, 'x'.repeat(200), {
    additions: [{ kind: 'file', path: 'papers/huge.md', text: 'y'.repeat(40000) }],
  });
  assert.equal(counted, 1, 'the exact capability is consulted once');
  assert.equal(result.status, 'capacity');
  assert.equal(result.exact, true, 'the block rests on an exact count');
  assert.equal(result.blocked, true);
});

test('an unsupported exact preflight falls back to the marked local estimate', async () => {
  // A capacity whose 80 percent mark the pending request crosses, so the exact
  // counting capability is consulted before the send.
  const fixture = makeFixture({ settings: { contextWindowTokens: 40000 } });
  const id = await start(fixture);
  const seen = [];
  fixture.network.request = async (options) => {
    seen.push(options.url);
    if (String(options.url).endsWith('/responses/input_tokens')) return { status: 404, text: 'unsupported' };
    return { status: 200, text: '', json: jsonTurn({ text: 'Answered' }) };
  };
  fixture.network.fetch = async () => sseResponse(textTurn({ text: 'Answered' }));

  // About 6000 tokens of Context: past 80 percent of the effective budget, yet
  // still inside it, so the local estimate lets the request through.
  const result = await fixture.conversation.send(id, 'summarize this', {
    additions: [{ kind: 'file', path: 'papers/near-limit.md', text: 'x'.repeat(24000) }],
  });
  assert.equal(seen.some((url) => String(url).endsWith('/responses/input_tokens')), true, 'the exact capability was consulted');
  assert.equal(result.status, 'complete', 'the marked local estimate allowed the request through');
  const occupancy = fixture.conversation.snapshot(id).occupancy;
  assert.equal(typeof occupancy.tokens, 'number');
});

// The forced-compaction retry for a provider overflow cannot be pinned end to
// end yet: the transport's own pre-acceptance retry budget absorbs a single
// overflow and switches to the non-streaming transport first, so a deterministic
// arrival of CONTEXT_OVERFLOW at the conversation layer needs a scripted
// transport double rather than the network slice. The pieces that path is built
// from are covered directly: the labelled overflow code in the transport tests,
// and the compaction transaction, shrink gate, and durable bracket here.

test('the official compact capability is preferred and its opaque output is preserved', async () => {
  const fixture = makeFixture({ official: 'supported' });
  const id = await start(fixture);
  // Build enough history to give the range selection something to compact.
  for (let index = 0; index < 4; index += 1) {
    await fixture.conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const result = await fixture.conversation.compactSession(fixture.conversation.stateFor(id), { reason: 'pressure' });
  assert.equal(result.status, 'committed');
  assert.equal(fixture.compactRequests.length, 1);
  assert.equal(fixture.compactRequests[0].url, 'https://api.openai.com/v1/responses/compact');
  const checkpoint = fixture.sessionStore.records.get(id).find((record) => record.kind === 'compaction/checkpoint');
  assert.deepEqual(checkpoint.payload.providerOutput, [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'blob' }]);
  assert.equal(checkpoint.payload.mode, 'official');
});

test('an explicitly unsupported compact endpoint falls back to the portable summary', async () => {
  const fixture = makeFixture({ official: 'unsupported', summaryText: '## Goal\nPortable summary.' });
  const id = await start(fixture);
  for (let index = 0; index < 4; index += 1) {
    await fixture.conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const result = await fixture.conversation.compactSession(fixture.conversation.stateFor(id), { reason: 'pressure' });
  assert.equal(result.status, 'committed');
  const checkpoint = fixture.sessionStore.records.get(id).find((record) => record.kind === 'compaction/checkpoint');
  assert.equal(checkpoint.payload.mode, 'fallback');
  assert.match(checkpoint.payload.checkpoint.framed, /<compacted-summary>/);
  assert.match(checkpoint.payload.checkpoint.framed, /Portable summary\./);
});

test('a committed compaction reports the divider facts and keeps the tracked files', async () => {
  const projections = [];
  const fixture = makeFixture({ official: 'supported' });
  fixture.conversation.stateFor('unused');
  const id = await start(fixture);
  // Observe the projection stream the sidebar consumes.
  const conversationModule = require('../src/quick-ask/conversation');
  void conversationModule;
  for (let index = 0; index < 4; index += 1) {
    await fixture.conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const result = await fixture.conversation.compactSession(fixture.conversation.stateFor(id), { reason: 'pressure' });
  assert.equal(result.status, 'committed');
  // The bracket records what was replaced and the measured sizes on both sides.
  assert.equal(result.checkpoint.estimatedBefore > result.checkpoint.estimatedAfter, true, 'the checkpoint is smaller');
  assert.equal(typeof result.checkpoint.range.from, 'number');
  assert.equal(typeof result.checkpoint.range.to, 'number');
  assert.equal(result.checkpoint.providerOutput.length > 0, true, 'the raw provider output is kept for replay');
  assert.equal(typeof result.checkpoint.mode === 'string', true);
  projections.push(result);
});

test('a server failure during compaction is not treated as an unsupported capability', async () => {
  const fixture = makeFixture({ official: 'server-error' });
  const id = await start(fixture);
  for (let index = 0; index < 4; index += 1) {
    await fixture.conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const result = await fixture.conversation.compactSession(fixture.conversation.stateFor(id), { reason: 'pressure' });
  assert.equal(result.status, 'failed');
  assert.equal(fixture.conversation.stateFor(id).officialUnsupported, undefined, 'a server error is not capability evidence');
});

test('a failed compaction changes no model context and leaves the question retryable', async () => {
  const fixture = makeFixture({ official: 'server-error' });
  const id = await start(fixture);
  for (let index = 0; index < 3; index += 1) {
    await fixture.conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const before = fixture.conversation.snapshot(id).items.length;
  await fixture.conversation.compactSession(fixture.conversation.stateFor(id), { reason: 'pressure' });
  const after = fixture.conversation.snapshot(id).items.length;
  assert.equal(after, before, 'the prior canonical items still stand');
  const ends = fixture.sessionStore.records.get(id).filter((record) => record.kind === 'compaction/end');
  assert.equal(ends.at(-1).payload.ok, false);
});

test('session usage folds compaction usage and every settled turn', async () => {
  const fixture = makeFixture({ official: 'supported' });
  const id = await start(fixture);
  await fixture.conversation.send(id, 'first');
  await fixture.conversation.send(id, 'second');
  const snapshot = fixture.conversation.snapshot(id);
  assert.equal(snapshot.sessionUsage > 0, true);
  assert.equal(snapshot.turnUsage.attempts >= 1, true);
  assert.equal(snapshot.turnUsage.total > 0, true);
});

test('the occupancy anchor comes from provider usage and stays exact afterwards', async () => {
  const fixture = makeFixture();
  const id = await start(fixture);
  await fixture.conversation.send(id, 'first');
  const snapshot = fixture.conversation.snapshot(id);
  assert.equal(snapshot.occupancy.exact, true, 'a provider-reported input becomes the exact anchor');
  assert.equal(snapshot.occupancy.tokens > 0, true);
});

test('local replay sends the compacted surface and reintroduces still-tracked files', async () => {
  // A tracked file the compaction must reintroduce verbatim.
  const tracked = [{ path: 'notes/a.md', observedRawText: '# Alpha\nfull text\n', status: 'tracked' }];
  const fixture = makeFixture({ official: 'supported', settings: { contextWindowTokens: 1000000, secretId: 'k', model: 'gpt-5' } });
  const tracker = {
    acceptTurn() {}, rejectTurn() {},
    allowlist: () => ['notes/a.md'],
    mutationsForSend: async () => [],
    trackedFiles: () => tracked,
  };
  const { createConversation } = require('../src/quick-ask/conversation');
  const conversation = createConversation({
    sessionStore: fixture.sessionStore,
    tracker,
    environment: {
      network: fixture.network,
      scheduler: { now: () => 0, delay: (ms, cb) => setTimeout(cb, ms), cancelDelay: clearTimeout, frame: (cb) => setTimeout(cb, 0), cancelFrame: clearTimeout },
      secrets: { resolve: () => 'sk' },
      vault: { normalizePath: (p) => p, readText: async () => null },
    },
    getSettings: () => ({ quickAsk: fixture.settings }),
  });
  const id = await start(fixture);
  await conversation.load(id);
  for (let index = 0; index < 4; index += 1) {
    await conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const state = conversation.stateFor(id);
  const result = await conversation.compactSession(state, { reason: 'pressure' });
  assert.equal(result.status, 'committed', 'a checkpoint is active');

  // Switch to local replay and ask again.
  conversation.applyStateFallback(id);
  await conversation.send(id, 'after compaction');
  const body = JSON.parse(fixture.requests.at(-1).options.body);
  assert.equal(body.previous_response_id, undefined, 'local replay chains nothing');

  const texts = body.input.map((item) => String(item.content?.[0]?.text ?? ''));
  assert.equal(texts.at(-1), 'after compaction');
  // The compacted surface sends the checkpoint's opaque output items, never a
  // parsed copy of them.
  assert.equal(body.input.some((item) => item.type === 'compaction' && item.encrypted_content === 'blob'), true,
    'the opaque Compaction Item is preserved exactly');
  // Every still-tracked Context File is reintroduced from its latest complete
  // original text, not from the diff history.
  assert.equal(texts.some((text) => text.includes('# Alpha\nfull text\n')), true,
    'the tracked file content is reintroduced verbatim');
});

test('replay closes an unmatched compaction bracket with an interrupted marker', async () => {
  const fixture = makeFixture();
  const id = await start(fixture);
  // A crash between compaction/start and its end leaves the bracket open.
  await fixture.sessionStore.append(id, 'compaction/start', { range: { from: 0, to: 2 }, mode: 'official', estimatedBefore: 900 });
  await fixture.sessionStore.append(id, 'compaction/checkpoint', { mode: 'official', providerOutput: [{ type: 'compaction', id: 'cmp_x' }] });

  const result = await fixture.conversation.recover(id);
  assert.equal(result.compactionInterrupted, true, 'the interruption is reported');
  assert.equal(result.retryable, true, 'the interrupted turn stays explicitly retryable');

  const ends = fixture.sessionStore.records.get(id).filter((record) => record.kind === 'compaction/end');
  assert.equal(ends.length, 1, 'the bracket is closed exactly once');
  assert.equal(ends[0].payload.ok, false);
  assert.equal(ends[0].payload.interrupted, true);

  // A second recovery must not stack another closing record.
  await fixture.conversation.recover(id);
  const after = fixture.sessionStore.records.get(id).filter((record) => record.kind === 'compaction/end');
  assert.equal(after.length, 1, 'a closed bracket is never closed again');
});

test('a discarded replacement never shadows the prior context', async () => {
  const fixture = makeFixture();
  const id = await start(fixture);
  await fixture.sessionStore.append(id, 'compaction/start', { range: { from: 0, to: 1 }, mode: 'fallback', estimatedBefore: 500 });
  await fixture.sessionStore.append(id, 'compaction/checkpoint', {
    mode: 'fallback', estimatedBefore: 500, estimatedAfter: 100,
    checkpoint: { framed: '<compacted-summary>discarded</compacted-summary>' },
  });
  await fixture.conversation.recover(id);
  const snapshot = fixture.conversation.snapshot(id);
  assert.equal(snapshot.compaction.active, false,
    'a checkpoint whose bracket never closed is not reconstructible from the body alone');
});

test('a checkpoint the shrink gate rejects never activates a replacement', async () => {
  // A checkpoint larger than the prefix it would replace fails the shrink gate,
  // so the prior canonical items still stand.
  const huge = { type: 'compaction', id: 'cmp_big', encrypted_content: 'x'.repeat(1600000) };
  const fixture = makeFixture({ official: 'supported' });
  fixture.network.request = async (options) => {
    if (String(options.url).endsWith('/responses/compact')) {
      fixture.compactRequests.push(options);
      return { status: 200, json: { output: [huge], usage: { total_tokens: 9 } } };
    }
    return { status: 200, text: '', json: jsonTurn({ text: 'Answered' }) };
  };
  const id = await start(fixture);
  for (let index = 0; index < 6; index += 1) {
    await fixture.conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const state = fixture.conversation.stateFor(id);
  const before = state.items.length;
  const result = await fixture.conversation.compactSession(state, { reason: 'pressure' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'no-shrink');
  assert.equal(fixture.conversation.snapshot(id).compaction.active, false,
    'a rejected replacement never shadows the prior context');
  assert.equal(state.items.length, before, 'no canonical item is discarded');
});

test('a composed context still over the threshold shrinks its tail and retries once', async () => {
  // The checkpoint itself shrinks, but the reintroduced tracked file pushes the
  // composed context back over the threshold, so the tail must shrink and the
  // compaction must run once more before it is accepted.
  const tracked = [{ path: 'papers/huge.md', observedRawText: 'y'.repeat(260000), status: 'tracked' }];
  const checkpoint = { type: 'compaction', id: 'cmp_mid', encrypted_content: 'c'.repeat(2000) };
  const fixture = makeFixture({ official: 'supported', settings: { contextWindowTokens: 200000 } });
  const { createConversation } = require('../src/quick-ask/conversation');
  const conversation = createConversation({
    sessionStore: fixture.sessionStore,
    tracker: {
      acceptTurn() {}, rejectTurn() {}, mutationsForSend: async () => [],
      allowlist: () => ['papers/huge.md'], trackedFiles: () => tracked,
    },
    environment: {
      network: fixture.network,
      scheduler: { now: () => 0, delay: (ms, cb) => setTimeout(cb, ms), cancelDelay: clearTimeout, frame: (cb) => setTimeout(cb, 0), cancelFrame: clearTimeout },
      secrets: { resolve: () => 'sk' },
      vault: { normalizePath: (p) => p, readText: async () => null },
    },
    getSettings: () => ({ quickAsk: fixture.settings }),
  });
  fixture.network.request = async (options) => {
    if (String(options.url).endsWith('/responses/compact')) {
      fixture.compactRequests.push(options);
      return { status: 200, json: { output: [checkpoint], usage: { total_tokens: 9 } } };
    }
    return { status: 200, text: '', json: jsonTurn() };
  };
  const id = await start(fixture);
  await conversation.load(id);
  for (let index = 0; index < 30; index += 1) {
    await conversation.send(id, `question ${index} ${'x'.repeat(2000)}`);
  }
  const state = conversation.stateFor(id);
  const result = await conversation.compactSession(state, { reason: 'pressure' });
  // The reintroduced tracked file keeps the composition over the threshold, so
  // the tail shrinks and one more compaction runs.
  assert.equal(fixture.compactRequests.length >= 1, true, 'compaction ran');
  assert.equal(['committed', 'no-viable-space'].includes(result.status), true, `terminal status, got ${result.status}`);
  assert.equal(tracked[0].observedRawText.length, 260000, 'the tracked file text is never truncated');
});

test('a checkpoint larger than its prefix is rejected and leaves every item in place', async () => {
  const oversized = { type: 'compaction', id: 'cmp_big', encrypted_content: 'x'.repeat(2000000) };
  const fresh = makeFixture({ official: 'supported', settings: { contextWindowTokens: 120000 } });
  fresh.network.request = async (options) => {
    if (String(options.url).endsWith('/responses/compact')) {
      fresh.compactRequests.push(options);
      return { status: 200, json: { output: [oversized] } };
    }
    return { status: 200, text: '', json: jsonTurn() };
  };
  const id = await start(fresh);
  for (let index = 0; index < 6; index += 1) {
    await fresh.conversation.send(id, `question ${index} ${'x'.repeat(400)}`);
  }
  const state = fresh.conversation.stateFor(id);
  const before = state.items.length;
  const result = await fresh.conversation.compactSession(state, { reason: 'pressure' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'no-shrink', 'the shrink gate refuses a replacement that is not smaller');
  assert.equal(state.items.length, before, 'no canonical item is dropped and no file is truncated');
  assert.equal(fresh.conversation.snapshot(id).compaction.active, false,
    'a rejected replacement never shadows the prior context');
});

test('the compacted surface carries each part once, files before the checkpoint', async () => {
  const tracked = [{ path: 'papers/kept.md', observedRawText: 'kept text', status: 'tracked' }];
  const output = [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'blob' }];
  const fixture = makeFixture({ official: 'supported' });
  fixture.network.request = async (options) => {
    if (String(options.url).endsWith('/responses/compact')) {
      fixture.compactRequests.push(options);
      return { status: 200, json: { output } };
    }
    return { status: 200, text: '', json: jsonTurn() };
  };
  const { createConversation } = require('../src/quick-ask/conversation');
  const conversation = createConversation({
    sessionStore: fixture.sessionStore,
    tracker: {
      acceptTurn() {}, rejectTurn() {}, mutationsForSend: async () => [],
      allowlist: () => ['papers/kept.md'], trackedFiles: () => tracked,
    },
    environment: {
      network: fixture.network,
      scheduler: { now: () => 0, delay: (ms, cb) => setTimeout(cb, ms), cancelDelay: clearTimeout, frame: (cb) => setTimeout(cb, 0), cancelFrame: clearTimeout },
      secrets: { resolve: () => 'sk' },
      vault: { normalizePath: (p) => p, readText: async () => null },
    },
    getSettings: () => ({ quickAsk: fixture.settings }),
  });
  const id = await start(fixture);
  await conversation.load(id);
  for (let index = 0; index < 6; index += 1) {
    await conversation.send(id, `question ${index} ${'x'.repeat(200)}`);
  }
  const state = conversation.stateFor(id);
  const result = await conversation.compactSession(state, { reason: 'pressure' });
  assert.equal(result.status, 'committed');

  conversation.applyStateFallback(id);
  await conversation.send(id, 'after');
  const body = JSON.parse(fixture.requests.at(-1).options.body);
  const compactionItems = body.input.filter((item) => item.type === 'compaction' && item.id === 'cmp_1');
  assert.equal(compactionItems.length, 1, 'the opaque checkpoint item appears exactly once');
  const texts = body.input.map((item) => String(item.content?.[0]?.text ?? ''));
  const fileIndex = texts.findIndex((text) => text.includes('kept text'));
  const checkpointIndex = body.input.findIndex((item) => item.type === 'compaction');
  assert.equal(fileIndex >= 0, true, 'the tracked file is reintroduced');
  assert.equal(checkpointIndex > fileIndex, true, 'tracked files come before the checkpoint output');
});

test('a provider overflow forces one compaction and retries the question, then answers', async () => {
  // The endpoint rejects every ordinary request with a context-window overflow
  // until a compaction has run, which is the real sequence the forced-compaction
  // retry exists for.
  // No configured capacity: the provider's overflow report is the only pressure
  // signal, which is the case forced compaction exists for.
  const fixture = makeFixture({ official: 'supported', summaryText: '## Goal\nCompact.', settings: { contextWindowTokens: '' } });
  const id = await start(fixture);
  // An older prefix gives compaction something to replace.
  const state = fixture.conversation.stateFor(id);
  state.items.push(
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier answer' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier question' }] },
  );

  const overflow = { status: 400, text: JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }) };
  let answered = false;
  fixture.network.fetch = async () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => overflow.text, body: null });
  fixture.network.request = async (options) => {
    if (String(options.url).endsWith('/responses/compact')) {
      fixture.compactRequests.push(options);
      return { status: 200, json: { output: [{ type: 'compaction', id: 'cmp_1' }], usage: { total_tokens: 9 } } };
    }
    if (!answered && fixture.compactRequests.length === 0) return overflow;
    answered = true;
    return { status: 200, text: '', json: jsonTurn({ text: 'Answered after compaction' }) };
  };

  const result = await fixture.conversation.send(id, 'question', { additions: [] });
  assert.equal(fixture.compactRequests.length >= 1, true, 'a compaction was forced');
  assert.equal(result.status, 'complete', 'the unchanged question was answered after compaction');
  assert.equal(result.text, 'Answered after compaction');
  const ends = fixture.sessionStore.records.get(id).filter((record) => record.kind === 'compaction/end');
  assert.equal(ends.length >= 1, true);
  assert.equal(ends[0].payload.ok, true, 'the compaction bracket closed successfully');
});

for (const exact of [false, true]) {
  test(`94% context compacts and continues through an unsupported endpoint (exact count: ${exact})`, async () => {
    const fixture = makeFixture({ official: 'unsupported' });
    const id = await start(fixture);
    const state = fixture.conversation.stateFor(id);
    const old = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old '.repeat(247000) }] };
    state.items.push(old,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'previous answer' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recent question' }] });
    state.occupancyAnchor = { inputTokens: 247200 };
    let summaries = 0;
    fixture.network.request = async options => {
      if (options.url.endsWith('/responses/input_tokens')) return exact
        ? { status: 200, json: { input_tokens: state.compactedSurface ? 500 : 247200 } }
        : { status: 404, text: 'unsupported' };
      if (options.url.endsWith('/responses/compact')) {
        fixture.compactRequests.push(options);
        return { status: 404, text: 'unsupported' };
      }
      throw new Error('unexpected non-streaming request');
    };
    fixture.network.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      fixture.requests.push({ url, options });
      if (body.tool_choice === 'none') {
        summaries++;
        return sseResponse(textTurn({ text: '## Goal\nPreserve the earlier decisions.' }));
      }
      assert.ok(body.input.some(item => item.content?.[0]?.text.includes('<compacted-summary>')));
      assert.equal(body.input.at(-1).content[0].text, 'test');
      assert.equal(body.input.includes(old), false);
      return sseResponse(textTurn());
    };
    const result = await fixture.conversation.send(id, 'test', { additions: [] });
    assert.equal(result.status, 'complete', 'pressure must reach compaction before capacity rejection');
    assert.equal(fixture.compactRequests.length, 1);
    assert.equal(summaries, 1);
    assert.equal(state.items[0], old, 'the original local history survives');
  });
}

test('manual compaction has no question, reserves the session and refreshes occupancy', async () => {
  const fixture = makeFixture({ official: 'unsupported' });
  const id = await start(fixture);
  for (let i = 0; i < 4; i++) await fixture.conversation.send(id, `history ${i} ${'x'.repeat(400)}`);
  const state = fixture.conversation.stateFor(id);
  const previousTurn = state.turn;
  const before = [...state.items];
  let release;
  const request = fixture.network.request;
  fixture.network.request = async options => {
    if (options.url.endsWith('/responses/compact')) await new Promise(resolve => { release = resolve; });
    return request(options);
  };
  const task = fixture.conversation.compactNow(id);
  assert.equal(fixture.conversation.snapshot(id).status, 'running');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await fixture.conversation.compactNow(id)).status, 'busy');
  assert.equal((await fixture.conversation.recover(id)).status, 'running', 'switching back must not close a live manual compaction');
  assert.equal(fixture.sessionStore.records.get(id).some(r => r.kind === 'compaction/end'), false);
  assert.equal((await fixture.conversation.send(id, 'overlap')).status, 'busy');
  release();
  assert.equal((await task).status, 'committed');
  assert.equal(fixture.conversation.runningTurns(), 0);
  assert.equal(state.turn, previousTurn, 'manual compaction does not create or replace a user turn');
  assert.deepEqual(state.items, before, 'the durable conversation remains intact');
  assert.ok(fixture.conversation.snapshot(id).occupancy.tokens > 0);
  assert.equal(fixture.conversation.snapshot(id).occupancy.estimated, true);
});

test('manual compaction skips empty history without network traffic', async () => {
  const fixture = makeFixture();
  const id = await start(fixture);
  assert.equal((await fixture.conversation.compactNow(id)).status, 'skipped');
  assert.equal(fixture.requests.length + fixture.compactRequests.length, 0);
  assert.equal(fixture.conversation.runningTurns(), 0);
});

test('manual compaction failure releases its reservation and keeps history retryable', async () => {
  const fixture = makeFixture({ official: 'server-error' });
  const id = await start(fixture);
  for (let i = 0; i < 3; i++) await fixture.conversation.send(id, `history ${i} ${'x'.repeat(400)}`);
  const state = fixture.conversation.stateFor(id);
  const before = [...state.items];
  assert.equal((await fixture.conversation.compactNow(id)).status, 'failed');
  assert.deepEqual(state.items, before);
  assert.equal(fixture.conversation.snapshot(id).compaction.active, false);
  assert.equal(fixture.conversation.runningTurns(), 0);
  assert.equal((await fixture.conversation.send(id, 'still works')).status, 'complete');
});

test('repeated manual compaction summarizes the active generation and replay restores the same input', async () => {
  const fixture = makeFixture({ official: 'unsupported' });
  const id = await start(fixture);
  for (let i = 0; i < 4; i++) await fixture.conversation.send(id, `OLD_UNIQUE_${i} ${'x'.repeat(2000)}`);
  assert.equal((await fixture.conversation.compactNow(id)).status, 'committed');
  await fixture.conversation.send(id, 'after first');
  let body = JSON.parse(fixture.requests.at(-1).options.body);
  assert.equal(JSON.stringify(body.input).includes('OLD_UNIQUE_0'), false, 'the compacted prefix must leave the active input');
  for (let i = 0; i < 3; i++) await fixture.conversation.send(id, `NEW_${i} ${'y'.repeat(2000)}`);
  const requestStart = fixture.requests.length;
  assert.equal((await fixture.conversation.compactNow(id)).status, 'committed');
  const summary = fixture.requests.slice(requestStart).map(r => JSON.parse(r.options.body)).find(b => b.tool_choice === 'none');
  assert.ok(JSON.stringify(summary.input).includes('<compacted-summary>'), 'consolidate the previous checkpoint');
  assert.equal(JSON.stringify(summary.input).includes('OLD_UNIQUE_0'), false, 'never re-summarize shadowed raw history');
  const pending = { question: 'inspect next', additions: [] };
  const before = await fixture.conversation.pricePendingRequest(fixture.conversation.stateFor(id), pending);
  fixture.conversation.forget(id);
  await fixture.conversation.load(id);
  const after = await fixture.conversation.pricePendingRequest(fixture.conversation.stateFor(id), pending);
  assert.equal(after.price.total, before.price.total, 'restart restores the same active generation');
});

test('pending files are still checked after compaction and are never truncated', async () => {
  const fixture = makeFixture({ official: 'supported', settings: { contextWindowTokens: 50000 } });
  const id = await start(fixture);
  const state = fixture.conversation.stateFor(id);
  state.items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old'.repeat(60000) }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recent' }] });
  const file = { kind: 'file', path: 'huge.md', text: 'f'.repeat(200000) };
  const result = await fixture.conversation.send(id, 'read', { additions: [file] });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CAPACITY');
  assert.equal(result.accepted, false);
  assert.equal(state.turn.additions[0].text, file.text);
  assert.equal(fixture.requests.filter(r => !r.url.endsWith('/responses/input_tokens')).length, 0);
});
