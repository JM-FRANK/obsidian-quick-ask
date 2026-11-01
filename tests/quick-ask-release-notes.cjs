// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { UPDATE_NOTICE, RELEASES_URL, releaseTagFor, releasePageUrl, releaseNoticePlan, fetchReleaseNotes } = require('../src/quick-ask/release-notes');
const { QuickAskSettings } = require('../release/quick-ask/settings-store');
const { t } = require('../src/quick-ask/i18n');

test('the local notice is independent of release descriptions and supports an optional preview invitation', () => {
  assert.deepEqual(UPDATE_NOTICE.message, { en: '', 'zh-CN': '' });
  assert.equal(UPDATE_NOTICE.showPreview, true);
  assert.equal(RELEASES_URL, 'https://github.com/JM-FRANK/obsidian-quick-ask/releases');
  assert.equal(releaseTagFor('1.0.7'), '1.0.7');
  assert.equal(releaseTagFor('1.1.0', '1.1.0-beta.2'), '1.1.0-beta.2');
  assert.equal(releasePageUrl('1.1.0-beta.2'), `${RELEASES_URL}/tag/1.1.0-beta.2`);
  assert.throws(() => releaseTagFor('1.0.7', '1.1.0-beta.2'), /match the manifest/);
});

test('first installation or first use establishes the current version without a popup', () => {
  for (const saved of [undefined, null, '', 'invalid']) {
    assert.deepEqual(releaseNoticePlan('1.0.8', saved), { remember: true, show: false });
  }
});

test('an upgrade opens once; same-tag reload and downgrade stay quiet, including preview tags', () => {
  assert.deepEqual(releaseNoticePlan('1.0.8', '1.0.7'), { remember: true, show: true });
  assert.deepEqual(releaseNoticePlan('1.0.8', '1.0.8'), { remember: false, show: false });
  assert.deepEqual(releaseNoticePlan('1.0.7', '1.0.8'), { remember: false, show: false });
  assert.deepEqual(releaseNoticePlan('1.1.0-beta.2', '1.1.0-beta.1'), { remember: true, show: true });
  assert.deepEqual(releaseNoticePlan('1.1.0-beta.2', '1.1.0-beta.2'), { remember: false, show: false });
  assert.deepEqual(releaseNoticePlan('1.1.0', '1.1.0-rc.1'), { remember: true, show: true });
});

test('version comparison is numeric and invalid current versions do not overwrite the marker', () => {
  assert.deepEqual(releaseNoticePlan('1.0.10', '1.0.9'), { remember: true, show: true });
  assert.deepEqual(releaseNoticePlan('1.0.9', '1.0.10'), { remember: false, show: false });
  assert.deepEqual(releaseNoticePlan('invalid', '1.0.7'), { remember: false, show: false });
});

test('GitHub loading requests the exact installed tag and preserves its Markdown body', async () => {
  const markdown = '# Release\r\n\r\n- 中文 **update**\r\n\r\n[Details](https://example.test/)';
  const requests = [];
  assert.equal(await fetchReleaseNotes('1.1.0-beta.2', async options => {
    requests.push(options);
    return { status: 200, json: { tag_name: '1.1.0-beta.2', draft: false, body: markdown } };
  }), markdown);
  assert.deepEqual(requests, [{ url: 'https://api.github.com/repos/JM-FRANK/obsidian-quick-ask/releases/tags/1.1.0-beta.2',
    headers: { Accept: 'application/vnd.github+json' }, throw: false }]);
  assert.equal(await fetchReleaseNotes('1.0.7', async () => ({ status: 200, json: { tag_name: '1.0.7', body: null } })), '');
});

test('unpublished, rate-limited and failed requests never substitute another release', async () => {
  for (const status of [404, 403, 500]) {
    await assert.rejects(fetchReleaseNotes('1.0.7', async () => ({ status })), error => error.status === status);
  }
  await assert.rejects(fetchReleaseNotes('1.0.7', async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(fetchReleaseNotes('1.0.7', async () => ({ status: 200, json: { tag_name: '1.0.6', body: 'wrong release' } })), /Invalid release/);
  assert.equal(await fetchReleaseNotes('1.0.7', async () => ({ status: 200, json: { tag_name: '1.0.7', body: 'Recovered' } })), 'Recovered');
});

test('release-note metadata persists alongside settings and survives unrelated updates and reload', async () => {
  let disk;
  const settings = new QuickAskSettings({ language: 'zh-CN', quickAsk: { display: { fontSize: 18 } } }, async value => { disk = structuredClone(value); });
  await Promise.all([
    settings.update({ lastSeenReleaseNotesVersion: '1.0.7' }),
    settings.update({ quickAsk: { display: { showUsage: false } } }),
  ]);
  assert.equal(disk.lastSeenReleaseNotesVersion, '1.0.7');
  assert.equal(disk.language, 'zh-CN');
  assert.equal(disk.quickAsk.display.fontSize, 18);
  assert.equal(disk.quickAsk.display.showUsage, false);
  const reopened = new QuickAskSettings(disk, async () => {});
  assert.deepEqual(releaseNoticePlan('1.0.7', reopened.values().lastSeenReleaseNotesVersion), { remember: false, show: false });
});

test('failed metadata persistence leaves saved settings intact and remains retryable', async () => {
  let fail = true;
  const settings = new QuickAskSettings({ lastSeenReleaseNotesVersion: '1.0.7' }, async () => { if (fail) throw new Error('write failed'); });
  await assert.rejects(settings.update({ lastSeenReleaseNotesVersion: '1.0.8' }), /write failed/);
  assert.equal(settings.values().lastSeenReleaseNotesVersion, '1.0.7');
  fail = false;
  await settings.update({ lastSeenReleaseNotesVersion: '1.0.8' });
  assert.equal(settings.values().lastSeenReleaseNotesVersion, '1.0.8');
});

test('the shell and preview invitation have English and Chinese text', () => {
  for (const language of ['en', 'zh-CN']) for (const key of ['command', 'title', 'empty', 'releaseHeading', 'releaseLink', 'loading', 'failed', 'notPublished', 'previewTitle', 'previewDescription', 'previewCompatibility', 'previewLink']) {
    const value = t(language, `updates.${key}`, { version: '1.0.7' });
    assert.notEqual(value, `updates.${key}`);
    assert.equal(value.includes('{version}'), false);
  }
});
