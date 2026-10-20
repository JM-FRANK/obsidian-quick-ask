// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { historyPageStart, HISTORY_PAGE_TURNS, HISTORY_PAGE_ENTRIES } = require('../src/quick-ask/history-window');
const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');

test('long history initially exposes recent turns and paging restores every entry in order', () => {
  const messages = Array.from({ length: 1000 }, (_, turn) => [
    { role: 'user', text: `Question ${turn}`, selections: [{ path: 'a.md', text: 'quote' }], images: ['a.png'] },
    { role: 'assistant', text: `Answer ${turn}`, reasoning: 'reasoning', sources: [{ url: 'https://example.com' }] },
    ...(turn % 10 === 0 ? [{ kind: 'compaction' }] : []),
  ]).flat();
  const start = historyPageStart(messages);
  assert.equal(messages[start].text, 'Question 992');
  assert.equal(messages.slice(start).filter(entry => entry.role === 'user').length, HISTORY_PAGE_TURNS);
  assert.ok(messages.length - start < 20, 'initial display work stays bounded for 1,000 turns');
  let end = messages.length;
  let restored = [];
  while (end > 0) {
    const from = historyPageStart(messages, end);
    assert.ok(from < end);
    restored = [...messages.slice(from, end), ...restored];
    end = from;
  }
  assert.equal(restored.length, messages.length);
  restored.forEach((entry, index) => assert.equal(entry, messages[index], 'preserve selections, images, citations and dividers by identity'));
});

test('empty/short history and legacy assistant-only history have finite, bounded pages', () => {
  assert.equal(historyPageStart([]), 0);
  assert.equal(historyPageStart([{ role: 'assistant', text: 'legacy' }]), 0);
  const entries = Array.from({ length: 200 }, () => ({ role: 'assistant', text: 'tool continuation' }));
  let end = entries.length;
  while (end) {
    const start = historyPageStart(entries, end);
    assert.ok(end - start <= HISTORY_PAGE_ENTRIES);
    assert.ok(start < end);
    end = start;
  }
});

test('a pending user turn and interrupted/compaction markers remain reachable across page boundaries', () => {
  const records = [];
  for (let turn = 0; turn < 9; turn++) {
    records.push({ kind: 'turn/started', payload: {} },
      { kind: 'item/input', payload: { item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Q${turn}` }] } } });
    if (turn < 8) records.push({ kind: 'turn/finished', payload: { text: `A${turn}`, state: turn === 2 ? 'interrupted' : 'complete' } });
    if (turn === 3) records.push({ kind: 'compaction/checkpoint', payload: { range: { from: 0, to: 3 } } });
  }
  const before = JSON.stringify(records);
  const messages = conversationFromRecords(records);
  const start = historyPageStart(messages);
  assert.equal(messages[start].text, 'Q1');
  assert.equal(messages.at(-1).text, 'Q8');
  assert.ok(messages.slice(start).some(entry => entry.kind === 'compaction'));
  assert.ok(messages.slice(start).some(entry => entry.kind === 'interrupted'));
  assert.equal(JSON.stringify(records), before, 'display paging never rewrites canonical history');
});
