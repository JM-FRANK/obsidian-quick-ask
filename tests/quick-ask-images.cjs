// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { imageMime, imagePaths, prepareImages, validateImageBatch, createImageCache, initializeImageCache } = require('../src/quick-ask/images');

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

test('image sources accept supported formats and only safe Vault paths', () => {
  assert.equal(imageMime('论文/FIGURE.PNG'), 'image/png');
  assert.equal(imageMime('a.jpeg'), 'image/jpeg');
  assert.equal(imageMime('a.webp'), 'image/webp');
  for (const path of ['a.gif', 'a.svg', 'a.heic']) assert.equal(imageMime(path), null);
  assert.deepEqual(imagePaths(['a.png', 'a.png', 'b.jpg']), ['a.png', 'b.jpg']);
  for (const path of ['/tmp/a.png', '../a.png', 'a/../b.png', 'C:\\a.png', 'a\n.png'])
    assert.throws(() => imagePaths([path]), /IMAGE_PATH/);
});

test('original bytes are sent as data URLs and reread on explicit retries', async () => {
  let bytes = PNG;
  const source = { stat: async () => ({ size: bytes.length }), readBinary: async () => bytes };
  const first = await prepareImages(['a.png'], source);
  assert.equal(first[0].url, `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`);
  bytes = Uint8Array.from([...PNG, 4]);
  assert.notEqual((await prepareImages(['a.png'], source))[0].url, first[0].url);
  source.stat = async () => null;
  await assert.rejects(prepareImages(['a.png'], source), /IMAGE_MISSING/);
  await assert.rejects(prepareImages(['a.jpg'], { stat: async () => ({ size: PNG.length }), readBinary: async () => PNG }), /IMAGE_FORMAT/);
});

test('byte/count boundaries are inclusive and checked before reading oversized files', async () => {
  const MiB = 1024 * 1024;
  validateImageBatch(Array.from({ length: 20 }, () => ({ size: 10 * MiB })));
  validateImageBatch([{ size: 20 * MiB }]);
  assert.throws(() => validateImageBatch([{ size: 20 * MiB + 1 }]), /IMAGE_SIZE/);
  assert.throws(() => validateImageBatch(Array.from({ length: 21 }, () => ({ size: 1 }))), /IMAGE_COUNT/);
  assert.throws(() => validateImageBatch(Array.from({ length: 11 }, () => ({ size: 20 * MiB }))), /IMAGE_TOTAL/);
  let reads = 0;
  await assert.rejects(prepareImages(['a.png'], { stat: async () => ({ size: 21 * MiB }), readBinary: async () => { reads++; } }), /IMAGE_SIZE/);
  assert.equal(reads, 0);
});

test('startup cleanup stays inside the image cache and runs once per application lifetime', async () => {
  const app = {}, session = new WeakMap();
  let cleanups = 0, finish;
  const first = initializeImageCache(session, app, 'plugin', () => { cleanups++; return new Promise(resolve => { finish = resolve; }); });
  const reload = initializeImageCache(session, app, 'plugin', () => { cleanups++; });
  assert.equal(reload, first);
  let ready = false;
  reload.then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  finish(); await reload;
  assert.equal(cleanups, 1);
  await initializeImageCache(session, {}, 'plugin', () => { cleanups++; });
  assert.equal(cleanups, 2);
  const files = new Map([['plugin/quick-ask/image-cache/old.png', PNG], ['papers/keep.png', PNG], ['plugin/quick-ask/sessions/s.jsonl', 'log']]);
  const adapter = {
    mkdir: async () => {}, exists: async path => files.has(path),
    writeBinary: async (path, bytes) => files.set(path, bytes),
    list: async () => ({ files: ['plugin/quick-ask/image-cache/old.png', 'papers/keep.png'], folders: [] }),
    remove: async path => files.delete(path),
  };
  const cache = createImageCache({ adapter, directory: 'plugin/quick-ask/image-cache', id: () => 'unique' });
  await cache.clear();
  assert.equal(files.has('papers/keep.png'), true);
  assert.equal(files.has('plugin/quick-ask/sessions/s.jsonl'), true);
  assert.equal(files.has('plugin/quick-ask/image-cache/old.png'), false);
  assert.equal(await cache.add({ name: 'external.png', bytes: PNG }), 'plugin/quick-ask/image-cache/unique.png');
  assert.deepEqual(files.get('plugin/quick-ask/image-cache/unique.png'), PNG.buffer);
});


test('changed sources exceeding the actual total are rejected before encoding further images', async () => {
  const bytes = new Uint8Array(20 * 1024 * 1024);
  bytes.set(PNG);
  let encodes = 0;
  await assert.rejects(prepareImages(Array.from({ length: 20 }, (_, at) => `a${at}.png`), {
    stat: async () => ({ size: 10 * 1024 * 1024 }), readBinary: async () => bytes,
    encodeBase64: () => { encodes++; return 'encoded'; },
  }), /IMAGE_TOTAL/);
  assert.equal(encodes, 10);
});

test('asynchronous acquisition commits to its owner, rejects concurrent overflow and never recreates deleted drafts', () => {
  const { appendImageDraft } = require('../src/quick-ask/image-drafts');
  const empty = () => ({ composer: '', pending: { files: [], selections: [] }, images: [] });
  const drafts = new Map([['a', empty()], ['b', { ...empty(), images: Array.from({ length: 20 }, (_, at) => `b${at}.png`) }]]);
  appendImageDraft(drafts, 'a', ['a.png']);
  assert.deepEqual(drafts.get('a').pending.images, ['a.png']);
  assert.equal(drafts.get('b').images.length, 20);
  appendImageDraft(drafts, 'a', Array.from({ length: 19 }, (_, at) => `extra${at}.png`));
  assert.throws(() => appendImageDraft(drafts, 'a', ['too-many.png']), /IMAGE_COUNT/);
  drafts.delete('a');
  assert.equal(appendImageDraft(drafts, 'a', ['late.png']), null);
  assert.equal(drafts.has('a'), false);
});
