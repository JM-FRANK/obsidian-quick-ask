const { test } = require('node:test');
const assert = require('node:assert/strict');
const { droppedFilePaths, supportedReferences } = require('../src/quick-ask/file-input');

const uri = (file, vault = '测试库') => `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(file)}`;
const files = new Set(['论文/中文 文稿.md', '图/plot.png', 'a.pdf', 'a.md']);
const options = { vaultName: '测试库', resolvePath: path => files.has(path) ? path : files.has(`${path}.md`) ? `${path}.md` : null };
const transfer = (value, type = 'text/uri-list') => ({ getData: key => key === type ? value : '' });

test('file explorer open URIs resolve multiple local files, including encoded Chinese and omitted md', () => {
  const value = `# URI list\r\n${uri('论文/中文 文稿')}\r\n${uri('图/plot.png')}\r\n${uri('论文/中文 文稿')}`;
  assert.deepEqual(droppedFilePaths(transfer(value), options), ['论文/中文 文稿.md', '图/plot.png']);
  assert.deepEqual(droppedFilePaths(transfer(uri('a.pdf'), 'text/plain'), options), ['a.pdf']);
});

test('external files, foreign vaults, folder names, traversal and action URIs grant no file reference', () => {
  for (const value of [uri('a.md', 'other'), 'file:///a.md', 'https://example.com/a.md', 'folder',
    uri('../a.md'), uri('/a.md'), 'obsidian://new?vault=测试库&file=a.md', 'obsidian://open?path=/a.md', uri('missing.md')]) {
    assert.deepEqual(droppedFilePaths(transfer(value), options), [], value);
  }
});

test('unsupported references never enter the supported path set', () => {
  assert.deepEqual(supportedReferences(['a.pdf', 'a.md', 'b.PNG', 'note.MARKDOWN', 'a.md'], p => /\.(md|markdown)$/i.test(p)), ['a.md', 'note.MARKDOWN']);
});

test('the installable bundle resolves file-input without host or UI dependencies', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const standalone = fs.existsSync(path.join(__dirname, '../upstream.json'));
  const source = fs.readFileSync(path.join(__dirname, standalone ? '../main.js' : '../scholar-workbench/main.js'), 'utf8');
  const context = { module: { exports: {} }, URL, require: id => { throw new Error(`Unexpected host dependency: ${id}`); } };
  vm.runInNewContext(source.replace(standalone ? "return load('release/quick-ask/main');" : 'return load("./main");', standalone ? "return load('src/quick-ask/file-input');" : 'return load("./quick-ask/file-input");'), context);
  const actual = context.module.exports.droppedFilePaths(transfer(uri('a.pdf')), options);
  assert.deepEqual(Array.from(actual), ['a.pdf']);
});
