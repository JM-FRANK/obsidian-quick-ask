// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parser, Table } = require('@lezer/markdown');
const { markdownTableSources } = require('../src/quick-ask/markdown-tables');
const { createSourceCopy } = require('../src/quick-ask/source-copy');
const tableParser = parser.configure(Table);
const extract = text => markdownTableSources(text, tableParser);

test('table copying preserves alignment, escapes, code, math, Unicode and CRLF', () => {
  const table = '| 中文😀 | Value |\r\n| :--- | ---: |\r\n| **bold** \\| text | `code` $x_1$<br>next |';
  assert.deepEqual(extract(`Before\r\n\r\n${table}\r\n\r\nAfter`), [table]);
});

test('multiple and identical tables retain their order and formatting', () => {
  const first = 'A | B\n:- | -:\nx | y';
  const second = '| C | D |\n| --- | --- |\n| 1 | 2 |';
  assert.deepEqual(extract(`${first}\n\n${second}\n\n${first}`), [first, second, first]);
});

test('line-end padding does not break table recognition or change copied whitespace', () => {
  const table = '| A | B |  \r\n| --- | --- | \r\n| x | y |\t ';
  assert.deepEqual(extract(table), [table]);
});

test('quoted and list-nested tables copy as standalone Markdown tables', () => {
  const table = '| A | B |\n| --- | --- |\n| x | y |';
  const quoted = table.split('\n').map(line => `> ${line}`).join('\n');
  const listed = table.split('\n').map(line => `  ${line}`).join('\n');
  assert.deepEqual(extract(`${quoted}\n\n- item\n\n${listed}`), [table, table]);
});

test('tables in text/code fences, indented code, HTML and comments are not copied as rendered tables', () => {
  const table = '| A | B |\n| --- | --- |\n| x | y |';
  const text = `\`\`\`text\n${table}\n\`\`\`\n\n~~~~md\n${table}\n~~~~\n\n${table.split('\n').map(line => `    ${line}`).join('\n')}\n\n<!--\n${table}\n-->\n\n<table><tr><td>x</td></tr></table>`;
  assert.deepEqual(extract(text), []);
});

test('a header-only table is preserved without consuming following prose', () => {
  const table = '| A | B |\n| --- | --- |';
  assert.deepEqual(extract(`${table}\n\nParagraph`), [table]);
  assert.deepEqual(extract('No table | here\njust prose'), []);
});

function clipboard(write = async () => {}) {
  const feedback = [], failures = [], timers = new Map(), cancelled = [];
  let next = 0;
  const action = createSourceCopy({ write, feedback: value => feedback.push(value), failed: () => failures.push(true),
    delay(ms, callback) { assert.equal(ms, 1000); timers.set(++next, callback); return next; },
    cancelDelay(id) { cancelled.push(id); timers.delete(id); } });
  return { action, feedback, failures, timers, cancelled };
}

test('copying writes the exact source and shows a check for one second after success', async () => {
  const writes = [];
  const state = clipboard(async source => writes.push(source));
  await state.action.copy('  exact\r\nsource\n');
  assert.deepEqual(writes, ['  exact\r\nsource\n']);
  assert.deepEqual(state.feedback, [true]);
  state.timers.get(1)();
  assert.deepEqual(state.feedback, [true, false]);
  assert.deepEqual(state.failures, []);
});

test('repeated copy resets the feedback timer; failure never indicates success', async () => {
  let fail = false;
  const state = clipboard(async () => { if (fail) throw Error('denied'); });
  await state.action.copy('first');
  await state.action.copy('second');
  assert.deepEqual(state.cancelled, [1]);
  assert.equal(state.timers.size, 1);
  fail = true;
  await state.action.copy('third');
  assert.deepEqual(state.feedback, [true, true, false]);
  assert.deepEqual(state.failures, [true]);
  assert.equal(state.timers.size, 0);
});

test('older clipboard completions cannot override a newer attempt', async () => {
  const pending = [];
  const state = clipboard(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  const older = state.action.copy('old'), newer = state.action.copy('new');
  pending[1].resolve(); await newer;
  pending[0].reject(Error('old failure')); await older;
  assert.deepEqual(state.feedback, [true]);
  assert.deepEqual(state.failures, []);
});

test('disposing cancels feedback timers and ignores outstanding clipboard operations', async () => {
  let finish;
  const state = clipboard(() => new Promise(resolve => { finish = resolve; }));
  const work = state.action.copy('source');
  state.action.dispose(); finish(); await work;
  assert.deepEqual(state.feedback, []);
  assert.equal(state.timers.size, 0);
  const successful = clipboard();
  await successful.action.copy('done');
  successful.action.dispose();
  assert.equal(successful.timers.size, 0);
  assert.deepEqual(successful.cancelled, [1]);
});
