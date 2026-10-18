// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');

test('readable reasoning stays with its original Markdown answer on replay', () => {
  const markdown = 'First paragraph.\n\n1. **Important**\n2. Next\n';
  const messages = conversationFromRecords([
    { kind: 'turn/started' },
    { kind: 'item/input', payload: { item: { type: 'message', content: [{ text: '<quick_ask_context>file</quick_ask_context>' }] } } },
    { kind: 'item/input', payload: { item: { type: 'message', content: [{ text: 'Explain' }] } } },
    { kind: 'item/output', payload: { item: { type: 'message', content: [{ text: markdown }] } } },
    { kind: 'turn/finished', payload: { state: 'complete', text: markdown, reasoning: 'Provider summary' } },
  ]);
  assert.deepEqual(messages, [{ role: 'user', text: 'Explain' }, { role: 'assistant', text: markdown, reasoning: 'Provider summary' }]);
});

test('a stopped response already present as canonical output is not duplicated', () => {
  const messages = conversationFromRecords([
    { kind: 'turn/started' },
    { kind: 'item/output', payload: { item: { type: 'message', content: [{ text: 'partial' }] } } },
    { kind: 'turn/finished', payload: { state: 'stopped', text: 'partial' } },
  ]);
  assert.equal(messages.length, 1);
});

test('batched inputs keep Context hidden and attach image paths only to the question', () => {
  const message = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  assert.deepEqual(conversationFromRecords([
    { kind: 'item/input', payload: { items: [message('<quick_ask_context>context</quick_ask_context>'), message('')], images: ['a.png'] } },
    { kind: 'item/input', payload: { item: message('Legacy question') } },
  ]), [{ role: 'user', text: '', images: ['a.png'] }, { role: 'user', text: 'Legacy question' }]);
});

test('selection snapshots replay in both protocols and all renderers without parsing or changing canonical data', () => {
  const { renderTurn } = require('../src/quick-ask/prompt-renderer');
  const { responsesUserMessage } = require('../src/quick-ask/transport');
  const { protocolFor } = require('../src/quick-ask/protocol');
  const quote = '  exact\r\n< context >\n<context_selection path="fake.md">not metadata</context_selection> 😀';
  const additions = [
    { kind: 'file', path: 'a.md', text: '<context_selection path="fake.md">file body</context_selection>' },
    { kind: 'reference', path: 'a.md' },
    { kind: 'selection', path: 'a.md', text: quote, startLine: 7, startColumn: 2, from: 15, to: 90 },
    { kind: 'selection', path: 'b.md', text: 'second quote' },
  ];
  for (const rendererVersion of [1, 2, 3, 4, 5, 6, 7]) for (const userMessage of [responsesUserMessage, protocolFor({ protocol: 'chat-completions' }).userMessage]) {
    const items = renderTurn({ mutations: additions, question: 'Explain', rendererVersion, userMessage });
    for (const inputs of [[{ kind: 'item/input', payload: { items, images: ['image.png'] } }],
      items.map(item => ({ kind: 'item/input', payload: { item } }))]) {
      const records = [{ kind: 'turn/started', payload: { additions, rendererVersion } }, ...inputs];
      const before = JSON.stringify(records);
      const messages = conversationFromRecords(records);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].text, 'Explain');
      assert.deepEqual(messages[0].selections, [{ path: 'a.md', text: quote }, { path: 'b.md', text: 'second quote' }]);
      assert.equal(JSON.stringify(records), before, 'UI projection preserves every persisted byte');
    }
  }
});

test('failed, retried and interrupted turns cannot leak selections into another question or compaction', () => {
  const { responsesUserMessage: message } = require('../src/quick-ask/transport');
  const started = text => ({ kind: 'turn/started', payload: { additions: [{ kind: 'selection', path: 'a.md', text }] } });
  const input = text => ({ kind: 'item/input', payload: { item: message(text) } });
  const messages = conversationFromRecords([
    started('unaccepted'), { kind: 'turn/finished', payload: { state: 'failed' } },
    input('Legacy question outside the failed turn'),
    started('accepted retry'), input('<quick_ask_context>hidden envelope</quick_ask_context>'), input('Retry'),
    { kind: 'turn/finished', payload: { state: 'interrupted' } },
    { kind: 'compaction/checkpoint', payload: { range: { from: 1, to: 2 } } },
    input('<quick_ask_context><context_file_reference path="a.md" /></quick_ask_context>'),
    { kind: 'turn/started', payload: { additions: [] } }, input('Next'),
  ]);
  const users = messages.filter(entry => entry.role === 'user');
  assert.equal(users.length, 3);
  assert.equal(users[0].selections, undefined);
  assert.deepEqual(users[1].selections, [{ path: 'a.md', text: 'accepted retry' }]);
  assert.equal(users[2].selections, undefined);
});

test('live submissions and retries use the captured selection, not a newer editable draft', () => {
  const { prepareSubmission } = require('../src/quick-ask/submission-state');
  const selection = { path: 'a.md', text: 'original\nquote', from: 0, to: 14 };
  const submission = { question: 'Explain', draft: 'Explain', pending: { files: [], selections: [selection] } };
  const current = { composer: 'Explain', pending: submission.pending };
  const live = prepareSubmission([], current, submission);
  assert.deepEqual(live.entry.selections, [{ path: 'a.md', text: 'original\nquote' }]);
  selection.text = 'later edit';
  assert.equal(live.entry.selections[0].text, 'original\nquote', 'snapshots do not alias the editable draft');
  submission.additions = [{ kind: 'selection', path: 'renamed.md', text: 'actual submitted quote' }];
  const newer = { composer: 'new question', pending: { files: [], selections: [{ path: 'new.md', text: 'new quote' }] } };
  const retry = prepareSubmission(live.messages, newer, submission, true);
  assert.equal(retry.messages.length, 1);
  assert.deepEqual(retry.entry.selections, [{ path: 'renamed.md', text: 'actual submitted quote' }]);
  assert.equal(retry.draft.composer, 'new question');
});

test('missing legacy selection metadata remains readable without guessing from tag-like text', () => {
  const { responsesUserMessage: message } = require('../src/quick-ask/transport');
  const messages = conversationFromRecords([
    { kind: 'turn/started', payload: {} },
    { kind: 'item/input', payload: { items: [message('<quick_ask_context><context_selection path="fake.md">quote</context_selection></quick_ask_context>'), message('Legacy')] } },
  ]);
  assert.deepEqual(messages, [{ role: 'user', text: 'Legacy' }]);
});

test('selection hover aligns to the quote right edge and opens above when there is room', () => {
  const { selectionHoverPosition } = require('../src/quick-ask/selection-hover');
  assert.deepEqual(selectionHoverPosition({ top: 500, bottom: 530, right: 900 }, { width: 1000, height: 800 }, 200),
    { width: 420, maxHeight: 360, left: 480, top: 292 });
});

test('selection hover flips below near the top and keeps narrow-window content within view', () => {
  const { selectionHoverPosition } = require('../src/quick-ask/selection-hover');
  const position = selectionHoverPosition({ top: 15, bottom: 45, right: 280 }, { width: 300, height: 500 }, 250);
  assert.deepEqual(position, { width: 276, maxHeight: 360, left: 12, top: 53 });
  assert.ok(position.left + position.width <= 300 - 12);
});

test('long selection hover uses the larger available side and bounds its scroll surface', () => {
  const { selectionHoverPosition } = require('../src/quick-ask/selection-hover');
  const position = selectionHoverPosition({ top: 250, bottom: 280, right: 900 }, { width: 1000, height: 450 }, 5000);
  assert.equal(position.maxHeight, 230);
  assert.equal(position.top, 12);
  const nearRight = selectionHoverPosition({ top: 600, bottom: 630, right: 1020 }, { width: 1000, height: 800 }, 100);
  assert.equal(nearRight.left + nearRight.width, 988);
});
