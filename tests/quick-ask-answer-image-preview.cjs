// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { answerImagePreview } = require('../src/quick-ask/answer-image-preview');

function snapshot(image = {}, event = {}) {
  return { active: true, event: { button: 0, ...event },
    image: { contained: true, excluded: false, naturalWidth: 640,
      currentSrc: 'app://local/attachments/figure.png', src: 'app://local/attachments/figure.png',
      alt: 'Figure', title: '', ...image } };
}

test('preview uses the native selected resource without resolving or changing its path', () => {
  for (const resource of [
    'https://images.example/figure.png?width=640&signature=a%2Fb#part',
    'app://local/vault/notes/attachments/a%20b%23c.png',
    'app://local/vault/shared/%E5%9B%BE.png?mtime=123',
    'file:///tmp/a%20b.png', 'blob:app://obsidian/example',
    'data:image/png;base64,aGVsbG8=',
  ]) {
    const input = snapshot({ currentSrc: resource, src: 'https://images.example/fallback.png' });
    const before = structuredClone(input);
    assert.deepEqual(answerImagePreview(input), { resource, label: 'Figure' });
    assert.deepEqual(input, before, 'preview must not rewrite source metadata');
  }
});

test('relative Markdown and wiki sources cannot override the host-resolved currentSrc', () => {
  const resource = 'app://local/vault/notes/assets/a%20b.png';
  for (const source of ['./assets/a%20b.png', '../notes/assets/a%20b.png', '![[assets/a b.png|200]]']) {
    assert.equal(answerImagePreview(snapshot({ currentSrc: resource, src: source })).resource, resource);
  }
  assert.equal(answerImagePreview(snapshot({ currentSrc: '', src: resource })).resource, resource);
  assert.equal(answerImagePreview(snapshot({ currentSrc: '', src: '' })), null);
});

test('fresh, historical and delayed-image snapshots produce identical preview requests', () => {
  const image = { currentSrc: 'https://example.test/image.png', alt: 'Original caption' };
  const fresh = snapshot(image);
  const history = structuredClone(fresh);
  const delayed = snapshot({ ...image, naturalWidth: 0 });
  assert.equal(answerImagePreview(delayed), null);
  delayed.image.naturalWidth = fresh.image.naturalWidth;
  assert.deepEqual(answerImagePreview(fresh), answerImagePreview(history));
  assert.deepEqual(answerImagePreview(fresh), answerImagePreview(delayed));
});

test('viewer labels prefer alt then title then the translated fallback', () => {
  for (const [alt, title, expected] of [['Figure', 'Title', 'Figure'], ['', 'Title', 'Title'], ['', '', '查看图片']]) {
    assert.equal(answerImagePreview(snapshot({ alt, title }), '查看图片').label, expected);
  }
});

test('modified, secondary and already-handled clicks remain with their existing handlers', () => {
  for (const event of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
    { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
    assert.equal(answerImagePreview(snapshot({}, event)), null, JSON.stringify(event));
  }
});

test('unloaded roots, non-image targets, foreign roots and failed images cannot open previews', () => {
  assert.equal(answerImagePreview(), null);
  assert.equal(answerImagePreview({ ...snapshot(), active: false }), null);
  assert.equal(answerImagePreview({ ...snapshot(), image: null }), null);
  assert.equal(answerImagePreview(snapshot({ contained: false })), null);
  for (const naturalWidth of [0, undefined, NaN]) assert.equal(answerImagePreview(snapshot({ naturalWidth })), null);
});

