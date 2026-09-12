const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activePickerQuery, isCompositionEvent, rankFiles, pickerOptions, MAX_RESULTS } = require('../src/quick-ask/file-picker');

// A stand-in for Obsidian's prepareFuzzySearch(): it accepts a path when every
// query character appears in order and scores how tightly they are packed.
function makeFuzzy() {
  return (text, query) => {
    let position = -1;
    let spread = 0;
    for (const character of query.toLowerCase()) {
      const found = text.toLowerCase().indexOf(character, position + 1);
      if (found < 0) return null;
      spread += found - position;
      position = found;
    }
    return { score: 1 / (1 + spread), matches: [] };
  };
}

test('the active query is the text between [[ and the caret', () => {
  assert.deepEqual(activePickerQuery('see [[pap', 9), { query: 'pap', from: 4, to: 9 });
  assert.equal(activePickerQuery('see [[paper.md]] later', 22), null, 'a closed link is not a query');
  assert.equal(activePickerQuery('no trigger here', 11), null);
  assert.deepEqual(activePickerQuery('[[', 2), { query: '', from: 0, to: 2 }, 'document start is a valid boundary');
  assert.equal(activePickerQuery('text[[', 6), null);
  assert.deepEqual(activePickerQuery('\t[[', 3), { query: '', from: 1, to: 3 });
  assert.deepEqual(activePickerQuery('\n[[', 3), { query: '', from: 1, to: 3 });
  assert.deepEqual(activePickerQuery('question\r\n[[', 12), { query: '', from: 10, to: 12 });
  assert.deepEqual(activePickerQuery(' [[', 3), { query: '', from: 1, to: 3 });
});

test('an explicitly expanded reference can edit its path without creating a normal text trigger', () => {
  assert.equal(activePickerQuery('text[[notes/a.md]]', 16), null);
  assert.deepEqual(activePickerQuery('[[notes/a.md]]', 12, { editingFrom: 0 }), { query: 'notes/a.md', from: 0, to: 12 });
});

test('a query never spans a line break or runs past a closing bracket', () => {
  assert.equal(activePickerQuery('[[pap\ncontinued', 16), null);
  // Only the most recent `[[` matters, so a closed link earlier in the line
  // does not block a fresh trigger.
  const line = '[[a]] and [[b';
  assert.deepEqual(activePickerQuery(line, line.length), { query: 'b', from: 10, to: 13 });
  assert.deepEqual(activePickerQuery('text [[b', 8), { query: 'b', from: 5, to: 8 });
});

test('a full-width IME opener triggers the picker exactly like the ASCII pair', () => {
  assert.deepEqual(activePickerQuery('【【pap', 5), { query: 'pap', from: 0, to: 5 });
  assert.deepEqual(activePickerQuery('see 【【pap', 9), { query: 'pap', from: 4, to: 9 });
  assert.deepEqual(activePickerQuery(' 【【', 3), { query: '', from: 1, to: 3 });
  assert.deepEqual(activePickerQuery('\n【【', 3), { query: '', from: 1, to: 3 });
  // Chinese IMEs emit U+3000 for a full-width space, and it is whitespace.
  assert.deepEqual(activePickerQuery('\u3000【【', 3), { query: '', from: 1, to: 3 });
  assert.equal(activePickerQuery('【', 1), null, 'one full-width bracket is ordinary text');
  assert.equal(activePickerQuery('text【【', 6), null, 'the same boundary rule applies to the full-width opener');
});

test('either closing pair ends a query, whichever opener started it', () => {
  assert.equal(activePickerQuery('【【pap】】', 7), null);
  assert.equal(activePickerQuery('【【pap]]', 7), null, 'a half-width close still ends a full-width query');
  assert.equal(activePickerQuery('[[pap】】', 7), null, 'a full-width close still ends a half-width query');
  assert.deepEqual(activePickerQuery('【【pap】', 6), { query: 'pap】', from: 0, to: 6 }, 'a single full-width bracket is query text');
  // The nearest opener wins, across spellings and across an earlier closed link.
  const mixed = '[[a]] 【【b';
  assert.deepEqual(activePickerQuery(mixed, mixed.length), { query: 'b', from: 6, to: 9 });
});

test('the picker only reacts to committed text, never to an IME composition', () => {
  // isComposing is the standard flag on key and input events.
  assert.equal(isCompositionEvent({ isComposing: true }), true);
  assert.equal(isCompositionEvent({ isComposing: true, keyCode: 13 }), true, 'Enter that confirms a candidate is composing');
  // keyCode 229 is the legacy marker some Windows IMEs still emit.
  assert.equal(isCompositionEvent({ keyCode: 229 }), true);
  assert.equal(isCompositionEvent({ isComposing: false, keyCode: 13 }), false, 'a real Enter chooses a suggestion');
  assert.equal(isCompositionEvent({ isComposing: false, keyCode: 27 }), false, 'a real Escape closes the picker');
  assert.equal(isCompositionEvent({}), false, 'a mouse selection carries no composition flag');
  assert.equal(isCompositionEvent(null), false);
  assert.equal(isCompositionEvent(undefined), false);
});

test('an empty query lists the supplied Markdown files in host order', () => {
  const paths = ['papers/attention.md', 'notes/alpha.md', 'notes/beta.md'];
  assert.deepEqual(rankFiles(paths, '', makeFuzzy()).map((entry) => entry.path), paths);
  assert.deepEqual(pickerOptions(paths, '', makeFuzzy()).map((option) => option.label), ['papers/', 'notes/']);
});

test('each query character matches the full path, including non-contiguous directories', () => {
  const paths = ['10_Raw/papers/中文文件夹/paper.md', 'notes/paper.md', 'assets/plot.png'];
  const options = pickerOptions(paths, '10p中文pa', makeFuzzy());
  assert.deepEqual(options.map(o => o.path), [paths[0]]);
  assert.equal(options[0].label, 'paper.md');
  assert.equal(options[0].directory, '10_Raw/papers/中文文件夹');
  assert.equal(pickerOptions(paths, 'assets/pl', makeFuzzy())[0].path, 'assets/plot.png');
});

test('display splits the official full-path highlight ranges without changing the query', () => {
  const options = pickerOptions(['long/folder/paper.md'], 'lo/pa', (text, query) => {
    assert.equal(text, 'long/folder/paper.md'); assert.equal(query, 'lo/pa');
    return { score: 1, matches: [[0, 2], [10, 14]] };
  });
  assert.deepEqual(options[0].matches, [[0, 2]]);
  assert.deepEqual(options[0].directoryMatches, [[0, 2], [10, 11]]);
});

test('ranking keeps only matching files, orders by score, and ties break by path', () => {
  const paths = ['papers/attention.md', 'notes/alpha.md', 'notes/alphabet.md'];
  const ranked = rankFiles(paths, 'alpha', makeFuzzy());
  assert.deepEqual(ranked.map((entry) => entry.path), ['notes/alpha.md', 'notes/alphabet.md']);
  const none = rankFiles(paths, 'zzz', makeFuzzy());
  assert.deepEqual(none, []);
});

test('ranking bounds the result list and tolerates a malformed host list', () => {
  const many = Array.from({ length: 120 }, (_, index) => `notes/file-${index}.md`);
  assert.equal(rankFiles(many, '', makeFuzzy()).length, MAX_RESULTS);
  assert.deepEqual(rankFiles(null, '', makeFuzzy()), []);
  assert.deepEqual(rankFiles([null, 42, '', 'a.md'], '', makeFuzzy()).map((entry) => entry.path), ['a.md']);
});
