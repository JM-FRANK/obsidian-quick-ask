// The pending-context UI state: File Rows and Selection Preview Rows staged
// above the composer, plus the expand/collapse projection. This is presentation
// state only. Whether a Context File is internally tracked is a separate fact
// held by the context tracker, and confusing the two is exactly what this
// module exists to prevent.

const MIN_ROWS_FOR_BAR = 2;

function createPendingContext() {
  return { files: [], selections: [] };
}

// File Rows stay ordered by the first time each file was added; a repeated add
// keeps the original position.
function addFile(context, path) {
  if (typeof path !== "string" || path.length === 0) return context;
  if (context.files.some((file) => file.path === path)) return context;
  return { ...context, files: [...context.files, { path }] };
}

// Selection Preview Rows stay ordered by drag time, and several selections may
// come from the same file.
function addSelection(context, selection) {
  if (!selection || typeof selection.path !== "string" || typeof selection.text !== "string") return context;
  return {
    ...context,
    selections: [...context.selections, {
      path: selection.path,
      text: selection.text,
      from: selection.from ?? null,
      to: selection.to ?? null,
    }],
  };
}

function removeFile(context, path) {
  return { ...context, files: context.files.filter((file) => file.path !== path) };
}

function removeSelection(context, index) {
  return { ...context, selections: context.selections.filter((_entry, at) => at !== index) };
}

// The selected-text rows belong to the next question and are removed once that
// question has been sent successfully. File Rows persist while tracked.
function clearSelections(context) {
  return { ...context, selections: [] };
}

function hasFile(context, path) {
  return context.files.some((file) => file.path === path);
}

// The expand/collapse bar appears when either group reaches two rows. One
// Context File plus its one Context Selection does not by itself show the bar.
function showsExpandBar(context) {
  return context.files.length >= MIN_ROWS_FOR_BAR || context.selections.length >= MIN_ROWS_FOR_BAR;
}

// The collapsed projection: one File Row and one Selection Preview Row.
// The file belongs to the most recently dragged pending selection; when no
// pending selection remains, it is the most recently added File Row.
function derivePendingView(context, { expanded = false } = {}) {
  const showBar = showsExpandBar(context);
  const fileRows = context.files.map((file) => ({ kind: "file", path: file.path }));
  const selectionRows = context.selections.map((selection, index) => ({
    kind: "selection",
    index,
    path: selection.path,
    text: selection.text,
    from: selection.from,
    to: selection.to,
  }));
  const counts = { fileCount: fileRows.length, selectionCount: selectionRows.length };
  if (expanded || !showBar) {
    return { ...counts, showBar, expanded: expanded && showBar, files: fileRows, selections: selectionRows };
  }
  const latestSelection = selectionRows[selectionRows.length - 1];
  const chosenFile = latestSelection
    ? fileRows.find((row) => row.path === latestSelection.path) ?? fileRows[fileRows.length - 1]
    : fileRows[fileRows.length - 1];
  return {
    showBar,
    expanded: false,
    files: chosenFile ? [chosenFile] : [],
    selections: latestSelection ? [latestSelection] : [],
    fileCount: fileRows.length,
    selectionCount: selectionRows.length,
  };
}

// Navigation never guesses among repeated quotes or selects a stale offset.
// A uniquely relocated quote is safe after edits before the captured range.
function selectionRange(text, selection) {
  const { from, to, text: quote } = selection;
  if (typeof quote !== "string" || !quote.length) return null;
  if (Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to > from && text.slice(from, to) === quote) return { from, to };
  const at = text.indexOf(quote);
  return at >= 0 && text.indexOf(quote, at + 1) < 0 ? { from: at, to: at + quote.length } : null;
}

module.exports = {
  MIN_ROWS_FOR_BAR,
  createPendingContext,
  addFile,
  addSelection,
  removeFile,
  removeSelection,
  clearSelections,
  hasFile,
  showsExpandBar,
  derivePendingView,
  selectionRange,
};
