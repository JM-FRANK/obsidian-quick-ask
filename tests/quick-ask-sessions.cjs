// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  QuickAskSessionStore, CURRENT_SCHEMA_VERSION, deriveTitle, parseLog, orderSessions,
} = require('../src/quick-ask/sessions');

const PLUGIN_DIRECTORY = '/vault/.obsidian/plugins/scholar-workbench';
// The store addresses the plugin's hidden Quick Ask directory, not the Vault.
const DIR = `${PLUGIN_DIRECTORY}/quick-ask/`;

// An in-memory DataAdapter with the same surface the store uses.
function makeDataAdapter({ files = {}, failAppend = false } = {}) {
  const store = new Map(Object.entries(files));
  const adapter = {
    files: store,
    writes: [],
    appends: [],
    async read(path) {
      if (!store.has(path)) throw new Error(`ENOENT ${path}`);
      return store.get(path);
    },
    async write(path, data) {
      store.set(path, String(data));
      adapter.writes.push({ path, data: String(data) });
    },
    async append(path, data) {
      if (failAppend) throw new Error('simulated append failure');
      store.set(path, (store.get(path) ?? '') + String(data));
      adapter.appends.push({ path, data: String(data) });
    },
    async exists(path) { return store.has(path); },
    async mkdir() {},
    async remove(path) { store.delete(path); },
    async list(path) {
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const files = [...store.keys()].filter((key) => key.startsWith(prefix));
      return { files, folders: [] };
    },
    async stat(path) { return store.has(path) ? { size: store.get(path).length, mtime: 1 } : null; },
  };
  return adapter;
}

function makeScheduler() {
  let now = Date.parse('2026-09-12T10:00:00.000Z');
  return {
    now: () => now,
    advance(milliseconds) { now += milliseconds; },
  };
}

function makeStore(options = {}) {
  const pluginData = { pluginDirectory: PLUGIN_DIRECTORY, dataAdapter: makeDataAdapter(options) };
  const scheduler = makeScheduler();
  const store = new QuickAskSessionStore({ pluginData, scheduler, onError: options.onError ?? (() => {}) });
  return { store, pluginData, adapter: pluginData.dataAdapter, scheduler };
}

test('initial entry and deletion of the last session ensure exactly one real active session', async () => {
  const { store } = makeStore();
  const [a, b] = await Promise.all([store.ensureActiveSession({ model: 'm' }), store.ensureActiveSession({ model: 'm' })]);
  assert.equal(a, b);
  assert.equal((await store.listSessions()).length, 1);
  assert.equal((await store.loadIndex()).activeSessionId, a);
  await store.delete(a);
  const next = await store.ensureActiveSession({ model: 'm' });
  assert.notEqual(next, a);
  assert.equal((await store.listSessions()).length, 1);
});

test('a new session writes one header, then appends records with consecutive seq values', async () => {
  const { store, adapter } = makeStore();
  const { id } = await store.createSession({});
  const first = await store.append(id, 'turn/started', { turnId: 't1' });
  const second = await store.append(id, 'turn/finished', { turnId: 't1', state: 'complete' });
  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  const lines = adapter.files.get(store.adapterPathFor(id)).trim().split('\n');
  assert.equal(lines.length, 3);
  const header = JSON.parse(lines[0]);
  assert.equal(header.kind, 'header');
  assert.equal(header.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(header.sessionId, id);
  assert.equal(typeof header.createdAt, 'string');
  assert.equal(typeof header.config, 'object');
  assert.equal(JSON.parse(lines[1]).seq, 0);
  assert.equal(JSON.parse(lines[2]).seq, 1);
});

test('the header is written with write() and later records with append()', async () => {
  const { store, adapter } = makeStore();
  const { id } = await store.createSession({});
  await store.append(id, 'turn/started', {});
  assert.ok(adapter.writes.length >= 2, 'the header and the index are separate writes');
  const headerAt = adapter.writes.findIndex(write => write.path === store.adapterPathFor(id));
  const indexedAt = adapter.writes.findIndex(write => write.path === store.indexPath && write.data?.includes?.(id));
  assert.ok(headerAt >= 0, 'the session header is written separately');
  assert.ok(indexedAt < 0 || indexedAt > headerAt, 'the session is never indexed before its header exists');
  assert.equal(adapter.appends.length, 1);
  assert.equal(adapter.appends[0].path, store.adapterPathFor(id));
});

test('concurrent appends keep their order through the per-session promise tail', async () => {
  const { store, adapter } = makeStore();
  const { id } = await store.createSession({});
  await Promise.all([
    store.append(id, 'item/input', { n: 1 }),
    store.append(id, 'item/input', { n: 2 }),
    store.append(id, 'item/input', { n: 3 }),
  ]);
  const records = adapter.files.get(store.adapterPathFor(id)).trim().split('\n').slice(1).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.seq), [0, 1, 2]);
  assert.deepEqual(records.map((record) => record.payload.n), [1, 2, 3]);
});

test('session identity, title, and next seq survive a reload in a fresh store', async () => {
  const { store, pluginData } = makeStore();
  const { id } = await store.createSession({});
  await store.append(id, 'turn/started', {});
  await store.rename(id, 'First question');
  const reloaded = new QuickAskSessionStore({ pluginData, scheduler: makeScheduler() });
  const sessions = await reloaded.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].title, 'First question');
  const appended = await reloaded.append(id, 'turn/finished', {});
  assert.equal(appended.seq, 2, 'seq continues from the durable log, not from memory');
});

test('only the sessions index is read at startup; a session body loads on demand', async () => {
  const { store, adapter } = makeStore();
  const { id } = await store.createSession({});
  await store.append(id, 'turn/started', {});
  adapter.reads = [];
  const originalRead = adapter.read;
  adapter.read = async (path) => { adapter.reads.push(path); return originalRead(path); };
  const reloaded = new QuickAskSessionStore({ pluginData: { pluginDirectory: PLUGIN_DIRECTORY, dataAdapter: adapter }, scheduler: makeScheduler() });
  await reloaded.listSessions();
  assert.deepEqual(adapter.reads, [`${DIR}index.json`]);
  await reloaded.readLog(id);
  assert.deepEqual(adapter.reads, [`${DIR}index.json`, `${DIR}sessions/${id}.jsonl`]);
});

test('a torn final line is truncated to the valid prefix and later appends continue the seq', async () => {
  const { store, pluginData, adapter } = makeStore();
  const { id } = await store.createSession({});
  await store.append(id, 'turn/started', {});
  const path = store.adapterPathFor(id);
  adapter.files.set(path, adapter.files.get(path) + '{"seq":1,"at":"2026-09-12T10:00:05.000Z","kind":"item/inp');
  const reloaded = new QuickAskSessionStore({ pluginData, scheduler: makeScheduler() });
  const parsed = await reloaded.readLog(id);
  assert.equal(parsed.damaged, undefined);
  assert.equal(parsed.tornTail, true);
  const record = await reloaded.append(id, 'turn/finished', {});
  assert.equal(record.seq, 1);
  const lines = adapter.files.get(path).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[2]).kind, 'turn/finished');
});

test('invalid JSON anywhere earlier marks the session damaged and refuses appends', async () => {
  const { store, pluginData, adapter } = makeStore();
  const { id } = await store.createSession({});
  const path = store.adapterPathFor(id);
  adapter.files.set(path, `${adapter.files.get(path)}{"seq":0,"at":"2026-09-12T10:00:01.000Z",BROKEN}\n{"seq":1,"at":"2026-09-12T10:00:02.000Z","kind":"turn/finished","payload":{}}\n`);
  const reloaded = new QuickAskSessionStore({ pluginData, scheduler: makeScheduler() });
  const parsed = await reloaded.readLog(id);
  assert.equal(parsed.damaged, true);
  assert.equal(adapter.files.get(path).includes('BROKEN'), true, 'the original file stays available for recovery');
  await assert.rejects(() => reloaded.append(id, 'turn/finished', {}), /damaged/);
});

test('a duplicate, missing, or out-of-order seq damages the session', () => {
  const header = '{"kind":"header","schemaVersion":1,"sessionId":"s1","createdAt":"2026-09-12T10:00:00.000Z","config":{}}\n';
  const record = (seq) => `{"seq":${seq},"at":"2026-09-12T10:00:01.000Z","kind":"turn/started","payload":{}}\n`;
  assert.equal(parseLog(header + record(1)).damaged, true);
  assert.equal(parseLog(header + record(0) + record(0)).damaged, true);
  assert.equal(parseLog(header + record(0) + record(2)).damaged, true);
  assert.equal(parseLog(header + record(0) + record(1)).damaged, undefined);
});

test('replay tolerates unknown record kinds and unknown fields inside a known payload', () => {
  const header = '{"kind":"header","schemaVersion":1,"sessionId":"s1","createdAt":"2026-09-12T10:00:00.000Z","config":{}}\n';
  const unknownKind = '{"seq":0,"at":"2026-09-12T10:00:01.000Z","kind":"future/thing","payload":{"whatever":1}}\n';
  const unknownField = '{"seq":1,"at":"2026-09-12T10:00:02.000Z","kind":"turn/started","payload":{"turnId":"t1"},"extra":{"a":1}}\n';
  const parsed = parseLog(header + unknownKind + unknownField);
  assert.equal(parsed.damaged, undefined);
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.nextSeq, 2);
});

test('a header without a version is version 1, and a newer version is never appended to', async () => {
  const { pluginData, adapter } = makeStore();
  const old = '{"kind":"header","sessionId":"s-old","createdAt":"2026-09-12T10:00:00.000Z","config":{}}\n';
  adapter.files.set(`${DIR}sessions/s-old.jsonl`, old);
  adapter.files.set(`${DIR}index.json`, JSON.stringify({
    kind: 'quick-ask-index', activeSessionId: 's-old',
    sessions: [{ id: 's-old', title: '', created: '2026-09-12T10:00:00.000Z', lastActivity: '2026-09-12T10:00:00.000Z', order: 0 }],
  }));
  const store = new QuickAskSessionStore({ pluginData, scheduler: makeScheduler() });
  assert.equal((await store.readLog('s-old')).version, 1);

  const newer = '{"kind":"header","schemaVersion":99,"sessionId":"s-new","createdAt":"2026-09-12T10:00:00.000Z","config":{}}\n';
  adapter.files.set(`${DIR}sessions/s-new.jsonl`, newer);
  const newerStore = new QuickAskSessionStore({ pluginData: { pluginDirectory: PLUGIN_DIRECTORY, dataAdapter: adapter }, scheduler: makeScheduler() });
  await assert.rejects(() => newerStore.append('s-new', 'turn/started', {}), /newer Scholar Workbench/);
});

test('a lost index is rebuilt from the sessions directory, sorted by recent activity then creation then id', async () => {
  const adapter = makeDataAdapter();
  const header = (id, createdAt, config = {}) => JSON.stringify({ kind: 'header', schemaVersion: 1, sessionId: id, createdAt, config }) + '\n';
  const record = (seq, at, kind, payload = {}) => JSON.stringify({ seq, at, kind, payload }) + '\n';
  adapter.files.set(`${DIR}sessions/a.jsonl`, header('a', '2026-09-01T00:00:00.000Z') + record(0, '2026-09-10T00:00:00.000Z', 'turn/started'));
  adapter.files.set(`${DIR}sessions/b.jsonl`, header('b', '2026-09-02T00:00:00.000Z') + record(0, '2026-09-11T00:00:00.000Z', 'turn/started'));
  adapter.files.set(`${DIR}sessions/c.jsonl`, header('c', '2026-09-03T00:00:00.000Z') + record(0, '2026-09-11T00:00:00.000Z', 'turn/started'));
  adapter.files.set(`${DIR}sessions/broken.jsonl`, 'not json at all\n');
  adapter.files.set(`${DIR}sessions/notes.txt`, 'ignored');
  const store = new QuickAskSessionStore({
    pluginData: { pluginDirectory: PLUGIN_DIRECTORY, dataAdapter: adapter },
    scheduler: makeScheduler(),
  });
  const { index, reset } = await store.init();
  assert.equal(reset, true);
  // b and c share the most recent activity, and b was created earlier.
  assert.deepEqual(index.sessions.map((session) => session.id), ['b', 'c', 'a']);
  assert.equal(index.activeSessionId, 'b', 'the first rebuilt session becomes active');
  assert.equal(adapter.files.has(`${DIR}index.json`), true);
});

test('the rebuilt index cannot lose a session that the old index never listed', async () => {
  const adapter = makeDataAdapter();
  const header = (id, createdAt) => JSON.stringify({ kind: 'header', schemaVersion: 1, sessionId: id, createdAt, config: {} }) + '\n';
  adapter.files.set(`${DIR}sessions/kept.jsonl`, header('kept', '2026-09-01T00:00:00.000Z'));
  adapter.files.set(`${DIR}index.json`, JSON.stringify({
    kind: 'quick-ask-index', activeSessionId: 'gone',
    sessions: [{ id: 'gone', title: 'Gone', created: '2026-09-01T00:00:00.000Z', lastActivity: '', order: 0 }],
  }));
  const store = new QuickAskSessionStore({
    pluginData: { pluginDirectory: PLUGIN_DIRECTORY, dataAdapter: adapter },
    scheduler: makeScheduler(),
  });
  const sessions = await store.listSessions();
  assert.deepEqual(sessions.map((session) => session.id), ['gone'], 'a readable index stays authoritative');
  // Losing the index rebuilds from the session files and loses no session.
  adapter.files.delete(`${DIR}index.json`);
  const recovered = new QuickAskSessionStore({
    pluginData: { pluginDirectory: PLUGIN_DIRECTORY, dataAdapter: adapter },
    scheduler: makeScheduler(),
  });
  const rebuilt = await recovered.listSessions();
  assert.deepEqual(rebuilt.map((session) => session.id), ['kept']);
});

test('deleting a session removes its log and picks a new active session', async () => {
  const { store, adapter } = makeStore();
  const first = await store.createSession({});
  const second = await store.createSession({});
  assert.equal((await store.loadIndex()).activeSessionId, second.id);
  await store.delete(second.id);
  const index = await store.loadIndex();
  assert.deepEqual(index.sessions.map((session) => session.id), [first.id]);
  assert.equal(index.activeSessionId, first.id);
  assert.equal(adapter.files.has(`sessions/${second.id}.jsonl`), false);
});

test('renaming and deleting an inactive session preserves the active id and its log', async () => {
  const { store, adapter } = makeStore();
  const older = await store.createSession({ title: 'Older' });
  const current = await store.createSession({ title: 'Current' });
  await store.append(current.id, 'item/input', { item: { type: 'message', role: 'user', content: [{ text: 'Keep this history' }] } });
  const before = adapter.files.get(store.adapterPathFor(current.id));
  await store.rename(older.id, 'Renamed without switching');
  assert.equal((await store.loadIndex()).activeSessionId, current.id);
  await store.delete(older.id);
  assert.equal((await store.loadIndex()).activeSessionId, current.id);
  assert.equal(adapter.files.get(store.adapterPathFor(current.id)), before);
});

test('the title derives locally from the first ten characters of the first line', () => {
  assert.equal(deriveTitle('How do I cite this?\nsecond line'), 'How do I c');
  assert.equal(deriveTitle('short'), 'short');
  assert.equal(deriveTitle('   leading spaces trimmed\nmore'), 'leading sp');
  assert.equal(deriveTitle(''), '');
  assert.equal(deriveTitle(undefined), '');
});

test('session ordering is deterministic for equal activity and creation times', () => {
  const sessions = [
    { id: 'c', created: '2026-09-03T00:00:00.000Z', lastActivity: '2026-09-02T00:00:00.000Z' },
    { id: 'a', created: '2026-09-01T00:00:00.000Z', lastActivity: '2026-09-02T00:00:00.000Z' },
    { id: 'b', created: '2026-09-01T00:00:00.000Z', lastActivity: '2026-09-02T00:00:00.000Z' },
  ];
  // Equal activity falls back to creation time ascending, then session ID.
  assert.deepEqual(orderSessions(sessions).map((session) => session.id), ['a', 'b', 'c']);
  // A tie on both activity and creation falls back to the session ID.
  const tied = [
    { id: 'z', created: '2026-09-01T00:00:00.000Z', lastActivity: '2026-09-02T00:00:00.000Z' },
    { id: 'm', created: '2026-09-01T00:00:00.000Z', lastActivity: '2026-09-02T00:00:00.000Z' },
  ];
  assert.deepEqual(orderSessions(tied).map((session) => session.id), ['m', 'z']);
  // More recent activity always sorts first.
  assert.deepEqual(orderSessions([
    { id: 'old', created: '2026-09-01T00:00:00.000Z', lastActivity: '2026-09-01T00:00:00.000Z' },
    { id: 'new', created: '2026-09-09T00:00:00.000Z', lastActivity: '2026-09-09T00:00:00.000Z' },
  ]).map((session) => session.id), ['new', 'old']);
});

test('Chat Completions logs have a version boundary while existing Responses logs remain writable', async () => {
  const { store } = makeStore();
  const responses = await store.createSession({ config: { protocol: 'responses' } });
  const chat = await store.createSession({ config: { protocol: 'chat-completions' } });
  assert.equal(responses.header.schemaVersion, 1);
  assert.equal(chat.header.schemaVersion, 2);
  await store.append(responses.id, 'turn/started', { turnId: 'r' });
  await store.append(chat.id, 'turn/started', { turnId: 'c' });
  assert.equal((await store.readLog(chat.id)).records.length, 1);
});

test('import preserves a Chat Completions version and rejects a protocol/version mismatch', async () => {
  const { store } = makeStore();
  const header = { kind: 'header', schemaVersion: 2, sessionId: 'cc-import', title: 'CC', config: { protocol: 'chat-completions' } };
  await store.importSession({ id: 'cc-import', header, records: [], title: 'CC' });
  assert.equal((await store.readLog('cc-import')).header.config.protocol, 'chat-completions');
  await assert.rejects(store.importSession({ id: 'bad-import', header: { ...header, schemaVersion: 1 }, records: [], title: 'CC' }), /unsupported/);
});
