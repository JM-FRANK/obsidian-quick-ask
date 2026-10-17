// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuickAskSettings, applyQuickAskPatch, sessionConfigSnapshot, redactQuickAskSettings } = require('../src/quick-ask/settings');
const { activeProvider, selectedModel } = require('../src/quick-ask/provider-profiles');
const { discoverModels, createProviderManager } = require('../src/quick-ask/model-discovery');
const { QuickAskSettings } = require('../release/quick-ask/settings-store');
const act = (settings, action) => applyQuickAskPatch(settings, { providerAction: action });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(saved = { baseUrl: 'https://one.test/v1', secretId: 'key-one', model: 'old' }) {
  let fail = false;
  const store = new QuickAskSettings({ quickAsk: saved }, async () => { if (fail) throw new Error('disk'); });
  const timers = new Map(), calls = [], responses = [], notices = [];
  let timerId = 0;
  const scheduler = { delay(ms, callback) { const id = ++timerId; timers.set(id, { ms, callback }); return id; }, cancelDelay(id) { timers.delete(id); } };
  const network = { AbortController, async request(options) {
    calls.push(options);
    return responses.length ? await responses.shift() : { status: 200, json: { data: [{ id: 'new' }] } };
  } };
  const manager = createProviderManager({ getSettings: () => store.values(), write: patch => store.update({ quickAsk: patch }),
    secrets: { resolve: id => id ? 'dummy-secret' : null }, network, scheduler, notice: key => notices.push(key) });
  return { store, manager, calls, responses, notices, timers, fail: value => { fail = value; },
    async tick(ms = 600) {
      for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.callback(); }
      await flush();
    } };
}

test('legacy connection migrates once without losing blank capacity, protocol, key reference or role bytes', () => {
  const input = { baseUrl: ' https://one.test/v1/ ', secretId: 'named', model: 'legacy', protocol: 'chat-completions', contextWindowTokens: null, systemPrompt: '  role\n' };
  const saved = normalizeQuickAskSettings(input), profile = activeProvider(saved);
  assert.equal(profile.baseUrl, 'https://one.test/v1');
  assert.equal(profile.secretId, 'named');
  assert.deepEqual(selectedModel(profile), { id: 'legacy', protocol: 'chat-completions', contextWindowTokens: null });
  assert.equal(saved.systemPrompt, input.systemPrompt);
  assert.deepEqual(normalizeQuickAskSettings(JSON.parse(JSON.stringify(saved))), saved);
  assert.equal(input.providerProfiles, undefined);
});

test('profiles remember their models and per-model protocol/capacity; snapshots stay independent after editing/deleting', () => {
  const settings = normalizeQuickAskSettings({ baseUrl: 'https://one.test', secretId: 'one', model: 'a', protocol: 'responses', contextWindowTokens: 32001 });
  const old = sessionConfigSnapshot(settings);
  act(settings, { type: 'add', id: 'two', name: 'Second' });
  act(settings, { type: 'connection', id: 'two', baseUrl: 'https://two.test/v1', secretId: 'two' });
  act(settings, { type: 'model-add', id: 'two', modelId: 'b' });
  act(settings, { type: 'model-edit', id: 'two', modelId: 'b', patch: { protocol: 'chat-completions', contextWindowTokens: null } });
  const second = sessionConfigSnapshot(settings);
  act(settings, { type: 'model-add', id: 'two', modelId: 'c' });
  act(settings, { type: 'model-edit', id: 'two', modelId: 'c', patch: { protocol: 'responses', contextWindowTokens: 262144 } });
  act(settings, { type: 'select', id: 'default' });
  assert.equal(settings.model, 'a'); assert.equal(settings.contextWindowTokens, 32001);
  act(settings, { type: 'select', id: 'two' });
  assert.equal(settings.model, 'c'); assert.equal(settings.contextWindowTokens, 262144);
  act(settings, { type: 'model-select', id: 'two', modelId: 'b' });
  assert.equal(settings.protocol, 'chat-completions'); assert.equal(settings.contextWindowTokens, null);
  act(settings, { type: 'delete', id: 'two' });
  assert.equal(settings.baseUrl, 'https://one.test');
  assert.equal(old.model, 'a'); assert.equal(old.contextWindowTokens, 32001);
  assert.equal(second.model, 'b'); assert.equal(second.baseUrl, 'https://two.test/v1');
  assert.equal(second.protocol, 'chat-completions'); assert.equal(second.providerProfiles, undefined);
});

test('invalid names/IDs and last-profile deletion cannot damage the saved catalog', () => {
  const saved = normalizeQuickAskSettings();
  act(saved, { type: 'rename', id: 'default', name: 'First' });
  const before = structuredClone(saved);
  for (const action of [{ type: 'add', id: 'x', name: '' }, { type: 'add', id: 'x', name: ' first ' },
    { type: 'delete', id: 'default' }, { type: 'select', id: 'missing' }, { type: 'model-add', id: 'default', modelId: ' ' }]) {
    assert.throws(() => act(saved, action)); assert.deepEqual(saved, before);
  }
});

test('legacy patches, catalog-only imports, and actions atomically publish compatibility fields', () => {
  const saved = normalizeQuickAskSettings();
  applyQuickAskPatch(saved, { baseUrl: 'https://one.test/', secretId: 'key', model: 'a', protocol: 'chat-completions', contextWindowTokens: null });
  assert.equal(activeProvider(saved).baseUrl, 'https://one.test');
  assert.equal(selectedModel(activeProvider(saved)).protocol, 'chat-completions');
  applyQuickAskPatch(saved, { model: '' }); assert.equal(saved.model, '');
  const imported = normalizeQuickAskSettings({ baseUrl: 'https://other.test', model: 'other' });
  applyQuickAskPatch(saved, { providerProfiles: imported.providerProfiles, activeProviderProfileId: imported.activeProviderProfileId });
  assert.equal(saved.baseUrl, 'https://other.test'); assert.equal(saved.model, 'other');
  applyQuickAskPatch(saved, { baseUrl: 'https://ignored.test', providerAction: { type: 'rename', id: 'default', name: 'Renamed' } });
  assert.equal(saved.baseUrl, 'https://other.test');
});

test('export/import retain all connections but discard unknown secret values at every catalog level', () => {
  const saved = normalizeQuickAskSettings({ secretId: 'one', apiKey: 'LEAK', providerProfiles: [
    { id: 'x', name: 'X', baseUrl: 'https://x.test', secretId: 'ref', apiKey: 'LEAK', selectedModelId: 'm', models: [{ id: 'm', apiKey: 'LEAK' }] },
  ] });
  const exported = redactQuickAskSettings(saved);
  assert.equal(JSON.stringify(exported).includes('LEAK'), false);
  assert.equal(exported.providerProfiles[0].secretId, 'one'); // Explicit legacy reference remains authoritative.
  const restored = normalizeQuickAskSettings();
  applyQuickAskPatch(restored, JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(restored, saved);
});

test('model discovery uses only GET base/models and key; parses explicit IDs/capacities without guessing protocol', async () => {
  const calls = [];
  const models = await discoverModels({ profile: { baseUrl: 'https://relay.test/custom/v1', secretId: 'ref' }, apiKey: 'dummy', network: { request: async options => {
    calls.push(options); return { status: 200, json: { data: [{ id: ' z ', context_window: 1048576 }, { id: 'a' }, { id: 'a' }, { id: '' }, { id: 4 }] } };
  } } });
  assert.deepEqual(models, [{ id: 'a' }, { id: 'z', contextWindowTokens: 1048576 }]);
  assert.equal(calls[0].url, 'https://relay.test/custom/v1/models'); assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer dummy'); assert.equal(calls[0].body, undefined);
  for (const response of [{ status: 401, json: { error: 'secret body' } }, { status: 200, json: {} }, { status: 200, json() { throw new Error('private'); } }]) {
    await assert.rejects(discoverModels({ profile: { baseUrl: 'https://x.test' }, apiKey: 'dummy', network: { request: async () => response } }), /^Error: providers\./);
  }
});

test('discovery merges models without resetting manual models, selected model or custom overrides', () => {
  const saved = normalizeQuickAskSettings({ baseUrl: 'https://one.test', secretId: 'key', model: 'manual', protocol: 'chat-completions', contextWindowTokens: null });
  act(saved, { type: 'discovered', id: 'default', baseUrl: saved.baseUrl, secretId: saved.secretId,
    models: [{ id: 'manual', contextWindowTokens: 999999 }, { id: 'new', contextWindowTokens: 1048576 }] });
  assert.equal(saved.model, 'manual'); assert.equal(saved.contextWindowTokens, null); assert.equal(saved.protocol, 'chat-completions');
  assert.equal(activeProvider(saved).models.find(model => model.id === 'new').contextWindowTokens, 1048576);
  const before = structuredClone(saved);
  act(saved, { type: 'discovered', id: 'default', baseUrl: 'https://stale.test', secretId: saved.secretId, models: [{ id: 'stale' }] });
  assert.deepEqual(saved, before);
});

test('opening settings, selecting profiles, reload and non-connection edits cause zero discovery requests', async () => {
  const f = fixture();
  f.manager.watch({ isConnected: true }, () => {});
  await f.manager.run({ type: 'rename', id: 'default', name: 'Main' });
  await f.manager.run({ type: 'select', id: 'default' });
  await f.manager.run({ type: 'model-edit', id: 'default', modelId: 'old', patch: { contextWindowTokens: null } });
  await f.tick(); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  f.manager.dispose();
});

test('connection edits debounce discovery; incomplete pairs never fetch; manual refresh repeats on demand', async () => {
  const f = fixture({});
  await f.manager.run({ type: 'connection', id: 'default', baseUrl: 'https://one.test/v1' });
  await f.tick(); assert.equal(f.calls.length, 0);
  await f.manager.run({ type: 'connection', id: 'default', secretId: 'key' });
  await f.manager.run({ type: 'connection', id: 'default', baseUrl: 'https://two.test/v1' });
  assert.equal(f.calls.length, 0);
  await f.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://two.test/v1/models');
  assert.equal(f.store.values().quickAsk.model, '', 'discovery must not choose an arbitrary model');
  await f.manager.refresh(); assert.equal(f.calls.length, 2);
  f.manager.dispose(); assert.equal(f.timers.size, 0);
});

test('late requests cannot overwrite an edited or deleted connection; keys are never written', async () => {
  const f = fixture(), response = deferred();
  f.responses.push(response.promise);
  const first = f.manager.refresh(); await flush();
  await f.manager.run({ type: 'connection', id: 'default', baseUrl: 'https://new.test' });
  assert.equal(f.calls[0].signal.aborted, true);
  response.resolve({ status: 200, json: { data: [{ id: 'stale' }] } }); await first;
  assert.equal(activeProvider(f.store.values().quickAsk).models.some(model => model.id === 'stale'), false);
  assert.equal(JSON.stringify(f.store.values()).includes('dummy-secret'), false);
  f.manager.dispose();
});

test('timeouts report a retryable status and ignore late results; dispose cancels pending discovery', async () => {
  const f = fixture(), response = deferred(); f.responses.push(response.promise);
  const request = f.manager.refresh(); await flush(); await f.tick(20000);
  assert.equal(f.manager.status('default'), 'providers.discoveryFailed'); assert.equal(f.calls[0].signal.aborted, true);
  response.resolve({ status: 200, json: { data: [{ id: 'late' }] } }); await request;
  assert.equal(f.store.values().quickAsk.model, 'old');
  await f.manager.run({ type: 'connection', id: 'default', secretId: 'new-key' });
  f.manager.dispose(); await f.tick(); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0);
});

test('save failures leave selection and model catalog unchanged and do not trigger discovery', async () => {
  const f = fixture(), before = f.store.values(); f.fail(true);
  assert.equal(await f.manager.run({ type: 'connection', id: 'default', baseUrl: 'https://unsaved.test' }), false);
  assert.deepEqual(f.store.values(), before); await f.tick(); assert.equal(f.calls.length, 0);
  await f.manager.refresh(); assert.deepEqual(f.store.values(), before);
  assert.equal(f.manager.status('default'), 'providers.saveFailed');
  f.fail(false); await f.manager.run({ type: 'rename', id: 'default', name: 'Recovered' });
  assert.equal(activeProvider(f.store.values().quickAsk).name, 'Recovered'); f.manager.dispose();
});

test('serialized rapid edits publish only the saved final value and schedule only the final connection', async () => {
  const f = fixture(), seen = [];
  f.manager.watch({ isConnected: true }, () => seen.push(f.store.values().quickAsk.baseUrl));
  await Promise.all(['https://a.test', 'https://b.test', 'https://c.test'].map(baseUrl => f.manager.run({ type: 'connection', id: 'default', baseUrl })));
  assert.deepEqual(seen, ['https://c.test']); await f.tick(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://c.test/models');
  f.manager.dispose();
});

test('native settings initialization and refresh callbacks never persist or discover (no DOM)', async () => {
  const { providerSettings } = require('../src/quick-ask/provider-settings');
  const f = fixture(), host = { settings: f.store, current: () => f.store.values(), app: {}, quickAskIntegration: { providers: f.manager } };
  let changes = 0;
  class Control {
    constructor() { this.value = ''; this.inputEl = { setAttribute() {}, addEventListener() {} }; this.selectEl = { empty() {} }; }
    onChange(callback) { this.change = callback; return this; }
    setValue(value) { this.value = value; if (this.change) { changes++; this.change(value); } return this; }
    getValue() { return this.value; }
    addOption() { return this; } setDisabled() { return this; } setPlaceholder() { return this; }
    setIcon() { return this; } setTooltip() { return this; } onClick() { return this; } setButtonText() { return this; }
  }
  for (const row of providerSettings(host, Control).flatMap(group => group.items)) {
    const setting = { settingEl: { isConnected: true }, controlEl: { createSpan() {} }, setErrorMessage() {}, setDesc() {} };
    for (const method of ['addText', 'addDropdown', 'addExtraButton', 'addButton']) setting[method] = callback => { callback(new Control()); return setting; };
    row.render(setting);
  }
  await flush(); await f.tick();
  assert.ok(changes > 0, 'the native-style programmatic callbacks actually ran');
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.notices.length, 0);
  assert.equal(activeProvider(f.store.values().quickAsk).name, null);
  await f.manager.run({ type: 'rename', id: 'default', name: 'Saved' });
  await f.tick(); assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 0);
  f.manager.dispose();
});
