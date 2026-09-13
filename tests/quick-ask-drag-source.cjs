// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EditorState } = require('@codemirror/state');
const {
  DRAG_MIME, createDragCapture, captureFromState, serializeCapture, deserializeCapture,
  validateDrop, createCaptureHolder, isAcceptedDropTarget, createQuickAskDragExtension,
} = require('../src/quick-ask/drag-source');

const SOURCE = 'Alpha beta gamma\ndelta epsilon\nzeta eta theta\n';
const PATH = 'papers/paper.md';

const tFile = { path: PATH };
const infoField = { name: 'editorInfoField' };

function stateWithSelection(from, to) {
  return EditorState.create({
    doc: SOURCE,
    selection: { anchor: from, head: to },
    extensions: [],
  });
}

function makeDataTransfer(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    setData(type, value) { data.set(type, value); },
    getData(type) { return data.get(type) ?? ''; },
  };
}

// A minimal in-memory vault exposing the vault capability slice's readText.
function makeVault(files) {
  return {
    readText: async (path) => (Object.hasOwn(files, path) ? files[path] : null),
  };
}

test('a drag captures the issuing editor path, range, and selected text', () => {
  const state = stateWithSelection(6, 10);
  const capture = captureFromState({ state, info: { file: tFile } });
  assert.equal(capture.path, PATH);
  assert.equal(capture.text, 'beta');
  assert.equal(capture.from, 6);
  assert.equal(capture.to, 10);
  assert.equal(capture.startLine, 1);
  assert.equal(capture.startColumn, 6);
});

test('an editor without a file or with an empty selection captures nothing', () => {
  assert.equal(captureFromState({ state: stateWithSelection(6, 10), info: { file: null } }), null);
  assert.equal(captureFromState({ state: stateWithSelection(6, 10), info: null }), null);
  assert.equal(captureFromState({ state: stateWithSelection(6, 6), info: { file: tFile } }), null, 'an empty selection is rejected');
  assert.equal(captureFromState({ state: stateWithSelection(6, 10), info: { file: { path: '' } } }), null);
});

test('the captured payload survives the drag round trip and is namespaced', () => {
  const capture = captureFromState({ state: stateWithSelection(0, 5), info: { file: tFile } });
  const transfer = makeDataTransfer();
  transfer.setData(DRAG_MIME, serializeCapture(capture));
  const restored = deserializeCapture(transfer);
  assert.equal(restored.path, PATH);
  assert.equal(restored.text, 'Alpha');
  assert.equal(restored.from, 0);
  assert.equal(restored.to, 5);
});

test('payloads with no captured editor origin are rejected', () => {
  // Obsidian's internal drag types and text dragged in from another
  // application both arrive without our namespaced payload.
  assert.equal(deserializeCapture(makeDataTransfer({ 'text/plain': 'Alpha' })), null);
  assert.equal(deserializeCapture(makeDataTransfer({ [DRAG_MIME]: 'not json' })), null);
  assert.equal(deserializeCapture(makeDataTransfer({ [DRAG_MIME]: '{"path":"a.md"}' })), null, 'no selected text');
  assert.equal(deserializeCapture(null), null);
  assert.equal(deserializeCapture({}), null);
});

test('a drop re-reads the file and accepts when the captured text is still present', async () => {
  const capture = captureFromState({ state: stateWithSelection(6, 10), info: { file: tFile } });
  const result = await validateDrop({ capture, vault: makeVault({ [PATH]: SOURCE }) });
  assert.equal(result.accepted, true);
  assert.equal(result.selection.path, PATH);
  assert.equal(result.selection.text, 'beta');
  assert.equal(SOURCE.slice(result.selection.from, result.selection.to), 'beta');
});

test('a stale range is refused instead of staging the wrong text', async () => {
  const capture = captureFromState({ state: stateWithSelection(6, 10), info: { file: tFile } });
  const result = await validateDrop({ capture, vault: makeVault({ [PATH]: 'Alpha BETA gamma\n' }) });
  assert.deepEqual(result, { accepted: false, reason: 'stale-text' });
});

test('a drop is refused when the file disappeared or no drag was captured', async () => {
  const capture = captureFromState({ state: stateWithSelection(6, 10), info: { file: tFile } });
  assert.deepEqual(await validateDrop({ capture, vault: makeVault({}) }), { accepted: false, reason: 'missing-file' });
  assert.deepEqual(await validateDrop({ capture: null, vault: makeVault({ [PATH]: SOURCE }) }), { accepted: false, reason: 'no-capture' });
});

test('the drop reads the file once and uses the normalized Vault Path', async () => {
  let reads = 0;
  const vault = { readText: async () => { reads++; return SOURCE; } };
  const capture = createDragCapture({ path: 'papers\\paper.md', from: 6, to: 10, text: 'beta' });
  const result = await validateDrop({
    capture,
    vault,
    normalizePath: (path) => path.replace(/\\/g, '/'),
  });
  assert.equal(reads, 1);
  assert.equal(result.selection.path, 'papers/paper.md');
});

test('the capture holder keeps at most one origin and clears on dragend', () => {
  const holder = createCaptureHolder();
  assert.equal(holder.get(), null);
  holder.set(createDragCapture({ path: PATH, from: 0, to: 5, text: 'Alpha' }));
  assert.equal(holder.get().text, 'Alpha');
  holder.set(createDragCapture({ path: PATH, from: 6, to: 10, text: 'beta' }));
  assert.equal(holder.get().text, 'beta', 'a repeated drag replaces the previous capture');
  holder.clear();
  assert.equal(holder.get(), null);
});

test('only the pending-context area and the composer accept a drop', () => {
  const composer = { kind: 'composer' };
  const pending = { kind: 'pending' };
  const elsewhere = { kind: 'elsewhere' };
  const composerArea = { contains: (node) => node === composer };
  const pendingArea = { contains: (node) => node === pending };
  const options = { pendingArea, composerArea };
  assert.equal(isAcceptedDropTarget(pending, options), true);
  assert.equal(isAcceptedDropTarget(composer, options), true);
  assert.equal(isAcceptedDropTarget(elsewhere, options), false, 'drops elsewhere in the sidebar are ignored');
  assert.equal(isAcceptedDropTarget(null, options), false);
  assert.equal(isAcceptedDropTarget(pending, {}), false, 'no drop target without the host regions');
  assert.equal(isAcceptedDropTarget('pending', { pendingArea: { contains: () => true } }), false, 'a non-node target is ignored');
});

test('the extension captures from its own editor and clears on dragend', () => {
  const { handlers, captureHolder } = createQuickAskDragExtension({ editorInfoField: infoField });
  const view = {
    state: {
      selection: { main: { from: 6, to: 10, empty: false } },
      sliceDoc: () => 'beta',
      doc: { lineAt: () => ({ number: 1, from: 0 }) },
      field: () => ({ file: tFile }),
    },
  };
  const transfer = makeDataTransfer();
  handlers.dragstart({ dataTransfer: transfer }, view);
  assert.equal(captureHolder.get().text, 'beta');
  assert.equal(deserializeCapture(transfer).path, PATH);
  handlers.dragend();
  assert.equal(captureHolder.get(), null);
});

test('the extension refuses a drag in an editor with no file', () => {
  const { handlers, captureHolder } = createQuickAskDragExtension({ editorInfoField: infoField });
  const view = {
    state: {
      selection: { main: { from: 0, to: 5, empty: false } },
      sliceDoc: () => 'Alpha',
      doc: { lineAt: () => ({ number: 1, from: 0 }) },
      field: () => ({ file: null }),
    },
  };
  handlers.dragstart({ dataTransfer: makeDataTransfer() }, view);
  assert.equal(captureHolder.get(), null);
});

test('one capture holder serves several editor extensions without sharing state per editor', () => {
  const holder = createCaptureHolder();
  const first = createQuickAskDragExtension({ editorInfoField: infoField, captureHolder: holder });
  const second = createQuickAskDragExtension({ editorInfoField: infoField, captureHolder: holder });
  assert.equal(first.captureHolder, second.captureHolder);
  assert.equal(first.extension === second.extension, false, 'each registered extension is its own value');
});

test('one capture holder serves the editor extension and the drop target', () => {
  const { createCaptureHolder, createQuickAskDragExtension } = require('../src/quick-ask/drag-source');
  const holder = createCaptureHolder();
  const drag = createQuickAskDragExtension({ editorInfoField: infoField, captureHolder: holder });
  const view = {
    state: {
      selection: { main: { from: 6, to: 10, empty: false } },
      sliceDoc: () => 'beta',
      doc: { lineAt: () => ({ number: 1, from: 0 }) },
      field: () => ({ file: tFile }),
    },
  };
  const transfer = makeDataTransfer();
  drag.handlers.dragstart({ dataTransfer: transfer }, view);
  // The same holder the drop target reads from now carries the origin.
  assert.equal(holder.get().text, 'beta');
  assert.equal(holder.get().path, PATH);
  drag.handlers.dragend();
  assert.equal(holder.get(), null, 'dragend clears the shared capture');
});
