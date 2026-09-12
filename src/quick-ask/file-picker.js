// The composer's file picker. It is a local, user-driven path selector over
// Vault files: no model search, no background retrieval, no automatic
// discovery. Matching itself is the host's own fuzzy helper, injected through
// the ui capability slice, so Quick Ask does not reinvent Obsidian's ranking.

const MAX_RESULTS = 50;

// A Chinese IME in full-width punctuation mode emits 【 for every [ the user
// types, so both spellings open a query. The pair does not have to match,
// because the user can switch between full-width and half-width while typing
// the same query. Only the opener is user-visible: choosing a completion always
// replaces the whole query with the canonical `[[Vault Path]]` form.
const QUERY_OPENERS = ["[[", "【【"];
const QUERY_CLOSERS = ["]]", "】】"];

// The nearest opener in the text before the caret, carrying its own length so
// the query starts after the whole delimiter.
function lastQueryOpener(before) {
  let nearest = null;
  for (const opener of QUERY_OPENERS) {
    const at = before.lastIndexOf(opener);
    if (at >= 0 && (!nearest || at > nearest.at)) nearest = { at, length: opener.length };
  }
  return nearest;
}

// The active `[[` query immediately before the caret, or null when the caret is
// not inside one. A query never spans a line break and stops at the closing
// bracket, so ordinary text with `[[` inside a link is not treated as a query.
function activePickerQuery(text, caret, { editingFrom = null } = {}) {
  const before = String(text ?? "").slice(0, caret);
  const open = lastQueryOpener(before);
  if (!open) return null;
  if (open.at !== editingFrom && open.at > 0 && !/\s/u.test(before[open.at - 1])) return null;
  const between = before.slice(open.at + open.length);
  if (QUERY_CLOSERS.some(closer => between.includes(closer)) || between.includes("\n")) return null;
  return { query: between, from: open.at, to: caret };
}

// A key or input event that belongs to an in-flight IME composition must never
// open, choose from, or close the picker: Enter and Escape confirm or cancel the
// candidate, and a composing `input` describes text the editor has not committed
// yet. `isComposing` is the standard flag; `keyCode === 229` is the legacy "an
// IME is processing this key" marker that some Windows IMEs still emit.
function isCompositionEvent(event) {
  if (!event) return false;
  return event.isComposing === true || event.keyCode === 229;
}

// Rank candidate paths for a query. An empty query lists files in the order the
// host supplied them, which keeps a fresh `[[` immediately useful.
function rankFiles(paths, query, fuzzy) {
  const candidates = (paths ?? []).filter((path) => typeof path === "string" && path.length > 0);
  if (typeof query !== "string" || query.length === 0) {
    return candidates.slice(0, MAX_RESULTS).map((path) => ({ path, score: 0, matches: [] }));
  }
  const ranked = [];
  for (const path of candidates) {
    const result = fuzzy(path, query);
    if (!result) continue;
    ranked.push({ path, score: result.score ?? 0, matches: result.matches ?? [] });
  }
  ranked.sort((left, right) => (right.score - left.score) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return ranked.slice(0, MAX_RESULTS);
}

// Options for the popup, built from ranked matches. `matches` carries the
// fuzzy-match ranges so the host's highlight helper can mark them.
function pickerOptions(paths, query, fuzzy) {
  const unique = [...new Set((paths ?? []).filter(path => typeof path === "string" && path.length > 0))];
  if (query) {
    // Search the entire path with the entire query. Display splitting never
    // changes ranking or matching, including characters across directories.
    return rankFiles(unique, query, fuzzy).map(entry => {
      const split = entry.path.lastIndexOf("/") + 1;
      const sliceMatches = (from, to) => entry.matches
        .map(([a, b]) => [Math.max(a, from) - from, Math.min(b, to) - from])
        .filter(([a, b]) => b > a);
      return { path: entry.path, kind: "file", label: entry.path.slice(split),
        directory: entry.path.slice(0, Math.max(0, split - 1)),
        matches: sliceMatches(split, entry.path.length), directoryMatches: sliceMatches(0, Math.max(0, split - 1)) };
    });
  }
  const children = new Map();
  for (const path of unique) {
    const slash = path.indexOf("/");
    const label = slash < 0 ? path : path.slice(0, slash + 1);
    children.set(label, { path: label, label, kind: slash < 0 ? "file" : "folder", matches: [] });
  }
  return [...children.values()].slice(0, MAX_RESULTS);
}

module.exports = { MAX_RESULTS, activePickerQuery, isCompositionEvent, rankFiles, pickerOptions };
