// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuickAskSessionStore, parseLog, isSupportedSession } = require('../src/quick-ask/sessions');
const { createConversation } = require('../src/quick-ask/conversation');
const { createContextTracker } = require('../src/quick-ask/tracking');
const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');
const { effectiveRecords, latestTurn, modelChoices, selectionLabel, portableItems, restoredDraft } = require('../src/quick-ask/session-editing');
const { sessionConfigSnapshot } = require('../src/quick-ask/settings');
const { serializeLog, buildExport, parseExport } = require('../src/quick-ask/portability');
const config = { baseUrl: 'https://first.test/v1', secretId: 'key', model: 'one', protocol: 'responses', systemPrompt: 'Role A', contextWindowTokens: 200000 };
const draft = text => ({ version: 1, composer: text, pending: { files: [], selections: [] }, images: [] });
const answer = (protocol, text = 'Answer') => {
  const message = { role: 'assistant', content: text };
  const data = protocol === 'responses' ? [
    ['response.created', { response: { id: 'response' } }],
    ['response.completed', { response: { id: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }],
  ] : [['message', { id: 'chat', choices: [{ index: 0, delta: message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }]];
  const wire = protocol === 'responses' ? data.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join('')
    : `data: ${JSON.stringify(data[0][1])}\n\ndata: [DONE]\n\n`;
  return { ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield new TextEncoder().encode(wire); })() };
};
async function setup(protocol = 'responses') {
  const files = new Map(), notes = new Map([['a.md', 'original']]);
  let failWrite = false, failProcess = false, gate = null;
  const adapter = {
    read: async path => files.get(path), write: async (path, text) => { if (failWrite) throw Error('write failed'); files.set(path, text); },
    append: async (path, text) => files.set(path, files.get(path) + text),
    process: async (path, update) => { const next = update(files.get(path)); if (failWrite || failProcess) throw Error('atomic save failed'); files.set(path, next); return next; },
    exists: async path => files.has(path), mkdir: async () => {}, remove: async path => files.delete(path),
    list: async () => ({ files: [...files.keys()].filter(path => path.endsWith('.jsonl')), folders: [] }),
  };
  const scheduler = { now: () => Date.now(), delay: (ms, fn) => setTimeout(fn, ms), cancelDelay: clearTimeout,
    frame: fn => setTimeout(fn, 0), cancelFrame: clearTimeout };
  const store = new QuickAskSessionStore({ pluginData: { pluginDirectory: 'plugin', dataAdapter: adapter }, scheduler });
  const requests = [], trackers = new Map();
  const vault = { readText: async path => notes.get(path) ?? null, normalizePath: path => path };
  const environment = { vault, scheduler, secrets: { resolve: name => name ? 'test-key' : null },
    images: { readForSend: async paths => paths.map(path => ({ path, url: 'data:image/png;base64,test', size: 4 })) },
    network: { fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); if (gate) await gate; return answer(protocol); } } };
  const settings = { quickAsk: { ...config, protocol } };
  const makeRuntime = () => createConversation({ sessionStore: store, environment, getSettings: () => settings,
    trackerFor: id => {
      if (!trackers.has(id)) trackers.set(id, createContextTracker({ vault, scheduler, onEvent: () => {} }));
      return trackers.get(id);
    } });
  const runtime = makeRuntime();
  const { id } = await store.createSession({ config: { ...config, protocol } });
  await runtime.load(id);
  return { runtime, store, id, files, adapter, notes, requests, trackers, settings, makeRuntime,
    failWrite: value => { failWrite = value; }, failProcess: value => { failProcess = value; }, gate: value => { gate = value; } };
}

for (const protocol of ['responses', 'chat-completions']) {
  test(`${protocol}: configuration, retry, withdrawal and reload preserve billing and current choice`, async () => {
    const h = await setup(protocol);
    const original = draft('first [[a.md]]');
    original.pending = { files: ['a.md'], selections: [{ path: 'a.md', text: 'original', startLine: 1 }] };
    original.images = ['figure.png'];
    assert.equal((await h.runtime.send(h.id, 'first', { editDraft: original, images: original.images,
      additions: [{ kind: 'file', path: 'a.md', text: 'original' }] })).status, 'complete');
    const usage = h.runtime.snapshot(h.id).sessionUsage;
    assert.equal(usage, 12);
    const before = h.requests.length;
    assert.equal((await h.runtime.configure(h.id, { systemPrompt: 'Role B', systemProfileId: 'b', systemProfileName: 'B' })).status, 'committed');
    assert.equal((await h.runtime.configure(h.id, { model: 'two', baseUrl: 'https://second.test/v1' })).status, 'committed');
    assert.equal(h.requests.length, before, 'switching makes no provider request');
    const replay = await h.store.readLog(h.id);
    assert.equal(replay.version, protocol === 'responses' ? 3 : 4);
    assert.equal(isSupportedSession(replay), true);
    assert.equal((await h.runtime.withdraw(h.id)).status, 'committed');
    const state = h.runtime.snapshot(h.id);
    assert.equal(state.sessionUsage, usage);
    assert.equal(state.config.model, 'two');
    assert.equal(state.config.systemPrompt, 'Role B');
    assert.equal(state.items.length, 0);
    assert.deepEqual(state.restoredDraft, original);
    assert.deepEqual(h.trackers.get(h.id).allowlist(), []);
    assert.equal(h.trackers.get(h.id).trackedFiles().length, 0);
    assert.equal(state.occupancy.estimated, true);
    const raw = await h.store.readLog(h.id);
    assert.equal(conversationFromRecords(raw.records).filter(item => item.role).length, 0);
    assert.deepEqual(restoredDraft(raw.records), original);
    const reopened = h.makeRuntime();
    await reopened.load(h.id);
    assert.deepEqual(reopened.snapshot(h.id).restoredDraft, original);
    assert.equal(reopened.snapshot(h.id).sessionUsage, usage);
    assert.equal((await reopened.send(h.id, 'edited', { editDraft: draft('edited') })).status, 'complete');
    const request = h.requests.at(-1);
    assert.match(request.url, /second\.test/);
    assert.equal(request.body.model, 'two');
    assert.match(JSON.stringify(request.body), /Role B/);
    assert.doesNotMatch(JSON.stringify(request.body), /first|original/);
    assert.equal(reopened.snapshot(h.id).sessionUsage, 24);
    assert.equal((await reopened.withdraw(h.id, { hasDraft: true })).status, 'draft');
    assert.equal((await reopened.withdraw(h.id)).status, 'committed');
    assert.equal((await reopened.withdraw(h.id)).status, 'failed', 'already withdrawn turns do not return');
    h.runtime.forget(h.id); reopened.forget(h.id);
  });

  test(`${protocol}: repeated withdrawal, old drafts disabled and failed upgrade leaves source untouched`, async () => {
    const h = await setup(protocol);
    await h.runtime.send(h.id, 'legacy');
    const legacy = h.files.get(h.store.adapterPathFor(h.id));
    assert.equal((await h.runtime.withdraw(h.id)).status, 'failed');
    assert.equal(h.files.get(h.store.adapterPathFor(h.id)), legacy);
    await h.runtime.send(h.id, 'second', { editDraft: draft('second') });
    await h.runtime.send(h.id, 'third', { editDraft: draft('third') });
    const before = h.files.get(h.store.adapterPathFor(h.id));
    h.failWrite(true);
    assert.equal((await h.runtime.configure(h.id, { systemPrompt: 'bad' })).status, 'failed');
    h.failWrite(false); h.failProcess(true);
    assert.equal((await h.runtime.configure(h.id, { systemPrompt: 'bad' })).status, 'failed');
    assert.equal(h.runtime.snapshot(h.id).config.systemPrompt, 'Role A');
    assert.equal(h.files.get(h.store.adapterPathFor(h.id)), before);
    assert.equal([...h.files.keys()].some(path => path.endsWith('.editing')), false);
    h.failProcess(false);
    await h.runtime.withdraw(h.id);
    await h.runtime.withdraw(h.id);
    assert.equal(h.runtime.snapshot(h.id).items.length, 2);
    assert.equal(h.runtime.snapshot(h.id).sessionUsage, 36);
    assert.equal((await h.runtime.withdraw(h.id)).status, 'failed');
    assert.equal(latestTurn((await h.store.readLog(h.id)).records).payload.question, 'legacy');
    h.runtime.forget(h.id);
  });

  test(`${protocol}: busy turns reject edits; cross-protocol switches fail without changing the log`, async () => {
    const h = await setup(protocol);
    const before = h.files.get(h.store.adapterPathFor(h.id));
    const other = protocol === 'responses' ? 'chat-completions' : 'responses';
    assert.equal((await h.runtime.configure(h.id, { protocol: other })).error.code, 'HISTORY_INCOMPATIBLE');
    assert.equal(h.files.get(h.store.adapterPathFor(h.id)), before);
    let release;
    h.gate(new Promise(resolve => { release = resolve; }));
    const sending = h.runtime.send(h.id, 'running', { editDraft: draft('running') });
    assert.equal((await h.runtime.withdraw(h.id)).status, 'busy');
    assert.equal((await h.runtime.configure(h.id, { model: 'two' })).status, 'busy');
    release();
    await sending;
    h.runtime.forget(h.id);
  });
}

test('withdrawal removes its compaction and tools but retains independent Vault lifecycle facts', () => {
  const records = [
    ['turn/started', { turnId: 'one' }], ['item/input', {}], ['turn/finished', { turnId: 'one' }],
    ['turn/started', { turnId: 'two' }], ['compaction/start', {}], ['compaction/checkpoint', {}], ['compaction/end', { ok: true }],
    ['context/tool-baseline', { path: 'a.md' }], ['turn/tool-started', { turnId: 'two' }], ['item/output', {}], ['turn/finished', { turnId: 'two' }],
    ['compaction/start', {}], ['compaction/checkpoint', {}], ['compaction/end', { ok: true }],
    ['context/file-renamed', { oldPath: 'a.md', newPath: 'b.md' }], ['context/file-deleted', { path: 'b.md' }],
    ['session/configured', { config: { model: 'new' } }], ['session/withdrawn', { turnId: 'two' }],
  ].map(([kind, payload], seq) => ({ seq, kind, payload }));
  const projected = effectiveRecords(records);
  assert.equal(projected.filter(r => r.kind.startsWith('compaction/')).length, 0);
  assert.equal(projected.filter(r => r.kind.startsWith('context/')).length, 2);
  assert.equal(projected.filter(r => r.kind === 'item/output').length, 0);
  assert.equal(projected.filter(r => r.kind === 'session/configured').length, 1);
  assert.deepEqual(effectiveRecords(projected), projected);
});

test('portable projection strips signatures and opaque state, preserves paired tools, rejects unmatched calls', () => {
  const response = [{ type: 'reasoning', encrypted_content: 'secret' },
    { type: 'function_call', id: 'fc', call_id: 'call', name: 'get-image', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call', output: 'image' },
    { type: 'message', id: 'native-id', role: 'assistant', content: [{ type: 'output_text', text: 'readable', annotations: [] }] }];
  const copied = [];
  const portable = portableItems(response, 'responses', (from, to) => copied.push([from, to]));
  assert.equal(portable.length, 3);
  assert.equal(copied[1][0], response[2]);
  assert.equal(portable[2].id, undefined);
  assert.equal(response[0].encrypted_content, 'secret', 'canonical history is untouched');
  assert.throws(() => portableItems(response.slice(0, 2), 'responses'), /HISTORY_INCOMPATIBLE/);
  assert.throws(() => portableItems([{ type: 'unknown' }], 'responses'), /HISTORY_INCOMPATIBLE/);
  const chat = portableItems([{ role: 'assistant', content: 'answer', reasoning_content: 'thinking', extra_content: { google: { signature: 'signed' } } }], 'chat-completions');
  assert.deepEqual(chat, [{ role: 'assistant', content: 'answer' }]);
});

test('model selection is same-protocol, uses duplicate-name prefixes and supports future display policies', () => {
  const profile = (id, protocol = 'responses') => ({ id, name: id, baseUrl: `https://${id}.test`, models: [{ id: 'same', protocol }], selectedModelId: 'same' });
  const choices = modelChoices({ providerProfiles: [profile('A'), profile('B'), profile('C', 'chat-completions')] }, 'responses');
  assert.deepEqual(choices.map(c => c.label), ['A · same', 'B · same']);
  assert.equal(modelChoices({ providerProfiles: [profile('A')] }, 'responses')[0].label, 'same');
  assert.equal(selectionLabel('model', 'High'), 'High');
  assert.equal(selectionLabel('model', 'High', 'both'), 'model · High');
  assert.equal(selectionLabel('model', 'High', 'model'), 'model');
});

test('new snapshots preserve role identity and old sessions still parse without any rewrite', async () => {
  const saved = sessionConfigSnapshot({ ...config, systemProfiles: [{ id: 'custom', name: 'Named role', prompt: 'Role A' }], activeSystemProfileId: 'custom' });
  assert.equal(saved.systemProfileId, 'custom');
  const h = await setup();
  const raw = h.files.get(h.store.adapterPathFor(h.id));
  assert.equal(parseLog(raw).version, 1);
  await h.runtime.load(h.id);
  assert.equal(h.files.get(h.store.adapterPathFor(h.id)), raw);
  h.runtime.forget(h.id);
});

test('edited sessions round-trip through export, preserved copy and import with withdrawal metadata', async () => {
  const h = await setup();
  await h.runtime.send(h.id, 'question', { editDraft: draft('question') });
  await h.runtime.configure(h.id, { systemPrompt: 'Changed', systemProfileId: 'saved', systemProfileName: 'Saved name' });
  await h.runtime.withdraw(h.id);
  const parsed = await h.store.readLog(h.id);
  const text = serializeLog(parsed.header, parsed.records);
  assert.equal(isSupportedSession(parseLog(text)), true);
  const exported = buildExport({ settings: h.settings.quickAsk, sessions: [{ id: h.id, header: parsed.header, records: parsed.records }] });
  const incoming = parseExport(JSON.stringify(exported));
  assert.equal(incoming.ok, true);
  const session = incoming.export.sessions[0];
  await h.store.importSession({ id: 'imported', header: session.header, records: session.records, title: 'Imported' });
  await h.runtime.load('imported');
  assert.equal(h.runtime.snapshot('imported').config.systemPrompt, 'Changed');
  assert.equal(h.runtime.snapshot('imported').items.length, 0);
  assert.equal(h.runtime.snapshot('imported').sessionUsage, 12);
  assert.deepEqual(h.runtime.snapshot('imported').restoredDraft, draft('question'));
  h.runtime.forget(h.id); h.runtime.forget('imported');
});

for (const protocol of ['responses', 'chat-completions']) {
  test(`${protocol}: withdrawal restores the preceding checkpoint and switching rebuilds the full portable history`, async () => {
    const h = await setup(protocol);
    await h.runtime.send(h.id, 'prefix question', { editDraft: draft('prefix question') });
    const checkpoint = async label => {
      await h.store.append(h.id, 'compaction/start', { range: { from: 0, to: 1 } });
      await h.store.append(h.id, 'compaction/checkpoint', { range: { from: 0, to: 1 }, checkpoint: { framed: label } });
      await h.store.append(h.id, 'compaction/end', { ok: true });
    };
    await checkpoint('EARLIER SUMMARY');
    await h.runtime.load(h.id);
    await h.runtime.send(h.id, 'tail question', { editDraft: draft('tail question') });
    await checkpoint('WITHDRAWN SUMMARY');
    await h.runtime.load(h.id);
    assert.equal(h.runtime.snapshot(h.id).compaction.active, true);
    await h.runtime.withdraw(h.id);
    assert.equal(h.runtime.stateFor(h.id).compactedSurface.checkpoint.framed, 'EARLIER SUMMARY');
    assert.equal(h.runtime.snapshot(h.id).items.length, 2);
    const stored = await h.store.readLog(h.id);
    assert.equal(conversationFromRecords(stored.records).filter(item => item.kind === 'compaction').length, 1);
    const previous = h.runtime.snapshot(h.id).config;
    const calls = h.requests.length;
    assert.equal((await h.runtime.configure(h.id, { model: 'new-model' })).status, 'committed');
    assert.equal(h.runtime.snapshot(h.id).compaction.active, false);
    assert.equal(h.requests.length, calls);
    assert.equal(h.runtime.snapshot(h.id).items.length, 2, 'full local prefix remains available after leaving opaque checkpoint');
    await h.runtime.send(h.id, 'new question', { editDraft: draft('new question') });
    const body = JSON.stringify(h.requests.at(-1).body);
    assert.match(body, /prefix question/);
    assert.doesNotMatch(body, /tail question|WITHDRAWN SUMMARY|EARLIER SUMMARY/);
    assert.equal(previous.model, 'one');
    h.runtime.forget(h.id);
  });

  test(`${protocol}: stopped and failed turns can be withdrawn; retries use the selected configuration`, async () => {
    const h = await setup(protocol);
    let release;
    h.gate(new Promise(resolve => { release = resolve; }));
    const sending = h.runtime.send(h.id, 'stop this', { editDraft: draft('stop this') });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, 1, 'stop after the durable turn and provider request begin');
    await h.runtime.stop(h.id);
    release();
    assert.equal((await sending).status, 'stopped');
    h.gate(null);
    assert.equal((await h.runtime.withdraw(h.id)).status, 'committed');
    // Seed a durably failed, unaccepted submission as recovered from a crash.
    await h.store.append(h.id, 'turn/started', { turnId: 'failed', question: 'retry me', additions: [], editDraft: draft('retry me'), config: { ...config, protocol } });
    await h.store.append(h.id, 'turn/finished', { turnId: 'failed', state: 'failed', text: '', error: { code: 'AUTH', message: 'Failed' } });
    await h.runtime.load(h.id);
    await h.runtime.configure(h.id, { model: 'retry-model', systemPrompt: 'Retry role' });
    await h.runtime.send(h.id, 'retry me', { editDraft: draft('retry me') });
    const body = h.requests.at(-1).body;
    assert.equal(body.model, 'retry-model');
    assert.match(JSON.stringify(body), /Retry role/);
    await h.runtime.withdraw(h.id);
    assert.equal((await h.runtime.withdraw(h.id)).status, 'committed', 'failed original remains eligible');
    assert.equal(h.runtime.snapshot(h.id).items.length, 0);
    h.runtime.forget(h.id);
  });
}

test('incompatible provider history prevents changing the durable selection', async () => {
  const h = await setup();
  await h.runtime.send(h.id, 'question', { editDraft: draft('question') });
  await h.store.append(h.id, 'item/output', { item: { type: 'unrecognized_native_state', data: 'opaque' } });
  await h.runtime.load(h.id);
  const before = h.files.get(h.store.adapterPathFor(h.id));
  assert.equal((await h.runtime.configure(h.id, { model: 'other' })).error.code, 'HISTORY_INCOMPATIBLE');
  assert.equal(h.runtime.snapshot(h.id).config.model, 'one');
  assert.equal(h.files.get(h.store.adapterPathFor(h.id)), before);
  h.runtime.forget(h.id);
});

test('withdrawn image-tool permissions and baselines disappear; migrated tool image references still materialize', async () => {
  const h = await setup();
  await h.runtime.send(h.id, 'look', { editDraft: draft('look'), additions: [{ kind: 'file', path: 'a.md', text: 'original' }] });
  await h.store.append(h.id, 'item/output', { item: { type: 'function_call', call_id: 'image-call', name: 'get-image', arguments: '{"path":"figure.png"}' } });
  await h.store.append(h.id, 'item/output', { tool: true, item: { type: 'function_call_output', call_id: 'image-call', output: 'image result' }, imagePaths: ['figure.png'] });
  await h.store.append(h.id, 'context/tool-baseline', { path: 'a.md', text: 'tool baseline' });
  await h.runtime.load(h.id);
  assert.equal(h.runtime.stateFor(h.id).authorizedImagePaths.has('figure.png'), true);
  assert.equal((await h.runtime.configure(h.id, { model: 'vision-two' })).status, 'committed');
  await h.runtime.send(h.id, 'follow up', { editDraft: draft('follow up') });
  assert.match(JSON.stringify(h.requests.at(-1).body), /data:image\/png/);
  await h.runtime.withdraw(h.id);
  await h.runtime.withdraw(h.id);
  assert.equal(h.runtime.stateFor(h.id).authorizedImagePaths.size, 0);
  assert.deepEqual(h.trackers.get(h.id).allowlist(), []);
  assert.deepEqual(h.trackers.get(h.id).trackedFiles(), []);
  h.runtime.forget(h.id);
});

test('new sessions inherit only the selected role snapshot and keep the global default model', () => {
  const { inheritSessionRole } = require('../src/quick-ask/session-editing');
  const defaults = { ...config, systemProfileId: 'global', systemProfileName: 'Global' };
  const current = { ...config, model: 'session-model', baseUrl: 'https://session.test', systemPrompt: 'Current prompt', systemProfileId: 'current', systemProfileName: 'Current' };
  const created = inheritSessionRole(defaults, current);
  assert.equal(created.model, defaults.model);
  assert.equal(created.baseUrl, defaults.baseUrl);
  assert.equal(created.systemPrompt, 'Current prompt');
  assert.equal(created.systemProfileId, 'current');
  assert.equal(created.systemProfileName, 'Current');
  assert.deepEqual(inheritSessionRole(defaults, null), defaults);
  assert.equal(defaults.systemProfileId, 'global');
});

test('editing configuration cannot erase a file change observed before tracker replay', async () => {
  const h = await setup();
  await h.runtime.send(h.id, 'read file', { editDraft: draft('read file'), additions: [{ kind: 'file', path: 'a.md', text: 'original' }] });
  h.notes.set('a.md', 'UPDATED AFTER FIRST SEND');
  h.trackers.get(h.id).modifiedFile('a.md');
  await h.runtime.configure(h.id, { systemPrompt: 'New role' });
  await h.runtime.send(h.id, 'follow up', { editDraft: draft('follow up') });
  assert.match(JSON.stringify(h.requests.at(-1).body), /UPDATED AFTER FIRST SEND/);
  h.runtime.forget(h.id);
});

test('physical billing retains old usage attempts and reported compaction charges after withdrawal', () => {
  const { sessionUsage } = require('../src/quick-ask/session-editing');
  const sample = { source: 'terminal', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
  const records = [
    { kind: 'turn/started', payload: { turnId: 'billed' } },
    { kind: 'turn/usage', payload: sample }, { kind: 'turn/usage', payload: sample },
    { kind: 'compaction/checkpoint', payload: { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
    { kind: 'turn/finished', payload: { turnId: 'billed' } },
    { kind: 'session/withdrawn', payload: { turnId: 'billed' } },
  ];
  assert.equal(sessionUsage(records).total(), 31);
  assert.equal(sessionUsage(effectiveRecords(records)).total(), 0);
});

test('the atomic edit callback rejects an intervening external write without overwriting it', async () => {
  const h = await setup();
  const original = h.adapter.process;
  const path = h.store.adapterPathFor(h.id);
  h.adapter.process = async (file, update) => {
    const parsed = parseLog(h.files.get(path));
    h.files.set(path, h.files.get(path) + JSON.stringify({ seq: parsed.nextSeq, kind: 'session/renamed', at: '2026-10-24T00:00:00Z', payload: { title: 'external title' } }) + '\n');
    return original(file, update);
  };
  assert.equal((await h.runtime.configure(h.id, { systemPrompt: 'do not commit' })).status, 'failed');
  const parsed = await h.store.readLog(h.id);
  assert.equal(parsed.title, 'external title');
  assert.equal(parsed.version, 1);
  assert.equal(parsed.records.some(record => record.kind === 'session/configured'), false);
  assert.equal(h.runtime.snapshot(h.id).config.systemPrompt, 'Role A');
  h.runtime.forget(h.id);
});

test('a post-commit read failure blocks stale sends until reloading the durable configuration', async () => {
  const h = await setup();
  const originalProcess = h.adapter.process, originalRead = h.store.readLog.bind(h.store);
  h.adapter.process = async (...args) => {
    const value = await originalProcess(...args);
    let failed = false;
    h.store.readLog = async id => {
      if (!failed) { failed = true; throw Error('temporary read failure'); }
      return originalRead(id);
    };
    return value;
  };
  assert.equal((await h.runtime.configure(h.id, { systemPrompt: 'Saved despite read failure' })).error.code, 'SESSION_RELOAD');
  assert.equal((await h.runtime.send(h.id, 'blocked')).error.code, 'SESSION_RELOAD');
  assert.equal(h.requests.length, 0);
  h.store.readLog = originalRead;
  await h.runtime.load(h.id);
  assert.equal(h.runtime.snapshot(h.id).config.systemPrompt, 'Saved despite read failure');
  assert.equal(h.runtime.canEdit(h.id), true);
  h.runtime.forget(h.id);
});

test('pending draft protection distinguishes tracked rows from unsent files, selections and images', () => {
  const { hasPendingDraft } = require('../src/quick-ask/session-editing');
  const value = { composer: '', pending: { files: [{ path: 'a.md' }], selections: [] }, images: [] };
  assert.equal(hasPendingDraft(value, [{ path: 'a.md', status: 'unchanged' }]), false);
  assert.equal(hasPendingDraft(value, []), true, 'restored but untracked file rows are pending attachments');
  assert.equal(hasPendingDraft(value, [{ path: 'a.md', status: 'staged' }]), true);
  assert.equal(hasPendingDraft({ ...value, composer: 'new draft' }, [{ path: 'a.md', status: 'unchanged' }]), true);
  assert.equal(hasPendingDraft({ composer: '', pending: { files: [], selections: [{ text: 'quote' }] }, images: [] }), true);
  assert.equal(hasPendingDraft({ composer: '', pending: { files: [], selections: [], images: ['image.png'] }, images: [] }), true);
});

test('legacy role labels require one exact prompt match and never override saved role identities', () => {
  const { legacyRoleProfile } = require('../src/quick-ask/session-editing');
  const saved = { systemPrompt: 'Role A', activeSystemProfileId: 'named', initialProfilesVersion: 1,
    systemProfiles: [{ id: 'default', name: null, prompt: '' }, { id: 'named', name: 'Named role', prompt: 'Role A' }] };
  const legacy = { systemPrompt: 'Role A' };
  assert.deepEqual(legacyRoleProfile(legacy, saved), { id: 'named', name: 'Named role' });
  assert.equal(legacyRoleProfile({ systemPrompt: 'Role A ' }, saved), null, 'no whitespace normalization');
  assert.equal(legacyRoleProfile({ systemPrompt: 'Missing role' }, saved), null);
  assert.equal(legacyRoleProfile({}, saved), null, 'missing prompt must not match an empty preset');
  assert.equal(legacyRoleProfile(null, saved), null);
  assert.equal(legacyRoleProfile(legacy, { ...saved, systemProfiles: [...saved.systemProfiles, { id: 'duplicate', name: 'Another role', prompt: 'Role A' }] }), null);
  assert.equal(legacyRoleProfile({ ...legacy, systemProfileId: 'deleted-role' }, saved), null);
  assert.equal(legacyRoleProfile({ ...legacy, systemProfileName: 'Original name' }, saved), null);
  assert.deepEqual(legacy, { systemPrompt: 'Role A' }, 'display inference never mutates the saved configuration');
});

test('legacy role inference is cached for rendering, uses final replayed config, and leaves logs and requests untouched', async () => {
  const h = await setup();
  h.settings.quickAsk = { ...h.settings.quickAsk, activeSystemProfileId: 'named', initialProfilesVersion: 1,
    systemProfiles: [{ id: 'default', name: null, prompt: '' }, { id: 'named', name: 'Named role', prompt: 'Role A' }] };
  const path = h.store.adapterPathFor(h.id), original = h.files.get(path);
  await h.runtime.load(h.id);
  const display = h.runtime.snapshot(h.id).roleDisplayProfile;
  assert.deepEqual(display, { id: 'named', name: 'Named role' });
  h.settings.quickAsk.systemProfiles[1].name = 'Edited catalog name';
  for (let i = 0; i < 100; i++) assert.equal(h.runtime.snapshot(h.id).roleDisplayProfile, display);
  assert.equal(h.runtime.snapshot(h.id).config.systemProfileId, undefined);
  assert.equal(h.runtime.snapshot(h.id).config.systemPrompt, 'Role A');
  assert.equal(h.files.get(path), original);
  assert.equal(h.requests.length, 0);
  await h.runtime.configure(h.id, { systemProfileId: 'chosen', systemProfileName: 'Explicit name', systemPrompt: 'Role A' });
  assert.equal(h.runtime.snapshot(h.id).roleDisplayProfile, null, 'explicit replayed identity takes precedence over the initial header');
  assert.equal(h.runtime.snapshot(h.id).config.systemProfileName, 'Explicit name');
  h.runtime.forget(h.id);
});
