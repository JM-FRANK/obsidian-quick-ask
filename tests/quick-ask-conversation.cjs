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

function makeConversation({ config = {}, script = () => sseResponse(streamedTurn()), settings = {}, imageSource = null, files = {} } = {}) {
  const sessionStore = makeStore();
  const tracker = makeTracker();
  const network = makeNetwork(script);
  const environment = {
    images: { readForSend: paths => require('../src/quick-ask/images').prepareImages(paths, imageSource) },
    vault: { normalizePath: path => path, readText: async path => files[path] ?? null },
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
  const projections = [];
  const conversation = createConversation({
    sessionStore, tracker, environment,
    getSettings: () => ({ quickAsk: merged }),
    onSessionChange: (_id, projection) => projections.push(projection),
  });
  return { conversation, sessionStore, tracker, network, settings: merged, projections };
}

async function newSession(sessionStore, conversation, config = {}) {
  const { id } = await sessionStore.createSession({ config });
  await conversation.load(id);
  return id;
}

function imageToolResponse(protocol, name, path, callId, sourcePath = null) {
  const args = JSON.stringify({ path, ...(name === 'get-image' ? { sourcePath } : {}) });
  return protocol === 'responses' ? sseResponse([
    { type: 'response.created', data: { response: { id: callId } } },
    { type: 'response.completed', data: { response: { id: callId, output: [{ type: 'function_call', id: `fc-${callId}`, call_id: callId, name, arguments: args }] } } },
  ]) : chatResponse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: args } }] });
}

test('the production conversation executor shares the live global cap across sessions', async () => {
  const reads = [], gates = {};
  const files = {};
  for (const id of ['a', 'b']) Object.defineProperty(files, `${id}.md`, { get() {
    reads.push(id); return new Promise(resolve => { gates[id] = resolve; });
  } });
  const f = makeConversation({ files, settings: { toolConcurrency: 1 }, script: (_url, options) => {
    const body = JSON.parse(options.body);
    return body.input.some(item => item.type === 'function_call_output')
      ? sseResponse(streamedTurn()) : imageToolResponse('responses', 'get-full-file', `${body.model}.md`, `call-${body.model}`);
  } });
  f.tracker.allowlist = () => ['a.md', 'b.md'];
  const a = await newSession(f.sessionStore, f.conversation, { ...f.settings, model: 'a', toolConcurrency: 10 });
  const b = await newSession(f.sessionStore, f.conversation, { ...f.settings, model: 'b', toolConcurrency: 10 });
  const first = f.conversation.send(a, 'Read a');
  const second = f.conversation.send(b, 'Read b');
  for (let attempt = 0; attempt < 20 && reads.length < 1; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 1);
  const initial = reads[0]; gates[initial]('first');
  for (let attempt = 0; attempt < 20 && reads.length < 2; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2); gates[reads[1]]('second');
  assert.equal((await first).status, 'complete'); assert.equal((await second).status, 'complete');
});

for (const protocol of ['responses', 'chat-completions']) {
  test(`${protocol}: legacy limits do not hide tools or cap repeated continuation rounds`, async () => {
    let requests = 0;
    const f = makeConversation({ settings: { protocol }, script: () => {
      requests++;
      return requests <= 8 ? imageToolResponse(protocol, 'get-full-file', 'missing.md', `round-${requests}`)
        : protocol === 'responses' ? sseResponse(streamedTurn()) : chatResponse();
    } });
    const id = await newSession(f.sessionStore, f.conversation, { ...f.settings, callLimit: 1, fullFileCallLimit: 1 });
    assert.equal((await f.conversation.send(id, 'Use the requested tools')).status, 'complete');
    assert.equal(requests, 9);
    assert.ok(f.network.requests.every(request => JSON.parse(request.options.body).tools.length === 2));
    const records = f.sessionStore.records.get(id);
    assert.equal(records.filter(record => record.kind === 'turn/tool-finished').length, 8);
  });

  test(`${protocol}: linked document images persist exact paths and replay after reload without source Markdown`, async () => {
    const sourcePath = 'file01/file11/paper.md', path = 'file01/file11/attachments/pic01.png';
    const files = { [sourcePath]: '![figure](attachments/pic01.png)' }, reads = [];
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const answer = () => protocol === 'responses' ? sseResponse(streamedTurn()) : chatResponse();
    const f = makeConversation({ settings: { protocol }, files, imageSource: {
      stat: async input => input === path ? { size: bytes.length } : null,
      readBinary: async input => { reads.push(input); return bytes; },
    }, script: [() => imageToolResponse(protocol, 'get-image', 'attachments/pic01.png', 'linked', sourcePath), answer, answer,
      () => imageToolResponse(protocol, 'get-image', path, 'direct'), answer] });
    f.tracker.allowlist = () => [sourcePath];
    const id = await newSession(f.sessionStore, f.conversation, { ...f.settings, protocol });
    assert.equal((await f.conversation.send(id, 'Read this document image')).status, 'complete');
    const activity = f.projections.filter(projection => projection.kind === 'tool-activity');
    assert.deepEqual(activity.map(projection => projection.group.calls[0].status), ['queued', 'running', 'complete']);
    const metadata = f.sessionStore.records.get(id).filter(record => record.kind.startsWith('turn/tool-'));
    assert.deepEqual(metadata.map(record => record.kind), ['turn/tool-started', 'turn/tool-started', 'turn/tool-finished']);
    assert.equal(metadata[2].payload.summary.path, path);
    assert.equal(f.network.requests.some(request => /tool-activity|turn\/tool-|"batchId"|"toolGroups"/.test(request.options.body)), false);
    assert.match(f.network.requests[1].options.body, /data:image/);
    const record = f.sessionStore.records.get(id).find(record => record.payload?.imagePaths);
    assert.deepEqual(record.payload.imagePaths, [path]);
    assert.equal(JSON.stringify(f.sessionStore.records.get(id)).includes('data:image'), false);
    delete files[sourcePath];
    f.conversation.forget(id);
    await f.conversation.load(id);
    const restoredCalls = f.conversation.snapshot(id).toolGroups.flatMap(group => group.calls);
    assert.equal(restoredCalls.length, 1);
    assert.equal(restoredCalls[0].status, 'complete');
    assert.equal(restoredCalls[0].summary.path, path);
    assert.equal((await f.conversation.send(id, 'Look again')).status, 'complete');
    assert.match(f.network.requests[2].options.body, /data:image/);
    assert.equal((await f.conversation.send(id, 'Read the exact authorized path')).status, 'complete');
    assert.match(f.network.requests[4].options.body, /data:image/);
    assert.ok(reads.length >= 4);
    assert.ok(reads.every(input => input === path));
  });

  test(`${protocol}: get-image replays path-based tool results through followups, reload and compaction`, async () => {
    let bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    let reads = 0;
    const answer = () => protocol === 'responses' ? sseResponse(streamedTurn()) : chatResponse();
    const f = makeConversation({ settings: { protocol }, imageSource: {
      stat: async () => ({ size: bytes.length }), readBinary: async () => { reads++; return bytes; },
    }, script: [answer,
      () => imageToolResponse(protocol, 'get-image', 'fig.png', 'image-1'),
      () => imageToolResponse(protocol, 'get-full-file', 'missing.md', 'file-1'), answer, answer, answer,
      () => imageToolResponse(protocol, 'get-image', 'fig.png', 'image-2'), answer] });
    const id = await newSession(f.sessionStore, f.conversation, { ...f.settings, protocol });
    assert.equal((await f.conversation.send(id, 'Look', { images: ['fig.png'] })).status, 'complete');
    const firstTools = JSON.parse(f.network.requests[0].options.body).tools.map(tool => tool.function ?? tool);
    assert.ok(firstTools.some(tool => tool.name === 'get-image'), 'provided by default before the first image is accepted');
    bytes = Uint8Array.from([...bytes, 2]);
    assert.equal((await f.conversation.send(id, 'Look again')).status, 'complete');
    const requests = f.network.requests.map(request => JSON.parse(request.options.body));
    const definition = requests[1].tools.map(tool => tool.function ?? tool).find(tool => tool.name === 'get-image');
    assert.equal(definition.parameters.properties.path.enum, undefined, 'document links must not be restricted to sent attachment paths');
    assert.deepEqual(definition.parameters.required, ['path', 'sourcePath']);
    assert.deepEqual(definition.parameters.properties.sourcePath.type, ['string', 'null']);
    assert.equal(JSON.stringify(requests[1]).includes('data:image'), false);
    const continuation = protocol === 'responses' ? requests[2].input : requests[2].messages;
    const output = continuation.find(item => item.call_id === 'image-1' && item.type === 'function_call_output' || item.tool_call_id === 'image-1');
    if (protocol === 'responses') {
      assert.equal(output.output[0].text, 'Image read: fig.png.');
      assert.equal(output.output[1].type, 'input_image');
      assert.equal(continuation.some(item => item.role === 'user' && item.content?.some(part => part.type === 'input_image')), false,
        'Responses keeps the image inside its tool output');
    } else {
      assert.equal(output.content, 'Image read: fig.png.');
      assert.equal(continuation.at(-1).role, 'user');
      assert.equal(continuation.at(-1).content.at(-1).type, 'image_url');
    }
    assert.match(JSON.stringify(continuation), new RegExp(Buffer.from(bytes).toString('base64')));
    assert.equal(JSON.stringify(requests[3]).includes('data:image'), true, 'ordinary tool continuation retains the image result');
    assert.equal(f.conversation.stateFor(id).occupancyAnchor, null);
    assert.equal(JSON.stringify(f.conversation.snapshot(id).items).includes('data:image'), false);
    const priorReads = reads;
    assert.equal((await f.conversation.send(id, 'Plain followup')).status, 'complete');
    assert.match(f.network.requests[4].options.body, /data:image/);
    assert.ok(reads > priorReads, 'normal followup rematerializes the current source');
    bytes = Uint8Array.from([...bytes, 3]);
    f.conversation.forget(id);
    await f.conversation.load(id);
    assert.equal((await f.conversation.send(id, 'After reload')).status, 'complete');
    assert.match(f.network.requests[5].options.body, new RegExp(Buffer.from(bytes).toString('base64')));
    const lastItem = f.conversation.stateFor(id).items.length - 1;
    await f.sessionStore.append(id, 'compaction/start', {});
    await f.sessionStore.append(id, 'compaction/checkpoint', { range: { from: 0, to: lastItem }, checkpoint: { framed: 'IMAGE_TOOL_SUMMARY' } });
    await f.sessionStore.append(id, 'compaction/end', { ok: true });
    f.conversation.forget(id);
    await f.conversation.load(id);
    assert.equal((await f.conversation.send(id, 'After reload, look again')).status, 'complete');
    assert.equal(f.network.requests[6].options.body.includes('data:image'), false, 'compacted image results are no longer active');
    assert.match(f.network.requests[6].options.body, /IMAGE_TOOL_SUMMARY/);
    assert.match(f.network.requests[7].options.body, /data:image/, 'explicit call can retrieve a compacted image again');
    const logs = JSON.stringify(f.sessionStore.records.get(id));
    assert.equal(logs.includes('data:image'), false);
    assert.equal(logs.includes('base64'), false);
    const toolRecord = f.sessionStore.records.get(id).find(record => record.kind === 'item/output' && record.payload.tool && record.payload.imagePaths?.length);
    assert.deepEqual(toolRecord.payload.imagePaths, ['fig.png']);
  });

  test(`${protocol}: image permissions do not cross sessions and unavailable sources return text without images`, async () => {
    let available = true, reads = 0;
    const answer = () => protocol === 'responses' ? sseResponse(streamedTurn()) : chatResponse();
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const f = makeConversation({ settings: { protocol }, imageSource: {
      stat: async () => available ? { size: bytes.length } : null, readBinary: async () => { reads++; return bytes; },
    }, script: [answer, () => imageToolResponse(protocol, 'get-image', 'fig.png', 'foreign'), answer,
      () => imageToolResponse(protocol, 'get-image', 'fig.png', 'missing'), answer] });
    const owner = await newSession(f.sessionStore, f.conversation, { ...f.settings, protocol });
    await f.conversation.send(owner, 'Look', { images: ['fig.png'] });
    const other = await newSession(f.sessionStore, f.conversation, { ...f.settings, protocol });
    assert.equal((await f.conversation.send(other, 'Read fig.png')).status, 'complete');
    assert.equal(reads, 1);
    assert.match(f.network.requests[2].options.body, /not authorized/);
    assert.equal(f.network.requests[2].options.body.includes('data:image'), false);
    available = false;
    assert.equal((await f.conversation.send(owner, 'Look again')).status, 'complete');
    assert.match(f.network.requests[4].options.body, /IMAGE_MISSING/);
    assert.equal(f.network.requests[4].options.body.includes('data:image'), false);
    assert.equal(reads, 1);
  });
}

test('history preview precedes replay while the next request retains the complete canonical context', async () => {
  const { conversation, sessionStore, network, settings } = makeConversation({ settings: { baseUrl: 'https://gateway.example/v1' } });
  const { id } = await sessionStore.createSession({ config: settings });
  for (let turn = 0; turn < 20; turn++) {
    await sessionStore.append(id, 'turn/started', { turnId: `t${turn}`, question: `Question ${turn}`, additions: [] });
    await sessionStore.append(id, 'item/input', { item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Question ${turn}` }] } });
    await sessionStore.append(id, 'item/output', { item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Answer ${turn}` }] } });
    await sessionStore.append(id, 'turn/finished', { turnId: `t${turn}`, state: 'complete', text: `Answer ${turn}` });
  }
  let release;
  let previewReady;
  const ready = new Promise(resolve => { previewReady = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const loading = conversation.load(id, { onParsed: async parsed => {
    assert.equal(parsed.records.length, 80);
    assert.equal(conversation.stateFor(id).items.length, 0, 'preview runs before protocol replay');
    const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');
    const { historyPageStart } = require('../src/quick-ask/history-window');
    const messages = conversationFromRecords(parsed.records);
    assert.equal(messages[historyPageStart(messages)].text, 'Question 12');
    previewReady();
    await gate;
  } });
  await ready;
  assert.equal(network.requests.length, 0, 'local preview makes no provider request');
  release();
  await loading;
  assert.equal(conversation.stateFor(id).items.length, 40);
  await conversation.send(id, 'Continue', { additions: [] });
  const input = JSON.stringify(JSON.parse(network.requests.at(-1).options.body).input);
  for (const text of ['Question 0', 'Answer 0', 'Question 19', 'Answer 19', 'Continue']) assert.ok(input.includes(text), text);
});

test('unavailable logs never reach the recent-history preview', async () => {
  const { conversation, sessionStore } = makeConversation();
  const { id } = await sessionStore.createSession({ config: { protocol: 'unsupported' } });
  let previews = 0;
  await assert.rejects(conversation.load(id, { onParsed: () => { previews++; } }), /unavailable/);
  assert.equal(previews, 0);
});

test('a run started during the preview paint is not overwritten by replay', async () => {
  const { conversation, sessionStore } = makeConversation();
  const { id } = await sessionStore.createSession({});
  const liveItems = [{ type: 'message', role: 'user', content: 'New live question' }];
  const controller = new AbortController();
  const loaded = await conversation.load(id, { onParsed: async () => {
    const state = conversation.stateFor(id);
    state.activeController = controller;
    state.items = liveItems;
  } });
  assert.equal(loaded.state.items, liveItems);
  assert.equal(loaded.state.activeController, controller);
});

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
  assert.equal(sessionStore.records.get(id).filter(record => record.kind === 'turn/process').length, 2, 'two thousand deltas produce only two boundary writes');
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
 const tools=projections.filter(p=>p.kind==='tool-activity');
 assert.deepEqual(tools.map(p=>p.group.calls[0].status),['running','complete']);
 const groups=require('../src/quick-ask/tool-history').toolHistory(f.sessionStore.records.get(id));
 assert.equal(groups.length,1);assert.equal(groups[0].calls.length,1);
 assert.equal(groups[0].calls[0].summary.sources[0].url,'https://example.org/');
});


test('invalid selected server search blocks before requests and preserves one-shot permission',async()=>{
 const f=makeConversation({settings:{baseUrl:'https://unknown.test/v1',model:'unrecognized-model',webSearch:{provider:'server'}}});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 await f.conversation.setSearchEnabled(id,true);
 const result=await f.conversation.send(id,'question');
 assert.equal(result.status,'invalid');assert.equal(result.errors.searchServer,true);
 assert.equal(f.network.requests.length,0);assert.equal(f.conversation.searchEnabled(id),true);
 assert.equal(f.sessionStore.records.get(id).some(r=>r.kind==='turn/started'),false);
 assert.equal((await f.conversation.send(id,'without search',{webSearch:false})).status,'complete');
});

test('a rejected independent key returns its error to the model without switching services',async()=>{
 let modelCalls=0,searchCalls=0;
 const f=makeConversation({settings:{webSearch:{provider:'exa',secretId:'bad-key-ref'}},script:(url,options)=>{
  if(url==='https://api.exa.ai/search'){searchCalls++;return {status:401,text:'invalid API key'};}
  modelCalls++;return modelCalls===1?searchTurn():sseResponse(streamedTurn());
 }});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 const result=await f.conversation.send(id,'q',{webSearch:true});
 assert.equal(result.status,'complete');
 assert.equal(modelCalls,2);assert.equal(searchCalls,1);
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
  assert.equal(sessionStore.records.get(id).find(r => r.kind === 'turn/finished')?.payload.usageSamples.at(-1).usage.total_tokens, 10);
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
  assert.equal(sessionStore.records.get(id).find(r => r.kind === 'turn/finished')?.payload.usageSamples.at(-1).usage.total_tokens, 10);
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
  const process = visible.find(entry => entry.kind === 'process');
  assert.equal(process.steps.filter(step => step.kind === 'reasoning').map(step => step.text).join(''), result.reasoning);
  assert.deepEqual(process.steps.map(step => step.kind), ['reasoning', 'tool', 'reasoning']);
  assert.equal(visible.at(-1).text, 'Answer');
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
  assert.equal(visible.find(entry => entry.kind === 'process').steps.find(step => step.kind === 'reasoning').text, 'Need evidence.');
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

test('recovered retries and fresh questions adopt the current renderer and tool descriptions', async () => {
  const { renderTurn, buildInstructions, getFullFileTool, RENDERER_VERSION } = require('../src/quick-ask/prompt-renderer');
  for (const protocol of ['responses', 'chat-completions']) {
    for (const version of [1, 2, 3, 4, 5, 6, 7]) {
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
      assert.equal(started.payload.rendererVersion, RENDERER_VERSION);
      const native = require('../src/quick-ask/protocol').protocolFor({ protocol });
      const expected = renderTurn({ mutations: additions, question: 'retry me', rendererVersion: RENDERER_VERSION, userMessage: native.userMessage });
      const body = JSON.parse(network.requests.at(-1).options.body);
      const input = protocol === 'responses' ? body.input : body.messages.slice(1);
      assert.equal(protocol === 'responses' ? body.instructions : body.messages[0].content, buildInstructions({ rendererVersion: RENDERER_VERSION, customSystemPrompt: 'Saved custom role.' }));
      assert.deepEqual(body.tools[0], native.functionTool(getFullFileTool()));
      assert.deepEqual(input, expected);
      assert.deepEqual(conversation.snapshot(id).items.slice(0, 2), expected);
      await conversation.send(id, 'new question', { additions });
      assert.equal(sessionStore.records.get(id).filter(r => r.kind === 'turn/started').at(-1).payload.rendererVersion, RENDERER_VERSION);
      assert.match(network.requests.at(-1).options.body, /1 \| alpha/);
      const fresh = JSON.parse(network.requests.at(-1).options.body);
      assert.deepEqual(fresh.tools[0], native.functionTool(getFullFileTool()));
      assert.equal(protocol === 'responses' ? fresh.instructions : fresh.messages[0].content, buildInstructions({ rendererVersion: RENDERER_VERSION, customSystemPrompt: 'Saved custom role.' }));
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

for (const protocol of ['responses', 'chat-completions']) {
  test(`${protocol}: historical replay and retried Context never send internal selection offsets`, async () => {
    const { renderTurn, RENDERER_VERSION } = require('../src/quick-ask/prompt-renderer');
    const native = require('../src/quick-ask/protocol').protocolFor({ protocol });
    const f = makeConversation({ settings: { protocol },
      script: protocol === 'responses' ? () => sseResponse(streamedTurn()) : () => chatResponse() });
    const id = await newSession(f.sessionStore, f.conversation, f.settings);
    const source = '你好 hello world', from = source.indexOf('world');
    const additions = [{ kind: 'file', path: 'a.md', text: source },
      { kind: 'selection', path: 'a.md', from, to: source.length, text: 'world', startLine: 1, startColumn: from }];
    const old = renderTurn({ mutations: additions, question: 'old question', rendererVersion: 6, userMessage: native.userMessage });
    await f.sessionStore.append(id, 'turn/started', { turnId: 'old', question: 'old question', additions, rendererVersion: 6 });
    await f.sessionStore.append(id, 'item/input', { items: old });
    await f.sessionStore.append(id, 'turn/finished', { turnId: 'old', state: 'complete', text: 'old answer' });
    const saved = JSON.stringify(f.sessionStore.records.get(id));
    await f.conversation.recover(id);
    const price = f.conversation.snapshot(id).price;
    assert.equal(typeof price.total, 'number');
    const result = await f.conversation.send(id, 'retry question', { additions, rendererVersion: 6 });
    assert.equal(result.status, 'complete');
    const body = JSON.parse(f.network.requests.at(-1).options.body);
    assert.equal(JSON.stringify(body).includes('start_column'), false);
    assert.equal(JSON.stringify(body).includes('startColumn'), false);
    const input = body.input ?? body.messages.slice(1);
    const envelopes = input.filter(item => require('../src/quick-ask/protocol').messageText(item).startsWith('<quick_ask_context>'));
    assert.equal(envelopes.length, 2);
    for (const item of envelopes) assert.match(require('../src/quick-ask/protocol').messageText(item), /start_unit="4"/);
    assert.equal(JSON.stringify(f.sessionStore.records.get(id).slice(0, 3)), saved);
    const latest = f.sessionStore.records.get(id).filter(record => record.kind === 'turn/started').at(-1);
    assert.equal(latest.payload.rendererVersion, RENDERER_VERSION);
    assert.equal(latest.payload.additions[1].from, from, 'the internal offset still exists only in local records');
  });
}

test('old retry hints use current pricing and current numbering through a full-file tool continuation', async () => {
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
  assert.equal(newPrice.price.total, oldPrice.price.total, 'pricing uses the current renderer even for an old retry hint');
  const result = await conversation.send(id, 'q', { additions, rendererVersion: 1 });
  assert.equal(result.status, 'complete');
  const body = JSON.parse(environment.network.requests.at(-1).options.body);
  assert.equal(body.messages.find(m => m.role === 'tool').content, '1 | alpha\n2 | beta');
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
  const { buildInstructions, RENDERER_VERSION } = require('../src/quick-ask/prompt-renderer');
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
        buildInstructions({ rendererVersion: RENDERER_VERSION, customSystemPrompt: prompt }));
    }
    assert.equal(JSON.stringify(f.sessionStore.logs.get(oldId)[0]), originalHeader);
  }
});


for (const protocol of ['responses', 'chat-completions']) {
  test(`${protocol}: images are transient first-request inputs; logs/replay/compaction only retain paths`, async () => {
    let bytes = Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3]);
    const imageSource = { stat: async () => ({ size: bytes.length }), readBinary: async () => bytes };
    const script = protocol === 'responses' ? () => sseResponse(streamedTurn()) : () => chatResponse();
    const f = makeConversation({ settings: { protocol }, imageSource, script });
    const id = await newSession(f.sessionStore, f.conversation, { ...f.settings, protocol });
    assert.equal((await f.conversation.send(id, '', { images: ['papers/figure.png'] })).status, 'complete');
    const first = f.network.requests[0].options.body;
    assert.match(first, /data:image\/png;base64/);
    const wire = JSON.parse(first);
    const input = protocol === 'responses' ? wire.input : wire.messages;
    const user = input.find(item => item.role === 'user');
    assert.equal(user.content.length, 1);
    assert.equal(user.content[0].type, protocol === 'responses' ? 'input_image' : 'image_url');
    const records = f.sessionStore.records.get(id);
    assert.deepEqual(f.conversation.stateFor(id).turn.images, [], 'settled turns release transient image bytes');
    assert.equal(f.conversation.stateFor(id).occupancyAnchor, null, 'image-inclusive usage cannot anchor image-free next requests');
    assert.equal(JSON.stringify(records).includes('data:image'), false);
    assert.equal(JSON.stringify(records).includes('base64'), false);
    const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');
    assert.deepEqual(conversationFromRecords(records)[0], { role: 'user', text: '', images: ['papers/figure.png'] });
    await f.conversation.send(id, 'Follow up');
    assert.equal(f.network.requests.at(-1).options.body.includes('data:image'), false);
    await f.conversation.load(id);
    await f.conversation.send(id, 'After reload');
    assert.equal(f.network.requests.at(-1).options.body.includes('data:image'), false);
    bytes = Uint8Array.from([...bytes, 4]);
    await f.conversation.send(id, '', { images: ['papers/figure.png'] });
    assert.notEqual(f.network.requests.at(-1).options.body, first);
    assert.match(f.network.requests.at(-1).options.body, new RegExp(Buffer.from(bytes).toString('base64')));
    imageSource.stat = async () => null;
    const before = JSON.stringify(records), requests = f.network.requests.length;
    const missing = await f.conversation.send(id, '', { images: ['papers/figure.png'] });
    assert.equal(missing.error.code, 'IMAGE_MISSING');
    assert.equal(missing.accepted, false);
    assert.equal(f.network.requests.length, requests);
    assert.equal(JSON.stringify(records), before);
  });

  test(`${protocol}: tool continuation cannot resend the image`, async () => {
    const call = { type: 'function_call', id: 'fc', call_id: 'read', name: 'get-full-file', arguments: '{"path":"missing.md"}' };
    const toolResponse = protocol === 'responses' ? () => sseResponse([
      { type: 'response.created', data: { response: { id: 'with-tool' } } },
      { type: 'response.completed', data: { response: { id: 'with-tool', output: [call] } } },
    ]) : () => chatResponse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: call.name, arguments: call.arguments } }] });
    const bytes = Uint8Array.from([137,80,78,71,13,10,26,10,1]);
    const f = makeConversation({ settings: { protocol }, imageSource: { stat: async () => ({ size: bytes.length }), readBinary: async () => bytes },
      script: [toolResponse, protocol === 'responses' ? () => sseResponse(streamedTurn()) : () => chatResponse()] });
    const id = await newSession(f.sessionStore, f.conversation, { ...f.settings, protocol });
    assert.equal((await f.conversation.send(id, '', { images: ['figure.png'] })).status, 'complete');
    assert.match(f.network.requests[0].options.body, /data:image/);
    assert.equal(f.network.requests[1].options.body.includes('data:image'), false);
    assert.equal(JSON.stringify(f.sessionStore.records.get(id)).includes('data:image'), false);
  });
}

test('one input record and terminal usage preserve requests, history and totals after reload for both protocols', async () => {
  for (const protocol of ['responses', 'chat-completions']) {
    const f = makeConversation({ settings: { protocol }, script: protocol === 'chat-completions' ? () => chatResponse() : () => sseResponse(streamedTurn()) });
    const id = await newSession(f.sessionStore, f.conversation, f.settings);
    await f.conversation.send(id, 'Question', { additions: [{ kind: 'file', path: 'paper.md', text: 'CONTEXT_SENTINEL' }] });
    const records = f.sessionStore.records.get(id);
    const inputs = records.filter(r => r.kind === 'item/input');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].payload.items.length, 2);
    assert.equal(records.some(r => r.kind === 'turn/usage'), false);
    assert.ok(records.at(-1).payload.usageSamples.length > 0);
    const before = f.conversation.snapshot(id);
    f.conversation.forget(id); await f.conversation.load(id);
    const after = f.conversation.snapshot(id);
    assert.deepEqual(after.turnUsage, before.turnUsage);
    assert.equal(after.sessionUsage, before.sessionUsage);
    await f.conversation.send(id, 'Follow up', { additions: [] });
    const body = JSON.parse(f.network.requests.at(-1).options.body);
    const serialized = JSON.stringify(body.messages ?? body.input);
    assert.equal(serialized.split('CONTEXT_SENTINEL').length - 1, 1);
    assert.ok(serialized.includes('Question'));
    assert.ok(serialized.includes('Follow up'));
  }
});

test('legacy usage records and terminal sample arrays can coexist without double counting', async () => {
  const f = makeConversation();
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const sample = { source: 'terminal', attemptId: 'attempt-1', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  await f.sessionStore.append(id, 'turn/started', { turnId: 'old', question: 'Old' });
  await f.sessionStore.append(id, 'turn/usage', sample);
  await f.sessionStore.append(id, 'turn/finished', { turnId: 'old', state: 'complete' });
  await f.sessionStore.append(id, 'turn/started', { turnId: 'mixed', question: 'Mixed' });
  await f.sessionStore.append(id, 'turn/usage', sample);
  await f.sessionStore.append(id, 'turn/finished', { turnId: 'mixed', state: 'complete', usageSamples: [sample], occupancyAnchor: null });
  f.conversation.forget(id); await f.conversation.load(id);
  assert.equal(f.conversation.snapshot(id).sessionUsage, 24);
  assert.equal(f.conversation.snapshot(id).turnUsage.total, 12);
});

test('tool-attempt usage is retained once in the terminal record and replays with the final attempt anchor', async () => {
  const f = makeConversation({ settings: { protocol: 'chat-completions' }, script: [
    () => chatResponse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"a.md"}' } }] }),
    () => chatResponse(),
  ] });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  assert.equal((await f.conversation.send(id, 'Read')).status, 'complete');
  assert.equal(f.network.requests.length, 2);
  const records = f.sessionStore.records.get(id);
  assert.equal(records.some(r => r.kind === 'turn/usage'), false);
  assert.equal(new Set(records.at(-1).payload.usageSamples.map(s => s.attemptId)).size, 2);
  assert.equal(f.conversation.snapshot(id).sessionUsage, 50);
  f.conversation.forget(id); await f.conversation.load(id);
  assert.equal(f.conversation.snapshot(id).sessionUsage, 50);
  assert.equal(f.conversation.snapshot(id).turnUsage.attempts, 2);
});

const GOOGLE_VERTEX_BASE = 'https://aiplatform.googleapis.com/v1/projects/qa-fixture/locations/global/endpoints/openapi';
const SEARCH_CITATION = { type: 'url_citation', url_citation: { start_index: 5, end_index: 8, url: 'https://example.org/grounded', title: 'Grounded evidence' } };

test('Vertex native search sends only documented search options and keeps citations across replay and off toggles', async () => {
  const f = makeConversation({ settings: { protocol: 'chat-completions', baseUrl: GOOGLE_VERTEX_BASE, model: 'google/gemini-3-flash-preview', webSearch: { provider: 'server' } },
    script: (_url, options) => chatResponse(JSON.parse(options.body).web_search_options ? { role: 'assistant', content: 'Fact [1]', annotations: [SEARCH_CITATION] } : { role: 'assistant', content: 'Offline follow up' }),
  });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const result = await f.conversation.send(id, 'Ground this', { webSearch: true, additions: [{ kind: 'file', path: 'a.md', text: 'EXPLICIT_CONTEXT' }] });
  assert.equal(result.status, 'complete');
  const body = JSON.parse(f.network.requests[0].options.body);
  assert.equal(f.network.requests[0].url, GOOGLE_VERTEX_BASE + '/chat/completions');
  assert.deepEqual(body.web_search_options, {});
  assert.deepEqual(body.tools.map(tool=>tool.function.name), ['get-full-file','get-image']); assert.equal(body.tool_choice, 'auto'); assert.equal(body.parallel_tool_calls, true);
  assert.ok(JSON.stringify(body.messages).includes('EXPLICIT_CONTEXT'));
  assert.deepEqual(result.sources.map(s => s.url), ['https://example.org/grounded']);
  assert.ok(result.displayText.includes('](https://example.org/grounded)'));
  assert.equal(result.searchStatuses[0].provider, 'google');
  const records = f.sessionStore.records.get(id);
  assert.deepEqual(records.find(r => r.kind === 'item/output').payload.item.annotations, [SEARCH_CITATION]);
  f.conversation.forget(id); await f.conversation.load(id);
  const history = require('../src/quick-ask/conversation-messages').conversationFromRecords(records);
  assert.equal(history.find(m => m.role === 'assistant').displayText, result.displayText);
  assert.deepEqual(history.find(m => m.role === 'assistant').sources, result.sources);
  await f.conversation.send(id, 'No new search', { webSearch: false, additions: [] });
  const followup = JSON.parse(f.network.requests.at(-1).options.body);
  assert.equal(followup.web_search_options, undefined);
  assert.ok(followup.tools.every(tool => tool.function.name !== 'web_search'));
  assert.deepEqual(followup.messages.find(m => m.annotations)?.annotations, [SEARCH_CITATION]);
});

test('Vertex server search keeps local functions enabled and applies file permissions at execution', async () => {
  let attempt = 0;
  const f = makeConversation({ settings: { protocol: 'chat-completions', baseUrl: GOOGLE_VERTEX_BASE, model: 'google/gemini-3.1-pro-preview', webSearch: { provider: 'server' } },
    script: () => attempt++ === 0 ? chatResponse({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"unauthorized.md"}' } }] }) : chatResponse(),
  });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const result = await f.conversation.send(id, 'Question', { webSearch: true });
  assert.equal(result.status, 'complete');
  assert.equal(f.network.requests.length, 2);
  const records = f.sessionStore.records.get(id);
  assert.ok(records.some(r => r.kind === 'turn/tool-finished' && r.payload.status === 'failed'));
  assert.ok(records.filter(r => r.kind === 'item/output').some(r => r.payload.item.tool_call_id === 'read'));
});

test('DeepSeek Flash uses independent Search with the model key through both conversation protocols', async () => {
 for (const protocol of ['responses', 'chat-completions']) {
  let modelCalls=0;
  const f=makeConversation({settings:{protocol,baseUrl:'https://relay.example/deepseek/v1',model:'deepseek-flash',webSearch:{provider:'server'}},script:(url,options)=>{
   if(url.endsWith('/tools/search'))return {status:200,json:{results:[{url:'https://example.org/search-result',title:'Evidence',summary:'Public web fact'}]}};
   const first=modelCalls++===0;
   if(protocol==='chat-completions')return chatResponse(first?{role:'assistant',content:null,tool_calls:[{index:0,id:'search-call',type:'function',function:{name:'web_search',arguments:'{"query":"public query"}'}}]}:{role:'assistant',content:'Answer'});
   return sseResponse([
    {type:'response.created',data:{response:{id:'deepseek-fixture'}}},
    {type:'response.output_text.delta',data:{delta:first?'':'Answer'}},
    {type:'response.completed',data:{response:{id:'deepseek-fixture',output:first?[{type:'function_call',call_id:'search-call',name:'web_search',arguments:'{"query":"public query"}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Answer'}]}],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}}},
   ]);
  }});
  const id=await newSession(f.sessionStore,f.conversation,f.settings);
  const result=await f.conversation.send(id,'Find public facts',{webSearch:true});
  assert.equal(result.status,'complete');assert.deepEqual(result.sources.map(source=>source.url),['https://example.org/search-result']);
  const search=f.network.requests.find(request=>request.url.endsWith('/tools/search'));
  assert.equal(search.url,'https://relay.example/deepseek/v1/tools/search');
  assert.equal(search.options.headers.Authorization,'Bearer sk-test');
  assert.deepEqual(JSON.parse(search.options.body),{query:'public query',count:5,need_content:false});
  const model=f.network.requests.filter(request=>!request.url.endsWith('/tools/search'));
  assert.equal(model.length,2);
  const body=JSON.parse(model[0].options.body);
  const tool=body.tools.find(tool=>(tool.function?.name??tool.name)==='web_search');
  assert.equal((tool.function??tool).parameters.properties.query.maxLength,128);
  assert.equal(body.tools.some(tool=>tool.type==='web_search'),false);
  await f.conversation.send(id,'No new search',{webSearch:false,additions:[]});
  const off=JSON.parse(f.network.requests.at(-1).options.body);
  assert.equal(off.tools.some(tool=>(tool.function?.name??tool.name)==='web_search'),false);
 }
});

test('unsupported server capabilities fail before accepting the draft or making any request', async () => {
  for (const settings of [
    { baseUrl: 'https://relay.example/v1', model: 'renamed-unknown-model' },
    { baseUrl: 'https://relay.example/v1', model: 'gpt-5', protocol: 'chat-completions' },
    { baseUrl: GOOGLE_VERTEX_BASE, model: 'unknown-family', protocol: 'responses' },
  ]) {
    const f = makeConversation({ settings: { ...settings, webSearch: { provider: 'server' } } });
    const id = await newSession(f.sessionStore, f.conversation, f.settings);
    const result = await f.conversation.send(id, 'Keep draft', { webSearch: true });
    assert.equal(result.status, 'invalid'); assert.equal(result.errors.searchServer, true);
    assert.equal(f.network.requests.length, 0); assert.equal(f.sessionStore.records.get(id).length, 0);
  }
});

test('native server search authentication errors never switch endpoints or providers', async () => {
  for (const config of [
    { baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
    { baseUrl: GOOGLE_VERTEX_BASE, model: 'google/gemini-3-flash-preview', protocol: 'chat-completions' },
  ]) {
    const f = makeConversation({ settings: { ...config, webSearch: { provider: 'server' } }, script: () => ({ status: 401, ok: false, text: async () => JSON.stringify({ error: { message: 'Expired token', code: 'invalid_api_key' } }) }) });
    const id = await newSession(f.sessionStore, f.conversation, f.settings);
    const result = await f.conversation.send(id, 'Question', { webSearch: true });
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'AUTH');
    assert.equal(f.network.requests.length, 1);
    assert.ok(f.network.requests.every(request => request.url.startsWith(config.baseUrl)));
  }
});

test('Google local summary generation never inherits the active native search permission', async () => {
  const f = makeConversation({ settings: { protocol: 'chat-completions', baseUrl: GOOGLE_VERTEX_BASE, model: 'google/gemini-3-flash-preview', webSearch: { provider: 'server' } },
    script: (_url, options) => chatResponse({ role: 'assistant', content: JSON.parse(options.body).web_search_options ? 'Answer' : '## Goal\nKeep the facts.' }),
  });
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  await f.conversation.send(id, 'Old question '.repeat(600), { webSearch: true });
  await f.conversation.send(id, 'Newest question', { webSearch: true });
  const compacted = await f.conversation.compactNow(id);
  assert.equal(compacted.status, 'committed');
  assert.equal(f.network.requests.length, 3);
  const summary = JSON.parse(f.network.requests.at(-1).options.body);
  assert.equal(summary.web_search_options, undefined);
  assert.equal(summary.tool_choice, 'none');
  assert.ok(summary.tools.every(tool => tool.function.name !== 'web_search'));
});

const GEMINI_STUDIO_BASE = 'https://relay.example/gemini/v1beta/openai';
const GOOGLE_SUGGESTIONS = '<div>Google Search suggestions</div>';
function nativeGeminiResponse() {
 return {candidates:[{content:{role:'model',parts:[{text:'中文🌏事实',thoughtSignature:'native-signature'}]},finishReason:'STOP',groundingMetadata:{webSearchQueries:['公开信息'],groundingChunks:[{web:{uri:'https://example.org/google-evidence',title:'Google evidence'}}],groundingSupports:[{segment:{partIndex:0,startIndex:0,endIndex:10,text:'中文🌏'},groundingChunkIndices:[0]}],searchEntryPoint:{renderedContent:GOOGLE_SUGGESTIONS}}}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:5,totalTokenCount:25}};
}

test('ordinary Gemini API keys use native search on relay URLs and preserve grounding through replay and off', async()=>{
 for(const model of ['gemini-2.5-flash','gemini-2.5-pro','gemini-3.8-flash','google/gemini-4-argon']){
  const f=makeConversation({settings:{protocol:'chat-completions',baseUrl:GEMINI_STUDIO_BASE,model,webSearch:{provider:'server'}},script:(url,options)=> url.endsWith(':generateContent')?{status:200,json:nativeGeminiResponse()}:chatResponse({role:'assistant',content:'No new search'})});
  const id=await newSession(f.sessionStore,f.conversation,f.settings);
  const result=await f.conversation.send(id,'Search',{webSearch:true,additions:[{kind:'file',path:'a.md',text:'EXPLICIT_NATIVE_CONTEXT'}]});
  assert.equal(result.status,'complete');
  assert.deepEqual(result.sources.map(s=>s.url),['https://example.org/google-evidence']);
  assert.deepEqual(result.searchSuggestions,[GOOGLE_SUGGESTIONS]);
  assert.equal(result.displayText,'中文🌏[1](https://example.org/google-evidence)事实');
  const first=f.network.requests[0];
  assert.equal(first.url,GEMINI_STUDIO_BASE.replace('/openai','')+'/models/'+model.replace('google/','')+':generateContent');
  assert.equal(first.options.headers['x-goog-api-key'],'sk-test');assert.equal(first.options.headers.Authorization,undefined);
  const body=JSON.parse(first.options.body);
  assert.deepEqual(body.tools.find(tool=>tool.functionDeclarations).functionDeclarations.map(tool=>tool.name),['get-full-file','get-image']);assert.ok(body.tools.some(tool=>tool.google_search));assert.equal(body.model,undefined);assert.equal(body.stream,undefined);
  assert.ok(JSON.stringify(body.contents).includes('EXPLICIT_NATIVE_CONTEXT'));
  const records=f.sessionStore.records.get(id);
  f.conversation.forget(id);await f.conversation.load(id);
  const history=require('../src/quick-ask/conversation-messages').conversationFromRecords(records);
  assert.deepEqual(history.find(m=>m.role==='assistant').searchSuggestions,[GOOGLE_SUGGESTIONS]);
  await f.conversation.send(id,'Search again',{webSearch:true,additions:[]});
  assert.ok(JSON.stringify(JSON.parse(f.network.requests.at(-1).options.body).contents).includes('native-signature'));
  await f.conversation.send(id,'Offline next',{webSearch:false,additions:[]});
  const off=f.network.requests.at(-1);
  assert.equal(off.url,GEMINI_STUDIO_BASE+'/chat/completions');
  assert.equal(off.nonStreaming,undefined,'native nonstreaming does not disable later Chat streaming');
  const chat=JSON.parse(off.options.body);
  assert.equal(chat.web_search_options,undefined);assert.ok(chat.messages.some(m=>m.content==='中文🌏事实'));
  assert.equal(chat.messages.some(m=>m.extra_content?.google?.nativeContent),false);
 }
});

test('cancelling native Gemini search passes the abort signal and creates no followup requests',async()=>{
 const f=makeConversation({settings:{protocol:'chat-completions',baseUrl:GEMINI_STUDIO_BASE,model:'gemini-2.5-flash',webSearch:{provider:'server'}},script:(_url,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true}))});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 const controller=new AbortController();
 const pending=f.conversation.send(id,'Search',{webSearch:true,signal:controller.signal});
 for(let i=0;i<50&&!f.network.requests.length;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.network.requests.length,1);controller.abort();
 assert.equal((await pending).status,'stopped');assert.equal(f.network.requests.length,1);
});

test('CPA Gemini hosted search sends the proven Responses shape and replays opaque provider state without new search',async()=>{
 // Shape taken from the successful CPA response; no local files or live carrier tokens.
 const successful={id:'cpa-fixture',status:'completed',model:'gemini-3-flash',output:[
  {id:'search',type:'web_search_call',status:'completed',action:{type:'search',query:'public fact',queries:['public fact'],sources:[{type:'url',url:'https://example.org/cpa-source'}]}},
  {id:'carrier',type:'reasoning',encrypted_content:'cpa-gemini-responses-carrier-v1:fixture-only',summary:[]},
  {id:'message',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'Fact [1]',annotations:[{type:'url_citation',url:'https://example.org/cpa-source',title:'Evidence',start_index:5,end_index:8}]}]},
 ],usage:{input_tokens:10,output_tokens:2,total_tokens:12}};
 const f=makeConversation({settings:{protocol:'responses',baseUrl:'http://127.0.0.1:8317/v1',model:'gemini-3-flash',webSearch:{provider:'server'}},script:(_url,options)=>{
  const body=JSON.parse(options.body);
  const response=body.tools.some(t=>t.type==='web_search')?successful:{id:'followup',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Followup without search'}]}],usage:{input_tokens:5,output_tokens:2,total_tokens:7}};
  return sseResponse([{type:'response.created',data:{response:{id:response.id}}},{type:'response.output_text.delta',data:{delta:response.output.filter(item=>item.type==='message').flatMap(item=>item.content??[]).map(part=>part.text??'').join('')}},{type:'response.completed',data:{response}}]);
 }});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 const result=await f.conversation.send(id,'Search public facts',{webSearch:true,additions:[{kind:'file',path:'fixture.md',text:'USER_CONTEXT_SENTINEL'}]});
 assert.equal(result.status,'complete');assert.ok(result.text);assert.ok(result.sources.length);
 const sent=f.network.requests[0];const body=JSON.parse(sent.options.body);
 assert.equal(sent.url,'http://127.0.0.1:8317/v1/responses');assert.deepEqual(body.tools.map(tool=>tool.name??tool.type),['get-full-file','get-image','web_search']);assert.equal(body.tool_choice,'auto');
 assert.ok(JSON.stringify(body.input).includes('USER_CONTEXT_SENTINEL'));
 const canonical=f.sessionStore.records.get(id).filter(r=>r.kind==='item/output').map(r=>r.payload.item);
 assert.deepEqual(canonical,successful.output);
 f.conversation.forget(id);await f.conversation.load(id);
 await f.conversation.send(id,'Repeat that fact without searching',{webSearch:false,additions:[]});
 const followup=JSON.parse(f.network.requests.at(-1).options.body);
 assert.equal(followup.tools.some(t=>t.type==='web_search'),false);assert.equal(followup.tool_choice,'auto');
 assert.ok(followup.input.some(item=>item.type==='reasoning'&&item.encrypted_content===successful.output.find(i=>i.type==='reasoning').encrypted_content));
});

test('CPA Gemini CC searches without changing protocol and does not fabricate structured search evidence',async()=>{
 const f=makeConversation({settings:{protocol:'chat-completions',baseUrl:'http://127.0.0.1:8317/v1',model:'gemini-3-flash',webSearch:{provider:'server'}},script:()=>chatResponse({role:'assistant',content:'Answer with [source](https://example.org/)'} )});
 const id=await newSession(f.sessionStore,f.conversation,f.settings);
 const result=await f.conversation.send(id,'Question',{webSearch:true,additions:[{kind:'file',path:'a.md',text:'EXPLICIT_CPA_CC_CONTEXT'}]});
 assert.equal(result.status,'complete');assert.equal(f.network.requests.length,1);
 const request=f.network.requests[0],body=JSON.parse(request.options.body);
 assert.equal(request.url,'http://127.0.0.1:8317/v1/chat/completions');assert.deepEqual(body.tools.map(tool=>tool.function?.name??(tool.google_search?'google_search':'')),['get-full-file','get-image','google_search']);
 assert.equal(body.web_search_options,undefined);assert.equal(body.tool_choice,'auto');assert.equal(body.parallel_tool_calls,true);
 assert.ok(JSON.stringify(body.messages).includes('EXPLICIT_CPA_CC_CONTEXT'));
 assert.deepEqual(result.sources,[]);assert.deepEqual(result.searchStatuses,[]);
 f.conversation.forget(id);await f.conversation.load(id);
 await f.conversation.send(id,'No new search',{webSearch:false,additions:[]});
 const off=JSON.parse(f.network.requests.at(-1).options.body);
 assert.ok(off.tools.some(tool=>tool.function?.name==='get-full-file'));assert.equal(off.tools.some(tool=>tool.google_search),false);
 assert.ok(off.messages.some(message=>message.content.includes('Answer with')));
});

for (const protocol of ['responses', 'chat-completions']) test(`${protocol}: ordered process survives reload without entering canonical items, permissions or model requests`, async () => {
  const reasoning = ['First thought.', 'Second thought.', 'Final thought.'];
  let attempt = 0;
  const f = makeConversation({ settings: { protocol }, files: { 'a.md': 'alpha' }, script: () => {
    const round = attempt++;
    const calls = round < 2 ? [{ type: 'function_call', id: `fc-${round}`, call_id: `call-${round}`, name: 'get-full-file', arguments: '{"path":"a.md"}' }] : [];
    if (protocol === 'chat-completions') return chatResponse({ role: 'assistant', content: round < 2 ? null : 'Final answer',
      reasoning_content: reasoning[round] ?? 'Next thought',
      ...(calls.length ? { tool_calls: calls.map(call => ({ index: 0, id: call.call_id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) });
    return sseResponse([
      { type: 'response.created', data: { response: { id: `r-${round}` } } },
      { type: 'response.reasoning_text.delta', data: { delta: reasoning[round] ?? 'Next thought' } },
      ...(round < 2 ? [] : [{ type: 'response.output_text.delta', data: { delta: 'Final answer' } }]),
      { type: 'response.completed', data: { response: { id: `r-${round}`, output: [
        { type: 'reasoning', id: `rs-${round}`, summary: [{ type: 'summary_text', text: reasoning[round] ?? 'Next thought' }] }, ...calls,
        ...(round < 2 ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final answer' }] }]),
      ] } } },
    ]);
  } });
  f.tracker.allowlist = () => ['a.md'];
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const result = await f.conversation.send(id, 'Read twice');
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.process.map(step => step.kind), ['reasoning', 'tool', 'reasoning', 'tool', 'reasoning', 'text']);
  const records = f.sessionStore.records.get(id), canonical = JSON.stringify(f.conversation.stateFor(id).items);
  assert.ok(records.filter(record => record.kind === 'turn/process').length < 10);
  const messages = require('../src/quick-ask/conversation-messages').conversationFromRecords(records);
  const process = messages.find(entry => entry.kind === 'process');
  assert.deepEqual(process.steps.map(step => step.kind), ['reasoning', 'tool', 'reasoning', 'tool', 'reasoning']);
  assert.deepEqual(process.steps.filter(step => step.kind === 'reasoning').map(step => step.text), reasoning);
  assert.ok(process.steps.filter(step => step.kind === 'tool').every(step => step.call.status === 'complete'));
  assert.equal(messages.at(-1).text, 'Final answer');
  f.conversation.forget(id); await f.conversation.load(id);
  assert.equal(JSON.stringify(f.conversation.stateFor(id).items), canonical);
  assert.deepEqual(f.conversation.snapshot(id).process, result.process);
  // Older readers ignore optional records. Simulate that interpretation and
  // verify the same canonical history is still produced by the real loader.
  f.sessionStore.records.set(id, records.filter(record => record.kind !== 'turn/process'));
  f.conversation.forget(id); await f.conversation.load(id);
  assert.equal(JSON.stringify(f.conversation.stateFor(id).items), canonical);
  f.sessionStore.records.set(id, records);
  f.conversation.forget(id); await f.conversation.load(id);
  await f.conversation.send(id, 'Next');
  const request = JSON.parse(f.network.requests.at(-1).options.body);
  assert.equal(JSON.stringify(request).includes('step-0'), false);
  assert.equal(JSON.stringify(request).includes('processVersion'), false);
  assert.equal(JSON.stringify(request).includes('groupId'), false);
});

test('failed optional process writes retain canonical response and reasoning fallback', async () => {
  const f = makeConversation({ script: () => sseResponse([
    { type: 'response.created', data: { response: { id: 'r' } } },
    { type: 'response.reasoning_text.delta', data: { delta: 'Readable reasoning' } },
    { type: 'response.output_text.delta', data: { delta: 'Answer' } },
    { type: 'response.completed', data: { response: { id: 'r' } } },
  ]) });
  const append = f.sessionStore.append.bind(f.sessionStore);
  f.sessionStore.append = async (id, kind, payload) => {
    if (kind === 'turn/process') throw new Error('disk failure');
    return append(id, kind, payload);
  };
  const id = await newSession(f.sessionStore, f.conversation, f.settings);
  const result = await f.conversation.send(id, 'Q');
  assert.equal(result.status, 'complete');
  const messages = require('../src/quick-ask/conversation-messages').conversationFromRecords(f.sessionStore.records.get(id));
  assert.equal(messages.find(entry => entry.kind === 'process').steps[0].text, 'Readable reasoning');
  assert.equal(messages.at(-1).text, 'Answer');
});

for (const protocol of ['responses','chat-completions']) test(`${protocol}: Gemini hosted search keeps both read tools and permits a mixed parallel batch with path-level rejection`, async () => {
  let attempt=0;
  const calls=[{callId:'read',name:'get-full-file',arguments:'{"path":"allowed.md"}'},
    {callId:'image',name:'get-image',arguments:'{"path":"forbidden.png","sourcePath":null}'}];
  const f=makeConversation({settings:{protocol,model:'gemini-3.8-flash-high',baseUrl:'http://127.0.0.1:8317/v1',webSearch:{provider:'server'}},files:{'allowed.md':'CURRENT_AUTHORIZED_TEXT'},script:()=>{
    const first=attempt++===0;
    if(protocol==='chat-completions') return chatResponse(first?{role:'assistant',content:null,tool_calls:calls.map((call,index)=>({index,id:call.callId,type:'function',function:{name:call.name,arguments:call.arguments}}))}:{role:'assistant',content:'Finished after tool results'});
    return sseResponse([{type:'response.created',data:{response:{id:`r-${attempt}`}}},
      ...(!first?[{type:'response.output_text.delta',data:{delta:'Finished after tool results'}}]:[]),
      {type:'response.completed',data:{response:{id:`r-${attempt}`,output:first?calls.map(call=>({type:'function_call',id:call.callId,call_id:call.callId,name:call.name,arguments:call.arguments})):[{type:'message',role:'assistant',content:[{type:'output_text',text:'Finished after tool results'}]}]}}}]);
  }});
  f.tracker.allowlist=()=>['allowed.md'];
  const id=await newSession(f.sessionStore,f.conversation,f.settings);
  const result=await f.conversation.send(id,'Read and search',{webSearch:true});
  assert.equal(result.status,'complete');assert.equal(attempt,2);
  for(const request of f.network.requests){
    const body=JSON.parse(request.options.body),names=body.tools.map(tool=>tool.function?.name??tool.name??tool.type??'google_search');
    assert.ok(names.includes('get-full-file'));assert.ok(names.includes('get-image'));
    assert.ok(body.tools.some(tool=>tool.type==='web_search'||tool.google_search));
    assert.equal(body.tool_choice,'auto');
  }
  const records=f.sessionStore.records.get(id),finished=records.filter(record=>record.kind==='turn/tool-finished');
  assert.deepEqual(finished.map(record=>record.payload.name).sort(),['get-full-file','get-image']);
  assert.equal(finished.find(record=>record.payload.name==='get-full-file').payload.status,'complete');
  assert.equal(finished.find(record=>record.payload.name==='get-image').payload.status,'failed');
  f.conversation.forget(id);await f.conversation.load(id);
  const before=JSON.stringify(f.conversation.snapshot(id).items);
  await f.conversation.send(id,'Read without search',{webSearch:false});
  const off=JSON.parse(f.network.requests.at(-1).options.body);
  assert.equal(off.tools.some(tool=>tool.type==='web_search'||tool.google_search),false);
  assert.equal(off.tools.length,2);
  assert.ok(before.includes('CURRENT_AUTHORIZED_TEXT'));
});

test('native Gemini Google search continues local functions, replays signed results, and keeps file permissions', async () => {
  let attempt=0;
  const nativeCall={role:'model',parts:[{functionCall:{id:'native-read',name:'get-full-file',args:{path:'allowed.md'}},thoughtSignature:'preserve-me'}]};
  const f=makeConversation({settings:{protocol:'chat-completions',baseUrl:GEMINI_STUDIO_BASE,model:'gemini-3.8-flash',webSearch:{provider:'server'}},files:{'allowed.md':'NATIVE_FILE_CONTENT'},script:()=>({status:200,json:{responseId:`native-${attempt}`,candidates:[{content:attempt++===0?nativeCall:{role:'model',parts:[{text:'Read finished'}]},finishReason:'STOP'}]}})});
  f.tracker.allowlist=()=>['allowed.md'];
  const id=await newSession(f.sessionStore,f.conversation,f.settings);
  const result=await f.conversation.send(id,'Search and read',{webSearch:true});
  assert.equal(result.status,'complete');assert.equal(attempt,2);
  for(const request of f.network.requests){
    const body=JSON.parse(request.options.body);
    assert.ok(body.tools.some(tool=>tool.google_search));
    assert.deepEqual(body.tools.find(tool=>tool.functionDeclarations).functionDeclarations.map(tool=>tool.name),['get-full-file','get-image']);
    assert.equal(body.toolConfig.includeServerSideToolInvocations,true);
  }
  const next=JSON.parse(f.network.requests[1].options.body);
  assert.ok(next.contents.some(content=>JSON.stringify(content)===JSON.stringify(nativeCall)));
  const returned=next.contents.find(content=>content.parts.some(part=>part.functionResponse));
  assert.equal(returned.role,'user');assert.equal(returned.parts[0].functionResponse.id,'native-read');
  assert.ok(returned.parts[0].functionResponse.response.output.includes('NATIVE_FILE_CONTENT'));
  f.conversation.forget(id);await f.conversation.load(id);
  await f.conversation.send(id,'Continue search',{webSearch:true});
  assert.ok(f.network.requests.at(-1).options.body.includes('preserve-me'));
});

function independentSearchFixture(protocol, script) {
  const f=makeConversation({settings:{protocol,model:'gemini-3.8-flash',systemPrompt:'PRIVATE_ROLE_SENTINEL',webSearch:{provider:'server'}},script});
  f.settings.providerProfiles=[{id:'search-profile',name:'Search connection',baseUrl:f.settings.baseUrl,secretId:f.settings.secretId,
    models:[{id:f.settings.model,protocol}],selectedModelId:f.settings.model,searchMode:'independent'}];
  f.settings.activeProviderProfileId='search-profile';
  return f;
}
function publicSearchCall(protocol) {
  return protocol==='chat-completions' ? chatResponse({role:'assistant',content:null,tool_calls:[{index:0,id:'search-one',type:'function',function:{name:'web_search',arguments:'{"query":"public query"}'}}]})
    : sseResponse([{type:'response.created',data:{response:{id:'main-search'}}},
      {type:'response.completed',data:{response:{id:'main-search',output:[{type:'function_call',id:'search-one',call_id:'search-one',name:'web_search',arguments:'{"query":"public query"}'}],usage:{input_tokens:100,output_tokens:3,total_tokens:103}}}}]);
}
function publicSearchResult(protocol) {
  return protocol==='chat-completions' ? chatResponse({role:'assistant',content:'Public search summary',annotations:[SEARCH_CITATION]})
    : sseResponse([{type:'response.created',data:{response:{id:'child-search'}}},
      {type:'response.output_text.delta',data:{delta:'Public search summary'}},
      {type:'response.completed',data:{response:{id:'child-search',output:[{type:'web_search_call',id:'hosted',status:'completed',action:{query:'public query',sources:[{url:'https://example.org/grounded',title:'Evidence'}]}},
        {type:'message',role:'assistant',content:[{type:'output_text',text:'Public search summary'}]}],usage:{input_tokens:5,output_tokens:6,total_tokens:11}}}}]);
}
for(const protocol of ['responses','chat-completions']) test(`${protocol}: manual independent search isolates the query, resumes main tools, accounts usage and replays without network`,async()=>{
  const final=()=>protocol==='responses'?sseResponse(streamedTurn({text:'Final synthesis'})):chatResponse({role:'assistant',content:'Final synthesis'});
  const f=independentSearchFixture(protocol,[()=>publicSearchCall(protocol),()=>publicSearchResult(protocol),final,final]);
  const config=require('../src/quick-ask/settings').sessionConfigSnapshot(f.settings);
  const id=await newSession(f.sessionStore,f.conversation,config);
  let searchAnchor;
  const append=f.sessionStore.append.bind(f.sessionStore);
  f.sessionStore.append=async(id,kind,payload)=>{
    if(kind==='turn/usage'&&payload.scope==='search')searchAnchor=f.conversation.stateFor(id).occupancyAnchor;
    return append(id,kind,payload);
  };
  const result=await f.conversation.send(id,'Find public facts',{webSearch:true,additions:[{kind:'file',path:'private.md',text:'PRIVATE_NOTE_SENTINEL'}]});
  assert.equal(result.status,'complete');assert.equal(f.network.requests.length,3);
  const [first,child,last]=f.network.requests.map(request=>JSON.parse(request.options.body));
  assert.deepEqual(first.tools.map(tool=>tool.function?.name??tool.name),['get-full-file','get-image','web_search']);
  assert.equal(first.tools.some(tool=>tool.type==='web_search'||tool.google_search),false);
  assert.equal(JSON.stringify(first).includes('PRIVATE_NOTE_SENTINEL'),true);
  assert.equal(JSON.stringify(child).includes('PRIVATE_NOTE_SENTINEL'),false);assert.equal(JSON.stringify(child).includes('PRIVATE_ROLE_SENTINEL'),false);
  if (protocol==='responses') {
    assert.equal(child.instructions,undefined);
    assert.deepEqual(child.input,[{type:'message',role:'user',content:[{type:'input_text',text:'public query'}]}]);
  } else assert.deepEqual(child.messages,[{role:'user',content:'public query'}]);
  assert.equal(JSON.stringify(child).includes('get-full-file'),false);assert.equal(JSON.stringify(child).includes('get-image'),false);
  assert.equal(child.previous_response_id,undefined);assert.equal(child.store,protocol==='responses'?false:undefined);
  assert.ok(child.tools.some(tool=>tool.type==='web_search'||tool.google_search));
  assert.ok(JSON.stringify(last).includes('Public search summary'));
  assert.equal(searchAnchor,null,'search-only input must not anchor main context occupancy');
  const records=f.sessionStore.records.get(id);
  assert.equal(records.find(record=>record.kind==='turn/started').payload.searchExecution,'independent');
  assert.equal(records.filter(record=>record.kind==='turn/tool-finished').length,1);
  assert.equal(records.find(record=>record.kind==='turn/tool-finished').payload.status,'complete');
  assert.equal(f.conversation.snapshot(id).turnUsage.attempts,3);
  assert.equal(f.conversation.snapshot(id).turnUsage.input,protocol==='responses'?115:60);
  assert.equal(result.sources[0].url,'https://example.org/grounded');
  const usage=f.conversation.snapshot(id).turnUsage,anchor={...f.conversation.stateFor(id).occupancyAnchor};
  f.conversation.forget(id);await f.conversation.load(id);
  assert.deepEqual(f.conversation.snapshot(id).turnUsage,usage);assert.deepEqual(f.conversation.stateFor(id).occupancyAnchor,anchor);
  assert.equal(f.network.requests.length,3);
  await f.conversation.send(id,'Without search',{webSearch:false});
  const off=JSON.parse(f.network.requests.at(-1).options.body);
  assert.equal(off.tools.length,2);assert.equal(f.network.requests.length,4);
});

test('mixed search errors carry a short manual-switch hint without probing, retrying or changing mode',async()=>{
  const f=independentSearchFixture('responses',[()=>({ok:false,status:400,headers:{get:()=>null},text:async()=>JSON.stringify({error:{message:'Tool use with function calling is unsupported'}})})]);
  f.settings.providerProfiles[0].searchMode='mixed';
  const config=require('../src/quick-ask/settings').sessionConfigSnapshot(f.settings),id=await newSession(f.sessionStore,f.conversation,config);
  const result=await f.conversation.send(id,'Search',{webSearch:true});
  assert.equal(result.status,'failed');assert.equal(result.error.hint,'search.switchIndependent');
  assert.equal(f.projections.find(projection=>projection.kind==='turn'&&projection.status==='failed').error.hint,'search.switchIndependent');
  assert.equal(f.network.requests.length,1);assert.equal(f.settings.providerProfiles[0].searchMode,'mixed');
  const finished=f.sessionStore.records.get(id).find(record=>record.kind==='turn/finished');
  assert.equal(finished.payload.error.hint,'search.switchIndependent');
  f.settings.providerProfiles[0].searchMode='independent';
  assert.equal(f.conversation.validateSearchForSend(id,true).route.kind,'provider-search','manual change applies to the same existing session');
});

test('independent provider search authentication failure returns one tool error and lets the main model continue',async()=>{
  const f=independentSearchFixture('responses',[()=>publicSearchCall('responses'),
    ()=>({ok:false,status:401,headers:{get:()=>null},text:async()=>JSON.stringify({error:{message:'Unauthorized'}})}),
    ()=>sseResponse(streamedTurn({text:'Search failed; retained local answer'}))]);
  const id=await newSession(f.sessionStore,f.conversation,require('../src/quick-ask/settings').sessionConfigSnapshot(f.settings));
  const result=await f.conversation.send(id,'Search',{webSearch:true});
  assert.equal(result.status,'complete');assert.equal(f.network.requests.length,3);
  const body=JSON.parse(f.network.requests.at(-1).options.body);
  assert.ok(JSON.stringify(body).includes('AUTH'));
  assert.equal(result.searchStatuses[0].status,'failed');
  assert.equal(f.settings.providerProfiles[0].searchMode,'independent');
});

test('cancelling an independent provider search cancels its tool and never starts a main continuation',async()=>{
  const controller=new AbortController();
  const f=independentSearchFixture('responses',[()=>publicSearchCall('responses'),()=>{controller.abort();throw {name:'AbortError'};}]);
  const id=await newSession(f.sessionStore,f.conversation,require('../src/quick-ask/settings').sessionConfigSnapshot(f.settings));
  const result=await f.conversation.send(id,'Search',{webSearch:true,signal:controller.signal});
  assert.equal(result.status,'stopped');assert.equal(f.network.requests.length,2);
  assert.equal(f.sessionStore.records.get(id).find(record=>record.kind==='turn/tool-finished').payload.status,'cancelled');
});

test('manual mode changes apply to the next question without changing an in-flight tool continuation',async()=>{
  const f=independentSearchFixture('responses',[()=>publicSearchCall('responses'),()=>{
    f.settings.providerProfiles[0].searchMode='mixed';
    return publicSearchResult('responses');
  },()=>sseResponse(streamedTurn()),()=>publicSearchResult('responses')]);
  const id=await newSession(f.sessionStore,f.conversation,require('../src/quick-ask/settings').sessionConfigSnapshot(f.settings));
  assert.equal((await f.conversation.send(id,'Search',{webSearch:true})).status,'complete');
  const continuation=JSON.parse(f.network.requests[2].options.body);
  assert.equal(continuation.tools.some(tool=>tool.type==='web_search'),false);
  assert.ok(continuation.tools.some(tool=>tool.name==='web_search'));
  assert.equal((await f.conversation.send(id,'Next search',{webSearch:true})).status,'complete');
  const next=JSON.parse(f.network.requests[3].options.body);
  assert.ok(next.tools.some(tool=>tool.type==='web_search'));
});

test('independent mode keeps main Chat protocol while the search child uses the configured native Gemini endpoint',async()=>{
  const f=independentSearchFixture('chat-completions',[()=>publicSearchCall('chat-completions'),
    ()=>({status:200,json:nativeGeminiResponse()}),()=>chatResponse({role:'assistant',content:'Final native-search synthesis'})]);
  f.settings.baseUrl=GEMINI_STUDIO_BASE;f.settings.providerProfiles[0].baseUrl=GEMINI_STUDIO_BASE;
  const id=await newSession(f.sessionStore,f.conversation,require('../src/quick-ask/settings').sessionConfigSnapshot(f.settings));
  const result=await f.conversation.send(id,'Search',{webSearch:true});
  assert.equal(result.status,'complete');assert.equal(f.network.requests.length,3);
  assert.ok(f.network.requests[0].url.endsWith('/chat/completions'));
  assert.ok(f.network.requests[1].url.endsWith('/models/gemini-3.8-flash:generateContent'));
  assert.ok(f.network.requests[2].url.endsWith('/chat/completions'));
  const body=JSON.parse(f.network.requests[1].options.body);
  assert.deepEqual(body.tools,[{google_search:{}}]);
  assert.deepEqual(body.contents,[{role:'user',parts:[{text:'public query'}]}]);
  assert.equal(body.systemInstruction,undefined);
  assert.equal(result.sources[0].url,'https://example.org/google-evidence');
  assert.equal(f.conversation.snapshot(id).turnUsage.attempts,3);
});

for(const defaultEnabled of [false,true]) test(`search state before loading an old session is safe with web default ${defaultEnabled}`,async()=>{
  const f=independentSearchFixture('responses',[]);
  f.settings.webSearch.defaultEnabled=defaultEnabled;
  const {id}=await f.sessionStore.createSession({config:{protocol:'responses',baseUrl:f.settings.baseUrl,model:f.settings.model,secretId:f.settings.secretId}});
  assert.equal(f.conversation.stateFor(id).config,null);
  assert.doesNotThrow(()=>f.conversation.nextSearchRoute(id),'the view reads the route before parsing a session header');
  assert.doesNotThrow(()=>f.conversation.validateSearchForSend(id,defaultEnabled));
  assert.equal(f.conversation.stateFor(id).config,null);
  assert.equal(f.network.requests.length,0);
  await f.conversation.load(id);
  assert.equal(f.conversation.nextSearchRoute(id).kind,defaultEnabled?'provider-search':'off');
  assert.deepEqual(await f.conversation.recover(id),{status:'clean'});
  assert.equal(f.network.requests.length,0);
});
