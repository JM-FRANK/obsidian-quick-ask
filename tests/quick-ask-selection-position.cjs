// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectionUnitPosition, withSelectionUnits } = require('../src/quick-ask/selection-position');
const { renderTurn, renderContextEnvelope, buildInstructions, RENDERER_VERSION } = require('../src/quick-ask/prompt-renderer');
const { protocolFor, messageText } = require('../src/quick-ask/protocol');
const { createContextProjection } = require('../src/quick-ask/context-projection');

function position(text, selected) {
  const from = text.indexOf(selected);
  return selectionUnitPosition(text, from, from + selected.length);
}

test('Han characters and English words share a one-based index without counting spaces or punctuation', () => {
  assert.deepEqual(position('我喜欢 machine learning。', 'learning'), { startLine: 1, startUnit: 5 });
  assert.deepEqual(position('hi，中文word!', '文'), { startLine: 1, startUnit: 3 });
  assert.deepEqual(position('hello,   world!', 'world'), { startLine: 1, startUnit: 2 });
  assert.deepEqual(position("can't stop", 'stop'), { startLine: 1, startUnit: 2 });
  assert.deepEqual(position('a-b 123', '123'), { startLine: 1, startUnit: 3 });
});

test('partial words keep their word index; leading punctuation uses the first selected unit', () => {
  assert.deepEqual(position('we study learning', 'arning'), { startLine: 1, startUnit: 3 });
  assert.deepEqual(position('hello,  world!', ',  world'), { startLine: 1, startUnit: 2 });
  assert.deepEqual(position('hello,  world!', ',  '), { startLine: 1, startUnit: null });
});

test('units handle supplementary Han, combining letters, emoji and physical CRLF lines', () => {
  assert.deepEqual(position('𠀀中文 study', 'study'), { startLine: 1, startUnit: 4 });
  assert.deepEqual(position('cafe\u0301 next', 'next'), { startLine: 1, startUnit: 2 });
  assert.deepEqual(position('x 👨‍👩‍👧‍👦 y', 'y'), { startLine: 1, startUnit: 2 });
  assert.deepEqual(position('header\r\n\r\n你好 hello world', 'world'), { startLine: 3, startUnit: 4 });
  assert.deepEqual(position('hello\nworld', '\nworld'), { startLine: 1, startUnit: null });
  assert.equal(selectionUnitPosition('abc', -1, 2), null);
  assert.equal(selectionUnitPosition('abc', 1, 99), null);
});

test('new metadata is derived from matching source; missing/stale source never reuses a character column as a unit', () => {
  const source = '你好 hello world', from = source.indexOf('world');
  const selection = { kind: 'selection', path: 'a.md', from, to: source.length, text: 'world', startLine: 1, startColumn: from };
  const additions = [{ kind: 'file', path: 'a.md', text: source }, selection];
  const result = withSelectionUnits(additions);
  assert.equal(result[1].startUnit, 4);
  assert.equal(result[1].from, from, 'internal offsets remain available locally');
  assert.equal(Object.hasOwn(selection, 'startUnit'), false);
  assert.equal(withSelectionUnits([selection])[0].startUnit, null);
  assert.equal(withSelectionUnits([selection], () => 'different source')[0].startUnit, null);
});

test('current Context exposes only lexical positions and never serializes internal offsets', () => {
  const additions = [{ kind: 'selection', path: 'a.md', text: 'selected', startLine: 3, startUnit: 5,
    startColumn: 987654, from: 123456, to: 123464, lineOrigin: 'current' }];
  const context = renderContextEnvelope(additions, { rendererVersion: RENDERER_VERSION });
  assert.match(context, /start_line="3" start_unit="5" line_origin="current"/);
  assert.match(context, /3 \| selected/);
  assert.equal(/start_column|startColumn|987654|123456|123464/.test(context), false);
  const instructions = buildInstructions({ rendererVersion: RENDERER_VERSION });
  assert.match(instructions, /Han characters individually and words as units/);
  assert.match(instructions, /both 1-based/);
  assert.equal(/start_column|UTF-16|startColumn/.test(instructions), false);
});

for (const protocol of ['responses', 'chat-completions']) {
  test(`${protocol}: legacy context projection changes only owned metadata, preserving quoted XML and local records`, () => {
    const native = protocolFor({ protocol });
    const quoted = '<context_selection start_column="88">example</context_selection>';
    const source = `你好 hello ${quoted}`;
    const from = source.indexOf(quoted);
    const additions = [{ kind: 'file', path: 'a.md', text: source },
      { kind: 'selection', path: 'a.md', text: quoted, from, to: source.length, startLine: 1, startColumn: from }];
    const projection = createContextProjection();
    projection.beginTurn(additions, 6);
    const old = renderTurn({ mutations: additions, question: 'q', rendererVersion: 6, userMessage: native.userMessage });
    const saved = JSON.stringify(old);
    projection.add(old[0], true);
    const model = projection.items(old);
    const text = messageText(model[0]);
    assert.match(text, /path="a.md" start_line="1" start_unit="4"/);
    assert.ok(text.includes(`1 | ${quoted}`), 'literal quoted XML is not scrubbed');
    assert.equal(JSON.stringify(old), saved);
    assert.equal(model[1], old[1]);
    const body = native.buildRequestBody({ model: 'm', instructions: buildInstructions({ rendererVersion: RENDERER_VERSION }), input: model });
    assert.equal(JSON.stringify(body).includes(`start_column=\\"${from}\\"`), false);
  });
}

test('legacy source snapshots support later selections and missing positions become unknown', () => {
  const projection = createContextProjection();
  const source = 'hello 世界 target';
  projection.beginTurn([{ kind: 'file', path: 'a.md', text: source }], 6);
  const selection = { kind: 'selection', path: 'a.md', text: 'target', from: source.indexOf('target'), to: source.length, startLine: 1, startColumn: 9 };
  projection.beginTurn([selection], 6);
  const item = renderTurn({ mutations: [selection], question: 'q', rendererVersion: 6 })[0];
  projection.add(item, true);
  assert.match(messageText(projection.items([item])[0]), /start_unit="4"/);
  const missing = createContextProjection();
  missing.beginTurn([selection], 6); missing.add(item, true);
  assert.match(messageText(missing.items([item])[0]), /start_unit="unknown"/);
});

test('replay uses the latest tool-read baseline rather than a stale lexical index', () => {
  const projection = createContextProjection();
  projection.beginTurn([{ kind: 'file', path: 'a.md', text: 'hellothere ! target' }], 6);
  const source = 'hello there target', from = source.indexOf('target');
  projection.sourceRecord({ kind: 'context/tool-baseline', payload: { path: 'a.md', text: source } });
  const additions = [{ kind: 'selection', path: 'a.md', text: 'target', from, to: source.length, startLine: 1, startColumn: from }];
  projection.beginTurn(additions, 6);
  const item = renderTurn({ mutations: additions, question: 'q', rendererVersion: 6 })[0];
  projection.add(item, true);
  assert.match(messageText(projection.items([item])[0]), /start_unit="3"/);
});

test('mismatched legacy program context fails closed without applying body-wide replacements', () => {
  const projection = createContextProjection();
  projection.beginTurn([], 6);
  const item = { role: 'user', content: '<quick_ask_context>\n<context_selection path="a.md" start_column="99">\ntext\n</context_selection>\n</quick_ask_context>' };
  projection.add(item, true);
  assert.throws(() => projection.items([item]), /structured source metadata/);
  const assistant = { role: 'assistant', content: item.content };
  projection.add(assistant);
  assert.equal(projection.items([assistant])[0], assistant);
});

test('drag validation and staging retain unit positions alongside internal editor offsets', async () => {
  const { validateDrop } = require('../src/quick-ask/drag-source');
  const { createContextTracker } = require('../src/quick-ask/tracking');
  const text = '你好 hello world', from = text.indexOf('world');
  const vault = { readText: async () => text, normalizePath: path => path, resolveRole: () => 'markdown' };
  const drop = await validateDrop({ capture: { path: 'a.md', from, to: text.length, text: 'world' }, vault });
  assert.equal(drop.selection.startUnit, 4);
  const tracker = createContextTracker({ vault });
  tracker.stageSelection(drop.selection);
  const selection = (await tracker.mutationsForSend()).find(mutation => mutation.kind === 'selection');
  assert.equal(selection.startUnit, 4);
  assert.equal(selection.startColumn, from);
  const textForModel = renderContextEnvelope([selection], { rendererVersion: RENDERER_VERSION });
  assert.equal(textForModel.includes('start_column='), false);
});
