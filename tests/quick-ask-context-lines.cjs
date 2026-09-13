// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderTurn } = require('../src/quick-ask/prompt-renderer');
test('version 2 Context adds physical line numbers without changing raw source or history', () => {
  const file = { kind: 'file', path: 'a.md', text: 'alpha\r\n\r\nomega\r\n' };
  const selection = { kind: 'selection', path: 'a.md', text: 'omega', startLine: 3, startColumn: 0 };
  const input = renderTurn({ mutations: [file, selection], question: 'explain', rendererVersion: 2 });
  const text = input[0].content[0].text;
  assert.ok(text.includes('1 | alpha\r\n2 | \r\n3 | omega\r\n4 | '));
  assert.ok(text.includes('start_line="3"'));
  assert.ok(text.includes('3 | omega'));
  assert.equal(file.text, 'alpha\r\n\r\nomega\r\n');
  const old = renderTurn({ mutations: [file], question: 'q', rendererVersion: 1 });
  assert.equal(old[0].content[0].text.includes('1 | alpha'), false);
});

test('numbered full-file tool output leaves its synchronization baseline raw', async () => {
  const { createToolLoop } = require('../src/quick-ask/tool-loop');
  const { createToolExecutor } = require('../src/quick-ask/tool');
  const seen = [];
  const loop = createToolLoop({ config: { protocol: 'chat-completions', rendererVersion: 2 },
    executor: createToolExecutor({ vault: { readText: async () => 'a\nb' } }),
    tracker: { applyFullFileResult: (path, text) => seen.push({ path, text }) },
  });
  const question = loop.beginQuestion({ allowlist: ['a.md'] });
  const result = await loop.runBatch([{ name: 'get-full-file', callId: 'call1', arguments: { path: 'a.md' } }], question);
  assert.equal(result.items[0].content, '1 | a\n2 | b');
  assert.deepEqual(seen, [{ path: 'a.md', text: 'a\nb' }]);
});

test('dragged selection line location survives staging and reflects the current matched source', async () => {
  const { validateDrop } = require('../src/quick-ask/drag-source');
  const { createContextTracker } = require('../src/quick-ask/tracking');
  const text = 'a\r\nbb\r\nccc';
  const vault = { readText: async () => text, normalizePath: p => p, resolveRole: () => 'markdown' };
  const dropped = await validateDrop({ capture: { path: 'a.md', from: 8, to: 10, text: 'cc' }, vault });
  assert.equal(dropped.accepted, true);
  assert.equal(dropped.selection.startLine, 3);
  assert.equal(dropped.selection.startColumn, 1);
  const tracker = createContextTracker({ vault });
  tracker.stageSelection(dropped.selection);
  const mutations = await tracker.mutationsForSend();
  const selection = mutations.find(m => m.kind === 'selection');
  assert.equal(selection.startLine, 3);
  assert.equal(selection.startColumn, 1);
  assert.equal(selection.lineOrigin, 'current');
});
