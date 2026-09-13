// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  RENDERER_MAX_EFFECTIVE_CHANGES,
  DIFF_CONTEXT_LINES,
  createTrackedFile,
  filteredProjection,
  diffIsEffective,
  createContextTracker,
} = require('../src/quick-ask/tracking');
const { renderTurn } = require('../src/quick-ask/prompt-renderer');

// Context Diff Filtering and the tracked Context File model. Expected projection
// strings below are written out by hand from the confirmed rules in spec.md.

// An in-memory stand-in for the environment's `vault` capability slice.
function makeVault(files = {}) {
  const store = new Map(Object.entries(files));
  const reads = [];
  return {
    store,
    reads,
    async readText(path) {
      reads.push(path);
      return store.has(path) ? store.get(path) : null;
    },
    exists(path) {
      return store.has(path);
    },
    normalizePath(path) {
      return String(path ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    },
    resolveRole(path) {
      const name = String(path ?? '');
      if (name.startsWith('.') || name.includes('..')) return null;
      return /\.(?:md|markdown)$/i.test(name) ? 'markdown' : null;
    },
  };
}

function makeTracker(files = {}) {
  const vault = makeVault(files);
  const events = [];
  // The tracker never timestamps anything, so the scheduler slice is an
  // injectable seam rather than a clock it needs.
  const scheduler = { now: () => 0 };
  const tracker = createContextTracker({ vault, scheduler, onEvent: (event) => events.push(event) });
  return { tracker, vault, events };
}

test('the confirmed tracking constants are pinned', () => {
  assert.equal(RENDERER_MAX_EFFECTIVE_CHANGES, 5);
  assert.equal(DIFF_CONTEXT_LINES, 3);
});

test('filteredProjection normalizes only line endings, a BOM, and one final newline', () => {
  const base = 'alpha\nbeta\ngamma';
  assert.equal(filteredProjection(base), base, 'already-normalized text is unchanged');
  assert.equal(filteredProjection('alpha\r\nbeta\r\ngamma'), base, 'CRLF versus LF is not a change');
  assert.equal(filteredProjection('alpha\rbeta'), 'alpha\nbeta', 'a lone CR is a line ending too');
  assert.equal(filteredProjection('\uFEFFalpha\nbeta\ngamma'), base, 'BOM insertion is not a change');
  assert.equal(filteredProjection(`${base}\n`), base, 'one final newline insertion is not a change');
  assert.equal(filteredProjection(`\uFEFFalpha\r\nbeta\r\ngamma\n`), base, 'all three together are still no change');
});

test('filteredProjection keeps real content changes, a second final newline, and inner newlines', () => {
  const base = 'alpha\nbeta\ngamma';
  assert.equal(filteredProjection('alpha\nbeta\nGAMMA'), 'alpha\nbeta\nGAMMA');
  assert.notEqual(filteredProjection(`${base}\n\n`), base, 'a second final newline is a real change');
  assert.notEqual(filteredProjection('alpha\n\nbeta\ngamma'), base, 'a blank line inside the body is a real change');
  assert.equal(filteredProjection('alpha beta'), 'alpha beta');
});

test('filteredProjection ignores bold, italic, strikethrough, and highlight delimiter changes', () => {
  assert.equal(filteredProjection('**bold**'), 'bold');
  assert.equal(filteredProjection('__bold__'), 'bold');
  assert.equal(filteredProjection('*italic*'), 'italic');
  assert.equal(filteredProjection('_italic_'), 'italic');
  assert.equal(filteredProjection('~~struck~~'), 'struck');
  assert.equal(filteredProjection('==marked=='), 'marked');
  assert.equal(filteredProjection('***both***'), 'both');
  assert.equal(filteredProjection('**a *b* c**'), 'a b c');
  assert.equal(filteredProjection('**bold** and *italic*'), 'bold and italic');
  // Changing only which delimiters carry the same visible text is not a change.
  assert.equal(filteredProjection('**same**'), filteredProjection('*same*'));
  assert.equal(filteredProjection('__same__'), filteredProjection('_same_'));
  assert.equal(filteredProjection('text'), filteredProjection('**text**'));
});

test('filteredProjection retains changes to the enclosed visible text', () => {
  assert.equal(filteredProjection('**bald**'), 'bald');
  assert.notEqual(filteredProjection('**bold**'), filteredProjection('**bald**'));
  assert.notEqual(filteredProjection('*a*'), filteredProjection('*ab*'));
  assert.notEqual(filteredProjection('~~a~~'), filteredProjection('~~b~~'));
  assert.notEqual(filteredProjection('==a=='), filteredProjection('==b=='));
});

test('filteredProjection leaves list markers, rules, comparisons, intraword underscores, and escapes alone', () => {
  assert.equal(filteredProjection('* item'), '* item');
  assert.equal(filteredProjection('- item'), '- item');
  assert.equal(filteredProjection('snake_case_name'), 'snake_case_name');
  assert.equal(filteredProjection('a == b'), 'a == b');
  assert.equal(filteredProjection('a = b'), 'a = b');
  assert.equal(filteredProjection('Title\n======'), 'Title\n======');
  assert.equal(filteredProjection('***'), '***');
  assert.equal(filteredProjection('\\*literal\\*'), '\\*literal\\*');
});

test('filteredProjection leaves code spans, fenced code, indented code, and frontmatter untouched', () => {
  assert.equal(filteredProjection('`**not bold**`'), '`**not bold**`');
  assert.equal(filteredProjection('```\n**not bold**\n```'), '```\n**not bold**\n```');
  assert.equal(filteredProjection('    **indented code**'), '    **indented code**');
  assert.equal(filteredProjection('---\ntitle: **keep**\n---'), '---\ntitle: **keep**\n---');
  // A real change outside the protected region is still retained.
  assert.equal(filteredProjection('`code` and **bold**'), '`code` and bold');
});

test('filteredProjection ignores Obsidian link and embed targets while retaining aliases', () => {
  assert.equal(filteredProjection('[[Folder/Note]]'), 'Note');
  assert.equal(filteredProjection('[[Note#Heading]]'), 'Note');
  assert.equal(filteredProjection('[[Folder/Note|alias]]'), 'alias');
  assert.equal(filteredProjection('![[Folder/Note]]'), '');
  assert.equal(filteredProjection('![[image.png|alt text]]'), 'alt text');
  assert.equal(filteredProjection('See ![[image.png|300]] here'), 'See here', 'an embed size alias is syntax, not alt text');
  // Target-only changes are ignored: moving a note to another folder, changing a
  // heading anchor, and swapping an embed target all keep the visible text. A
  // different note does change the visible text and is retained.
  assert.equal(filteredProjection('[[Folder/One]]'), filteredProjection('[[Other/One]]'));
  assert.equal(filteredProjection('[[One#First]]'), filteredProjection('[[One#Second]]'));
  assert.equal(filteredProjection('[[Folder/One|same]]'), filteredProjection('[[Other/Two|same]]'));
  assert.equal(filteredProjection('![[a.png]]'), filteredProjection('![[b.png]]'));
  assert.notEqual(filteredProjection('[[One]]'), filteredProjection('[[Two]]'));
  // Alias changes are retained.
  assert.notEqual(filteredProjection('[[A|one]]'), filteredProjection('[[A|two]]'));
  assert.notEqual(filteredProjection('![[a.png|one]]'), filteredProjection('![[a.png|two]]'));
});

test('filteredProjection ignores Markdown link and image targets while retaining labels and alt text', () => {
  assert.equal(filteredProjection('[label](https://example.com)'), 'label');
  assert.equal(filteredProjection('[label][ref]'), 'label');
  assert.equal(filteredProjection('![alt text](image.png)'), 'alt text');
  assert.equal(filteredProjection('[ref]: https://example.com'), '');
  // Target-only changes are ignored.
  assert.equal(filteredProjection('[same](https://one.example)'), filteredProjection('[same](https://two.example)'));
  assert.equal(filteredProjection('[same][one]'), filteredProjection('[same][two]'));
  assert.equal(filteredProjection('![same](a.png)'), filteredProjection('![same](b.png)'));
  // Label and alt text changes are retained.
  assert.notEqual(filteredProjection('[one](https://x.example)'), filteredProjection('[two](https://x.example)'));
  assert.notEqual(filteredProjection('![one](a.png)'), filteredProjection('![two](a.png)'));
});

test('filteredProjection ignores bare URL and autolink targets', () => {
  assert.equal(filteredProjection('see https://example.com/a for details'), 'see for details');
  assert.equal(filteredProjection('see <https://example.com/a> for details'), 'see for details');
  assert.equal(filteredProjection('read https://example.com/a.'), 'read.', 'a removed target keeps its sentence punctuation attached');
  assert.equal(filteredProjection('mail me at mailto:someone@example.com now'), 'mail me at now');
  assert.equal(filteredProjection('visit www.example.com/path today'), 'visit today');
  // Target-only changes are ignored.
  assert.equal(filteredProjection('see https://one.example/x'), filteredProjection('see https://two.example/y'));
  // Ordinary text around a removed target is retained.
  assert.notEqual(filteredProjection('see https://x.example one'), filteredProjection('see https://x.example two'));
  // An email address is ordinary text, not a URL to strip.
  assert.equal(filteredProjection('write to someone@example.com now'), 'write to someone@example.com now');
});

test('filteredProjection ignores complete Pandoc Citations in every form', () => {
  assert.equal(filteredProjection('Text [@smith2020].'), 'Text.');
  assert.equal(filteredProjection('Text [see @smith2020, p. 33].'), 'Text.');
  assert.equal(filteredProjection('Text [@a; @b].'), 'Text.');
  assert.equal(filteredProjection('Text [@a, pp. 1-2; @b, chap. 3].'), 'Text.');
  assert.equal(filteredProjection('Text @smith2020.'), 'Text.');
  assert.equal(filteredProjection('Text @{smith 2020}.'), 'Text.');
  assert.equal(filteredProjection('Text @a-b.'), 'Text.');
});

test('filteredProjection ignores citation additions, removals, and changes', () => {
  assert.equal(filteredProjection('Text.'), filteredProjection('Text [@smith2020].'));
  assert.equal(filteredProjection('Text [@a].'), filteredProjection('Text [@b].'));
  assert.equal(filteredProjection('Text [see @a, p. 3].'), filteredProjection('Text [@b].'));
  assert.equal(filteredProjection('Text @a.'), filteredProjection('Text @b.'));
  assert.equal(filteredProjection('Text [@a], more.'), filteredProjection('Text, more.'));
  // The visible text around a citation is still retained.
  assert.notEqual(filteredProjection('Text [@a].'), filteredProjection('Other [@a].'));
});

test('filteredProjection does not treat ordinary @ text as a citation', () => {
  assert.equal(filteredProjection('user@example.com'), 'user@example.com');
  assert.equal(filteredProjection('foo.@bar'), 'foo.@bar');
  assert.equal(filteredProjection('100 @ 5'), '100 @ 5');
  assert.equal(filteredProjection('```\n@notacitation\n```'), '```\n@notacitation\n```');
  assert.equal(filteredProjection('`@notacitation`'), '`@notacitation`');
  assert.equal(filteredProjection('\\@escaped'), '\\@escaped');
  assert.equal(filteredProjection('see [^@a] note'), 'see [^@a] note', 'a footnote label is an identifier, not a citation');
  assert.equal(filteredProjection('not a citation [label] here'), 'not a citation [label] here');
});

test('a citation-shaped label inside a real Markdown link keeps the link label', () => {
  assert.equal(filteredProjection('[see @a](https://x.example)'), 'see @a');
});

test('createTrackedFile and diffIsEffective describe the tracked model', () => {
  const record = createTrackedFile({ path: 'notes/a.md', rawText: 'alpha\n' });
  assert.equal(record.path, 'notes/a.md');
  assert.equal(record.observedRawText, 'alpha\n');
  assert.equal(record.observedProjection, 'alpha');
  assert.equal(record.effectiveChanges, 0);
  assert.equal(record.status, 'tracked');
  assert.deepEqual(record.pendingSelections, []);
  assert.equal(diffIsEffective('a', 'b'), true);
  assert.equal(diffIsEffective('a', 'a'), false);
  assert.equal(diffIsEffective('', ''), false);
});

test('a staged complete file sends original text and tracks only at acceptTurn', async () => {
  const raw = 'alpha\nbeta\n';
  const { tracker, vault, events } = makeTracker({ 'notes/a.md': raw });
  assert.deepEqual(tracker.stageFile('notes/a.md', raw), { path: 'notes/a.md', staged: true });

  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations, [{ kind: 'file', path: 'notes/a.md', text: raw }]);
  assert.deepEqual(vault.reads, [], 'caller-verified staged text is not read again');
  assert.deepEqual(tracker.allowlist(), [], 'nothing is allowlisted before the endpoint accepts');
  assert.deepEqual(tracker.trackedFiles(), [{
    path: 'notes/a.md',
    observedRawText: raw,
    observedProjection: 'alpha\nbeta',
    effectiveChanges: 0,
    status: 'staged',
    pendingSelections: [],
  }]);

  tracker.acceptTurn();
  assert.deepEqual(tracker.allowlist(), ['notes/a.md']);
  assert.deepEqual(tracker.trackedFiles(), [{
    path: 'notes/a.md',
    observedRawText: raw,
    observedProjection: 'alpha\nbeta',
    effectiveChanges: 0,
    status: 'tracked',
    pendingSelections: [],
  }]);
  assert.deepEqual(events, [{ kind: 'context/file-added', path: 'notes/a.md', text: raw }]);
});

test('first inclusion sends the original Vault text rather than a filtered projection', async () => {
  const raw = '**bold** and [@a] and [[Note|alias]]\n';
  const { tracker, vault } = makeTracker({ 'notes/a.md': raw });
  tracker.stageFile('notes/a.md');
  const mutations = await tracker.mutationsForSend();
  assert.equal(mutations[0].text, raw);
  assert.deepEqual(vault.reads, ['notes/a.md']);
});

test('only Markdown Vault Paths become Context Files', async () => {
  const { tracker } = makeTracker({ 'notes/a.txt': 'text', 'notes/scan.pdf': 'pdf' });
  assert.deepEqual(tracker.stageFile('notes/a.txt', 'text'), { path: 'notes/a.txt', staged: false, reason: 'role' });
  assert.deepEqual(tracker.stageReference('notes/scan.pdf'), { path: 'notes/scan.pdf', staged: false, reason: 'role' });
  assert.deepEqual(await tracker.mutationsForSend(), []);
  assert.deepEqual(tracker.trackedFiles(), []);
  assert.deepEqual(tracker.allowlist(), []);
});

test('a failure before response.created leaves staged input retryable and untracked', async () => {
  const raw = 'alpha\n';
  const { tracker } = makeTracker({ 'notes/a.md': raw });
  tracker.stageFile('notes/a.md', raw);
  const first = await tracker.mutationsForSend();
  tracker.rejectTurn();
  assert.deepEqual(tracker.allowlist(), []);
  assert.deepEqual(tracker.trackedFiles().map((file) => file.status), ['staged']);
  const retry = await tracker.mutationsForSend();
  assert.deepEqual(retry, first, 'the explicit retry carries the same staged input');
  tracker.acceptTurn();
  assert.deepEqual(tracker.allowlist(), ['notes/a.md']);
  assert.deepEqual(tracker.trackedFiles().map((file) => file.status), ['tracked']);
});

test('a Vault Path is normalized through the vault slice and staged once', async () => {
  const { tracker } = makeTracker({ 'notes/a.md': 'alpha' });
  tracker.stageFile('notes\\a.md', 'alpha');
  tracker.stageFile('./notes/a.md', 'alpha');
  const mutations = await tracker.mutationsForSend();
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].path, 'notes/a.md');
  assert.equal(tracker.trackedFiles().length, 1);
});

test('a chip reference to a new file sends its complete content plus the reference', async () => {
  const raw = 'new file\ncontent\n';
  const { tracker } = makeTracker({ 'notes/b.md': raw });
  assert.deepEqual(tracker.stageReference('notes/b.md'), { path: 'notes/b.md', staged: true });
  assert.deepEqual(tracker.trackedFiles(), [], 'a chip alone creates no File Row before acceptance');

  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations, [
    { kind: 'file', path: 'notes/b.md', text: raw },
    { kind: 'reference', path: 'notes/b.md' },
  ]);

  tracker.acceptTurn();
  assert.deepEqual(tracker.allowlist(), ['notes/b.md']);
  assert.deepEqual(tracker.trackedFiles().map((file) => file.status), ['tracked']);
});

test('a reference to an unchanged tracked file emits only the reference element', async () => {
  const { tracker } = makeTracker({ 'notes/b.md': 'body\n' });
  tracker.stageFile('notes/b.md', 'body\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  tracker.stageReference('notes/b.md');
  assert.deepEqual(await tracker.mutationsForSend(), [{ kind: 'reference', path: 'notes/b.md' }]);
  tracker.acceptTurn();
  assert.deepEqual(await tracker.mutationsForSend(), [], 'the accepted chip belongs to the question that carried it');
});

test('repeated chips in one question are deduplicated in first-chip order', async () => {
  const { tracker, vault } = makeTracker({ 'a.md': 'a', 'b.md': 'b' });
  tracker.stageReference('b.md');
  tracker.stageReference('a.md');
  tracker.stageReference('b.md');
  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations, [
    { kind: 'file', path: 'b.md', text: 'b' },
    { kind: 'file', path: 'a.md', text: 'a' },
    { kind: 'reference', path: 'b.md' },
    { kind: 'reference', path: 'a.md' },
  ]);
  assert.deepEqual(vault.reads, ['b.md', 'a.md'], 'one read per newly referenced file');
});

test('a rejected turn keeps staged chips and selections retryable', async () => {
  const { tracker } = makeTracker({ 'notes/b.md': 'body\n' });
  tracker.stageReference('notes/b.md');
  const selection = tracker.stageSelection({ path: 'notes/b.md', from: 0, to: 4, text: 'body' });
  const first = await tracker.mutationsForSend();
  tracker.rejectTurn();
  assert.deepEqual(tracker.trackedFiles()[0].pendingSelections.map((entry) => entry.id), [selection.id]);
  assert.deepEqual(await tracker.mutationsForSend(), first);
  assert.deepEqual(tracker.allowlist(), []);
});

test('multiple Context Selections accumulate in drag order and carry the containing file', async () => {
  const raw = 'one two three\n';
  const { tracker, events } = makeTracker({ 'notes/a.md': raw });
  const first = tracker.stageSelection({ path: 'notes/a.md', from: 0, to: 3, text: 'one' });
  const second = tracker.stageSelection({ path: 'notes/a.md', from: 4, to: 7, text: 'two' });
  assert.equal(first.staged, true);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(tracker.trackedFiles(), [{
    path: 'notes/a.md',
    observedRawText: null,
    observedProjection: null,
    effectiveChanges: 0,
    status: 'staged',
    pendingSelections: [
      { id: first.id, path: 'notes/a.md', from: 0, to: 3, text: 'one' },
      { id: second.id, path: 'notes/a.md', from: 4, to: 7, text: 'two' },
    ],
  }]);

  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations, [
    { kind: 'file', path: 'notes/a.md', text: raw },
    { kind: 'selection', id: first.id, path: 'notes/a.md', from: 0, to: 3, text: 'one', startLine: 1, startColumn: 0, lineOrigin: 'current' },
    { kind: 'selection', id: second.id, path: 'notes/a.md', from: 4, to: 7, text: 'two', startLine: 1, startColumn: 4, lineOrigin: 'current' },
  ]);

  tracker.acceptTurn();
  assert.deepEqual(tracker.trackedFiles()[0].pendingSelections, [], 'the sent selections belong to that question');
  assert.deepEqual(events.map((event) => event.kind), [
    'context/file-added', 'context/selection-added', 'context/selection-added',
  ]);
});

test('removing one staged selection before send cancels only that selection', async () => {
  const { tracker } = makeTracker({ 'notes/a.md': 'one two\n' });
  const first = tracker.stageSelection({ path: 'notes/a.md', from: 0, to: 3, text: 'one' });
  const second = tracker.stageSelection({ path: 'notes/a.md', from: 4, to: 7, text: 'two' });
  assert.equal(tracker.removeSelection(second.id), true);
  assert.equal(tracker.removeSelection(second.id), false);
  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations.map((mutation) => mutation.kind), ['file', 'selection']);
  assert.equal(mutations[1].text, 'one');
  assert.equal(mutations[1].id, first.id);
});

test('a selection from an unchanged tracked file sends only the selection', async () => {
  const { tracker } = makeTracker({ 'notes/a.md': 'one two\n' });
  tracker.stageFile('notes/a.md', 'one two\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  tracker.stageSelection({ path: 'notes/a.md', from: 0, to: 3, text: 'one' });
  assert.deepEqual((await tracker.mutationsForSend()).map((mutation) => mutation.kind), ['selection']);
});

test('an empty selection and a non-Markdown selection source are refused', () => {
  const { tracker } = makeTracker({ 'notes/a.md': 'x', 'notes/a.txt': 'x' });
  assert.deepEqual(
    tracker.stageSelection({ path: 'notes/a.md', from: 0, to: 0, text: '' }),
    { path: 'notes/a.md', staged: false, reason: 'empty' },
  );
  assert.deepEqual(
    tracker.stageSelection({ path: 'notes/a.txt', from: 0, to: 1, text: 'x' }),
    { path: 'notes/a.txt', staged: false, reason: 'role' },
  );
  assert.deepEqual(tracker.trackedFiles(), []);
});

test('a tracked change produces a unified diff with three context lines and Vault-relative paths', async () => {
  const before = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9'].join('\n');
  const after = ['line 1', 'line 2', 'line 3', 'line 4', 'CHANGED', 'line 6', 'line 7', 'line 8', 'line 9'].join('\n');
  const { tracker, vault } = makeTracker({ 'notes/a.md': before });
  tracker.stageFile('notes/a.md', `${before}\n`);
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  vault.store.set('notes/a.md', `${after}\n`);
  assert.equal(tracker.modifiedFile('notes/a.md'), true);
  const mutations = await tracker.mutationsForSend();
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].kind, 'diff');
  assert.equal(mutations[0].path, 'notes/a.md');
  assert.equal(
    mutations[0].diff,
    'Index: notes/a.md\n'
    + '===================================================================\n'
    + '--- notes/a.md\n'
    + '+++ notes/a.md\n'
    + '@@ -2,7 +2,7 @@\n'
    + ' line 2\n'
    + ' line 3\n'
    + ' line 4\n'
    + '-line 5\n'
    + '+CHANGED\n'
    + ' line 6\n'
    + ' line 7\n'
    + ' line 8\n',
  );
  // The diff belongs to the turn; the count moves only when the endpoint accepts it.
  assert.equal(tracker.trackedFiles()[0].status, 'changed');
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 0);
  tracker.acceptTurn();
  assert.equal(tracker.trackedFiles()[0].status, 'tracked');
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 1);
});

test('a raw modify event, an empty diff, and a failed request never increment the count', async () => {
  const { tracker, vault } = makeTracker({ 'notes/a.md': 'one\n' });
  tracker.stageFile('notes/a.md', 'one\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  tracker.modifiedFile('notes/a.md');
  assert.deepEqual(await tracker.mutationsForSend(), [], 'an unchanged file produces no Context input');
  tracker.acceptTurn();
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 0);

  vault.store.set('notes/a.md', 'two\n');
  tracker.modifiedFile('notes/a.md');
  assert.equal((await tracker.mutationsForSend())[0].kind, 'diff');
  tracker.rejectTurn();
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 0, 'a failure before response.created carries no count');
  assert.equal(tracker.trackedFiles()[0].observedRawText, 'two\n', 'the change stays carried by the retry');
  assert.equal((await tracker.mutationsForSend())[0].kind, 'diff');
  tracker.acceptTurn();
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 1);
});

test('a filtered-only change advances both observed states with no API input and no count', async () => {
  const { tracker, vault, events } = makeTracker({ 'notes/a.md': '**bold** text\n' });
  tracker.stageFile('notes/a.md', '**bold** text\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  events.length = 0;

  vault.store.set('notes/a.md', '*bold* text\n');
  tracker.modifiedFile('notes/a.md');
  assert.deepEqual(await tracker.mutationsForSend(), []);
  tracker.acceptTurn();

  const file = tracker.trackedFiles()[0];
  assert.equal(file.effectiveChanges, 0);
  assert.equal(file.status, 'tracked');
  assert.equal(file.observedRawText, '*bold* text\n');
  assert.equal(file.observedProjection, 'bold text');
  assert.deepEqual(events, [{ kind: 'context/file-updated', path: 'notes/a.md', observedRawText: '*bold* text\n' }]);
});

test('any number of modifications before the next question coalesce into one diff', async () => {
  const { tracker, vault } = makeTracker({ 'notes/a.md': 'one\n' });
  tracker.stageFile('notes/a.md', 'one\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  vault.store.set('notes/a.md', 'two\n');
  tracker.modifiedFile('notes/a.md');
  vault.store.set('notes/a.md', 'three\n');
  tracker.modifiedFile('notes/a.md');
  vault.store.set('notes/a.md', 'four\n');
  tracker.modifiedFile('notes/a.md');

  const mutations = await tracker.mutationsForSend();
  assert.equal(mutations.length, 1);
  assert.equal(
    mutations[0].diff,
    'Index: notes/a.md\n'
    + '===================================================================\n'
    + '--- notes/a.md\n'
    + '+++ notes/a.md\n'
    + '@@ -1,1 +1,1 @@\n'
    + '-one\n'
    + '+four\n',
  );
  assert.equal(vault.reads.filter((path) => path === 'notes/a.md').length, 1, 'three modify events read the file once');
});

test('a change that arrives while a turn is in flight stays pending after acceptance', async () => {
  const { tracker, vault } = makeTracker({ 'notes/a.md': 'one\n' });
  tracker.stageFile('notes/a.md', 'one\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  vault.store.set('notes/a.md', 'two\n');
  tracker.modifiedFile('notes/a.md');
  assert.equal((await tracker.mutationsForSend())[0].kind, 'diff');

  vault.store.set('notes/a.md', 'three\n');
  tracker.modifiedFile('notes/a.md');
  tracker.acceptTurn();

  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 1, 'only the transmitted diff counts');
  assert.equal(tracker.trackedFiles()[0].status, 'changed', 'the later edit is still pending');
  assert.equal(
    (await tracker.mutationsForSend())[0].diff,
    'Index: notes/a.md\n'
    + '===================================================================\n'
    + '--- notes/a.md\n'
    + '+++ notes/a.md\n'
    + '@@ -1,1 +1,1 @@\n'
    + '-two\n'
    + '+three\n',
  );
});

test('the fifth effective change sends the current original text and resets the baseline and count', async () => {
  const { tracker, vault, events } = makeTracker({ 'notes/a.md': 'value 0\n' });
  tracker.stageFile('notes/a.md', 'value 0\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  for (let change = 1; change <= 4; change++) {
    // Formatting delimiters are filtered out of proactive diffs.
    vault.store.set('notes/a.md', `**value ${change}**\n`);
    tracker.modifiedFile('notes/a.md');
    const mutations = await tracker.mutationsForSend();
    assert.equal(mutations[0].kind, 'diff', `change ${change} is a proactive diff`);
    assert.equal(
      mutations[0].diff,
      'Index: notes/a.md\n'
      + '===================================================================\n'
      + '--- notes/a.md\n'
      + '+++ notes/a.md\n'
      + '@@ -1,1 +1,1 @@\n'
      + `-value ${change - 1}\n`
      + `+value ${change}\n`,
    );
    tracker.acceptTurn();
    assert.equal(tracker.trackedFiles()[0].effectiveChanges, change);
  }

  // The fifth effective change is a full refresh of the current original text.
  const fifth = '**value 5** with a citation [@a]\n';
  vault.store.set('notes/a.md', fifth);
  tracker.modifiedFile('notes/a.md');
  const refresh = await tracker.mutationsForSend();
  assert.deepEqual(refresh, [{ kind: 'file', path: 'notes/a.md', text: fifth }]);
  assert.equal(tracker.trackedFiles()[0].status, 'refresh');
  tracker.acceptTurn();

  const file = tracker.trackedFiles()[0];
  assert.equal(file.status, 'tracked');
  assert.equal(file.effectiveChanges, 0);
  assert.equal(file.observedRawText, fifth);
  assert.equal(tracker.trackedFiles().length, 1, 'the File Row is retained');
  assert.equal(events.filter((event) => event.kind === 'context/file-added').length, 2);

  // Tracking continues from the refreshed baseline.
  vault.store.set('notes/a.md', 'value 6\n');
  tracker.modifiedFile('notes/a.md');
  assert.equal(
    (await tracker.mutationsForSend())[0].diff,
    'Index: notes/a.md\n'
    + '===================================================================\n'
    + '--- notes/a.md\n'
    + '+++ notes/a.md\n'
    + '@@ -1,1 +1,1 @@\n'
    + '-value 5 with a citation\n'
    + '+value 6\n',
  );
  tracker.acceptTurn();
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 1);
});

test('a rename updates the path immediately and moves the allowlist entry only at accept', async () => {
  const { tracker, vault, events } = makeTracker({ 'notes/old.md': 'body\n' });
  tracker.stageFile('notes/old.md', 'body\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  events.length = 0;

  assert.equal(tracker.renamedFile('notes/old.md', 'notes/new.md'), true);
  assert.deepEqual(tracker.trackedFiles().map((file) => file.path), ['notes/new.md']);
  assert.deepEqual(events, [{ kind: 'context/file-renamed', oldPath: 'notes/old.md', newPath: 'notes/new.md' }]);
  assert.deepEqual(tracker.allowlist(), ['notes/old.md'], 'the tool allowlist moves when the turn is accepted');

  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations, [{ kind: 'renamed', oldPath: 'notes/old.md', newPath: 'notes/new.md' }]);
  tracker.acceptTurn();
  assert.deepEqual(tracker.allowlist(), ['notes/new.md']);
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 0, 'a rename never increments the count');
  assert.equal(tracker.modifiedFile('notes/old.md'), false, 'the old path is no longer tracked');

  // Later changes diff under the new Vault Path.
  vault.store.set('notes/new.md', 'changed\n');
  tracker.modifiedFile('notes/new.md');
  const diff = (await tracker.mutationsForSend())[0];
  assert.equal(diff.kind, 'diff');
  assert.equal(diff.diff.includes('--- notes/new.md\n'), true);
  assert.equal(diff.diff.includes('notes/old.md'), false);
});

test('an unsent Context File rename keeps its pending selections on the new path', async () => {
  const { tracker, vault, events } = makeTracker({ 'notes/old.md': 'one two\n' });
  const selection = tracker.stageSelection({ path: 'notes/old.md', from: 0, to: 3, text: 'one' });
  vault.store.set('notes/new.md', 'one two\n');
  vault.store.delete('notes/old.md');

  tracker.renamedFile('notes/old.md', 'notes/new.md');
  assert.deepEqual(events, [], 'an unsent file has no model-visible rename event');
  assert.deepEqual(await tracker.mutationsForSend(), [
    { kind: 'file', path: 'notes/new.md', text: 'one two\n' },
    { kind: 'selection', id: selection.id, path: 'notes/new.md', from: 0, to: 3, text: 'one', startLine: 1, startColumn: 0, lineOrigin: 'current' },
  ]);
});

test('a deleted tracked file stops tracking, keeps its history and selections, and queues one event', async () => {
  const { tracker, vault, events } = makeTracker({ 'notes/a.md': 'body\n' });
  tracker.stageFile('notes/a.md', 'body\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  const selection = tracker.stageSelection({ path: 'notes/a.md', from: 0, to: 4, text: 'body' });
  events.length = 0;

  assert.equal(tracker.deletedFile('notes/a.md'), true);
  assert.deepEqual(tracker.trackedFiles(), [], 'the File Row goes immediately');
  assert.deepEqual(tracker.allowlist(), ['notes/a.md'], 'the old path keeps its tool allowlist entry');
  assert.deepEqual(events, [{ kind: 'context/file-deleted', path: 'notes/a.md', wasSent: true }]);

  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations, [
    { kind: 'deleted', path: 'notes/a.md' },
    { kind: 'selection', id: selection.id, path: 'notes/a.md', from: 0, to: 4, text: 'body', startLine: null, startColumn: null, lineOrigin: 'capture' },
  ]);
  tracker.acceptTurn();
  assert.deepEqual(await tracker.mutationsForSend(), [], 'the deletion event belongs to one question');
});

test('a file deleted before its first successful send is dropped with its pending selections', async () => {
  const { tracker, events } = makeTracker({ 'notes/a.md': 'body\n' });
  tracker.stageSelection({ path: 'notes/a.md', from: 0, to: 4, text: 'body' });
  assert.equal(tracker.deletedFile('notes/a.md'), true);
  assert.deepEqual(tracker.trackedFiles(), []);
  assert.deepEqual(events, [{ kind: 'context/file-deleted', path: 'notes/a.md', wasSent: false }]);
  assert.deepEqual(await tracker.mutationsForSend(), []);
});

test('a staged file that vanished before its first send is dropped locally', async () => {
  const { tracker, events } = makeTracker({});
  tracker.stageSelection({ path: 'notes/gone.md', from: 0, to: 3, text: 'one' });
  assert.deepEqual(await tracker.mutationsForSend(), []);
  assert.deepEqual(tracker.trackedFiles(), []);
  assert.deepEqual(tracker.allowlist(), []);
  assert.deepEqual(events, [{ kind: 'context/file-deleted', path: 'notes/gone.md', wasSent: false, reason: 'missing' }]);
});

test('removing a File Row stops tracking but keeps the tool allowlist entry', async () => {
  const { tracker, vault, events } = makeTracker({ 'notes/a.md': 'body\n' });
  tracker.stageFile('notes/a.md', 'body\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  events.length = 0;

  assert.equal(tracker.removedFile('notes/a.md'), true);
  assert.deepEqual(tracker.trackedFiles(), []);
  assert.deepEqual(tracker.allowlist(), ['notes/a.md']);
  assert.deepEqual(events, [{ kind: 'context/file-removed', path: 'notes/a.md', wasSent: true }]);

  vault.store.set('notes/a.md', 'changed\n');
  assert.equal(tracker.modifiedFile('notes/a.md'), false, 'a removed file is no longer tracked');
  assert.deepEqual(await tracker.mutationsForSend(), [], 'it sends no later changes');

  // Dragging from the file again starts tracking again.
  tracker.stageFile('notes/a.md', 'changed\n');
  assert.deepEqual(await tracker.mutationsForSend(), [{ kind: 'file', path: 'notes/a.md', text: 'changed\n' }]);
  tracker.acceptTurn();
  assert.deepEqual(tracker.trackedFiles().map((file) => file.status), ['tracked']);
});

test('removing a File Row that was never sent discards the file and its selections', async () => {
  const { tracker, events } = makeTracker({ 'notes/a.md': 'body\n' });
  tracker.stageSelection({ path: 'notes/a.md', from: 0, to: 4, text: 'body' });
  assert.equal(tracker.removedFile('notes/a.md'), true);
  assert.deepEqual(tracker.trackedFiles(), []);
  assert.deepEqual(tracker.allowlist(), []);
  assert.deepEqual(events, [{ kind: 'context/file-removed', path: 'notes/a.md', wasSent: false }]);
  assert.deepEqual(await tracker.mutationsForSend(), []);
});

test('removing, deleting, or renaming an unknown path is not an error', () => {
  const { tracker } = makeTracker({});
  assert.equal(tracker.removedFile('notes/unknown.md'), false);
  assert.equal(tracker.deletedFile('notes/unknown.md'), false);
  assert.equal(tracker.renamedFile('notes/unknown.md', 'notes/other.md'), false);
  assert.equal(tracker.modifiedFile('notes/unknown.md'), false);
});

test('reconcile compares one read per tracked file and marks a difference as changed', async () => {
  const { tracker, vault } = makeTracker({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' });
  tracker.stageFile('a.md', 'alpha\n');
  tracker.stageFile('b.md', 'bravo\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  const readsBefore = vault.reads.length;

  const result = tracker.reconcile([
    { path: 'a.md', text: 'alpha\n' },
    { path: 'b.md', text: 'bravo changed\n' },
  ]);
  assert.deepEqual(result, { changed: ['b.md'], filteredOnly: [], unchanged: ['a.md'], missing: [] });
  assert.equal(vault.reads.length, readsBefore, 'reconciliation never reads on its own');
  assert.deepEqual(
    tracker.trackedFiles().map((file) => [file.path, file.status]),
    [['a.md', 'tracked'], ['b.md', 'changed']],
  );
  assert.deepEqual((await tracker.mutationsForSend()).map((mutation) => mutation.path), ['b.md']);
});

test('reconcile treats a projection-identical difference as filtered-only', async () => {
  const { tracker, events } = makeTracker({ 'a.md': '**bold**\n' });
  tracker.stageFile('a.md', '**bold**\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  events.length = 0;

  const result = tracker.reconcile(new Map([['a.md', '*bold*\n']]));
  assert.deepEqual(result, { changed: [], filteredOnly: ['a.md'], unchanged: [], missing: [] });
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 0);
  assert.equal(tracker.trackedFiles()[0].observedRawText, '*bold*\n');
  assert.deepEqual(events, [{ kind: 'context/file-updated', path: 'a.md', observedRawText: '*bold*\n' }]);
});

test('reconcile reads a plain object, ignores untracked files, and reports a missing read', async () => {
  const { tracker } = makeTracker({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' });
  tracker.stageFile('a.md', 'alpha\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  tracker.stageSelection({ path: 'b.md', from: 0, to: 5, text: 'bravo' });

  const result = tracker.reconcile({ 'a.md': 'alpha\n', 'b.md': 'bravo\n' });
  assert.deepEqual(result, { changed: [], filteredOnly: [], unchanged: ['a.md'], missing: [] });

  assert.deepEqual(
    tracker.reconcile([{ path: 'a.md', text: null }]),
    { changed: [], filteredOnly: [], unchanged: [], missing: ['a.md'] },
  );
});

test('a successful get-full-file result resets a tracked baseline and count', async () => {
  const { tracker, vault, events } = makeTracker({ 'a.md': 'one\n' });
  tracker.stageFile('a.md', 'one\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  for (const value of ['two', 'three']) {
    vault.store.set('a.md', `${value}\n`);
    tracker.modifiedFile('a.md');
    await tracker.mutationsForSend();
    tracker.acceptTurn();
  }
  assert.equal(tracker.trackedFiles()[0].effectiveChanges, 2);

  const returned = 'three\nwith the tool\n';
  assert.deepEqual(
    tracker.applyFullFileResult('a.md', returned),
    { path: 'a.md', tracked: true, text: returned },
  );
  const file = tracker.trackedFiles()[0];
  assert.equal(file.effectiveChanges, 0);
  assert.equal(file.status, 'tracked');
  assert.equal(file.observedRawText, returned);
  assert.deepEqual(events.at(-1), { kind: 'context/tool-baseline', path: 'a.md', text: returned });

  vault.store.set('a.md', 'four\n');
  tracker.modifiedFile('a.md');
  assert.equal(
    (await tracker.mutationsForSend())[0].diff,
    'Index: a.md\n'
    + '===================================================================\n'
    + '--- a.md\n'
    + '+++ a.md\n'
    + '@@ -1,2 +1,1 @@\n'
    + '-three\n'
    + '-with the tool\n'
    + '+four\n',
  );
});

test('a get-full-file result for an untracked file never resumes tracking', async () => {
  const { tracker } = makeTracker({ 'a.md': 'one\n' });
  tracker.stageFile('a.md', 'one\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  tracker.removedFile('a.md');

  assert.deepEqual(
    tracker.applyFullFileResult('a.md', 'one\nchanged\n'),
    { path: 'a.md', tracked: false, text: 'one\nchanged\n' },
  );
  assert.deepEqual(tracker.trackedFiles(), []);
  assert.deepEqual(tracker.allowlist(), ['a.md'], 'the path stays readable through the tool');
  assert.deepEqual(await tracker.mutationsForSend(), []);

  assert.deepEqual(
    tracker.applyFullFileResult('notes/other.md', 'x'),
    { path: 'notes/other.md', tracked: false, text: 'x' },
  );
});

test('staging an already-tracked file neither re-sends it nor disturbs its baseline', async () => {
  const { tracker, vault } = makeTracker({ 'notes/a.md': 'body\n' });
  tracker.stageFile('notes/a.md', 'body\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  assert.deepEqual(tracker.stageFile('notes/a.md', 'body\n'), { path: 'notes/a.md', staged: true });
  assert.deepEqual(await tracker.mutationsForSend(), [], 'an unchanged tracked file is introduced once');
  // Even stale staged text cannot move a tracked baseline: only classification
  // through the vault decides what a tracked file now contains.
  tracker.stageFile('notes/a.md', 'stale staged text\n');
  assert.deepEqual(await tracker.mutationsForSend(), []);
  assert.deepEqual(tracker.trackedFiles()[0].observedRawText, 'body\n');
  vault.store.set('notes/a.md', 'changed\n');
  assert.equal(tracker.modifiedFile('notes/a.md'), true);
  assert.equal((await tracker.mutationsForSend())[0].kind, 'diff');
});

test('a changed tracked file that is referenced again emits its diff and the reference', async () => {
  const { tracker, vault } = makeTracker({ 'notes/a.md': 'one\n' });
  tracker.stageFile('notes/a.md', 'one\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  vault.store.set('notes/a.md', 'two\n');
  tracker.modifiedFile('notes/a.md');
  tracker.stageReference('notes/a.md');
  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(mutations.map((mutation) => mutation.kind), ['diff', 'reference']);
});

test('renaming a tracked Markdown file out of Markdown stops tracking it as a deletion', async () => {
  const { tracker, events } = makeTracker({ 'notes/a.md': 'body\n' });
  tracker.stageFile('notes/a.md', 'body\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();
  events.length = 0;

  assert.equal(tracker.renamedFile('notes/a.md', 'notes/a.txt'), true);
  assert.deepEqual(tracker.trackedFiles(), []);
  assert.deepEqual(events, [{ kind: 'context/file-deleted', path: 'notes/a.md', wasSent: true }]);
  assert.deepEqual(await tracker.mutationsForSend(), [{ kind: 'deleted', path: 'notes/a.md' }]);
});

test('the tracker mutations compose with the renderer into one additions message and one question', async () => {
  const { tracker } = makeTracker({ 'notes/a.md': 'The **quick** brown fox.\n' });
  tracker.stageSelection({ path: 'notes/a.md', from: 4, to: 11, text: 'quick' });
  const mutations = await tracker.mutationsForSend();
  assert.deepEqual(renderTurn({ mutations, question: 'What does it say?' }), [
    {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: '<quick_ask_context>\n'
          + '<context_file path="notes/a.md" content_length="25">\n'
          + 'The **quick** brown fox.\n'
          + '\n</context_file>\n'
          + '<context_selection path="notes/a.md">\n'
          + 'quick\n'
          + '</context_selection>\n'
          + '</quick_ask_context>',
      }],
    },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What does it say?' }] },
  ]);
});

test('a File Row removed while its first request is in flight is not resurrected by accept', async () => {
  const raw = 'body\n';
  const { tracker, events } = makeTracker({ 'notes/a.md': raw });
  tracker.stageFile('notes/a.md', raw);
  const sent = await tracker.mutationsForSend();

  // The user removes the pending row before response.created arrives.
  tracker.removedFile('notes/a.md');
  events.length = 0;
  tracker.acceptTurn(sent);

  assert.deepEqual(tracker.trackedFiles(), [], 'the endpoint accepted the content but the user stopped tracking');
  assert.deepEqual(tracker.allowlist(), ['notes/a.md'], 'the sent content stays readable through the tool');
  assert.deepEqual(events.map((event) => [event.kind, event.wasSent]), [
    ['context/file-added', undefined],
    ['context/file-removed', true],
  ]);
  assert.deepEqual(await tracker.mutationsForSend(), []);

  // Dragging from the file again starts tracking again.
  tracker.stageFile('notes/a.md', raw);
  assert.deepEqual((await tracker.mutationsForSend()).map((mutation) => mutation.kind), ['file']);
});

test('a file renamed while its first request is in flight tracks under the new path', async () => {
  const raw = 'body\n';
  const { tracker, vault } = makeTracker({ 'notes/old.md': raw });
  tracker.stageFile('notes/old.md', raw);
  const sent = await tracker.mutationsForSend();

  vault.store.set('notes/new.md', raw);
  vault.store.delete('notes/old.md');
  tracker.renamedFile('notes/old.md', 'notes/new.md');
  tracker.acceptTurn(sent);

  assert.deepEqual(tracker.trackedFiles().map((file) => file.path), ['notes/new.md']);
  assert.deepEqual(tracker.allowlist(), ['notes/new.md']);
  assert.deepEqual(await tracker.mutationsForSend(), [], 'the accepted content is not sent again under the new path');
});

test('a file renamed while a diff is in flight keeps its count under the new path', async () => {
  const { tracker, vault } = makeTracker({ 'notes/a.md': 'one\n' });
  tracker.stageFile('notes/a.md', 'one\n');
  await tracker.mutationsForSend();
  tracker.acceptTurn();

  vault.store.set('notes/a.md', 'two\n');
  tracker.modifiedFile('notes/a.md');
  const sent = await tracker.mutationsForSend();
  assert.equal(sent[0].kind, 'diff');

  vault.store.set('notes/b.md', 'two\n');
  vault.store.delete('notes/a.md');
  tracker.renamedFile('notes/a.md', 'notes/b.md');
  tracker.acceptTurn(sent);

  assert.deepEqual(
    tracker.trackedFiles().map((file) => [file.path, file.effectiveChanges]),
    [['notes/b.md', 1]],
  );
  // The queued rename reaches the model with the next question, then moves the allowlist.
  assert.deepEqual((await tracker.mutationsForSend()).map((mutation) => mutation.kind), ['renamed']);
  tracker.acceptTurn();
  assert.deepEqual(tracker.allowlist(), ['notes/b.md']);
});
