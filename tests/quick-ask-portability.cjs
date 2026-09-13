// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BACKUP_DIRECTORY, backupPaths, createPreservedCopy, serializeLog, sanitizeIndex,
  planImport, buildExport, parseExport, clearQuickAskData,
} = require('../src/quick-ask/portability');

function makeVault(files = {}) {
  const written = new Map(Object.entries(files));
  return {
    written,
    writes: [],
    async writeText(path, text) {
      written.set(path, String(text));
      this.writes.push({ path, text: String(text) });
    },
    async readText(path) { return written.get(path) ?? null; },
  };
}

function makePluginData(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    dataAdapter: {
      async read(path) { if (!store.has(path)) throw new Error(`ENOENT ${path}`); return store.get(path); },
      async write(path, data) { store.set(path, String(data)); },
      async append(path, data) { store.set(path, (store.get(path) ?? '') + String(data)); },
      async exists(path) { return store.has(path); },
      async mkdir() {},
      async remove(path) { store.delete(path); },
      async list(path) {
        const prefix = String(path).endsWith('/') ? String(path) : `${path}/`;
        return { files: [...store.keys()].filter((key) => key.startsWith(prefix)), folders: [] };
      },
      async stat() { return null; },
    },
  };
}

function makeSettings(overrides = {}) {
  return { preservedCopy: { enabled: true, directory: 'notes/quick-ask', ...overrides } };
}

test('the preserved copy mirrors under quick-ask-backup in the chosen folder', async () => {
  const vault = makeVault();
  const copy = createPreservedCopy({ pluginData: makePluginData(), vault, getSettings: () => makeSettings() });
  const result = await copy.syncSession({
    id: 's1',
    header: { kind: 'header', schemaVersion: 1, sessionId: 's1', createdAt: '2026-09-12T00:00:00.000Z', config: {} },
    records: [{ seq: 0, kind: 'turn/started', payload: {} }],
  });
  assert.equal(result.status, 'synced');
  assert.deepEqual(backupPaths('notes/quick-ask'), {
    base: `notes/quick-ask/${BACKUP_DIRECTORY}`,
    index: `notes/quick-ask/${BACKUP_DIRECTORY}/index.json`,
    sessions: `notes/quick-ask/${BACKUP_DIRECTORY}/sessions`,
  });
  assert.equal(vault.written.has(`notes/quick-ask/${BACKUP_DIRECTORY}/sessions/s1.jsonl`), true);
  const lines = vault.written.get(`notes/quick-ask/${BACKUP_DIRECTORY}/sessions/s1.jsonl`).trim().split('\n');
  assert.equal(lines.length, 2, 'the mirror keeps the header and the record');
});

test('the preserved copy is opt-in and does nothing while disabled', async () => {
  const vault = makeVault();
  const copy = createPreservedCopy({
    pluginData: makePluginData(), vault,
    getSettings: () => makeSettings({ enabled: false }),
  });
  assert.equal(copy.isEnabled(), false);
  assert.deepEqual(await copy.syncSession({ id: 's1', header: {}, records: [] }), { status: 'disabled' });
  assert.equal(vault.writes.length, 0);
  assert.equal(copy.status().unsynchronized, true);
});

test('the preserved copy never contains a secret value, only the reference', async () => {
  const vault = makeVault();
  const copy = createPreservedCopy({ pluginData: makePluginData(), vault, getSettings: () => makeSettings() });
  await copy.syncSession({
    id: 's1',
    header: {
      kind: 'header', schemaVersion: 1, sessionId: 's1', createdAt: '2026-09-12T00:00:00.000Z',
      config: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', secretId: 'openai-key', secretValue: 'sk-live-secret' },
    },
    records: [],
  });
  const text = vault.written.get(`notes/quick-ask/${BACKUP_DIRECTORY}/sessions/s1.jsonl`);
  assert.equal(text.includes('sk-live-secret'), false, 'a value on the input cannot survive the allowlist');
  assert.equal(text.includes('openai-key'), true, 'the secret reference is kept so the copy stays usable');
});

test('a backup failure is reported without failing the live session', async () => {
  const vault = { async writeText() { throw new Error('disk full'); }, async readText() { return null; } };
  const copy = createPreservedCopy({ pluginData: makePluginData(), vault, getSettings: () => makeSettings() });
  const result = await copy.syncSession({ id: 's1', header: { config: {} }, records: [] });
  assert.equal(result.status, 'failed');
  const status = copy.status();
  assert.equal(status.lastError, 'disk full');
  assert.equal(status.lastSuccessAt, null, 'no successful synchronization is claimed');
});

test('the mirrored index drops the volatile running and unread projections', () => {
  const index = sanitizeIndex({
    kind: 'quick-ask-index', activeSessionId: 's1',
    sessions: [{ id: 's1', title: 'First', created: 'c', lastActivity: 'a', order: 0, running: true, unread: true }],
  });
  assert.deepEqual(index.sessions[0], { id: 's1', title: 'First', created: 'c', lastActivity: 'a', order: 0 });
});

test('import adds missing sessions unchanged and renames a colliding one', () => {
  const planned = planImport({
    localIds: ['keep', 'clash'],
    backupSessions: [
      { id: 'fresh', title: 'Fresh' },
      { id: 'clash', title: 'Clashing' },
      { id: 'keep', title: 'Already here' },
    ],
  });
  assert.equal(planned[0].id, 'fresh');
  assert.equal(planned[0].sourceId, 'fresh');
  assert.equal(planned[0].collision, false);
  assert.equal(planned[1].collision, true);
  assert.notEqual(planned[1].id, 'clash', 'both sessions are preserved');
  assert.equal(planned[1].sourceId, 'clash', 'the backup id is still reachable');
  assert.match(planned[1].title, /（导入）$/);
  assert.equal(planned[2].collision, true, 'an existing id is never overwritten');
});

test('an export round-trips and carries secret references only', () => {
  const exported = buildExport({
    settings: { baseUrl: 'https://api.openai.com/v1', secretId: 'openai-key', secretValue: 'sk-secret' },
    index: { activeSessionId: 's1', sessions: [{ id: 's1', title: 'T', order: 0 }] },
    sessions: [{ id: 's1', header: { config: { model: 'gpt-5', secretId: 'openai-key', secretValue: 'sk-secret' } }, records: [{ seq: 0, kind: 'turn/started', payload: {} }] }],
  });
  const text = JSON.stringify(exported);
  assert.equal(text.includes('sk-secret'), false, 'a secret value never leaves the machine');
  // The reference name is kept so an import can be reconnected to the secret.
  assert.equal(text.includes('openai-key'), true);
  assert.equal(exported.settings.secretId, 'openai-key');
  assert.equal(exported.sessions[0].header.config.secretId, 'openai-key');
  const parsed = parseExport(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.export.sessions.length, 1);
  assert.equal(parsed.export.sessions[0].records.length, 1);
});

test('a malformed import is refused instead of partially applied', () => {
  assert.deepEqual(parseExport('not json'), { ok: false, reason: 'invalid-json' });
  assert.deepEqual(parseExport('{"kind":"other"}'), { ok: false, reason: 'not-an-export' });
  assert.deepEqual(parseExport('{"kind":"quick-ask-export"}'), { ok: false, reason: 'missing-sessions' });
});

test('clearing Quick Ask data removes local sessions and never a shared secret', async () => {
  const pluginData = makePluginData({
    'quick-ask/sessions/a.jsonl': 'x',
    'quick-ask/sessions/b.jsonl': 'y',
    'quick-ask/index.json': '{}',
  });
  const result = await clearQuickAskData({
    pluginData,
    sessionsDirectory: 'quick-ask/sessions',
    indexPath: 'quick-ask/index.json',
  });
  assert.equal(result.removed.length, 3);
  assert.equal(result.secretsDeleted, 0, 'a shared Obsidian Secret is never deleted');
  assert.equal([...pluginData.store.keys()].length, 0);
});

test('serializeLog keeps every record byte-identical', () => {
  const records = [
    { seq: 0, at: 'a', kind: 'turn/started', payload: { question: 'hi' } },
    { seq: 1, at: 'b', kind: 'turn/finished', payload: { state: 'complete' } },
  ];
  const text = serializeLog({ kind: 'header', sessionId: 's1', config: {} }, records);
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.slice(1), records);
});
