const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createConversation, MAX_CONCURRENT_TURNS } = require('../src/quick-ask/conversation');

// A session-store double recording the durable log in memory.
function makeStore() {
  const logs = new Map();
  const records = new Map();
  let counter = 0;
  return {
    logs,
    records,
    async createSession({ config } = {}) {
      const id = `s${++counter}`;
      logs.set(id, [{ kind: 'header', schemaVersion: 1, sessionId: id, createdAt: '2026-09-12T00:00:00.000Z', config: config ?? {} }]);
      records.set(id, []);
      return { id, header: logs.get(id)[0] };
    },
    async append(id, kind, payload) {
      const record = { seq: (records.get(id) ?? []).length, at: '2026-09-12T00:00:01.000Z', kind, payload };
      records.get(id).push(record);
      return record;
    },
    async readLog(id) {
      if (!records.has(id)) return { missing: true };
      return { header: logs.get(id)[0], records: records.get(id), version: 1, nextSeq: records.get(id).length };
    },
  };
}

function makeTracker() {
  const calls = { accept: 0, reject: 0 };
  return {
    calls,
    acceptTurn() { calls.accept++; },
    rejectTurn() { calls.reject++; },
    mutationsForSend: () => [],
    stageSelection() {}, stageFile() {}, stageReference() {},
    allowlist: () => [], trackedFiles: () => [],
  };
}

// A scripted transport double: each call replays one scripted attempt.
function makeNetwork(script) {
  const requests = [];
  let index = 0;
  const repeatable = typeof script === 'function';
  const next = () => {
    if (repeatable) return script;
    if (index >= script.length) throw new Error('the network double received an unscripted request');
    return script[index++];
  };
  const network = {
    requests,
    fetch: async (url, options) => {
      const step = next();
      requests.push({ url, options });
      return step(url, options);
    },
    request: async (options) => {
      const step = next();
      requests.push({ url: options.url, options, nonStreaming: true });
      return step(options.url, options);
    },
  };
  return network;
}

function sseResponse(events) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`).join('');
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: (async function* stream() { yield new TextEncoder().encode(body); })(),
  };
}

function streamedTurn({ text = 'Hello', responseId = 'resp_1' } = {}) {
  return [
    { type: 'response.created', data: { response: { id: responseId } } },
    { type: 'response.output_text.delta', data: { delta: text } },
    { type: 'response.completed', data: { response: { id: responseId, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } } },
  ];
}

function conversationEnvironment(script = () => sseResponse(streamedTurn())) {
  return {
    network: makeNetwork(script),
    scheduler: {
      now: () => Date.parse('2026-09-12T00:00:00.000Z'),
      delay: (ms, callback) => setTimeout(callback, ms),
      cancelDelay: (handle) => clearTimeout(handle),
      frame: (callback) => setTimeout(callback, 0),
      cancelFrame: (handle) => clearTimeout(handle),
    },
    secrets: { resolve: (id) => (id ? 'sk-test' : null), list: () => [], onChange: () => () => {} },
  };
}

function makeConversation({ config = {}, script = () => sseResponse(streamedTurn()), settings = {} } = {}) {
  const sessionStore = makeStore();
  const tracker = makeTracker();
  const network = makeNetwork(script);
  const environment = {
    vault: { normalizePath: path => path, readText: async () => null },
    network,
    scheduler: {
      now: () => Date.parse('2026-09-12T00:00:00.000Z'),
      delay: (ms, callback) => setTimeout(callback, ms),
      cancelDelay: (handle) => clearTimeout(handle),
      frame: (callback) => setTimeout(callback, 0),
      cancelFrame: (handle) => clearTimeout(handle),
    },
    secrets: { resolve: (id) => (id ? 'sk-test' : null), list: () => [], onChange: () => () => {} },
  };
  const merged = {
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', secretId: 'openai-key',
    systemPrompt: 'Be terse.', contextWindowTokens: 262144, ...settings,
  };
  const conversation = createConversation({
    sessionStore, tracker, environment,
    getSettings: () => ({ quickAsk: merged }),
  });
  return { conversation, sessionStore, tracker, network, settings: merged };
}

async function newSession(sessionStore, conversation, config = {}) {
  const { id } = await sessionStore.createSession({ config });
  await conversation.load(id);
  return id;
}

test('custom endpoints receive full canonical context on consecutive turns and after reload', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { baseUrl: 'https://gateway.example/v1' } });
  const id = await newSession(sessionStore, conversation, settings);
  const paper = 'FULL_PAPER_SENTINEL\n' + 'paragraph\n'.repeat(200);
  await conversation.send(id, 'First question', { additions: [{ kind: 'file', path: 'paper.md', text: paper }] });
  await conversation.send(id, 'Follow up', { additions: [] });
  const check = (body, question) => {
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.store, false);
    const text = JSON.stringify(body.input);
    assert.ok(text.includes('FULL_PAPER_SENTINEL'));
    assert.ok(text.includes('First question'));
    assert.ok(text.includes('Hello'));
    assert.ok(text.includes(question));
    assert.equal(text.split('FULL_PAPER_SENTINEL').length - 1, 1);
  };
  check(JSON.parse(network.requests.at(-1).options.body), 'Follow up');
  conversation.forget(id);
  await conversation.load(id);
  await conversation.send(id, 'After restart', { additions: [] });
  check(JSON.parse(network.requests.at(-1).options.body), 'After restart');
});

test('a question reaches the endpoint with the session snapshot and disabled truncation', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  const result = await conversation.send(id, 'What is this?');
  assert.equal(result.status, 'complete');
  assert.equal(result.text, 'Hello');
  const body = JSON.parse(network.requests[0].options.body);
  assert.equal(body.model, 'gpt-5');
  assert.equal(body.store, false, 'local history is the default for every endpoint');
  assert.equal(body.truncation, 'disabled');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.previous_response_id, undefined, 'the first request chains nothing');
  assert.equal(body.input.at(-1).content[0].text, 'What is this?');
  assert.equal(network.requests[0].options.headers.Authorization, 'Bearer sk-test');
});

test('reloading a completed response keeps question then one canonical answer', async () => {
  const output = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One answer' }] };
  const events = streamedTurn({ text: 'One answer' });
  events.at(-1).data.response.output = [output];
  const { conversation, sessionStore, settings } = makeConversation({ script: () => sseResponse(events) });
  const id = await newSession(sessionStore, conversation, settings);
  await conversation.send(id, 'One question');
  const reloaded = await conversation.load(id);
  const visible = require('../src/quick-ask/view').conversationFromRecords(reloaded.parsed.records);
  assert.deepEqual(visible.map(message => [message.role, message.text]), [['user', 'One question'], ['assistant', 'One answer']]);
  assert.equal(reloaded.state.items.filter(item => item.role === 'assistant').length, 1);
});

test('preparation reserves its session before any file reads finish', async () => {
  const { sessionStore, settings } = makeConversation();
  const tracker = makeTracker();
  let release;
  tracker.mutationsForSend = () => new Promise(resolve => { release = resolve; });
  const environment = conversationEnvironment();
  const conversation = createConversation({ sessionStore, tracker, environment, getSettings: () => ({ quickAsk: settings }) });
  const id = await newSession(sessionStore, conversation, settings);
  const first = conversation.send(id, 'first');
  assert.equal(conversation.runningTurns(), 1);
  assert.equal((await conversation.send(id, 'duplicate')).status, 'busy');
  conversation.suspend();
  release([]);
  assert.equal((await first).status, 'disabled');
  assert.equal(environment.network.requests.length, 0);
});

test('disabling during an input-token preflight aborts it without a Responses send', async () => {
  const { sessionStore, settings } = makeConversation({ settings: { contextWindowTokens: 20000 } });
  const environment = conversationEnvironment();
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  let seenSignal;
  environment.network.request = ({ signal }) => new Promise((_resolve, reject) => {
    seenSignal = signal;
    requestStarted();
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const conversation = createConversation({ sessionStore, tracker: makeTracker(), environment, getSettings: () => ({ quickAsk: settings }) });
  const id = await newSession(sessionStore, conversation, settings);
  const sending = conversation.send(id, 'q'.repeat(12000), { additions: [] });
  await started;
  conversation.suspend();
  assert.equal(seenSignal.aborted, true);
  assert.equal((await sending).status, 'disabled');
  assert.equal(environment.network.requests.length, 0);
});

test('invalid configuration fails inline without any connection attempt', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { model: '' } });
  const id = await newSession(sessionStore, conversation, { ...settings, model: '' });
  const result = await conversation.send(id, 'hello');
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.model);
  assert.equal(network.requests.length, 0, 'no request is spent on probing');
});

test('a missing secret value is an inline failure rather than a request', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation();
  conversation.environmentUnknown = null;
  const id = await newSession(sessionStore, conversation, { ...settings, secretId: '' });
  const result = await conversation.send(id, 'hello');
  assert.equal(result.status, 'invalid');
  assert.ok(result.errors.secretId);
  assert.equal(network.requests.length, 0);
});

test('streamed deltas update the projection and the turn finishes durably', async () => {
  const { conversation, sessionStore, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  const projections = [];
  const withListener = createConversation({
    sessionStore,
    tracker: makeTracker(),
    environment: conversationEnvironment(),
    getSettings: () => ({ quickAsk: settings }),
    onSessionChange: (_id, projection) => projections.push(projection),
  });
  await withListener.load(id);
  const result = await withListener.send(id, 'hi');
  assert.equal(result.status, 'complete');
  assert.ok(projections.some((projection) => projection.kind === 'text' && projection.text === 'Hello'));
  const kinds = sessionStore.records.get(id).map((record) => record.kind);
  assert.ok(kinds.includes('turn/started'));
  assert.ok(kinds.includes('turn/response-created'));
  assert.ok(kinds.includes('turn/finished'));
});

test('a burst of long reasoning coalesces presentation and retains only canonical history', async t => {
  const { sessionStore, settings } = makeConversation();
  const count = 2000;
  const events = [
    { type: 'response.created', data: { response: { id: 'long-reasoning' } } },
    ...Array.from({ length: count }, () => ({ type: 'response.reasoning_text.delta', data: { delta: 'reasoning line\n' } })),
    { type: 'response.output_text.delta', data: { delta: 'Answer' } },
    { type: 'response.completed', data: { response: { id: 'long-reasoning' } } },
  ];
  let updates = 0;
  const environment = conversationEnvironment(() => sseResponse(events));
  const runtime = createConversation({ sessionStore, tracker: makeTracker(), environment,
    getSettings: () => ({ quickAsk: settings }), onSessionChange: (_id, projection) => { if (projection.kind === 'reasoning') updates++; } });
  const id = await newSession(sessionStore, runtime, settings);
  const result = await runtime.send(id, 'Long reasoning');
  assert.equal(result.reasoning, 'reasoning line\n'.repeat(count));
  assert.ok(updates <= 2, `one burst generated ${updates} full-prefix updates`);
  t.diagnostic(`${count} reasoning chunks -> ${updates} presentation update(s); ${result.reasoning.length} characters preserved`);
  assert.equal(runtime.stateFor(id).projections, undefined, 'transient full-prefix snapshots must not accumulate');
});

test('response.created is the checkpoint that accepts staged Context and starts tracking', async () => {
  const { conversation, sessionStore, tracker, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  await conversation.send(id, 'hi', { additions: [{ kind: 'file', path: 'a.md', text: 'alpha' }] });
  assert.equal(tracker.calls.accept, 1);
  assert.equal(tracker.calls.reject, 0);
  const records = sessionStore.records.get(id);
  const created = records.findIndex((record) => record.kind === 'turn/response-created');
  const accepted = records.findIndex((record) => record.kind === 'turn/accepted');
  assert.ok(created >= 0 && accepted > created, 'acceptance is durable and ordered after response.created');
});

test('a failure before response.created keeps the staged Context retryable and untracked', async () => {
  const { conversation, sessionStore, tracker, settings } = makeConversation({
    script: [() => { throw new Error('connect ECONNREFUSED'); }],
  });
  const id = await newSession(sessionStore, conversation, settings);
  const result = await conversation.send(id, 'hi', { additions: [{ kind: 'file', path: 'a.md', text: 'alpha' }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(tracker.calls.accept, 0);
  assert.equal(tracker.calls.reject, 1);
  const finished = sessionStore.records.get(id).find((record) => record.kind === 'turn/finished');
  assert.equal(finished.payload.state, 'failed');
});

test('an accepted attempt that fails is not resubmitted and keeps its partial text', async () => {
  const script = [
    () => sseResponse([
      { type: 'response.created', data: { response: { id: 'resp_9' } } },
      { type: 'response.output_text.delta', data: { delta: 'Partial' } },
    ]),
  ];
  const { conversation, sessionStore, tracker, settings } = makeConversation({ script });
  const id = await newSession(sessionStore, conversation, settings);
  const result = await conversation.send(id, 'hi');
  assert.equal(result.status, 'failed');
  assert.equal(result.text, 'Partial', 'the partial answer is preserved');
  assert.equal(tracker.calls.accept, 1);
  assert.equal(sessionStore.records.get(id).filter((record) => record.kind === 'turn/started').length, 1);
});

test('a second turn replays history even on the official endpoint', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  await conversation.send(id, 'first');
  await conversation.send(id, 'second');
  const second = JSON.parse(network.requests.at(-1).options.body);
  assert.equal(second.previous_response_id, undefined);
  assert.equal(second.input.at(-1).content[0].text, 'second');
  assert.equal(second.store, false);
  assert.ok(second.input.some(item => item.content?.[0]?.text === 'first'));
  assert.ok(second.input.some(item => item.role === 'assistant'));
  assert.equal(conversation.snapshot(id).turnUsage.total, 12, 'turn usage does not accumulate earlier turns');
});

test('local replay mode rebuilds the whole request from canonical items', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  await conversation.send(id, 'first');
  conversation.applyStateFallback(id);
  await conversation.send(id, 'second');
  const body = JSON.parse(network.requests[1].options.body);
  assert.equal(body.previous_response_id, undefined, 'no chaining in local replay mode');
  assert.equal(body.store, false);
  const texts = body.input.map((item) => item.content?.[0]?.text);
  assert.ok(texts.includes('first'), 'the canonical history is resent');
  assert.equal(texts.at(-1), 'second');
});

test('a committed local checkpoint retains its summary and all later turns across restart', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  const item = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  await sessionStore.append(id, 'item/input', { item: item('old prefix') });
  await sessionStore.append(id, 'item/input', { item: item('retained question') });
  await sessionStore.append(id, 'compaction/start', {});
  await sessionStore.append(id, 'compaction/checkpoint', { range: { from: 0, to: 0 }, checkpoint: { framed: 'SUMMARY_SENTINEL' } });
  await sessionStore.append(id, 'compaction/end', { ok: true });
  await conversation.load(id);
  await conversation.send(id, 'New after checkpoint');
  await conversation.send(id, 'Next');
  const check = () => {
    const text = JSON.stringify(JSON.parse(network.requests.at(-1).options.body).input);
    for (const value of ['SUMMARY_SENTINEL', 'retained question', 'New after checkpoint']) assert.ok(text.includes(value), value);
    assert.equal(text.includes('old prefix'), false);
  };
  check();
  conversation.forget(id); await conversation.load(id);
  await conversation.send(id, 'Restarted'); check();
});

test('local tool continuation includes provider reasoning and each tool item exactly once', async () => {
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get-full-file', arguments: '{"path":"missing.md"}' };
  const reasoning = { type: 'reasoning', id: 'r_1', summary: [{ type: 'summary_text', text: 'Readable tool reasoning' }] };
  const first = [
    { type: 'response.created', data: { response: { id: 'resp_call' } } },
    { type: 'response.output_item.done', data: { output_index: 0, item: reasoning } },
    { type: 'response.output_item.done', data: { output_index: 1, item: call } },
    { type: 'response.completed', data: { response: { id: 'resp_call', output: [reasoning, call] } } },
  ];
  const { conversation, sessionStore, network, settings } = makeConversation({ script: [() => sseResponse(first), () => sseResponse(streamedTurn())] });
  const id = await newSession(sessionStore, conversation, settings);
  await conversation.send(id, 'Read it');
  assert.equal(network.requests.length, 2);
  const body = JSON.parse(network.requests[1].options.body);
  for (const type of ['reasoning', 'function_call', 'function_call_output']) assert.equal(body.input.filter(item => item.type === type).length, 1, type);
  assert.equal(body.previous_response_id, undefined);
});

test('a session keeps its own endpoint, model, prompt, and capacity', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, {
    baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', secretId: 'deepseek-key',
    systemPrompt: 'Be brief.', contextWindowTokens: 131072,
  });
  await conversation.send(id, 'hi');
  const request = network.requests[0];
  assert.equal(request.url, 'https://api.deepseek.com/responses');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.match(body.instructions, /Be brief\./);
  void settings;
});

test('only one turn runs per session and at most three globally', async () => {
  const gates = [];
  const script = [() => new Promise((resolve) => gates.push(resolve))];
  const { conversation, sessionStore, settings } = makeConversation({ script });
  const first = await newSession(sessionStore, conversation, settings);
  const running = conversation.send(first, 'slow');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const busy = await conversation.send(first, 'another');
  assert.equal(busy.status, 'busy');
  assert.equal(conversation.runningTurns(), 1);
  assert.equal(MAX_CONCURRENT_TURNS, 3);

  const second = await newSession(sessionStore, conversation, settings);
  const third = await newSession(sessionStore, conversation, settings);
  const fourth = await newSession(sessionStore, conversation, settings);
  const two = conversation.send(second, 'x');
  const three = conversation.send(third, 'x');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fourth_result = await conversation.send(fourth, 'x');
  assert.equal(fourth_result.status, 'busy', 'a fourth concurrent turn is refused');

  for (const resolve of gates) resolve(sseResponse(streamedTurn()));
  await Promise.all([running, two, three]);
});

test('Stop aborts only its owning session and keeps the partial answer', async () => {
  const gates = [];
  const script = [() => new Promise((resolve) => gates.push(resolve))];
  const { conversation, sessionStore, settings } = makeConversation({ script });
  const first = await newSession(sessionStore, conversation, settings);
  const second = await newSession(sessionStore, conversation, settings);
  const running = conversation.send(first, 'slow');
  const other = conversation.send(second, 'x');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(await conversation.stop(first), true);
  for (const resolve of gates) {
    resolve({
      ok: false,
      status: 499,
      headers: { get: () => null },
      body: (async function* stream() {
        yield new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"half"}\n\n');
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      })(),
    });
  }
  const stopped = await running;
  assert.ok(['stopped', 'failed'].includes(stopped.status));
  const finished = sessionStore.records.get(first).filter((record) => record.kind === 'turn/finished');
  assert.equal(finished.length, 1);
  await Promise.allSettled([other]);
});

test('restart recovery marks an unrecoverable pending turn interrupted and never resubmits it', async () => {
  const { conversation, sessionStore, tracker, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  // A crash leaves a started turn with no finished record.
  await sessionStore.append(id, 'turn/started', { turnId: 't-crash', question: 'was it sent?', additions: [] });
  const fresh = createConversation({
    sessionStore, tracker, environment: conversationEnvironment(), getSettings: () => ({ quickAsk: settings }),
  });
  const result = await fresh.recover(id);
  assert.equal(result.status, 'interrupted');
  const finished = sessionStore.records.get(id).filter((record) => record.kind === 'turn/finished');
  assert.equal(finished.at(-1).payload.state, 'interrupted');
  assert.equal(tracker.calls.reject, 1);
  const snap = fresh.snapshot(id);
  assert.equal(snap.status, 'interrupted');
});

test('a recovered turn reports resumable when the stored Response is still in progress', async () => {
  const { conversation, sessionStore, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  await sessionStore.append(id, 'turn/started', { turnId: 't1', question: 'q', additions: [] });
  await sessionStore.append(id, 'turn/response-created', { turnId: 't1', responseId: 'resp_live' });
  const fresh = createConversation({
    sessionStore, tracker: makeTracker(), environment: conversationEnvironment(), getSettings: () => ({ quickAsk: settings }),
  });
  const result = await fresh.recover(id, { retrieve: async () => ({ status: 'in_progress' }) });
  assert.deepEqual(result, { status: 'resumable', responseId: 'resp_live' });
});

test('a pending turn whose stored Response completed is committed on recovery', async () => {
  const { conversation, sessionStore, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  await sessionStore.append(id, 'turn/started', { turnId: 't1', question: 'q', additions: [] });
  await sessionStore.append(id, 'turn/response-created', { turnId: 't1', responseId: 'resp_done' });
  const fresh = createConversation({
    sessionStore, tracker: makeTracker(), environment: conversationEnvironment(), getSettings: () => ({ quickAsk: settings }),
  });
  const result = await fresh.recover(id, { retrieve: async () => ({ status: 'completed', text: 'Recovered answer' }) });
  assert.equal(result.status, 'complete');
  assert.equal(result.text, 'Recovered answer');
});

test('a session with no unfinished turn recovers cleanly', async () => {
  const { conversation, sessionStore, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  await conversation.send(id, 'done');
  const fresh = createConversation({
    sessionStore, tracker: makeTracker(), environment: conversationEnvironment(), getSettings: () => ({ quickAsk: settings }),
  });
  assert.deepEqual(await fresh.recover(id), { status: 'clean' });
});

test('mixed dropped chips exclude unsupported paths from requests and durable history', async () => {
  const { EditorState } = require('@codemirror/state');
  const { fileReferenceField, editingReferenceField, stageReferences, referencedPaths, questionText } = require('../src/quick-ask/composer-state');
  let editor = EditorState.create({ doc: 'Explain', selection: { anchor: 7 }, extensions: [fileReferenceField, editingReferenceField] });
  editor = editor.update(stageReferences(editor, ['notes/readme.md', 'private-unsupported-image.png', 'private-unsupported-document.pdf'])).state;
  const paths = referencedPaths(editor, path => /\.(md|markdown)$/i.test(path));
  const { conversation, sessionStore, network, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  const result = await conversation.send(id, questionText(editor), {
    additions: paths.map(path => ({ kind: 'file', path, text: 'supported file content' })),
  });
  assert.equal(result.status, 'complete');
  assert.equal(questionText(editor), 'Explain');
  for (const serialized of [network.requests[0].options.body, JSON.stringify(sessionStore.records.get(id))]) {
    assert.equal(serialized.includes('private-unsupported'), false, 'neither requests nor persisted history may contain ignored references');
    assert.ok(serialized.includes('notes/readme.md'));
  }
});
