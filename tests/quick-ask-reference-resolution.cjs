// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReferenceResolver } = require('../src/quick-ask/reference-resolution');

test('resolve actual files before classification, with stable root context and no reads', () => {
  const files = new Set(['bb/a.md', 'notes/a.markdown', 'images/a.PNG', 'paper.pdf', '.obsidian/secret.md']);
  const calls = [];
  const resolve = createReferenceResolver({
    exactPath: path => files.has(path) ? path : null,
    linkPath: (path, source) => {
      calls.push([path, source]);
      return { 'bb/a': 'bb/a.md', 'short': 'notes/a.markdown', 'hidden': '.obsidian/secret.md' }[path] ?? null;
    },
    resolveRole: path => /\.(md|markdown)$/i.test(path) ? 'markdown' : /\.png$/i.test(path) ? 'image' : null,
    isExcluded: path => path === '.obsidian' || path.startsWith('.obsidian/'),
  });
  assert.deepEqual(resolve('bb/a'), { path: 'bb/a.md', role: 'markdown', status: 'supported' });
  assert.deepEqual(calls, [['bb/a', '']]);
  assert.deepEqual(resolve('bb/a.md'), resolve('bb/a'));
  for (const reference of ['bb/a.md|test', 'bb/a.md#title1', 'bb/a.md#title1|test', 'bb/a#title1|test', 'bb/a.md#title1#title2|test', 'bb/a.md#^block|test']) {
    assert.deepEqual(resolve(reference), { path: 'bb/a.md', role: 'markdown', status: 'supported' });
  }
  assert.equal(resolve('short').path, 'notes/a.markdown');
  assert.equal(resolve('images/a.PNG|preview').role, 'image');
  assert.deepEqual(resolve('paper.pdf'), { path: 'paper.pdf', role: null, status: 'unsupported' });
  for (const path of ['missing', '`aa/c`', 'hidden', '.obsidian/secret.md', '/tmp/a.md', 'a\\b.md', 'a\nb.md', '#title1', '#title1|test', '|test', 'missing#title1|test']) {
    assert.deepEqual(resolve(path), { path: null, role: null, status: 'missing' });
  }
});

test('omitted extension reaches the request as one real file, while literal and invalid text survive', async () => {
  const { EditorState } = require('@codemirror/state');
  const { fileReferenceField, questionText, referencedPaths, removeReferences } = require('../src/quick-ask/composer-state');
  const { createContextTracker } = require('../src/quick-ask/tracking');
  const { renderTurn, RENDERER_VERSION } = require('../src/quick-ask/prompt-renderer');
  const reads = [];
  const vault = {
    normalizePath: path => path,
    exists: path => path === 'bb/a.md',
    resolveRole: path => path === 'bb/a.md' ? 'markdown' : null,
    readText: async path => { reads.push(path); return path === 'bb/a.md' ? '正文' : null; },
  };
  const resolve = createReferenceResolver({
    exactPath: path => ['bb/a.md', 'paper.pdf'].includes(path) ? path : null,
    linkPath: path => path === 'bb/a' ? 'bb/a.md' : null,
    resolveRole: vault.resolveRole,
    isExcluded: () => false,
  });
  const state = EditorState.create({
    doc: '看看 [[bb/a]] [[bb/a.md]] [[bb/a.md|test]] [[bb/a.md#title1]] [[bb/a#title1|test]] `[[bb/a]]` [[`aa/c`]] [[missing]] [[paper.pdf]]',
    extensions: [fileReferenceField],
  });
  const supported = path => resolve(path).status === 'supported';
  const tracker = createContextTracker({ vault, scheduler: { now: () => 0 }, onEvent() {} });
  tracker.replacePending({ references: referencedPaths(state, supported, path => resolve(path).path), selections: [] });
  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(reads, ['bb/a.md']);
  assert.deepEqual(mutations, [
    { kind: 'file', path: 'bb/a.md', text: '正文' },
    { kind: 'reference', path: 'bb/a.md' },
  ]);
  const turn = renderTurn({ mutations, question: questionText(state, supported), rendererVersion: RENDERER_VERSION });
  assert.equal(turn[0].content[0].text,
    '<quick_ask_context>\n<context_file path="bb/a.md" content_length="6" original_length="2" line_numbers="physical">\n1 | 正文\n</context_file>\n<context_file_reference path="bb/a.md" />\n</quick_ask_context>');
  assert.equal(turn[1].content[0].text, '看看 `[[bb/a]]` [[`aa/c`]] [[missing]] [[paper.pdf]]');
  const removed = state.update(removeReferences(state, 'bb/a.md', path => resolve(path).path)).state;
  assert.deepEqual(referencedPaths(removed, supported, path => resolve(path).path), []);
  assert.equal(questionText(removed, supported), turn[1].content[0].text);
});
