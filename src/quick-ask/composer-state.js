const { activePickerQuery } = require("./file-picker");
const { canReferencePath, supportedReferences } = require("./file-input");
const { StateField, StateEffect } = require("@codemirror/state");
const { parser } = require("@lezer/markdown");

// The composer is an owned, minimal CodeMirror 6 editor. This module holds the
// part that is pure editor state: which `[[folder/file.md]]` markers the
// document currently contains, the question text the model receives, and the
// caret navigation around a marker. The DOM view lives in composer-view.js.
//
// The marker list is derived from the document on every state update instead of
// being stored separately, so it can never drift out of sync with the text the
// user sees. A File Reference Chip is composer-only staged state: it neither
// starts file tracking nor creates a File Row.

// One chip per complete `[[folder/file.md]]` marker, in document order.
const fileReferenceField = StateField.define({
  create: (state) => scanMarkers(state.doc.toString()),
  update: (references, transaction) => transaction.docChanged ? scanMarkers(transaction.state.doc.toString()) : references,
});

const openReferenceEffect = StateEffect.define();
const closeReferenceEffect = StateEffect.define();
// Editing is local presentation state. The full [[Vault Path]] remains the
// serializable document representation in both the folded and editable form.
const editingReferenceField = StateField.define({
  create: () => null,
  update(value, transaction) {
    if (value && transaction.docChanged) {
      const startBeforeInsertion = transaction.changes.mapPos(value.from, -1);
      value = { from: transaction.changes.mapPos(value.from, 1), to: transaction.changes.mapPos(value.to, 1) };
      // Keep prose inserted at either boundary outside the editable link. A
      // newly completed closing delimiter can still extend an incomplete link.
      const references = referencesOf(transaction.state);
      const reference = references.find(reference => reference.from === value.from) ?? references.find(reference =>
        reference.from >= startBeforeInsertion && reference.from < value.from && reference.to > value.from && reference.to <= value.to);
      if (reference) value = { from: reference.from, to: reference.to };
    }
    for (const effect of transaction.effects) {
      if (effect.is(openReferenceEffect)) value = effect.value;
      if (effect.is(closeReferenceEffect)) value = null;
    }
    if (value && value.from >= value.to) value = null;
    if (value && transaction.selection) {
      const selection = transaction.state.selection.main;
      const complete = referencesOf(transaction.state).some(reference => reference.from === value.from && reference.to === value.to);
      if (complete && (selection.from < value.from || selection.to > value.to)) value = null;
    }
    return value;
  },
});

function referencesOf(state) {
  return state.field(fileReferenceField, false) ?? [];
}

function markerFor(path) {
  return `[[${path}]]`;
}

// Compact display only: keep the complete filename, the immediate parent and
// both ends of a long parent name. File identity always remains the full path.
function labelFor(path) {
  const parts = path.split("/");
  const filename = parts.pop();
  if (parts.length === 0) return `@${filename}`;
  const parent = Array.from(parts.pop());
  const shortParent = parent.length > 16 ? parent.slice(0, 6).join("") + "..." + parent.slice(-6).join("") : parent.join("");
  return `@../${shortParent}/${filename}`;
}

// Build the chip list for a set of document ranges, dropping empty ones.
function referencesFrom(ranges, text) {
  return ranges
    .filter((range) => range.to > range.from)
    .map((range) => ({
      path: text.slice(range.from, range.to).replace(/^\[\[/, "").replace(/\]\]$/, ""),
      from: range.from,
      to: range.to,
    }));
}

// Markdown owns code and escape boundaries; markers overlapping those ranges
// remain literal, even when the code is inside the apparent link.
function literalRanges(text) {
  const ranges = [];
  parser.parse(text).iterate({ enter(node) {
    if (["InlineCode", "FencedCode", "CodeBlock", "Escape"].includes(node.name)) {
      // Lezer excludes the first line's indentation from CodeBlock.from.
      const from = ["FencedCode", "CodeBlock"].includes(node.name)
        ? Math.max(text.lastIndexOf("\n", node.from - 1), text.lastIndexOf("\r", node.from - 1)) + 1
        : node.from;
      ranges.push({ from, to: node.to });
      return false;
    }
  } });
  return ranges;
}

function isLiteralRange(text, from, to) {
  return literalRanges(text).some(range => range.from < to && range.to > from);
}

// Find complete single-line, non-nested markers outside literal syntax.
function scanMarkers(text) {
  const own = typeof text === "string" ? text : String(text ?? "");
  const literals = literalRanges(own);
  const ranges = [];
  let index = 0;
  while (index < own.length) {
    const open = own.indexOf("[[", index);
    if (open < 0) break;
    if (literals.some(range => range.from < open + 2 && range.to > open)) {
      index = open + 2;
      continue;
    }
    const close = own.indexOf("]]", open + 2);
    if (close < 0) break;
    const between = own.slice(open + 2, close);
    if (between.length > 0 && !/[\r\n\[\]]/.test(between) &&
        !literals.some(range => range.from < close + 2 && range.to > open)) {
      ranges.push({ from: open, to: close + 2 });
    }
    index = close + 2;
  }
  return referencesFrom(ranges, own);
}

// Stage one referenced file at the caret: replace the active `[[` query, or
// insert the marker, and leave the caret after it. Returns a transaction spec
// so the same logic works for a live view and for a plain EditorState.
function stageReference(state, path, { from, to } = {}) {
  const marker = markerFor(path);
  if (from == null) {
    const at = state.selection.main.head;
    return { changes: { from: at, insert: marker }, selection: { anchor: at + marker.length } };
  }
  return { changes: { from, to, insert: marker }, selection: { anchor: from + marker.length } };
}

// One transaction for a multi-file drop: preserve surrounding prose and keep
// the cursor outside existing atomic chips. Insertion is undoable as one step.
function stageReferences(state, paths, position = state.selection.main.head) {
  const chosen = [...new Set(paths)].filter(canReferencePath);
  if (chosen.length === 0) return null;
  let at = Math.max(0, Math.min(position, state.doc.length));
  const containing = referencesOf(state).find(ref => ref.from < at && at < ref.to);
  if (containing) at = containing.to;
  const query = activePickerQuery(state.doc.toString(), at, { editingFrom: state.field(editingReferenceField, false)?.from });
  const from = query?.from ?? at;
  const before = state.sliceDoc(0, from), after = state.sliceDoc(at);
  const insert = `${before && !/\s$/u.test(before) ? " " : ""}${chosen.map(markerFor).join(" ")}${after && !/^\s/u.test(after) ? " " : ""}`;
  return { changes: { from, to: at, insert }, selection: { anchor: from + insert.length }, effects: closeReferenceEffect.of(null) };
}

function choosePath(state, option, query) {
  const existing = referencesOf(state).find(reference => reference.from === query.from && reference.to >= query.to);
  const range = { from: query.from, to: existing?.to ?? query.to };
  if (option.kind !== "folder") return { ...stageReference(state, option.path, range), effects: closeReferenceEffect.of(null) };
  const insert = `[[${option.path}`;
  const to = range.from + insert.length;
  return {
    changes: { ...range, insert }, selection: { anchor: to },
    effects: openReferenceEffect.of({ from: range.from, to }),
  };
}

// Only sendable references are removed. Literal syntax and unresolved or
// unsupported references stay in the question so user text is never lost.
function questionText(state, isSupported = () => true) {
  const references = referencesOf(state).filter(reference => isSupported(reference.path))
    .sort((left, right) => left.from - right.from);
  const text = state.doc.toString();
  let result = "";
  let position = 0;
  for (const reference of references) {
    if (reference.from < position) continue;
    result += text.slice(position, reference.from);
    position = reference.to;
  }
  result += text.slice(position);
  // Normalize only prose gaps left by removed chips. Code whitespace belongs
  // to the user's example: collapsing it changes strings and indentation.
  let normalized = "";
  position = 0;
  for (const range of literalRanges(result)) {
    let prose = result.slice(position, range.from).replace(/[ \t]{2,}/g, " ");
    if (position === 0) prose = prose.trimStart();
    normalized += prose + result.slice(range.from, range.to);
    position = range.to;
  }
  let tail = result.slice(position).replace(/[ \t]{2,}/g, " ");
  if (position === 0) tail = tail.trimStart();
  return normalized + tail.trimEnd();
}

// The exact Vault Paths of the staged chips, deduplicated in first-chip order.
function referencedPaths(state, isSupported = () => true, resolvePath = path => path) {
  const seen = new Set();
  const paths = [];
  for (const reference of referencesOf(state)) {
    if (!isSupported(reference.path)) continue;
    const path = resolvePath(reference.path);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return supportedReferences(paths, () => true);
}

function removeReferences(state, path, resolvePath = path => path) {
  return { changes: referencesOf(state).filter(reference => resolvePath(reference.path) === path)
    .map(reference => ({ from: reference.from, to: reference.to, insert: "" })) };
}

// The chip whose range starts or ends exactly at the caret. A caret anywhere
// else returns null.
function referenceAt(state, position, side) {
  for (const reference of referencesOf(state)) {
    if (side === "end" && reference.to === position) return reference;
    if (side === "start" && reference.from === position) return reference;
  }
  return null;
}

// A first Backspace/Delete selects the adjacent whole chip; a second deletes
// that selection. Expanded links use ordinary text editing instead.
function referenceDeletion(state, side) {
  if (state.field(editingReferenceField, false)) return null;
  const selection = state.selection.main;
  if (!selection.empty) {
    const reference = referencesOf(state).find(reference => reference.from === selection.from && reference.to === selection.to);
    return reference ? { changes: { from: reference.from, to: reference.to }, selection: { anchor: reference.from } } : null;
  }
  const reference = referenceAt(state, selection.head, side);
  return reference ? { selection: { anchor: reference.from, head: reference.to } } : null;
}

// The composer's own `/command` token: a slash command only lives at a line
// start, so ordinary text and URLs never open the command picker.
function slashQuery(text, caret) {
  const before = String(text).slice(0, caret);
  const from = before.lastIndexOf('\n') + 1;
  const match = /^\/([a-z_]*)$/.exec(before.slice(from));
  return match ? { kind: 'command', query: match[1], from, to: caret } : null;
}

module.exports = {
  fileReferenceField,
  editingReferenceField,
  openReferenceEffect,
  closeReferenceEffect,
  referencesOf,
  referencesFrom,
  scanMarkers,
  isLiteralRange,
  stageReference,
  stageReferences,
  choosePath,
  questionText,
  referencedPaths,
  removeReferences,
  referenceAt,
  slashQuery,
  referenceDeletion,
  markerFor,
  labelFor,
};
