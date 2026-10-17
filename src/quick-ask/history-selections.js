// Display-only snapshots: never parse Context XML or reread a changed Vault file.
function selectionSnapshots(additions) {
  return (Array.isArray(additions) ? additions : [])
    .filter(item => item?.kind === "selection" && typeof item.text === "string" && item.text.length > 0)
    .map(item => ({ path: typeof item.path === "string" ? item.path : "", text: item.text }));
}

function submissionSelections(submission) {
  return selectionSnapshots(submission.additions ??
    (submission.pending?.selections ?? []).map(selection => ({ ...selection, kind: "selection" })));
}

module.exports = { selectionSnapshots, submissionSelections };
