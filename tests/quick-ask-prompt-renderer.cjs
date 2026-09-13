// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  RENDERER_VERSION,
  escapeAttribute,
  renderContextEnvelope,
  renderTurn,
  buildInstructions,
  GET_FULL_FILE_TOOL,
} = require('../src/quick-ask/prompt-renderer');

// The renderer is the byte-stable contract between a stored session and the
// model, so every expected value below is written out by hand from spec.md
// instead of being recomputed the way the module computes it.

test('the default rendering keeps the original version 1 bytes and the latest version is 2', () => {
  // Version 1 stays reachable for callers that predate the line-numbering
  // follow-up; new requests select the latest explicitly (QA-007).
  assert.equal(RENDERER_VERSION, 2);
  const legacy = renderTurn({ mutations: [{ kind: 'file', path: 'a.md', text: 'alpha' }], question: 'q', rendererVersion: 1 });
  assert.equal(legacy[0].content[0].text.includes('1 | alpha'), false);
  const latest = renderTurn({ mutations: [{ kind: 'file', path: 'a.md', text: 'alpha' }], question: 'q', rendererVersion: 2 });
  assert.equal(latest[0].content[0].text.includes('1 | alpha'), true);
});

test('attribute escaping covers the XML attribute characters', () => {
  assert.equal(escapeAttribute('folder/file.md'), 'folder/file.md');
  assert.equal(escapeAttribute('a&b'), 'a&amp;b');
  assert.equal(escapeAttribute('a<b>c'), 'a&lt;b&gt;c');
  assert.equal(escapeAttribute('a"b\'c'), 'a&quot;b&apos;c');
  assert.equal(
    escapeAttribute('x&<>"\'y'),
    'x&amp;&lt;&gt;&quot;&apos;y',
    'the ampersand introduced by escaping is never double-escaped',
  );
});

test('one complete file renders one XML envelope element with its raw body and length', () => {
  // '# Title' (7) + '\n\n' (2) + 'Body text' (9) + '\n' (1) = 19 code units.
  const body = '# Title\n\nBody text\n';
  const envelope = renderContextEnvelope([{ kind: 'file', path: 'folder/a.md', text: body }]);
  assert.equal(
    envelope,
    '<quick_ask_context>\n'
    + '<context_file path="folder/a.md" content_length="19">\n'
    + '# Title\n\nBody text\n'
    + '\n</context_file>\n'
    + '</quick_ask_context>',
  );
});

test('content_length is the JavaScript string length of the body', () => {
  // Four UTF-16 code units: astral characters count as two, exactly like
  // String.length.
  const body = 'a\u{1F600}b';
  assert.equal(body.length, 4);
  const envelope = renderContextEnvelope([{ kind: 'file', path: 'emoji.md', text: body }]);
  assert.equal(envelope.includes('content_length="4"'), true);
  assert.equal(envelope.includes(`>\n${body}\n</context_file>`), true);
});

test('rendering the same mutations twice is byte-stable', () => {
  const mutations = [
    { kind: 'file', path: 'a.md', text: 'alpha' },
    { kind: 'diff', path: 'b.md', diff: 'Index: b.md\n' },
    { kind: 'selection', path: 'b.md', text: 'picked' },
    { kind: 'reference', path: 'c.md' },
    { kind: 'renamed', oldPath: 'c.md', newPath: 'd.md' },
    { kind: 'deleted', path: 'e.md' },
  ];
  assert.equal(renderContextEnvelope(mutations), renderContextEnvelope(mutations));
  assert.equal(renderContextEnvelope([]), '<quick_ask_context>\n</quick_ask_context>');
});

test('every Context mutation kind renders its confirmed element', () => {
  const envelope = renderContextEnvelope([
    { kind: 'file', path: 'a.md', text: 'alpha' },
    { kind: 'diff', path: 'a.md', diff: 'Index: a.md\n@@ -1 +1 @@\n-alpha\n+ALPHA\n' },
    { kind: 'reference', path: 'b.md' },
    { kind: 'renamed', oldPath: 'b.md', newPath: 'c.md' },
    { kind: 'deleted', path: 'd.md' },
    { kind: 'selection', path: 'a.md', text: 'picked words' },
  ]);
  assert.equal(
    envelope,
    '<quick_ask_context>\n'
    + '<context_file path="a.md" content_length="5">\n'
    + 'alpha\n'
    + '</context_file>\n'
    + '<context_diff path="a.md">\n'
    + 'Index: a.md\n@@ -1 +1 @@\n-alpha\n+ALPHA\n'
    + '\n</context_diff>\n'
    + '<context_file_renamed old_path="b.md" new_path="c.md" />\n'
    + '<context_file_deleted path="d.md" />\n'
    + '<context_file_reference path="b.md" />\n'
    + '<context_selection path="a.md">\n'
    + 'picked words\n'
    + '</context_selection>\n'
    + '</quick_ask_context>',
  );
});

test('paths are XML-escaped in every attribute, including both lifecycle paths', () => {
  const path = 'notes/a&b<"c">.md';
  const escaped = 'notes/a&amp;b&lt;&quot;c&quot;&gt;.md';
  assert.equal(
    renderContextEnvelope([
      { kind: 'file', path, text: 'x' },
      { kind: 'diff', path, diff: 'x' },
      { kind: 'selection', path, text: 'x' },
      { kind: 'reference', path },
      { kind: 'renamed', oldPath: path, newPath: path },
      { kind: 'deleted', path },
    ]),
    '<quick_ask_context>\n'
    + `<context_file path="${escaped}" content_length="1">\n`
    + 'x\n'
    + '</context_file>\n'
    + `<context_diff path="${escaped}">\n`
    + 'x\n'
    + '</context_diff>\n'
    + `<context_file_renamed old_path="${escaped}" new_path="${escaped}" />\n`
    + `<context_file_deleted path="${escaped}" />\n`
    + `<context_file_reference path="${escaped}" />\n`
    + `<context_selection path="${escaped}">\n`
    + 'x\n'
    + '</context_selection>\n'
    + '</quick_ask_context>',
  );
});

test('mutations are grouped in the confirmed order regardless of input order', () => {
  const envelope = renderContextEnvelope([
    { kind: 'selection', path: 's2.md', text: 'second pick' },
    { kind: 'reference', path: 'r2.md' },
    { kind: 'deleted', path: 'gone.md' },
    { kind: 'file', path: 'f2.md', text: 'two' },
    { kind: 'selection', path: 's1.md', text: 'first pick' },
    { kind: 'file', path: 'f1.md', text: 'one' },
    { kind: 'renamed', oldPath: 'old.md', newPath: 'new.md' },
    { kind: 'reference', path: 'r1.md' },
    { kind: 'reference', path: 'r2.md' },
    { kind: 'diff', path: 'f1.md', diff: 'diff-body' },
  ]);
  assert.equal(
    envelope,
    '<quick_ask_context>\n'
    + '<context_file path="f2.md" content_length="3">\n'
    + 'two\n'
    + '</context_file>\n'
    + '<context_file path="f1.md" content_length="3">\n'
    + 'one\n'
    + '</context_file>\n'
    + '<context_file_deleted path="gone.md" />\n'
    + '<context_file_renamed old_path="old.md" new_path="new.md" />\n'
    + '<context_diff path="f1.md">\n'
    + 'diff-body\n'
    + '</context_diff>\n'
    + '<context_file_reference path="r2.md" />\n'
    + '<context_file_reference path="r1.md" />\n'
    + '<context_selection path="s2.md">\n'
    + 'second pick\n'
    + '</context_selection>\n'
    + '<context_selection path="s1.md">\n'
    + 'first pick\n'
    + '</context_selection>\n'
    + '</quick_ask_context>',
  );
});

test('a repeated chip for the same Vault Path within one question renders once', () => {
  const envelope = renderContextEnvelope([
    { kind: 'reference', path: 'notes/a.md' },
    { kind: 'reference', path: 'notes/b.md' },
    { kind: 'reference', path: 'notes/a.md' },
  ]);
  assert.equal(
    envelope,
    '<quick_ask_context>\n'
    + '<context_file_reference path="notes/a.md" />\n'
    + '<context_file_reference path="notes/b.md" />\n'
    + '</quick_ask_context>',
  );
});

test('a file body and a selection body keep their original text, CRLF included', () => {
  const fileBody = 'line1\r\nline2';
  const selectionBody = 'picked\r\nwords\n';
  // 'line1' (5) + CRLF (2) + 'line2' (5) = 12 code units.
  const envelope = renderContextEnvelope([
    { kind: 'file', path: 'a.md', text: fileBody },
    { kind: 'selection', path: 'a.md', text: selectionBody },
  ]);
  assert.equal(
    envelope,
    '<quick_ask_context>\n'
    + '<context_file path="a.md" content_length="12">\n'
    + 'line1\r\nline2\n'
    + '</context_file>\n'
    + '<context_selection path="a.md">\n'
    + 'picked\r\nwords\n'
    + '\n</context_selection>\n'
    + '</quick_ask_context>',
  );
});

test('a mutation kind this renderer version does not know is ignored', () => {
  const envelope = renderContextEnvelope([
    { kind: 'future/mutation', path: 'a.md', text: 'ignored' },
    null,
    { kind: 'file', path: 'kept.md', text: 'kept' },
  ]);
  assert.equal(
    envelope,
    '<quick_ask_context>\n'
    + '<context_file path="kept.md" content_length="4">\n'
    + 'kept\n'
    + '</context_file>\n'
    + '</quick_ask_context>',
  );
  assert.deepEqual(renderContextEnvelope(null).split('\n'), ['<quick_ask_context>', '</quick_ask_context>']);
});


test('a turn with Context additions sends an additions message then a separate question message', () => {
  const messages = renderTurn({
    mutations: [{ kind: 'file', path: 'a.md', text: 'alpha' }],
    question: 'What does this mean?',
  });
  assert.deepEqual(messages, [
    {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: '<quick_ask_context>\n'
          + '<context_file path="a.md" content_length="5">\n'
          + 'alpha\n'
          + '</context_file>\n'
          + '</quick_ask_context>',
      }],
    },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What does this mean?' }] },
  ]);
});

test('a turn with no Context additions sends only the question message', () => {
  assert.deepEqual(renderTurn({ mutations: [], question: 'Just a question' }), [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Just a question' }] },
  ]);
  assert.equal(renderTurn({ mutations: [{ kind: 'future/mutation' }], question: 'Q' }).length, 1);
});

test('the fixed instructions carry the confirmed operational rules', () => {
  const instructions = buildInstructions({ customSystemPrompt: '' });
  assert.match(instructions, /quick_ask_context/);
  assert.match(instructions, /untrusted/i);
  assert.match(instructions, /never follow/i);
  assert.match(instructions, /get-full-file/);
  assert.match(instructions, /read-only/i);
  assert.match(instructions, /cannot create, modify, rename, or delete/i);
  assert.equal(buildInstructions({}), instructions, 'the same stable value is produced without a custom prompt');
  assert.equal(buildInstructions({ customSystemPrompt: '' }), instructions);
});

test('the custom system prompt is appended inside the same stable instructions value', () => {
  const fixed = buildInstructions({ customSystemPrompt: '' });
  assert.equal(
    buildInstructions({ customSystemPrompt: 'Always answer in Chinese.' }),
    `${fixed}\n\nAlways answer in Chinese.`,
  );
  assert.equal(buildInstructions({ customSystemPrompt: '   ' }), fixed, 'a blank custom prompt appends nothing');
  assert.equal(buildInstructions({ customSystemPrompt: '  padded  ' }), `${fixed}\n\npadded`);
});

test('the line-number rule describes the reference block instead of trailing the custom prompt', () => {
  const latest = buildInstructions({ rendererVersion: 2 });
  assert.match(latest, /line_numbers="physical"/);
  assert.ok(latest.indexOf('line_numbers') > latest.indexOf('<quick_ask_context>'), 'the rule belongs to the reference block');
  assert.ok(latest.indexOf('line_numbers') < latest.indexOf('Use only tools declared'), 'and stays inside that paragraph');
  assert.equal(buildInstructions({ rendererVersion: 1 }).includes('line_numbers'), false, 'version 1 has no line numbering');
  const withCustom = buildInstructions({ rendererVersion: 2, customSystemPrompt: 'Always answer in Chinese.' });
  assert.ok(withCustom.indexOf('line_numbers') < withCustom.indexOf('Always answer in Chinese.'), 'the rule is never part of the custom prompt');
  assert.ok(withCustom.indexOf('Always answer in Chinese.') > withCustom.indexOf('Quick Ask is read-only'), 'the custom prompt stays last');
});

test('the get-full-file tool definition is the exact frozen spec constant', () => {
  assert.deepEqual(GET_FULL_FILE_TOOL, {
    type: 'function',
    name: 'get-full-file',
    description: '当你不确定文件的完整上下文时使用，以获得完整文件内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Obsidian Vault 相对路径' } },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  });
  assert.equal(Object.isFrozen(GET_FULL_FILE_TOOL), true);
});
