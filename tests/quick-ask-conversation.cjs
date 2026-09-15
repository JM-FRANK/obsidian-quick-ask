// quick-ask-suite: portable
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
      logs.set(id, [{ kind: 'header', schemaVersion: config?.protocol === 'chat-completions' ? 2 : 1, sessionId: id, createdAt: '2026-09-12T00:00:00.000Z', config: config ?? {} }]);
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
      return { header: logs.get(id)[0], records: records.get(id), version: logs.get(id)[0].schemaVersion, nextSeq: records.get(id).length };
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

function searchTurn(query = 'current facts') {
  const call = {type:'function_call',id:'search-call',call_id:'search-1',name:'web_search',arguments:JSON.stringify({query})};
  const events=streamedTurn({text:''}); events.at(-1).data.response.output=[call];
  return sseResponse(events);
}
test('one-shot search is removed from the next request while sticky manual-off survives restart',async()=>{
 const f=makeConversation({settings:{webSearch:{provider:'server'}}}); const id=await newSession(f.sessionStore,f.conversation,f.settings);
 await f.conversation.setSearchEnabled(id,true);
 assert.equal((await f.conversation.send(id,'first')).status,'complete');
 assert.ok(JSON.parse(f.network.requests[0].options.body).tools.some(t=>t.type==='web_search'));
 assert.equal(f.conversation.searchEnabled(id),false);
 await f.conversation.send(id,'next');
 assert.equal(JSON.parse(f.network.requests.at(-1).options.body).tools.some(t=>/web_search/.test(t.type+t.name)),false);
 f.settings.webSearch={defaultEnabled:true};
 await f.conversation.setSearchEnabled(id,false); f.conversation.forget(id); await f.conversation.load(id);
 assert.equal(f.conversation.searchEnabled(id),false);
 await f.conversation.send(id,'closed');
 assert.equal(JSON.parse(f.network.requests.at(-1).options.body).tools.some(t=>/web_search/.test(t.type+t.name)),false);
});
test('independent search executes inside the turn and sources survive the durable conversation',async()=>{
 let reads=0;
 const f=makeConversation({settings:{webSearch:{provider:'exa',secretId:'search-key'}},script:(url,options)=>{
  if(url==='https://api.exa.ai/search'){reads++;return {status:200,json:{results:[{title:'Source',url:'https://example.org',highlights:['evidence']}]}};}
  const body=JSON.parse(options.body);
  return body.input.some(i=>i.type==='function_call_output')?sseResponse(streamedTurn({text:'Answer'})):searchTurn();
 }});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 let baseline=0;f.tracker.applyFullFileResult=()=>baseline++;
 const result=await f.conversation.send(id,'search',{webSearch:true});
 assert.equal(result.status,'complete');assert.equal(reads,1);assert.equal(baseline,0);
 assert.equal(result.sources[0].url,'https://example.org/');
 assert.equal(f.conversation.stateFor(id).toolQuestion,undefined);
 const records=f.sessionStore.records.get(id);
 const visible=require('../src/quick-ask/conversation-messages').conversationFromRecords(records);
 assert.equal(visible.at(-1).sources[0].title,'Source');
 assert.equal(JSON.stringify(records).includes('sk-test'),false);
});
test('disabled search refuses an unexpected function call without executing network search',async()=>{
 const f=makeConversation({script:(url,options)=>{
  assert.ok(url.endsWith('/responses'));
  const body=JSON.parse(options.body);
  return body.input.some(i=>i.type==='function_call_output')?sseResponse(streamedTurn()):searchTurn();
 }});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 assert.equal((await f.conversation.send(id,'no web',{webSearch:false})).status,'complete');
 const body=JSON.parse(f.network.requests.at(-1).options.body);
 assert.match(body.input.find(i=>i.type==='function_call_output').output,/disabled/);
});
test('explicit server search refusal fails without switching methods or adding another turn',async()=>{
 let attempts=0;
 const f=makeConversation({settings:{webSearch:{provider:'server'}},script:(url,options)=>{
  const body=JSON.parse(options.body);attempts++;
  if(body.tools.some(t=>t.type==='web_search'))return {ok:false,status:400,headers:{get:()=>null},text:async()=>JSON.stringify({error:{message:'web_search is not supported'}}),body:null};
  return sseResponse(streamedTurn());
 }});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 const result=await f.conversation.send(id,'search',{webSearch:true});
 assert.equal(result.status,'failed');assert.equal(attempts,1);
 assert.ok(JSON.parse(f.network.requests.at(-1).options.body).tools.some(t=>t.type==='web_search'));
 assert.equal(f.sessionStore.records.get(id).filter(r=>r.kind==='turn/started').length,1);
});
test('validation failure does not consume the one-shot permission',async()=>{
 const f=makeConversation({settings:{webSearch:{provider:'exa',secretId:''}}});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 await f.conversation.setSearchEnabled(id,true);
 assert.equal((await f.conversation.send(id,'search')).status,'invalid');
 assert.equal(f.conversation.searchEnabled(id),true);assert.equal(f.network.requests.length,0);
});

test('one-shot consumption does not clear a newer selection made during preflight',async()=>{
 const f=makeConversation();const id=await newSession(f.sessionStore,f.conversation,f.settings);
 let release;f.tracker.mutationsForSend=()=>new Promise(resolve=>{release=resolve;});
 await f.conversation.setSearchEnabled(id,true);
 const sending=f.conversation.send(id,'q');
 await f.conversation.setSearchEnabled(id,false);await f.conversation.setSearchEnabled(id,true);
 release([]);assert.equal((await sending).status,'complete');
 assert.equal(f.conversation.searchEnabled(id),true);
});
test('server sources are preserved and progress reaches a terminal state',async()=>{
 const f=makeConversation({settings:{webSearch:{provider:'server'}}});const projections=[];
 const environment=conversationEnvironment(()=>sseResponse([
  {type:'response.created',data:{response:{id:'server-response'}}},
  {type:'response.web_search_call.searching',data:{}},
  {type:'response.output_text.delta',data:{delta:'Cited answer'}},
  {type:'response.completed',data:{response:{id:'server-response',output:[{type:'web_search_call',action:{sources:[{title:'Official',url:'https://example.org'}]}},{type:'message',role:'assistant',content:[{type:'output_text',text:'Cited answer',annotations:[{type:'url_citation',url:'https://example.org',title:'Official'}]}]}]}}}
 ]));
 const runtime=createConversation({sessionStore:f.sessionStore,tracker:makeTracker(),environment,getSettings:()=>({quickAsk:f.settings}),onSessionChange:(_id,p)=>projections.push(p)});
 const id=await newSession(f.sessionStore,runtime,f.settings);
 const result=await runtime.send(id,'q',{webSearch:true});
 assert.equal(result.sources.length,1);
 assert.deepEqual(projections.filter(p=>p.kind==='search-status').map(p=>p.status),['running','complete']);
});


test('invalid selected server search blocks before requests and preserves one-shot permission',async()=>{
 const f=makeConversation({settings:{baseUrl:'https://unknown.test/v1',webSearch:{provider:'server'}}});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 await f.conversation.setSearchEnabled(id,true);
 const result=await f.conversation.send(id,'question');
 assert.equal(result.status,'invalid');assert.equal(result.errors.searchServer,true);
 assert.equal(f.network.requests.length,0);assert.equal(f.conversation.searchEnabled(id),true);
 assert.equal(f.sessionStore.records.get(id).some(r=>r.kind==='turn/started'),false);
 assert.equal((await f.conversation.send(id,'without search',{webSearch:false})).status,'complete');
});

test('a rejected independent key stops before answer continuation without another service',async()=>{
 let modelCalls=0,searchCalls=0;
 const f=makeConversation({settings:{webSearch:{provider:'exa',secretId:'bad-key-ref'}},script:(url,options)=>{
  if(url==='https://api.exa.ai/search'){searchCalls++;return {status:401,text:'invalid API key'};}
  modelCalls++;return searchTurn();
 }});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 const result=await f.conversation.send(id,'q',{webSearch:true});
 assert.equal(result.status,'failed');assert.equal(result.error.code,'SEARCH_FAILED');
 assert.equal(modelCalls,1);assert.equal(searchCalls,1);
 assert.equal(f.network.requests.some(r=>r.url.includes('duckduckgo')),false);
});

function chatResponse(message = { role: 'assistant', content: 'CC answer' }) {
  const data = [
    { id: 'cc-fixture', choices: [{ index: 0, delta: message, finish_reason: null }] },
    { id: 'cc-fixture', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] },
    { id: 'cc-fixture', choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
  ];
  return { status: 200, body: (async function* () {
    for (const value of data) yield `data: ${JSON.stringify(value)}\n\n`;
    yield 'data: [DONE]\n\n';
  })() };
}

test('Chat Completions replays native history and keeps the session protocol after settings change and restart', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({
    settings: { protocol: 'chat-completions' }, script: () => chatResponse(),
  });
  const id = await newSession(sessionStore, conversation, { ...settings });
  assert.equal((await conversation.send(id, 'First', { additions: [{ kind: 'file', path: 'a.md', text: 'FULL_CC_FILE' }] })).status, 'complete');
  settings.protocol = 'responses';
  conversation.forget(id);
  await conversation.load(id);
  assert.equal((await conversation.send(id, 'Next')).status, 'complete');
  const body = JSON.parse(network.requests.at(-1).options.body);
  assert.ok(network.requests.every(r => r.url.endsWith('/chat/completions')));
  assert.deepEqual(body.messages.slice(-3), [{ role: 'user', content: 'First' }, { role: 'assistant', content: 'CC answer' }, { role: 'user', content: 'Next' }]);
  assert.ok(body.messages.some(m => m.content.includes('FULL_CC_FILE')));
  for (const key of ['input', 'instructions', 'previous_response_id', 'truncation', 'store']) assert.equal(body[key], undefined);
  assert.equal(body.tools[0].function.name, 'get-full-file');
  const visible = require('../src/quick-ask/conversation-messages').conversationFromRecords(sessionStore.records.get(id));
  assert.deepEqual(visible.filter(m => m.role === 'assistant').map(m => m.text), ['CC answer', 'CC answer']);
});

test('Chat Completions continues a batch of native function calls without duplicating assistant calls', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { protocol: 'chat-completions' },
    script: [() => chatResponse({ role: 'assistant', content: null, tool_calls: [
      { index: 0, id: 'call-a', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"a.md"}' } },
      { index: 1, id: 'call-b', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"b.md"}' } },
    ] }), () => chatResponse()],
  });
  const id = await newSession(sessionStore, conversation, settings);
  assert.equal((await conversation.send(id, 'Read')).status, 'complete');
  const body = JSON.parse(network.requests[1].options.body);
  assert.equal(body.messages.filter(m => m.tool_calls).length, 1);
  assert.deepEqual(body.messages.slice(-2), [
    { role: 'tool', tool_call_id: 'call-a', content: '文件不存在' },
    { role: 'tool', tool_call_id: 'call-b', content: '文件不存在' },
  ]);
  assert.equal(body.messages.some(m => m.type === 'function_call'), false);
});

test('Chat Completions compacts locally without Responses endpoints and keeps the checkpoint after restart', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { protocol: 'chat-completions' },
    script: (_url, options) => chatResponse({ role: 'assistant', content: JSON.parse(options.body).tool_choice === 'none' ? '## Goal\nKeep facts.' : 'answer' }),
  });
  const id = await newSession(sessionStore, conversation, { ...settings });
  await conversation.send(id, 'Older '.repeat(600));
  await conversation.send(id, 'Newest');
  const compacted = await conversation.compactNow(id);
  assert.equal(compacted.status, 'committed');
  assert.ok(network.requests.every(r => r.url.endsWith('/chat/completions')));
  const summary = network.requests.map(r => JSON.parse(r.options.body)).find(b => b.tool_choice === 'none');
  assert.equal(summary.max_completion_tokens, 8192);
  assert.equal(summary.messages.at(-1).role, 'user');
  conversation.forget(id); await conversation.load(id);
  await conversation.send(id, 'Continue');
  const body = JSON.parse(network.requests.at(-1).options.body);
  assert.equal(body.messages.some(m => m.content?.includes('Older Older')), false);
  assert.equal(body.messages.filter(m => m.content?.includes('<compacted-summary>')).length, 1);
});

test('Chat Completions rejects server search before accepting a question', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: {
    protocol: 'chat-completions', webSearch: { provider: 'server', defaultEnabled: true },
  } });
  const id = await newSession(sessionStore, conversation, settings);
  const result = await conversation.send(id, 'Search');
  assert.equal(result.status, 'invalid');
  assert.equal(result.errors.searchServer, true);
  assert.equal(network.requests.length, 0);
  assert.equal(sessionStore.records.get(id).some(r => r.kind === 'turn/started'), false);
});

test('a legacy session remains Responses when global settings switch to Chat Completions', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { protocol: 'chat-completions' } });
  const { protocol, ...legacy } = settings;
  const id = await newSession(sessionStore, conversation, legacy);
  assert.equal((await conversation.send(id, 'Legacy question')).status, 'complete');
  assert.ok(network.requests[0].url.endsWith('/responses'));
});

test('Chat Completions oversized first context fails locally without input_tokens or compaction probes', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { protocol: 'chat-completions', contextWindowTokens: 17000 } });
  const id = await newSession(sessionStore, conversation, settings);
  const result = await conversation.send(id, 'Explain', { additions: [{ kind: 'file', path: 'a.md', text: 'x'.repeat(100000) }] });
  assert.equal(result.status, 'capacity'); assert.equal(network.requests.length, 0);
});

test('Chat Completions invokes an independently configured search and omits it when the next turn is off', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: {
    protocol: 'chat-completions', webSearch: { provider: 'exa', secretId: 'exa-ref', defaultEnabled: false },
  }, script: [
    () => chatResponse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 's', type: 'function', function: { name: 'web_search', arguments: '{"query":"public docs"}' } }] }),
    () => ({ status: 200, json: { results: [{ title: 'Docs', url: 'https://example.test/docs', text: 'Public docs' }] }, text: JSON.stringify({ results: [{ title: 'Docs', url: 'https://example.test/docs', text: 'Public docs' }] }) }),
    () => chatResponse(), () => chatResponse(),
  ] });
  const id = await newSession(sessionStore, conversation, settings);
  await conversation.setSearchEnabled(id, true);
  assert.equal((await conversation.send(id, 'Search')).status, 'complete');
  assert.ok(network.requests[1].url.startsWith('https://api.exa.ai/'));
  assert.equal((await conversation.send(id, 'Next')).status, 'complete');
  const body = JSON.parse(network.requests.at(-1).options.body);
  assert.equal(body.tools.some(tool => tool.function.name === 'web_search'), false);
  assert.equal(body.messages.filter(m => m.tool_calls?.some(c => c.function.name === 'web_search')).length, 1);
});

test('incomplete Chat Completions tool batches remain replayable after restart without executing them', async () => {
  let first = true;
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { protocol: 'chat-completions' }, script: () => {
    if (!first) return chatResponse(); first = false;
    return { status: 200, body: (async function* () {
      yield `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":' } }] }, finish_reason: 'length' }] })}\n\n`;
      yield 'data: [DONE]\n\n';
    })() };
  } });
  const id = await newSession(sessionStore, conversation, settings);
  assert.equal((await conversation.send(id, 'First')).status, 'incomplete');
  assert.equal(network.requests.length, 1);
  conversation.forget(id); await conversation.load(id);
  assert.equal((await conversation.send(id, 'Next')).status, 'complete');
  const messages = JSON.parse(network.requests[1].options.body).messages;
  const callIndex = messages.findIndex(m => m.tool_calls);
  assert.equal(messages[callIndex + 1].role, 'tool');
  assert.equal(messages[callIndex + 1].tool_call_id, 'a');
  assert.match(messages[callIndex + 1].content, /not executed/i);
});

test('unknown Chat Completions tools receive an explicit error alongside known tools', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { protocol: 'chat-completions' }, script: [
    () => chatResponse({ role: 'assistant', content: null, tool_calls: [
      { index: 0, id: 'a', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"a.md"}' } },
      { index: 1, id: 'b', type: 'function', function: { name: 'unknown', arguments: '{"path":"a.md"}' } },
    ] }), () => chatResponse(),
  ] });
  const id = await newSession(sessionStore, conversation, settings);
  assert.equal((await conversation.send(id, 'Read')).status, 'complete');
  const messages = JSON.parse(network.requests[1].options.body).messages;
  assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b']);
  assert.match(messages.at(-1).content, /Unsupported tool/);
});

test('reported Chat Completions usage survives disconnection before DONE and session reload', async () => {
  const { conversation, sessionStore, settings } = makeConversation({ settings: { protocol: 'chat-completions' }, script: () => ({
    status: 200, body: (async function* () {
      yield `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }] })}\n\n`;
      yield `data: ${JSON.stringify({ id: 'c', choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`;
    })(),
  }) });
  const id = await newSession(sessionStore, conversation, settings);
  assert.equal((await conversation.send(id, 'Question')).status, 'failed');
  assert.equal(sessionStore.records.get(id).find(r => r.kind === 'turn/usage')?.payload.usage.total_tokens, 10);
  conversation.forget(id); await conversation.load(id);
  assert.equal(conversation.snapshot(id).sessionUsage, 10);
});

test('reported Chat Completions usage is kept when the user cancels after the usage frame', async () => {
  const controller = new AbortController();
  const { conversation, sessionStore, settings } = makeConversation({ settings: { protocol: 'chat-completions' }, script: () => ({
    status: 200, body: (async function* () {
      yield `data: ${JSON.stringify({ id: 'c', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: 'stop' }] })}\n\n`;
      yield `data: ${JSON.stringify({ id: 'c', choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } })}\n\n`;
      controller.abort();
    })(),
  }) });
  const id = await newSession(sessionStore, conversation, settings);
  assert.equal((await conversation.send(id, 'Question', { signal: controller.signal })).status, 'stopped');
  assert.equal(conversation.snapshot(id).turnUsage.total, 10);
  assert.equal(sessionStore.records.get(id).find(r => r.kind === 'turn/usage')?.payload.usage.total_tokens, 10);
});

test('draft search toggles write nothing until valid send, then restore the committed post-send state', async () => {
  const f = makeConversation({ settings: { webSearch: { defaultEnabled: true, provider: 'server' } } });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  for (const enabled of [false, true, false]) await f.conversation.setSearchEnabled(id, enabled);
  assert.equal(f.sessionStore.records.get(id).length, 0);
  await f.conversation.load(id);
  assert.equal(f.conversation.searchEnabled(id), false, 'in-memory draft survives session switching');
  assert.equal((await f.conversation.send(id, 'Question')).status, 'complete');
  assert.equal(f.sessionStore.records.get(id).filter(r => r.kind === 'session/search-state').length, 0);
  assert.equal(f.sessionStore.records.get(id).find(r => r.kind === 'turn/started').payload.nextSearchEnabled, false);
  f.conversation.forget(id); await f.conversation.load(id);
  assert.equal(f.conversation.searchEnabled(id), false);
});

test('reasoning effort uses the send snapshot through tools and changes only the next request', async () => {
  const f = makeConversation({ settings: { protocol: 'chat-completions' }, script: [
    () => { f.conversation.setReasoningEffort(id, 'none'); return chatResponse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"a.md"}' } }] }); },
    () => chatResponse(), () => chatResponse(),
  ] });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  assert.equal(f.conversation.reasoningEffort(id), 'high');
  f.conversation.setReasoningEffort(id, 'max');
  assert.equal((await f.conversation.send(id, 'First')).status, 'complete');
  assert.deepEqual(f.network.requests.map(r => JSON.parse(r.options.body).reasoning_effort), ['max', 'max']);
  await f.conversation.send(id, 'Next');
  assert.equal(JSON.parse(f.network.requests[2].options.body).reasoning_effort, 'none');
  f.conversation.forget(id); await f.conversation.load(id);
  assert.equal(f.conversation.reasoningEffort(id), 'none');
});

test('CC reasoning stays visible across tool rounds and is replayed as native reasoning', async () => {
  const f = makeConversation({ settings: { protocol: 'chat-completions' }, script: [
    () => chatResponse({ role: 'assistant', content: null, reasoning_content: 'First reasoning.', tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"a.md"}' } }] }),
    () => chatResponse({ role: 'assistant', content: 'Answer', reasoning_content: 'Final reasoning.' }),
    () => chatResponse(),
  ] });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const result = await f.conversation.send(id, 'Question');
  assert.equal(result.reasoning, 'First reasoning.Final reasoning.');
  f.conversation.forget(id); await f.conversation.load(id);
  const visible = require('../src/quick-ask/conversation-messages').conversationFromRecords(f.sessionStore.records.get(id));
  assert.equal(visible.at(-1).reasoning, result.reasoning);
  await f.conversation.send(id, 'Next');
  const history = JSON.parse(f.network.requests.at(-1).options.body).messages;
  assert.deepEqual(history.filter(m => m.reasoning_content).map(m => m.reasoning_content), ['First reasoning.', 'Final reasoning.']);
});

test('CC reasoning survives a search tool failure and replay', async () => {
  const f = makeConversation({ settings: { protocol: 'chat-completions', webSearch: { defaultEnabled: true, provider: 'exa', secretId: 'search-key' } }, script: [
    () => chatResponse({ role: 'assistant', content: null, reasoning_content: 'Need evidence.', tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":"public"}' } }] }),
    () => ({ status: 401, text: 'Unauthorized' }),
  ] });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const result = await f.conversation.send(id, 'Question');
  assert.equal(result.status, 'failed');
  assert.equal(result.reasoning, 'Need evidence.');
  const visible = require('../src/quick-ask/conversation-messages').conversationFromRecords(f.sessionStore.records.get(id));
  assert.equal(visible.at(-1).reasoning, 'Need evidence.');
});

test('Stop during a CC search retains reasoning and paired tool history', async () => {
  const controller = new AbortController();
  const f = makeConversation({ settings: { protocol: 'chat-completions', webSearch: { defaultEnabled: true, provider: 'exa', secretId: 'search-key' } }, script: [
    () => chatResponse({ role: 'assistant', content: null, reasoning_content: 'Searching.', tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":"public"}' } }] }),
    () => { controller.abort(); return { status: 200, json: { results: [] } }; },
  ] });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const result = await f.conversation.send(id, 'Question', { signal: controller.signal });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reasoning, 'Searching.');
  const items = f.sessionStore.records.get(id).filter(r => r.kind === 'item/output').map(r => r.payload.item);
  assert.ok(items.some(m => m.tool_calls?.[0].id === 'a'));
  assert.ok(items.some(m => m.role === 'tool' && m.tool_call_id === 'a'));
});

test('recovered retries preserve their renderer while genuinely new questions use the current version', async () => {
  const { renderTurn, buildInstructions, RENDERER_VERSION } = require('../src/quick-ask/prompt-renderer');
  for (const protocol of ['responses', 'chat-completions']) {
    for (const version of [1, 2, 3]) {
      const script = protocol === 'responses' ? () => sseResponse(streamedTurn()) : () => ({
        ok: true, status: 200, headers: { get: () => null },
        body: (async function* () { yield new TextEncoder().encode('data: {"id":"cc","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); })(),
      });
      const { conversation, sessionStore, network, settings } = makeConversation({ script });
      const id = await newSession(sessionStore, conversation, { ...settings, protocol, systemPrompt: 'Saved custom role.' });
      const additions = [{ kind: 'file', path: 'a.md', text: 'alpha\nbeta' }];
      await sessionStore.append(id, 'turn/started', { turnId: 'old', question: 'retry me', additions, rendererVersion: version });
      await conversation.recover(id);
      const recovered = conversation.stateFor(id).turn;
      assert.equal(recovered.rendererVersion, version);
      const result = await conversation.send(id, recovered.question, { additions: recovered.additions, rendererVersion: recovered.rendererVersion });
      assert.equal(result.status, 'complete');
      const started = sessionStore.records.get(id).filter(r => r.kind === 'turn/started').at(-1);
      assert.notEqual(started.payload.turnId, 'old');
      assert.equal(started.payload.rendererVersion, version);
      const native = require('../src/quick-ask/protocol').protocolFor({ protocol });
      const expected = renderTurn({ mutations: additions, question: 'retry me', rendererVersion: version, userMessage: native.userMessage });
      const body = JSON.parse(network.requests.at(-1).options.body);
      const input = protocol === 'responses' ? body.input : body.messages.slice(1);
      assert.equal(protocol === 'responses' ? body.instructions : body.messages[0].content, buildInstructions({ rendererVersion: version, customSystemPrompt: 'Saved custom role.' }));
      assert.deepEqual(input, expected);
      assert.deepEqual(conversation.snapshot(id).items.slice(0, 2), expected);
      await conversation.send(id, 'new question', { additions });
      assert.equal(sessionStore.records.get(id).filter(r => r.kind === 'turn/started').at(-1).payload.rendererVersion, RENDERER_VERSION);
      assert.match(network.requests.at(-1).options.body, /1 \| alpha/);
      const fresh = JSON.parse(network.requests.at(-1).options.body);
      assert.equal(protocol === 'responses' ? fresh.instructions : fresh.messages[0].content, buildInstructions({ rendererVersion: 3, customSystemPrompt: 'Saved custom role.' }));
    }
  }
});

test('legacy turns recover renderer 1 and unknown retry renderers fail before writes or requests', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation();
  const id = await newSession(sessionStore, conversation, settings);
  await sessionStore.append(id, 'turn/started', { turnId: 'legacy', question: 'q', additions: [] });
  await conversation.recover(id);
  assert.equal(conversation.stateFor(id).turn.rendererVersion, 1);
  const before = JSON.stringify(sessionStore.records.get(id));
  const result = await conversation.send(id, 'q', { rendererVersion: 999 });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /renderer.*999/i);
  assert.equal(network.requests.length, 0);
  assert.equal(JSON.stringify(sessionStore.records.get(id)), before);
});

test('a pinned retry prices its own format and retains it through a full-file tool continuation', async () => {
  const store = makeStore();
  const tracker = makeTracker();
  tracker.allowlist = () => ['a.md'];
  const environment = conversationEnvironment([
    () => chatResponse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"a.md"}' } }] }),
    () => chatResponse(),
  ]);
  environment.vault = { normalizePath: path => path, readText: async () => 'alpha\nbeta' };
  const config = { protocol: 'chat-completions', baseUrl: 'https://example.test/v1', model: 'm', secretId: 'key' };
  const conversation = createConversation({ sessionStore: store, tracker, environment, getSettings: () => ({ quickAsk: config }) });
  const id = await newSession(store, conversation, config);
  const additions = [{ kind: 'file', path: 'a.md', text: 'alpha\n'.repeat(100) }];
  const state = conversation.stateFor(id);
  const oldPrice = await conversation.pricePendingRequest(state, { question: 'q', additions, rendererVersion: 1 });
  const newPrice = await conversation.pricePendingRequest(state, { question: 'q', additions, rendererVersion: 2 });
  assert.ok(newPrice.price.total > oldPrice.price.total);
  const result = await conversation.send(id, 'q', { additions, rendererVersion: 1 });
  assert.equal(result.status, 'complete');
  const body = JSON.parse(environment.network.requests.at(-1).options.body);
  assert.equal(body.messages.find(m => m.role === 'tool').content, 'alpha\nbeta');
});

test('CC Stop before the first frame leaves canonical history untouched', async () => {
  let conversation;
  let id;
  const fixture = makeConversation({ settings: { protocol: 'chat-completions' }, script: () => ({
    status: 200, body: (async function* () { await conversation.stop(id); })(),
  }) });
  conversation = fixture.conversation;
  id = await newSession(fixture.sessionStore, conversation, fixture.settings);
  const result = await conversation.send(id, 'q');
  assert.equal(result.status, 'stopped');
  assert.equal(result.accepted, false);
  assert.deepEqual(conversation.snapshot(id).items, []);
  assert.equal(fixture.sessionStore.records.get(id).some(r => r.kind === 'item/output'), false);
});

test('profile switching changes new-session requests only in both protocols', async () => {
  const { applyQuickAskPatch, sessionConfigSnapshot } = require('../src/quick-ask/settings');
  const { buildInstructions } = require('../src/quick-ask/prompt-renderer');
  for (const protocol of ['responses', 'chat-completions']) {
    const f = makeConversation({ settings: { protocol, systemPrompt: 'Original role' },
      script: protocol === 'responses' ? () => sseResponse(streamedTurn()) : () => chatResponse(),
    });
    const oldId = await newSession(f.sessionStore, f.conversation, sessionConfigSnapshot(f.settings));
    const originalHeader = JSON.stringify(f.sessionStore.logs.get(oldId)[0]);
    applyQuickAskPatch(f.settings, { profileAction: { type: 'add', id: 'new-role', name: 'New role' } });
    applyQuickAskPatch(f.settings, { profileAction: { type: 'prompt', id: 'new-role', prompt: 'Different role' } });
    const newId = await newSession(f.sessionStore, f.conversation, sessionConfigSnapshot(f.settings));
    for (const [id, prompt] of [[oldId, 'Original role'], [newId, 'Different role']]) {
      const result = await f.conversation.send(id, 'Explain');
      assert.equal(result.status, 'complete');
      const body = JSON.parse(f.network.requests.at(-1).options.body);
      assert.equal(protocol === 'responses' ? body.instructions : body.messages[0].content,
        buildInstructions({ rendererVersion: 3, customSystemPrompt: prompt }));
    }
    assert.equal(JSON.stringify(f.sessionStore.logs.get(oldId)[0]), originalHeader);
  }
});
