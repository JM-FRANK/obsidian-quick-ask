// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EditorState } = require('@codemirror/state');
const {
  fileReferenceField, referencesOf, referencesFrom, scanMarkers,
  stageReference, choosePath, questionText, referencedPaths, referenceAt, labelFor,
  referenceDeletion, editingReferenceField, openReferenceEffect, closeReferenceEffect, slashQuery,
} = require('../src/quick-ask/composer-state');

// A composer state is a real CodeMirror EditorState; the chip list is derived
// from its document, so no test has to keep them in sync by hand.
function composerState(text = '', selection = null) {
  return EditorState.create({
    doc: text,
    selection: selection ?? undefined,
    extensions: [fileReferenceField, editingReferenceField],
  });
}

test('folder choices continue at the next level and only a file choice creates a chip', () => {
  let state = composerState('Explain [[pa');
  state = state.update(choosePath(state, { kind: 'folder', path: 'papers/' }, { from: 8, to: state.doc.length })).state;
  assert.equal(state.doc.toString(), 'Explain [[papers/');
  assert.deepEqual(referencedPaths(state), []);
  assert.ok(state.field(editingReferenceField));
  state = state.update(choosePath(state, { kind: 'file', path: 'papers/paper.md' }, { from: 8, to: state.doc.length })).state;
  assert.equal(state.doc.toString(), 'Explain [[papers/paper.md]]');
  assert.deepEqual(referencedPaths(state), ['papers/paper.md']);
  assert.equal(state.field(editingReferenceField), null);
});

test('changing an ancestor while editing replaces the old descendant and preserves following prose', () => {
  let state = composerState('[[old/sub/paper.md]] after');
  state = state.update({ effects: openReferenceEffect.of({ from: 0, to: 20 }), selection: { anchor: 5 } }).state;
  state = state.update(choosePath(state, { kind: 'folder', path: 'new/' }, { from: 0, to: 5 })).state;
  assert.equal(state.doc.toString(), '[[new/ after');
  assert.equal(state.selection.main.head, 6);
});

test('a chosen file becomes a chip marker in the composer text', () => {
  let state = composerState('explain [[pap');
  const query = { from: 8, to: 13 };
  state = state.update(stageReference(state, 'papers/attention.md', query)).state;
  assert.equal(state.doc.toString(), 'explain [[papers/attention.md]]');
  assert.equal(state.selection.main.head, 'explain [[papers/attention.md]]'.length);
});

test('a full-width IME query becomes the canonical ASCII chip and leaves no bracket behind', () => {
  let state = composerState('解释 【【pa');
  state = state.update(choosePath(state, { kind: 'folder', path: 'papers/' }, { from: 3, to: state.doc.length })).state;
  assert.equal(state.doc.toString(), '解释 [[papers/');
  state = state.update(choosePath(state, { kind: 'file', path: 'papers/paper.md' }, { from: 3, to: state.doc.length })).state;
  assert.equal(state.doc.toString(), '解释 [[papers/paper.md]]');
  assert.deepEqual(referencedPaths(state), ['papers/paper.md']);
  assert.equal(questionText(state), '解释');
  assert.equal(state.doc.toString().includes('【'), false);
});

test('only the canonical ASCII marker is a chip', () => {
  // The trigger accepts the IME spelling, but a chip is still exactly
  // `[[Vault Path]]`: a hand-typed full-width marker stays ordinary prose and
  // is neither staged as Context nor stripped from the question.
  const state = composerState('see 【【notes/a.md】】 now');
  assert.deepEqual(referencesOf(state), []);
  assert.deepEqual(referencedPaths(state), []);
  assert.equal(questionText(state), 'see 【【notes/a.md】】 now');
});

test('the picker query and the marker never reach the question text', () => {
  let state = composerState('what does ');
  state = state.update(stageReference(state, 'papers/attention.md')).state;
  state = state.update({ changes: { from: state.doc.length, insert: ' change?' } }).state;
  assert.equal(questionText(state), 'what does change?');
  assert.equal(state.doc.toString().includes('[['), true, 'the chip stays in the document');
});

test('several chips are staged in document order and deduplicated by path', () => {
  let state = composerState('');
  state = state.update(stageReference(state, 'notes/a.md')).state;
  state = state.update({ changes: { from: state.doc.length, insert: ' and ' } }).state;
  state = state.update(stageReference(state, 'notes/b.md')).state;
  assert.deepEqual(referencedPaths(state), ['notes/a.md', 'notes/b.md']);
  assert.equal(questionText(state), 'and');

  let repeated = composerState('');
  repeated = repeated.update(stageReference(repeated, 'notes/a.md')).state;
  repeated = repeated.update({ changes: { from: repeated.doc.length, insert: ' ' } }).state;
  repeated = repeated.update(stageReference(repeated, 'notes/a.md')).state;
  assert.deepEqual(referencedPaths(repeated), ['notes/a.md'], 'a repeated chip is one reference');
  assert.equal(questionText(repeated), '');
});

test('a chip is exactly one atomic replacement range in the editor state', () => {
  const state = composerState('ask [[notes/a.md]] now');
  const references = referencesOf(state);
  assert.equal(references.length, 1);
  assert.deepEqual({ path: references[0].path, from: references[0].from, to: references[0].to },
    { path: 'notes/a.md', from: 4, to: 18 });
  assert.equal(state.doc.sliceString(references[0].from, references[0].to), '[[notes/a.md]]');
  assert.equal(labelFor('notes/a.md'), '@../notes/a.md');
});

test('chip labels keep the complete filename and abbreviate only the parent directory', () => {
  assert.equal(labelFor('a.md'), '@a.md');
  assert.equal(labelFor('deep/parent/AAA/a.md'), '@../AAA/a.md');
  const filename = 'very-long-complete-filename-with-extension.md';
  const label = labelFor('deep/' + 'A'.repeat(40) + 'Z/' + filename);
  assert.ok(label.startsWith('@../'));
  assert.ok(label.endsWith('/' + filename));
  assert.ok(label.includes('...'));
  assert.ok(label.length < 30 + filename.length);
});

test('adjacent deletion selects before deleting, without changing the reference on the first step', () => {
  for (const side of ['start', 'end']) {
    let state = composerState('ask [[notes/a.md]] now');
    const reference = referencesOf(state)[0];
    state = state.update({ selection: { anchor: side === 'start' ? reference.from : reference.to } }).state;
    state = state.update(referenceDeletion(state, side)).state;
    assert.equal(state.doc.toString(), 'ask [[notes/a.md]] now');
    assert.deepEqual(referencedPaths(state), ['notes/a.md']);
    assert.equal(state.selection.main.from, reference.from);
    assert.equal(state.selection.main.to, reference.to);
    state = state.update(referenceDeletion(state, side)).state;
    assert.equal(state.doc.toString(), 'ask  now');
    assert.deepEqual(referencedPaths(state), []);
  }
});

test('editing a chip keeps the exact marker and maps its editable range across text changes', () => {
  let state = composerState('ask [[notes/a.md]] now');
  const reference = referencesOf(state)[0];
  state = state.update({ effects: openReferenceEffect.of(reference), selection: { anchor: reference.from + 2, head: reference.to - 2 } }).state;
  assert.equal(referenceDeletion(state, 'end'), null, 'expanded references use ordinary text editing');
  const selection = state.selection.main;
  const path = 'deep/Another parent/complete-file-name.md';
  state = state.update({ changes: { from: selection.from, to: selection.to, insert: path }, selection: { anchor: selection.from + path.length } }).state;
  const editing = state.field(editingReferenceField);
  assert.equal(state.doc.sliceString(editing.from, editing.to), '[[' + path + ']]');
  assert.equal(questionText(state), 'ask now');
  state = state.update({ effects: closeReferenceEffect.of(null) }).state;
  assert.equal(state.field(editingReferenceField), null);
  assert.deepEqual(referencedPaths(state), [path]);
});

test('an incomplete edited link stays editing instead of becoming sendable query text', () => {
  let state = composerState('ask [[notes/a.md]] now');
  const reference = referencesOf(state)[0];
  state = state.update({ effects: openReferenceEffect.of(reference), selection: { anchor: reference.to - 2 } }).state;
  state = state.update({ changes: { from: reference.to - 2, to: reference.to }, selection: { anchor: state.doc.length - 2 } }).state;
  assert.ok(state.field(editingReferenceField), 'invalid raw marker cannot silently finish editing');
  state = state.update({ changes: { from: 0, to: state.doc.length }, selection: { anchor: 0 } }).state;
  assert.equal(state.field(editingReferenceField), null, 'clearing the document clears the edit range');
});

test('editing boundaries never absorb prose inserted before or after a complete marker', () => {
  for (const side of ['before', 'after']) {
    let state = composerState('ask [[notes/a.md]] now');
    const reference = referencesOf(state)[0];
    const at = side === 'before' ? reference.from : reference.to;
    state = state.update({ effects: openReferenceEffect.of(reference), selection: { anchor: at } }).state;
    state = state.update({ changes: { from: at, insert: ' extra ' }, selection: { anchor: at + 7 } }).state;
    if (side === 'before') {
      const editing = state.field(editingReferenceField);
      assert.equal(state.doc.sliceString(editing.from, editing.to), '[[notes/a.md]]');
      state = state.update({ selection: { anchor: 0 } }).state;
    }
    assert.equal(state.field(editingReferenceField), null);
    assert.equal(questionText(state), 'ask extra now');
    assert.deepEqual(referencedPaths(state), ['notes/a.md']);
  }
});

test('repairing the opening brackets keeps the edited reference attached to its full marker', () => {
  let state = composerState('[[a.md]]');
  state = state.update({ effects: openReferenceEffect.of(referencesOf(state)[0]), selection: { anchor: 0 } }).state;
  state = state.update({ changes: { from: 0, to: 1 }, selection: { anchor: 0 } }).state;
  state = state.update({ changes: { from: 0, insert: '[' }, selection: { anchor: 1 } }).state;
  assert.equal(state.doc.toString(), '[[a.md]]');
  assert.deepEqual(state.field(editingReferenceField), { from: 0, to: 8 });
  assert.deepEqual(referencedPaths(state), ['a.md']);
});

test('chip ranges survive ordinary edits elsewhere in the composer', () => {
  let state = composerState('[[notes/a.md]] question');
  state = state.update({ changes: { from: 0, insert: 'First: ' } }).state;
  state = state.update({ changes: { from: state.doc.length, insert: ' more' } }).state;
  const references = referencesOf(state);
  assert.equal(state.doc.sliceString(references[0].from, references[0].to), '[[notes/a.md]]');
  assert.equal(questionText(state), 'First: question more');
});

test('editing inside a chip range is remapped instead of silently corrupting the path', () => {
  let state = composerState('[[notes/a.md]]');
  // Inserting at the very start keeps the marker text intact and moves the chip.
  state = state.update({ changes: { from: 0, insert: 'x' } }).state;
  const references = referencesOf(state);
  assert.equal(state.doc.sliceString(references[0].from, references[0].to), '[[notes/a.md]]');
});

test('removing a whole chip with backspace removes its staged reference', () => {
  let state = composerState('ask [[notes/a.md]]');
  const reference = referencesOf(state)[0];
  state = state.update({ changes: { from: reference.from, to: reference.to } }).state;
  assert.deepEqual(referencesOf(state), [], 'the field is updated by the document change');
});

test('a single Backspace or Delete adjacent to a chip identifies that whole chip', () => {
  const state = composerState('ask [[notes/a.md]] now');
  const reference = referencesOf(state)[0];
  assert.equal(referenceAt(state, reference.to, 'end').path, 'notes/a.md');
  assert.equal(referenceAt(state, reference.from, 'start').path, 'notes/a.md');
  assert.equal(referenceAt(state, reference.from - 1, 'end'), null);
  assert.equal(referenceAt(state, reference.to + 1, 'start'), null);
  assert.equal(referenceAt(state, 0, 'end'), null);
});

test('scanning markers ignores incomplete brackets and multi-line content', () => {
  assert.deepEqual(scanMarkers('[[notes/a.md]]'), [{ path: 'notes/a.md', from: 0, to: 14 }]);
  assert.deepEqual(scanMarkers('[[notes/a.md'), []);
  assert.deepEqual(scanMarkers('[[]]'), []);
  assert.deepEqual(scanMarkers('[[a\nb]]'), []);
  assert.deepEqual(scanMarkers('[[a]][[b]]').map((entry) => entry.path), ['a', 'b']);
  assert.deepEqual(scanMarkers(''), []);
  assert.deepEqual(scanMarkers(undefined), []);
});

test('referencesFrom drops empty ranges and strips the marker brackets', () => {
  assert.deepEqual(referencesFrom([{ from: 3, to: 3 }], 'abcdef'), []);
  assert.deepEqual(referencesFrom([{ from: 0, to: 5 }], '[[a]]b'), [{ path: 'a', from: 0, to: 5 }]);
});

test('the question keeps single spaces and trims only the ends', () => {
  let state = composerState('  ');
  state = state.update(stageReference(state, 'a.md')).state;
  state = state.update({ changes: { from: state.doc.length, insert: ' explain  this  ' } }).state;
  assert.equal(questionText(state), 'explain this');
  assert.equal(questionText(composerState('   ')), '');
});

test('a submitted question with no chips is exactly what the user typed', () => {
  assert.equal(questionText(composerState('plain question')), 'plain question');
  assert.deepEqual(referencedPaths(composerState('plain question')), []);
});


test('dropping multiple files makes atomic markers without replacing surrounding text', () => {
  const { stageReferences } = require('../src/quick-ask/composer-state');
  let state = composerState('explain this', { anchor: 7 });
  state = state.update(stageReferences(state, ['中文/论文.md', 'images/图.png', '中文/论文.md'])).state;
  assert.equal(state.doc.toString(), 'explain [[中文/论文.md]] [[images/图.png]] this');
  assert.equal(questionText(state), 'explain this');
  assert.deepEqual(referencedPaths(state, path => /\.(md|markdown)$/i.test(path)), ['中文/论文.md']);
  assert.equal(referencesOf(state).length, 2, 'unsupported files remain editable chips');
});

test('dropping inside an existing chip inserts after it, without corrupting either marker', () => {
  const { stageReferences } = require('../src/quick-ask/composer-state');
  let state = composerState('[[a.md]] end');
  state = state.update(stageReferences(state, ['b.md'], 3)).state;
  assert.equal(state.doc.toString(), '[[a.md]] [[b.md]] end');
  assert.deepEqual(referencedPaths(state), ['a.md', 'b.md']);
});

test('a filename that cannot be represented cannot inject another chip', () => {
  const { stageReferences } = require('../src/quick-ask/composer-state');
  const state = composerState('safe');
  assert.equal(stageReferences(state, ['bad]] [[secret.md', 'two\nlines.md']), null);
});

test('a file dropped into an unfinished picker replaces the query instead of nesting markers', () => {
  const { stageReferences } = require('../src/quick-ask/composer-state');
  let state = composerState('Explain [[pa', { anchor: 12 });
  state = state.update(stageReferences(state, ['notes/a.md', 'images/a.png'])).state;
  assert.equal(state.doc.toString(), 'Explain [[notes/a.md]] [[images/a.png]]');
  assert.equal(questionText(state), 'Explain');
  assert.deepEqual(referencedPaths(state, path => path.endsWith('.md')), ['notes/a.md']);
});

test('slash commands are confined to line starts and preserve other text', () => {
  assert.deepEqual(slashQuery('draft\n/web', 10), { kind: 'command', query: 'web', from: 6, to: 10 });
  assert.equal(slashQuery('https://x/web', 13), null);
  assert.equal(slashQuery('words /web', 10), null);
});
