const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProjectionPublisher, reasoningPage, REASONING_PAGE_SIZE, createScrollFollow } = require('../src/quick-ask/stream-presentation');
const { clearSubmittedDraft, recoverSubmittedDraft } = require('../src/quick-ask/submission-state');

test('frames retain only latest channel values and flush them before completion', () => {
  const callbacks = new Map(); let id = 0; const delivered = [];
  const publisher = createProjectionPublisher({ frame: cb => { callbacks.set(++id, cb); return id; }, cancelFrame: id => callbacks.delete(id) }, value => delivered.push(value));
  for (let n = 0; n < 10000; n++) publisher.push({ kind: 'reasoning', text: String(n) });
  publisher.push({ kind: 'text', text: 'answer' });
  assert.equal(callbacks.size, 1);
  assert.equal(delivered.length, 0);
  publisher.push({ kind: 'turn', status: 'complete' });
  assert.deepEqual(delivered.map(v => v.text ?? v.status), ['9999', 'answer', 'complete']);
  assert.equal(callbacks.size, 0);
  publisher.push({ kind: 'text', text: 'late' });
  publisher.dispose();
  assert.equal(callbacks.size, 0);
  assert.equal(delivered.length, 3);
});

test('bounded reasoning pages reconstruct a long source exactly, including split surrogate boundaries', () => {
  const text = 'a'.repeat(REASONING_PAGE_SIZE - 1) + '😀' + 'line\n'.repeat(20000);
  const count = reasoningPage(text).count;
  const pages = Array.from({ length: count }, (_, n) => reasoningPage(text, n).text);
  assert.equal(pages.join(''), text);
  assert.ok(pages.every(page => page.length <= REASONING_PAGE_SIZE + 1));
  assert.equal(reasoningPage(text).page, count - 1);
  assert.equal(reasoningPage(text, 0).text, reasoningPage(text + 'later', 0).text, 'reading an earlier page stays stable');
});

test('scroll following pauses on upward intent, survives content growth, and resumes at the bottom', () => {
  const follow = createScrollFollow();
  follow.positioned(600);
  assert.equal(follow.following, true);
  follow.pause();
  assert.equal(follow.scroll({ top: 600, height: 1000, viewport: 400 }), false, 'queued programmatic scroll must not undo upward intent');
  assert.equal(follow.scroll({ top: 590, height: 1000, viewport: 400 }), false);
  assert.equal(follow.scroll({ top: 590, height: 1600, viewport: 400 }), false, 'new text does not pull the reader down');
  assert.equal(follow.scroll({ top: 1190, height: 1600, viewport: 400 }), true);
  follow.positioned(1200);
  assert.equal(follow.scroll({ top: 1200, height: 1800, viewport: 400 }), true, 'growth alone does not count as user scroll');
  follow.pause(); follow.submit(); assert.equal(follow.following, true, 'a new send explicitly returns to the latest content');
});

test('submission clears the editable draft immediately and recovery restores it only if unoccupied', () => {
  const draft = { composer: 'Explain [[paper.md]]', pending: { files: [{ path: 'paper.md' }], selections: [{ path: 'paper.md', text: 'quote' }] } };
  const submission = { draft: draft.composer, pending: draft.pending, question: 'Explain', references: ['paper.md'] };
  const cleared = clearSubmittedDraft(draft);
  assert.equal(cleared.composer, ''); assert.deepEqual(cleared.pending.selections, []);
  assert.equal(draft.composer, 'Explain [[paper.md]]', 'captured submission remains intact');
  const restored = recoverSubmittedDraft(cleared, submission);
  assert.equal(restored.composer, draft.composer);
  assert.deepEqual(restored.pending.selections, draft.pending.selections);
  const newer = { ...cleared, composer: 'Next question' };
  const kept = recoverSubmittedDraft(newer, submission);
  assert.equal(kept.composer, 'Next question');
  assert.equal(kept.failedSubmission.submission.draft, draft.composer, 'old question remains independently retryable');
  assert.equal(kept.failedSubmission.restored, false);
  const sameText = recoverSubmittedDraft({ ...cleared, composer: draft.composer }, submission);
  assert.equal(sameText.failedSubmission.restored, false, 'identical newly typed text is still a new draft');
});

test('retry reuses the question bubble and never replaces a newer draft', () => {
  const { prepareSubmission } = require('../src/quick-ask/submission-state');
  const submission = { draft: 'first', question: 'first', pending: { files: [], selections: [] } };
  const existing = { role: 'user', text: 'first', retry: submission };
  const newer = { composer: 'writing next', pending: { files: [], selections: [] } };
  const retry = prepareSubmission([existing], newer, submission, true);
  assert.equal(retry.messages.length, 1);
  assert.equal(retry.entry.text, 'first');
  assert.equal(retry.entry.retry, undefined, 'hide the retry action while running');
  assert.equal(retry.draft.composer, 'writing next');
  const failed = recoverSubmittedDraft(retry.draft, submission, { restoreDraft: false });
  assert.equal(failed.composer, 'writing next');
  const again = prepareSubmission([{ ...retry.entry, retry: submission }], failed, submission, true);
  assert.equal(again.messages.length, 1, 'repeated retries do not multiply bubbles');
});

test('retry consumes an untouched restored draft once and does not refill it on failure', () => {
  const { prepareSubmission } = require('../src/quick-ask/submission-state');
  const submission = { draft: 'question', question: 'question', pending: { files: [], selections: [{ text: 'selected' }] } };
  const restored = recoverSubmittedDraft({ composer: '', pending: { files: [], selections: [] } }, submission);
  const retry = prepareSubmission([{ role: 'user', text: 'question', retry: submission }], restored, submission, true);
  assert.equal(retry.draft.composer, '');
  assert.equal(retry.draft.pending.selections.length, 0);
  const failed = recoverSubmittedDraft(retry.draft, submission, { restoreDraft: false });
  assert.equal(failed.composer, '');
  assert.equal(failed.pending.selections.length, 0);
  assert.equal(failed.failedSubmission.submission, submission, 'the retry receipt survives independently');
});

test('a new send with identical text remains a separate question', () => {
  const { prepareSubmission } = require('../src/quick-ask/submission-state');
  const previous = { question: 'same' };
  const next = { question: 'same', draft: 'same', pending: { files: [], selections: [] } };
  const result = prepareSubmission([{ role: 'user', text: 'same', submission: previous }],
    { composer: 'same', pending: next.pending }, next, false);
  assert.equal(result.messages.length, 2);
  assert.equal(result.draft.composer, '');
});
