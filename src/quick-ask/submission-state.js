// The submitted draft and the next editable draft have different lifetimes.
function clearSubmittedDraft(draft) {
  return { ...draft, composer: "", pending: { ...draft.pending, selections: [] } };
}

function recoverSubmittedDraft(current, submission, { restoreDraft = true } = {}) {
  const untouched = restoreDraft && !current.composer && current.pending.selections.length === 0;
  return {
    ...current,
    ...(untouched ? { composer: submission.draft, pending: {
      files: current.pending.files,
      selections: [...submission.pending.selections],
    } } : {}),
    failedSubmission: { submission, restored: untouched },
  };
}

// Identity belongs to the captured submission, never to its question text:
// submitting the same wording anew must still create a separate turn.
function prepareSubmission(messages, current, submission, retry = false) {
  const index = retry ? messages.findIndex(entry => entry.submission === submission || entry.retry === submission) : -1;
  const entry = { role: "user", text: submission.question, submission };
  const next = [...messages];
  if (index < 0) next.push(entry);
  else next[index] = entry;
  const failed = current.failedSubmission;
  const selections = submission.pending.selections;
  const restored = failed?.restored && failed.submission === submission && current.composer === submission.draft &&
    selections.length === current.pending.selections.length && selections.every((item, at) => item === current.pending.selections[at]);
  const draft = !retry || restored ? clearSubmittedDraft(current) : current;
  return { messages: next, entry, draft: { ...draft, failedSubmission: null } };
}

module.exports = { clearSubmittedDraft, recoverSubmittedDraft, prepareSubmission };
