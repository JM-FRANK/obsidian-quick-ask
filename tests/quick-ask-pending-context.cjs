// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createPendingContext, addFile, addSelection, removeFile, removeSelection, clearSelections,
  hasFile, showsExpandBar, derivePendingView,
  selectionRange,
} = require('../src/quick-ask/pending-context');

function withFiles(...paths) {
  return paths.reduce((context, path) => addFile(context, path), createPendingContext());
}

function withSelections(context, ...selections) {
  return selections.reduce((current, selection) => addSelection(current, selection), context);
}

test('File Rows keep first-added order and a repeated add does not reorder them', () => {
  let context = withFiles('a.md', 'b.md');
  context = addFile(context, 'a.md');
  assert.deepEqual(context.files.map((file) => file.path), ['a.md', 'b.md']);
  assert.equal(hasFile(context, 'a.md'), true);
  assert.equal(hasFile(context, 'missing.md'), false);
});

test('Selection Preview Rows keep drag order and allow several from one file', () => {
  let context = withSelections(createPendingContext(),
    { path: 'a.md', text: 'first' },
    { path: 'a.md', text: 'second' },
    { path: 'b.md', text: 'third' });
  assert.deepEqual(context.selections.map((selection) => selection.text), ['first', 'second', 'third']);
});

test('a repeated dragged selection from the same file appends another row', () => {
  let context = withSelections(createPendingContext(), { path: 'a.md', text: 'same' });
  context = addSelection(context, { path: 'a.md', text: 'same' });
  assert.equal(context.selections.length, 2);
});

test('removing a selection cancels only that Context Selection', () => {
  let context = withSelections(createPendingContext(),
    { path: 'a.md', text: 'keep' },
    { path: 'a.md', text: 'drop' });
  context = removeSelection(context, 1);
  assert.deepEqual(context.selections.map((selection) => selection.text), ['keep']);
});

test('removing a file row leaves the pending selections untouched', () => {
  let context = withSelections(withFiles('a.md', 'b.md'), { path: 'a.md', text: 'quoted' });
  context = removeFile(context, 'a.md');
  assert.deepEqual(context.files.map((file) => file.path), ['b.md']);
  assert.deepEqual(context.selections.map((selection) => selection.text), ['quoted']);
});

test('sending a question clears the selected-text rows but keeps the file rows', () => {
  const context = withSelections(withFiles('a.md'), { path: 'a.md', text: 'quoted' });
  const after = clearSelections(context);
  assert.deepEqual(after.selections, []);
  assert.deepEqual(after.files.map((file) => file.path), ['a.md']);
});

test('the expand bar needs two rows in either group, not one file with its one selection', () => {
  assert.equal(showsExpandBar(createPendingContext()), false);
  assert.equal(showsExpandBar(withFiles('a.md')), false);
  assert.equal(showsExpandBar(withSelections(withFiles('a.md'), { path: 'a.md', text: 'x' })), false);
  assert.equal(showsExpandBar(withFiles('a.md', 'b.md')), true);
  assert.equal(showsExpandBar(withSelections(createPendingContext(),
    { path: 'a.md', text: 'x' }, { path: 'a.md', text: 'y' })), true);
});

test('the collapsed projection shows the most recently dragged selection and its file', () => {
  const context = withSelections(withFiles('a.md', 'b.md', 'c.md'),
    { path: 'a.md', text: 'older' },
    { path: 'c.md', text: 'newest' });
  const view = derivePendingView(context);
  assert.equal(view.showBar, true);
  assert.equal(view.expanded, false);
  assert.deepEqual(view.files.map((row) => row.path), ['c.md']);
  assert.deepEqual(view.selections.map((row) => row.text), ['newest']);
  assert.equal(view.fileCount, 3);
  assert.equal(view.selectionCount, 2);
});

test('with no pending selection the collapsed projection shows the most recently added file', () => {
  const view = derivePendingView(withFiles('a.md', 'b.md', 'c.md'));
  assert.deepEqual(view.files.map((row) => row.path), ['c.md']);
  assert.deepEqual(view.selections, []);
});

test('a selection whose file is no longer listed falls back to the last file row', () => {
  const context = withSelections(createPendingContext(), { path: 'gone.md', text: 'orphan' });
  const view = derivePendingView(context);
  assert.deepEqual(view.files, []);
  assert.deepEqual(view.selections.map((row) => row.text), ['orphan']);
});

test('the expanded projection lists every file row then every selection row', () => {
  const context = withSelections(withFiles('a.md', 'b.md'),
    { path: 'a.md', text: 'first' },
    { path: 'b.md', text: 'second' });
  const view = derivePendingView(context, { expanded: true });
  assert.equal(view.expanded, true);
  assert.deepEqual(view.files.map((row) => row.kind + ':' + row.path), ['file:a.md', 'file:b.md']);
  assert.deepEqual(view.selections.map((row) => row.text), ['first', 'second']);
});

test('expansion is ignored while the bar is not shown', () => {
  const view = derivePendingView(withFiles('a.md'), { expanded: true });
  assert.equal(view.expanded, false);
  assert.equal(view.showBar, false);
  assert.deepEqual(view.files.map((row) => row.path), ['a.md']);
});

test('a file row carries only the Vault Path, never an absolute path or UI state', () => {
  const view = derivePendingView(withFiles('papers/paper.md'), { expanded: true });
  assert.deepEqual(Object.keys(view.files[0]).sort(), ['kind', 'path']);
  assert.equal(view.files[0].path.includes('\\'), false);
});

test('malformed additions are ignored instead of creating empty rows', () => {
  let context = createPendingContext();
  context = addFile(context, '');
  context = addFile(context, null);
  context = addSelection(context, null);
  context = addSelection(context, { path: 'a.md' });
  assert.deepEqual(context, createPendingContext());
});

test('both group counts survive expansion and a single remaining row', () => {
  const context = withSelections(withFiles('a.md', 'b.md'), { path: 'a.md', text: 'x' });
  for (const expanded of [false, true]) {
    const view = derivePendingView(context, { expanded });
    assert.equal(view.fileCount, 2);
    assert.equal(view.selectionCount, 1);
  }
  assert.equal(derivePendingView(withFiles('a.md')).fileCount, 1);
});

test('collapsed and expanded selection projections retain the captured navigation range', () => {
  const context = withSelections(withFiles('a.md'),
    { path: 'a.md', text: 'older', from: 0, to: 5 },
    { path: 'a.md', text: 'latest', from: 12, to: 18 });
  for (const expanded of [false, true]) {
    const row = derivePendingView(context, { expanded }).selections.at(-1);
    assert.deepEqual({ from: row.from, to: row.to }, { from: 12, to: 18 });
  }
});

test('navigation validates the exact range, relocates only a unique quote, and refuses ambiguity', () => {
  assert.deepEqual(selectionRange('x quote quote', { text: 'quote', from: 8, to: 13 }), { from: 8, to: 13 });
  assert.deepEqual(selectionRange('new\nquote', { text: 'quote', from: 0, to: 5 }), { from: 4, to: 9 });
  assert.equal(selectionRange('quote quote', { text: 'quote', from: 2, to: 7 }), null);
  assert.equal(selectionRange('changed', { text: 'quote', from: 0, to: 5 }), null);
  assert.equal(selectionRange('changed', { text: '' }), null);
});
