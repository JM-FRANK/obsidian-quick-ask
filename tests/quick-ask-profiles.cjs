// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuickAskSettings, applyQuickAskPatch, sessionConfigSnapshot, redactQuickAskSettings } = require('../src/quick-ask/settings');
const { activeProfile, profilePromptText, applyProfileAction, createProfileManager, profileName } = require('../src/quick-ask/profiles');
const { DEFAULT_ROLE_INSTRUCTIONS, buildInstructions } = require('../src/quick-ask/prompt-renderer');

function act(settings, action) { applyQuickAskPatch(settings, { profileAction: action }); }

test('normalization preserves legacy prompt bytes without mutating input or creating custom default text', () => {
  for (const prompt of ['', '  saved\nrole  ', DEFAULT_ROLE_INSTRUCTIONS]) {
    const input = { systemPrompt: prompt };
    const settings = normalizeQuickAskSettings(input);
    assert.deepEqual(input, { systemPrompt: prompt });
    assert.equal(settings.systemPrompt, prompt);
    assert.equal(activeProfile(settings).prompt, prompt);
    assert.equal(profilePromptText(activeProfile(settings)), prompt);
    assert.deepEqual(normalizeQuickAskSettings(settings), settings);
    assert.equal(buildInstructions({ rendererVersion: 3, customSystemPrompt: sessionConfigSnapshot(settings).systemPrompt }), buildInstructions({ rendererVersion: 3, customSystemPrompt: prompt }));
  }
  const fresh = normalizeQuickAskSettings();
  assert.equal(fresh.systemPrompt, '');
  assert.equal(profilePromptText(activeProfile(fresh)), DEFAULT_ROLE_INSTRUCTIONS);
  assert.deepEqual(normalizeQuickAskSettings(fresh), fresh);
});

test('add, edit, rename, select and delete preserve default and earlier session snapshots', () => {
  const settings = normalizeQuickAskSettings({ systemPrompt: 'Original role' });
  const originalSession = sessionConfigSnapshot(settings);
  act(settings, { type: 'add', id: 'reader', name: 'Reader' });
  act(settings, { type: 'prompt', id: 'reader', prompt: '  New\nrole  ' });
  const secondSession = sessionConfigSnapshot(settings);
  assert.equal(secondSession.systemPrompt, '  New\nrole  ');
  act(settings, { type: 'rename', id: 'reader', name: 'Close reader' });
  act(settings, { type: 'select', id: 'default' });
  assert.equal(settings.systemPrompt, 'Original role');
  act(settings, { type: 'select', id: 'reader' });
  assert.equal(settings.systemPrompt, '  New\nrole  ');
  act(settings, { type: 'delete', id: 'reader' });
  assert.equal(settings.activeSystemProfileId, 'default');
  assert.equal(settings.systemPrompt, 'Original role');
  assert.equal(originalSession.systemPrompt, 'Original role');
  assert.equal(secondSession.systemPrompt, '  New\nrole  ');
  assert.equal(secondSession.systemProfiles, undefined);
  assert.throws(() => act(settings, { type: 'delete', id: 'default' }), /keepDefault/);
});

test('invalid names and stale IDs never overwrite profiles; default rename is explicit and persists across languages', () => {
  const settings = normalizeQuickAskSettings();
  for (const name of ['', '  ', 'Default']) assert.throws(() => act(settings, { type: 'add', id: 'x', name }), /invalidName/);
  act(settings, { type: 'add', id: 'x', name: 'Reader' });
  assert.throws(() => act(settings, { type: 'rename', id: 'default', name: 'reader' }), /invalidName/);
  assert.throws(() => act(settings, { type: 'select', id: 'gone' }), /missing/);
  act(settings, { type: 'rename', id: 'default', name: 'My default' });
  const profile = settings.systemProfiles.find(p => p.id === 'default');
  assert.equal(profileName(profile, { language: 'zh-CN' }), 'My default');
  assert.equal(profileName(profile, { language: 'en' }), 'My default');
});

test('profiles survive export, import, reload and legacy field edits', () => {
  const settings = normalizeQuickAskSettings();
  act(settings, { type: 'add', id: 'x', name: 'X' });
  act(settings, { type: 'prompt', id: 'x', prompt: 'custom' });
  act(settings, { type: 'select', id: 'default' });
  const copy = normalizeQuickAskSettings();
  applyQuickAskPatch(copy, redactQuickAskSettings(settings));
  assert.deepEqual(copy, settings);
  applyQuickAskPatch(copy, { systemPrompt: 'legacy edit' });
  assert.equal(activeProfile(copy).prompt, 'legacy edit');
  assert.equal(profilePromptText(activeProfile(copy)), 'legacy edit');
  const reloaded = normalizeQuickAskSettings(JSON.parse(JSON.stringify(copy)));
  assert.deepEqual(reloaded, copy);
});

test('profile manager serializes edits and continues after failed persistence without mutating settings', async () => {
  let settings = normalizeQuickAskSettings();
  const notices = [];
  let fail = true;
  const manager = createProfileManager({ getSettings: () => ({ quickAsk: settings }),
    write: async patch => {
      if (fail) { fail = false; throw new Error('disk'); }
      const next = normalizeQuickAskSettings(settings);
      act(next, patch.profileAction); settings = next;
    }, changed: () => {}, notice: message => notices.push(message),
  });
  await manager.run({ type: 'add', id: 'failed', name: 'Failed' });
  assert.equal(settings.systemProfiles.length, 1);
  const add = manager.run({ type: 'add', id: 'ok', name: 'OK' });
  const edit1 = manager.run({ type: 'prompt', id: 'ok', prompt: 'a' });
  const edit2 = manager.run({ type: 'prompt', id: 'ok', prompt: 'ab' });
  await Promise.all([add, edit1, edit2]);
  assert.equal(settings.systemPrompt, 'ab');
  assert.deepEqual(notices, ['profiles.saveFailed', 'profiles.newSessionsOnly']);
  manager.dispose();
});

test('profile actions own the legacy mirror even when a patch includes conflicting fields', () => {
  const settings = normalizeQuickAskSettings();
  applyQuickAskPatch(settings, { profileAction: { type: 'prompt', id: 'default', prompt: 'Action role' }, systemPrompt: 'Conflicting legacy role' });
  assert.equal(settings.systemPrompt, 'Action role');
  assert.equal(activeProfile(settings).prompt, 'Action role');
  applyQuickAskPatch(settings, { profileAction: { type: 'reset', id: 'default' }, systemPrompt: 'Conflict' });
  assert.equal(settings.systemPrompt, '');
  assert.equal(activeProfile(settings).showDefaultRole, true);
});

test('load normalization reconciles legacy edits once and preserves the default display sentinel', () => {
  const fresh = normalizeQuickAskSettings();
  const changed = { ...fresh, systemPrompt: 'Edited by old client' };
  const normalized = normalizeQuickAskSettings(changed);
  assert.equal(activeProfile(normalized).prompt, 'Edited by old client');
  assert.equal(activeProfile(normalized).showDefaultRole, false);
  assert.equal(changed.systemProfiles[0].prompt, '', 'normalization cannot mutate the saved object');
  assert.deepEqual(normalizeQuickAskSettings(normalized), normalized);
  act(normalized, { type: 'rename', id: 'default', name: 'Renamed' });
  assert.equal(normalized.systemPrompt, 'Edited by old client');
  assert.equal(activeProfile(normalizeQuickAskSettings(fresh)).showDefaultRole, true);
});

test('catalog-only import and selection-only patches atomically update the request mirror', () => {
  const settings = normalizeQuickAskSettings();
  applyQuickAskPatch(settings, { systemProfiles: [
    { id: 'default', name: null, prompt: '', showDefaultRole: true },
    { id: 'reader', name: 'Reader', prompt: 'Read closely' },
  ], activeSystemProfileId: 'reader' });
  assert.equal(settings.systemPrompt, 'Read closely');
  assert.equal(activeProfile(settings).prompt, 'Read closely');
  applyQuickAskPatch(settings, { activeSystemProfileId: 'default' });
  assert.equal(settings.systemPrompt, '');
  assert.equal(activeProfile(settings).showDefaultRole, true);
});

test('subscriptions survive page construction and stop after an observed detach', async () => {
  const values = { quickAsk: normalizeQuickAskSettings() };
  const manager = createProfileManager({ getSettings: () => values,
    write: async patch => applyQuickAskPatch(values.quickAsk, patch), changed() {}, notice() {},
  });
  const constructing = { isConnected: false }, mounted = { isConnected: true };
  let first = 0, second = 0;
  manager.watch(constructing, () => first++);
  manager.watch(mounted, () => second++);
  const refresh = () => manager.run({ type: 'select', id: 'default' });
  await refresh();
  assert.deepEqual([first, second], [0, 1]);
  constructing.isConnected = true;
  await refresh();
  assert.deepEqual([first, second], [1, 2]);
  constructing.isConnected = false;
  await refresh();
  constructing.isConnected = true;
  await refresh();
  assert.deepEqual([first, second], [1, 4], 'detached rows require a new subscription');
  manager.watch(constructing, () => first++);
  await refresh();
  assert.deepEqual([first, second], [2, 5]);
  manager.dispose();
  await refresh();
  assert.deepEqual([first, second], [2, 5]);
});
