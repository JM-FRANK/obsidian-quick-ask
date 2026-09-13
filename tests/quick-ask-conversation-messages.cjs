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
