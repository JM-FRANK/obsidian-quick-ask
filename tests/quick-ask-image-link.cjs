// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { documentImagePath } = require('../src/quick-ask/image-link');
const { createToolExecutor, GET_IMAGE_TOOL } = require('../src/quick-ask/tool');
const sourcePath = 'file01/file11/paper.md';

test('image link adapter resolves one exact path for Markdown and wikilinks', () => {
  for (const [text, path, expected] of [
    ['![figure](./attachments/pic01.png)', './attachments/pic01.png', 'file01/file11/attachments/pic01.png'],
    ['![[./attachments/pic01.png|100]]', '![[./attachments/pic01.png|100]]', 'file01/file11/attachments/pic01.png'],
    ['![a](../shared/a%20b.png "title")', '../shared/a%20b.png', 'file01/shared/a b.png'],
    ['![a](<./attachments/a b.png>)', '![a](<./attachments/a b.png>)', 'file01/file11/attachments/a b.png'],
    ['![a](./attachments/a(b).png)', './attachments/a(b).png', 'file01/file11/attachments/a(b).png'],
    ['[a](attachments/a.png)', 'attachments/a.png', 'file01/file11/attachments/a.png'],
    ['![Figure 1](attachments/fig_01.jpg)', 'attachments/fig_01.jpg', 'file01/file11/attachments/fig_01.jpg'],
    ['![a](pic01.png)', 'pic01.png', 'file01/file11/pic01.png'],
    ['![a](attachments/a%20b.png)', 'attachments/a%20b.png', 'file01/file11/attachments/a b.png'],
    ['![a][fig]\n\n[fig]: attachments/a.png', '![a][fig]', 'file01/file11/attachments/a.png'],
    ['![[attachments/a.png#fragment|200]]', 'attachments/a.png#fragment', 'attachments/a.png'],
    ['![a](./attachments/a%23b.png)', './attachments/a%23b.png', 'file01/file11/attachments/a#b.png'],
    ['![a][fig]\n\n[fig]: ./attachments/a.png', '![a][fig]', 'file01/file11/attachments/a.png'],
    ['![a][]\n\n[a]: ./attachments/a.png', './attachments/a.png', 'file01/file11/attachments/a.png'],
  ]) assert.equal(documentImagePath(sourcePath, path, text), expected);
});

test('image link adapter denies fabricated links, literal examples, external paths and Vault escapes', () => {
  for (const text of ['no image', '`![a](./a.png)`', '```md\n![[./a.png]]\n```', '    ![[./a.png]]', '\\![[./a.png]]', '<!-- ![[./a.png]] -->', '%% ![[./a.png]] %%']) {
    assert.throws(() => documentImagePath(sourcePath, './a.png', text));
  }
  for (const path of ['../../../a.png', './%2e%2e/%2e%2e/%2e%2e/a.png', 'https://host/a.png', '//host/a.png', '/a.png', './a\\b.png', './a%00.png', './a%ZZ.png', './a.svg']) {
    assert.throws(() => documentImagePath(sourcePath, path, `![a](${path})`), path);
  }
  for (const source of ['/paper.md', '../paper.md', 'a/../paper.md', 'a.txt']) assert.throws(() => documentImagePath(source, './a.png', '![[./a.png]]'));
});

test('document image tool fails on the missing exact image instead of reading a sibling with the same name', async () => {
  for (const prefix of ['./', '']) {
    const reads = [], textReads = [];
    const available = new Set(['file01/file11/attachments/pic01.png', 'file01/file12/attachments/pic01.png', 'attachments/pic01.png']);
    const executor = createToolExecutor({
      vault: { readText: async path => { textReads.push(path); return `![a](${prefix}attachments/pic01.png)`; } },
      images: { readForSend: async ([path]) => {
        reads.push(path);
        if (!available.has(path)) throw Object.assign(new Error('sibling exists, but must not be read'), { code: 'IMAGE_MISSING' });
        return [{ path }];
      } },
    });
    const call = { name: 'get-image', arguments: { sourcePath, path: `${prefix}attachments/pic01.png` } };
    const begin = () => executor.createQuestionState({ allowlist: [sourcePath] });
    const denied = await executor.executeCall(call, { question: executor.createQuestionState() });
    assert.equal(denied.ok, false); assert.deepEqual(textReads, []); assert.deepEqual(reads, []);
    const success = await executor.executeCall(call, { question: begin() });
    assert.deepEqual(success.imagePaths, ['file01/file11/attachments/pic01.png']);
    available.delete('file01/file11/attachments/pic01.png');
    const failed = await executor.executeCall(call, { question: begin(), normalizePath: () => 'file01/file12/attachments/pic01.png' });
    assert.equal(failed.ok, false); assert.equal(failed.output, 'Image read failed (IMAGE_MISSING).');
    assert.ok(available.has('file01/file12/attachments/pic01.png'));
    assert.ok(available.has('attachments/pic01.png'), 'an existing root-level path is not a fallback either');
    assert.deepEqual(reads, ['file01/file11/attachments/pic01.png', 'file01/file11/attachments/pic01.png']);
  }
});

test('only linked images inherit document permission; successful paths can be read directly in the same question', async () => {
  let text = '![[./a.png]]';
  const reads = [];
  const executor = createToolExecutor({ vault: { readText: async () => text }, images: { readForSend: async ([path]) => { reads.push(path); return [{ path }]; } } });
  const question = executor.createQuestionState({ allowlist: [sourcePath], callLimit: 6 });
  const run = args => executor.executeCall({ name: 'get-image', arguments: args }, { question });
  assert.equal((await run({ sourcePath, path: './secret.png' })).ok, false);
  assert.equal((await run({ sourcePath, path: './a.png' })).ok, true);
  assert.equal((await run({ sourcePath: null, path: 'file01/file11/a.png' })).ok, true);
  text = '';
  assert.equal((await run({ sourcePath, path: './a.png' })).ok, false);
  assert.equal(reads.length, 2);
  text = null;
  assert.match((await run({ sourcePath, path: './a.png' })).output, /IMAGE_MISSING/);
  assert.equal(question.reads.size, 0, 'reading source Markdown must not change tracked baselines');
  assert.equal(GET_IMAGE_TOOL.strict, true);
  assert.deepEqual(GET_IMAGE_TOOL.parameters.required, ['path', 'sourcePath']);
  assert.equal(GET_IMAGE_TOOL.parameters.additionalProperties, false);
});
