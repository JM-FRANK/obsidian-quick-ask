// Quick Ask's tracked Context File model and Context Diff Filtering.
//
// This module is pure CommonJS with no Obsidian, DOM, or global access. It
// receives the `vault` capability slice (readText / exists / normalizePath /
// resolveRole) and plain Vault Path strings, and it builds its unified diffs
// from the pinned `diff@8.0.2` package.
//
// Context Diff Filtering is used only while producing proactive diffs for an
// already-sent tracked file. It never touches the original text sent for a first
// inclusion, a fifth-change refresh, or a `get-full-file` result.

const { createTwoFilesPatch } = require("diff");

// The fifth effective change refreshes the complete original text.
const RENDERER_MAX_EFFECTIVE_CHANGES = 5;
// Unified diffs retain three unchanged context lines around each hunk.
const DIFF_CONTEXT_LINES = 3;

// A proactive update is one unified diff between the previous and current
// filtered projections. Both sides are newline-terminated for the diff, because
// a projection drops one final newline and a hunk that touches the end of a file
// would otherwise carry jsdiff's `\ No newline at end of file` marker.
function proactiveDiff(path, previousProjection, nextProjection) {
  const terminate = (projection) => (projection.endsWith("\n") ? projection : `${projection}\n`);
  return createTwoFilesPatch(
    path,
    path,
    terminate(previousProjection),
    terminate(nextProjection),
    undefined,
    undefined,
    { context: DIFF_CONTEXT_LINES },
  );
}

// ---------------------------------------------------------------------------
// Context Diff Filtering
// ---------------------------------------------------------------------------

// Ignore line-ending-only changes between CRLF and LF, BOM insertion/removal,
// and insertion/removal of one final newline. Everything else is retained.
function normalizeLines(text) {
  let normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  normalized = normalized.replace(/\r\n?/g, "\n");
  if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1);
  return normalized;
}

// ---------------------------------------------------------------------------
// Protected regions
// ---------------------------------------------------------------------------
//
// Code, comments, math, and frontmatter are rendered verbatim by Obsidian, so a
// change inside them is a real visible change. The syntax passes below never
// rewrite these regions. The same classification backs the repository's Pandoc
// citation parser, restated here because Quick Ask modules stay self-contained.

function isEscaped(text, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}

function mark(mask, start, end) {
  for (let index = Math.max(0, start); index < Math.min(mask.length, end); index++) mask[index] = 1;
}

function lineRanges(text) {
  const ranges = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index === text.length || text[index] === "\n") {
      ranges.push({ start, end: index, next: index < text.length ? index + 1 : index });
      start = index + 1;
    }
  }
  return ranges;
}

function markFrontmatter(text, mask, lines) {
  if (lines.length === 0) return;
  const first = text.slice(lines[0].start, lines[0].end).replace(/^\uFEFF/u, "").trim();
  if (first !== "---") return;
  for (let index = 1; index < lines.length; index++) {
    const line = text.slice(lines[index].start, lines[index].end).trim();
    if (line === "---" || line === "...") {
      mark(mask, lines[0].start, lines[index].next);
      return;
    }
  }
}

function markBlockCode(text, mask, lines) {
  let fence = null;
  for (const line of lines) {
    const source = text.slice(line.start, line.end);
    if (fence) {
      mark(mask, line.start, line.next);
      const close = source.match(/^ {0,3}(`{3,}|~{3,})\s*$/u)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      continue;
    }
    const open = source.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (open) {
      fence = { char: open[0], length: open.length };
      mark(mask, line.start, line.next);
      continue;
    }
    if (/^(?: {4}|\t)/u.test(source) && source.trim()) mark(mask, line.start, line.next);
  }
}

function markDelimited(text, mask, opener, closer = opener) {
  let cursor = 0;
  while ((cursor = text.indexOf(opener, cursor)) >= 0) {
    if (mask[cursor] || isEscaped(text, cursor)) {
      cursor += opener.length;
      continue;
    }
    const end = text.indexOf(closer, cursor + opener.length);
    if (end < 0) break;
    mark(mask, cursor, end + closer.length);
    cursor = end + closer.length;
  }
}

function markCodeSpans(text, mask) {
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "`" || mask[cursor] || isEscaped(text, cursor)) {
      cursor++;
      continue;
    }
    let runEnd = cursor;
    while (text[runEnd] === "`") runEnd++;
    const run = text.slice(cursor, runEnd);
    let close = text.indexOf(run, runEnd);
    const paragraph = text.slice(runEnd).search(/\n[ \t]*\n/u);
    const paragraphEnd = paragraph < 0 ? text.length : runEnd + paragraph;
    if (close >= paragraphEnd) close = -1;
    if (close >= 0) {
      mark(mask, cursor, close + run.length);
      cursor = close + run.length;
    } else {
      cursor++;
    }
  }
}

function markMath(text, mask) {
  markDelimited(text, mask, "\\(", "\\)");
  markDelimited(text, mask, "\\[", "\\]");
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "$" || mask[cursor] || isEscaped(text, cursor)) {
      cursor++;
      continue;
    }
    const length = text[cursor + 1] === "$" ? 2 : 1;
    const delimiter = "$".repeat(length);
    let close = cursor + length;
    while ((close = text.indexOf(delimiter, close)) >= 0 && isEscaped(text, close)) close += length;
    if (close < 0) {
      cursor += length;
      continue;
    }
    mark(mask, cursor, close + length);
    cursor = close + length;
  }
}

function protectedMask(text) {
  const mask = new Uint8Array(text.length);
  const lines = lineRanges(text);
  markFrontmatter(text, mask, lines);
  markBlockCode(text, mask, lines);
  markDelimited(text, mask, "%%", "%%");
  markCodeSpans(text, mask);
  markMath(text, mask);
  return mask;
}

// ---------------------------------------------------------------------------
// Free-text syntax passes
// ---------------------------------------------------------------------------

// Bold, italic, strikethrough, and highlight delimiters are syntax: their style
// may change freely while the enclosed visible text stays authoritative. A run
// counts as a delimiter only when it flanks visible content, which keeps list
// markers (`* item`), horizontal rules, `a == b`, and setext underlines intact.
function stripFormattingDelimiters(text) {
  return text.replace(/([*_~=])\1*/g, (run, character, offset) => {
    if (isEscaped(text, offset)) return run;
    const before = offset > 0 ? text[offset - 1] : "";
    const after = offset + run.length < text.length ? text[offset + run.length] : "";
    const closes = before !== "" && !/\s/u.test(before);
    const opens = after !== "" && !/\s/u.test(after);
    if (!closes && !opens) return run;
    // A single `~` or `=` is never strikethrough or highlight syntax.
    if (run.length === 1 && (character === "~" || character === "=")) return run;
    // `_` inside a word is a name, not emphasis.
    if (character === "_" && closes && opens
      && /[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after)) return run;
    return "";
  });
}

// ---------------------------------------------------------------------------
// Link, embed, image, and URL syntax
// ---------------------------------------------------------------------------
//
// Link syntax and targets are ignorable; the visible alias, label, or alt text
// is not. An element without visible text is removed together with one adjacent
// separator so that adding or removing it leaves the visible text unchanged.

const WIKILINK_OR_EMBED = /(!?)\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/y;
const MD_IMAGE_INLINE = /!\[([^\]\n]*)\]\([^)\n]*\)/y;
const MD_IMAGE_REFERENCE = /!\[([^\]\n]*)\]\[[^\]\n]*\]/y;
const MD_LINK_INLINE = /\[([^\]\n]*)\]\([^)\n]*\)/y;
const MD_LINK_REFERENCE = /\[([^\]\n]*)\]\[[^\]\n]*\]/y;
const MD_REFERENCE_DEFINITION = /\[[^\]\n]+\]:[ \t]*\S[^\n]*/y;
const AUTOLINK = /<[a-z][a-z0-9+.-]*:[^<>\s]*>/iy;
const BARE_URL = /(?:https?:\/\/|mailto:|www\.)[^\s<>[\]]+/iy;
const EMBED_SIZE_ALIAS = /^\d+(?:x\d+)?$/u;

function startsLine(text, index) {
  return index === 0 || text[index - 1] === "\n";
}

function precededByWordCharacter(text, index) {
  return index > 0 && /[\p{L}\p{N}_.@/-]/u.test(text[index - 1]);
}

function trimTrailingUrlPunctuation(url) {
  let end = url.length;
  while (end > 0 && /[.,;:!?]/.test(url[end - 1])) end--;
  while (end > 0 && url[end - 1] === ")" && (url.slice(0, end).split("(").length < url.slice(0, end).split(")").length)) end--;
  return url.slice(0, end);
}

// The visible text of one wikilink target: the alias when present, otherwise the
// note name itself. An embed shows no text of its own, and a numeric alias is a
// size rather than alt text.
function visibleWikilinkText(target, alias, isEmbed) {
  if (alias !== undefined) {
    if (isEmbed && EMBED_SIZE_ALIAS.test(alias)) return "";
    return alias;
  }
  if (isEmbed) return "";
  const withoutAnchor = target.split("#")[0].split("^")[0];
  const name = withoutAnchor.slice(withoutAnchor.lastIndexOf("/") + 1);
  return name;
}

// One left-to-right scan over a free-text segment. Each rule is anchored at the
// current position, so a later rule never rewrites part of an earlier match.
function linkEdits(text) {
  const edits = [];
  let index = 0;
  while (index < text.length) {
    const match = matchLinkRule(text, index);
    if (!match) {
      index++;
      continue;
    }
    edits.push(match);
    index = match.end;
  }
  return edits;
}

function matchLinkRule(text, index) {
  const character = text[index];
  const rules = [];
  if (character === "!" || character === "[") rules.push(wikilinkRule, markdownImageRule, markdownLinkRule);
  else if (character === "<") rules.push(autolinkRule);
  else if (character === "h" || character === "m" || character === "w") rules.push(bareUrlRule);
  if (rules.length === 0) return null;
  for (const rule of rules) {
    const match = rule(text, index);
    if (match) return match;
  }
  return null;
}

function wikilinkRule(text, index) {
  WIKILINK_OR_EMBED.lastIndex = index;
  const match = WIKILINK_OR_EMBED.exec(text);
  if (!match || isEscaped(text, index)) return null;
  const isEmbed = match[1] === "!";
  const visible = visibleWikilinkText(match[2], match[3], isEmbed);
  return { start: index, end: index + match[0].length, text: visible };
}

function markdownImageRule(text, index) {
  for (const pattern of [MD_IMAGE_INLINE, MD_IMAGE_REFERENCE]) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (match) return { start: index, end: index + match[0].length, text: match[1] };
  }
  return null;
}

function markdownLinkRule(text, index) {
  if (isEscaped(text, index)) return null;
  // A reference definition owns its whole line, and a shortcut `[label]` without
  // a target stays ordinary text.
  if (startsLine(text, index)) {
    MD_REFERENCE_DEFINITION.lastIndex = index;
    const definition = MD_REFERENCE_DEFINITION.exec(text);
    if (definition) {
      const after = index + definition[0].length;
      if (after >= text.length || text[after] === "\n") {
        return { start: index, end: after, text: "" };
      }
    }
  }
  for (const pattern of [MD_LINK_INLINE, MD_LINK_REFERENCE]) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (match) return { start: index, end: index + match[0].length, text: match[1] };
  }
  return null;
}

function autolinkRule(text, index) {
  AUTOLINK.lastIndex = index;
  const match = AUTOLINK.exec(text);
  return match ? { start: index, end: index + match[0].length, text: "" } : null;
}

function bareUrlRule(text, index) {
  if (precededByWordCharacter(text, index)) return null;
  BARE_URL.lastIndex = index;
  const match = BARE_URL.exec(text);
  if (!match) return null;
  const url = trimTrailingUrlPunctuation(match[0]);
  if (url.length === 0) return null;
  return { start: index, end: index + url.length, text: "" };
}

function horizontalRunBefore(text, index) {
  let start = index;
  while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
  return index - start;
}

function horizontalRunAfter(text, index) {
  let end = index;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  return end - index;
}

// Apply non-overlapping edits. A removal absorbs one adjacent separator so that
// adding or removing the removed element never changes the visible text.
function applyEdits(text, edits) {
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    let start = edit.start;
    let end = edit.end;
    if (edit.text === "") {
      const after = horizontalRunAfter(text, end);
      const before = horizontalRunBefore(text, start);
      if (after > 0) {
        // Swallow the separator after the removed element, so the text before it
        // keeps its own separator.
        end += after;
      } else if (before > 0) {
        // Nothing follows: swallow the separator before it, so trailing
        // punctuation stays attached to the text that precedes the element.
        start -= before;
      } else {
        const lineStart = text.lastIndexOf("\n", start - 1) + 1;
        const lineEnd = text.indexOf("\n", end);
        const beforeText = text.slice(lineStart, start);
        const afterText = lineEnd < 0 ? text.slice(end) : text.slice(end, lineEnd);
        if (beforeText.trim() === "" && afterText.trim() === "") {
          start = lineStart;
          end = lineEnd < 0 ? text.length : lineEnd + 1;
        }
      }
    }
    if (start < cursor) start = cursor;
    result += text.slice(cursor, start) + edit.text;
    cursor = Math.max(cursor, end);
  }
  return result + text.slice(cursor);
}

function replaceLinks(text) {
  const edits = linkEdits(text);
  return edits.length === 0 ? text : applyEdits(text, edits);
}

// ---------------------------------------------------------------------------
// Pandoc Citations
// ---------------------------------------------------------------------------
//
// Complete parser-recognized citations are ignorable in a proactive diff: the
// citekeys, prefixes, suffixes, and locators carry no visible prose. The rules
// below restate the repository's Pandoc citation parser so a citation-shaped
// sequence means the same thing in both places. Ordinary `@` text (an email
// address, `foo.@bar`, a spaced `@`, `.@`) is never a citation, and neither is
// a footnote label.

function firstKeyCharacter(character) {
  return character === "*" || character === "_" || /[\p{L}\p{N}]/u.test(character ?? "");
}

function continuationCharacter(character) {
  return /[\p{L}\p{N}_]/u.test(character ?? "");
}

const INTERNAL_PUNCTUATION = new Set([":", ".", "#", "$", "%", "&", "-", "+", "?", "<", ">", "~", "/"]);

function readBracedKey(text, at) {
  if (text[at + 1] !== "{") return null;
  let depth = 1;
  for (let cursor = at + 2; cursor < text.length && text[cursor] !== "\n"; cursor++) {
    if (text[cursor] === "{" && !isEscaped(text, cursor)) depth++;
    else if (text[cursor] === "}" && !isEscaped(text, cursor) && --depth === 0) {
      if (cursor === at + 2) return null;
      return { keyStart: at + 2, keyEnd: cursor, end: cursor + 1 };
    }
  }
  return null;
}

function readBareKey(text, at) {
  let cursor = at + 1;
  if (!firstKeyCharacter(text[cursor])) return null;
  cursor++;
  while (cursor < text.length) {
    if (continuationCharacter(text[cursor])) {
      cursor++;
      continue;
    }
    if (INTERNAL_PUNCTUATION.has(text[cursor]) && continuationCharacter(text[cursor + 1])) {
      cursor += 2;
      continue;
    }
    break;
  }
  return { keyStart: at + 1, keyEnd: cursor, end: cursor };
}

function readKeyAt(text, at, mask) {
  if (text[at] !== "@" || mask[at] || isEscaped(text, at)) return null;
  const preceding = text[at - 1];
  if (preceding === "." || /[\p{L}\p{N}]/u.test(preceding ?? "")) return null;
  const parsed = readBracedKey(text, at) ?? readBareKey(text, at);
  if (!parsed) return null;
  for (let index = at; index < parsed.end; index++) if (mask[index]) return null;
  const dash = text[at - 1] === "-" && !isEscaped(text, at - 1) ? at - 1 : at;
  const beforeDash = text[dash - 1];
  const suppressAuthor = dash < at && !/[\p{L}\p{N}_]/u.test(beforeDash ?? "");
  return { start: suppressAuthor ? dash : at, end: parsed.end, at };
}

function scanKeys(text, mask) {
  const keys = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@") continue;
    const key = readKeyAt(text, index, mask);
    if (!key) continue;
    keys.push(key);
    index = key.end - 1;
  }
  return keys;
}

function trimRange(text, start, end) {
  while (start < end && /\s/u.test(text[start])) start++;
  while (end > start && /\s/u.test(text[end - 1])) end--;
  return start < end ? { start, end } : null;
}

function balancedTrailingDelimiter(text, start, open, close) {
  if (text[start] !== open) return false;
  let depth = 0;
  for (let index = start; index < text.length && text[index] !== "\n"; index++) {
    if (text[index] === open && !isEscaped(text, index)) depth++;
    if (text[index] === close && !isEscaped(text, index) && --depth === 0) return true;
  }
  return false;
}

function findClusterClose(text, start, mask) {
  const close = text[start] === "【" ? "】" : "]";
  let braces = 0;
  for (let index = start + 1; index < text.length && text[index] !== "\n"; index++) {
    if (mask[index]) continue;
    if (text[index] === "{" && text[index - 1] === "@") braces++;
    else if (text[index] === "{" && braces) braces++;
    else if (text[index] === "}" && braces) braces--;
    else if (text[index] === close && braces === 0 && !isEscaped(text, index)) return index;
  }
  return -1;
}

function splitSegments(text, start, end, mask) {
  const ranges = [];
  let segmentStart = start;
  let braces = 0;
  for (let index = start; index < end; index++) {
    if (mask[index]) continue;
    if (text[index] === "{" && text[index - 1] === "@") braces++;
    else if (text[index] === "{" && braces) braces++;
    else if (text[index] === "}" && braces) braces--;
    else if (text[index] === ";" && braces === 0) {
      ranges.push({ start: segmentStart, end: index });
      segmentStart = index + 1;
    }
  }
  ranges.push({ start: segmentStart, end });
  return ranges;
}

// A cluster is `[prefix @key, suffix]` with one key per `;`-separated segment.
// A Markdown link, an embed, a footnote, or a trailing target disqualifies it.
function parseCluster(text, start, end, keys, mask) {
  if (text[start] === "[" && (text[start - 1] === "[" || text[start - 1] === "!")) return null;
  if (text[start] === "[" && text[start - 1] === "^" && !isEscaped(text, start - 1)) return null;
  if (text[start] === "[" && text[start + 1] === "^" && text[start + 2] === "@") return null;
  const next = end + 1;
  if (balancedTrailingDelimiter(text, next, "(", ")")
    || balancedTrailingDelimiter(text, next, "[", "]")
    || balancedTrailingDelimiter(text, next, "{", "}")) return null;
  for (const segment of splitSegments(text, start + 1, end, mask)) {
    const found = keys.filter((key) => key.start >= segment.start && key.end <= segment.end);
    if (found.length !== 1) return null;
    const suffix = trimRange(text, found[0].end, segment.end);
    trimRange(text, segment.start, found[0].start);
    if (suffix) trimRange(text, suffix.start, suffix.end);
  }
  return { start, end: end + 1 };
}

function citationEdits(text) {
  if (!text.includes("@")) return [];
  const mask = new Uint8Array(text.length);
  const keys = scanKeys(text, mask);
  if (keys.length === 0) return [];
  const edits = [];
  const clustered = new Set();
  const blocked = [];
  for (let index = 0; index < text.length; index++) {
    if ((text[index] !== "[" && text[index] !== "【") || mask[index]) continue;
    const end = findClusterClose(text, index, mask);
    if (end < 0) continue;
    const cluster = parseCluster(text, index, end, keys, mask);
    if (!cluster) {
      if (!(text[index - 1] === "^" && !isEscaped(text, index - 1))) blocked.push({ start: index, end: end + 1 });
      continue;
    }
    edits.push({ start: cluster.start, end: cluster.end, text: "" });
    for (const key of keys) {
      if (key.start >= index && key.end <= end) clustered.add(key);
    }
    index = end;
  }
  for (const key of keys) {
    if (clustered.has(key)) continue;
    if (blocked.some((range) => key.start >= range.start && key.end <= range.end)) continue;
    if (text[key.start - 2] === "[" && text[key.start - 1] === "^") continue;
    edits.push({ start: key.start, end: key.end, text: "" });
  }
  edits.sort((left, right) => left.start - right.start);
  return edits;
}

// The projection of one original Vault text under the confirmed filtering rules.
function filteredProjection(rawText) {
  const text = normalizeLines(String(rawText ?? ""));
  if (text.length === 0) return "";
  const mask = protectedMask(text);
  let projection = "";
  let index = 0;
  while (index < text.length) {
    const protectedHere = mask[index] === 1;
    let end = index;
    while (end < text.length && (mask[end] === 1) === protectedHere) end++;
    const segment = text.slice(index, end);
    if (protectedHere) {
      projection += segment;
    } else {
      const withoutCitations = applyEdits(segment, citationEdits(segment));
      projection += stripFormattingDelimiters(replaceLinks(withoutCitations));
    }
    index = end;
  }
  return projection;
}

// ---------------------------------------------------------------------------
// Tracked Context File model
// ---------------------------------------------------------------------------

// One tracked file keeps only active tracking facts: its Vault Path, the
// original text of the last successfully sent state, the latest classified
// original text and its filtered projection, the accepted effective-change
// count, and whether it has ever been accepted. `status` is the projection UI
// reads: staged (not yet sent), tracked, changed, or refresh.
function createTrackedFile({ path, rawText, tracked = true, order = 0, source = "stage" }) {
  const text = typeof rawText === "string" ? rawText : "";
  const record = {
    path,
    order,
    source,
    tracked,
    rawText: tracked ? text : "",
    rawProjection: tracked ? filteredProjection(text) : null,
    observedRawText: typeof rawText === "string" ? text : null,
    observedProjection: typeof rawText === "string" ? filteredProjection(text) : null,
    effectiveChanges: 0,
    dirty: false,
    stagedText: tracked ? null : (typeof rawText === "string" ? text : null),
    pendingSelections: [],
  };
  record.status = statusOf(record);
  return record;
}

// The transmitted baseline and its projection always move together, so the
// status projection never has to re-filter a whole file to answer.
function setBaseline(record, text) {
  record.rawText = text;
  record.rawProjection = filteredProjection(text);
}

function setObserved(record, text) {
  record.observedRawText = text;
  record.observedProjection = filteredProjection(text);
}

function statusOf(record) {
  if (!record.tracked) return "staged";
  // A freshly noted modification is not classified until the next question is
  // prepared, so `dirty` already reads as changed: the visible state reflects
  // the Vault event, not a later read.
  const pending = record.dirty || diffIsEffective(record.observedProjection, record.rawProjection);
  if (pending) return record.effectiveChanges >= RENDERER_MAX_EFFECTIVE_CHANGES - 1 ? "refresh" : "changed";
  return "tracked";
}

// A change is effective when the two filtered projections differ. An identical
// projection is an empty diff, and an empty diff never reaches the endpoint.
function diffIsEffective(previousProjection, nextProjection) {
  return String(previousProjection ?? "") !== String(nextProjection ?? "");
}

// ---------------------------------------------------------------------------
// Context tracker
// ---------------------------------------------------------------------------


function createContextTracker({ vault, scheduler, onEvent } = {}) {
  const capability = vault ?? {};
  let replaying = false;
  const emit = event => { if (!replaying && typeof onEvent === "function") onEvent(event); };
  // The tracker never timestamps anything, so the scheduler slice is accepted
  // as an injected seam rather than a clock it reads.
  void scheduler;

  const files = new Map();
  const references = [];
  const selections = [];
  const lifecycle = [];
  const allowlisted = new Set();
  // Paths the user removed or that left the Vault while a request carrying them
  // could still be in flight. Their content may already be canonical Context,
  // but tracking is never silently resumed for them.
  const removedPaths = new Set();
  // Old path -> path a renamed file lives at now, so an accepted mutation that
  // was built before the rename still lands on the tracked file.
  const redirects = new Map();
  let nextOrder = 0;
  let nextSelectionId = 0;
  let pendingSend = null;

  // Reconciled reads arrive as `{ path, text }` records, a Map, or a plain
  // object keyed by Vault Path.
  function normalizeReads(reads) {
    const provided = new Map();
    if (reads instanceof Map) {
      for (const [path, text] of reads) provided.set(path, text);
    } else if (Array.isArray(reads)) {
      for (const entry of reads) {
        if (entry && typeof entry === "object" && typeof entry.path === "string") provided.set(entry.path, entry.text);
      }
    } else if (reads && typeof reads === "object") {
      for (const [path, text] of Object.entries(reads)) provided.set(path, text);
    }
    return provided;
  }

  function normalizePath(path) {
    if (typeof path !== "string" || path.length === 0) return null;
    const normalized = typeof capability.normalizePath === "function" ? capability.normalizePath(path) : path;
    return typeof normalized === "string" && normalized.length > 0 ? normalized : null;
  }

  // The vault slice owns role classification; Markdown is the only accepted
  // kind, and a slice that cannot classify anything tracks nothing.
  function isMarkdown(path) {
    if (typeof capability.resolveRole !== "function") return false;
    return capability.resolveRole(path) === "markdown";
  }

  async function readText(path) {
    if (typeof capability.readText !== "function") return null;
    try {
      const text = await capability.readText(path);
      return typeof text === "string" ? text : null;
    } catch {
      return null;
    }
  }

  // Files stay in first-added order for the rest of their tracked life.
  function orderedRecords() {
    return [...files.values()].sort((left, right) => left.order - right.order);
  }

  function ensureRecord(path, source) {
    removedPaths.delete(path);
    const existing = files.get(path);
    if (existing) {
      if (source === "stage") existing.source = "stage";
      return existing;
    }
    const record = {
      path,
      order: nextOrder,
      source,
      tracked: false,
      rawText: "",
      rawProjection: null,
      observedRawText: null,
      observedProjection: null,
      effectiveChanges: 0,
      dirty: false,
      stagedText: null,
    };
    nextOrder += 1;
    files.set(path, record);
    return record;
  }

  function refreshStatus(record) {
    record.status = statusOf(record);
    return record;
  }

  function dropReferencesFor(path) {
    const index = references.indexOf(path);
    if (index >= 0) references.splice(index, 1);
  }

  function dropSelectionsFor(path) {
    for (let index = selections.length - 1; index >= 0; index--) {
      if (selections[index].path === path) selections.splice(index, 1);
    }
  }

  // A rename or deletion event is known immediately, so it is durable
  // immediately, but it reaches the model once, with the next accepted question.
  function queueLifecycle(mutation) {
    lifecycle.push(mutation);
  }

  function consumeLifecycle(mutation) {
    const index = lifecycle.findIndex((queued) => (
      queued.kind === mutation.kind
      && queued.path === mutation.path
      && queued.oldPath === mutation.oldPath
      && queued.newPath === mutation.newPath
    ));
    if (index >= 0) lifecycle.splice(index, 1);
  }

  // The staged Context Selections that belong to one file, in drag order.
  function pendingSelectionsFor(path) {
    const pending = [];
    for (const selection of selections) {
      if (selection.path !== path) continue;
      pending.push({
        id: selection.id,
        path: selection.path,
        from: selection.from,
        to: selection.to,
        text: selection.text,
      });
    }
    return pending;
  }

  // A composer File Reference Chip is staged state: it neither creates a File
  // Row nor starts tracking. A newly referenced file's complete content is read
  // when the next question is prepared; an already-tracked file contributes only
  // the reference element.
  function stageReference(path) {
    const normalized = normalizePath(path);
    if (normalized === null) return { path, staged: false, reason: "path" };
    if (!isMarkdown(normalized)) return { path: normalized, staged: false, reason: "role" };
    ensureRecord(normalized, "reference");
    if (!references.includes(normalized)) references.push(normalized);
    return { path: normalized, staged: true };
  }

  // Stage the complete text of one explicitly added Markdown file. The caller
  // may pass the text it already read (a verified drag read); otherwise the text
  // is read through the vault slice when the next question is prepared.
  function stageFile(path, text) {
    const normalized = normalizePath(path);
    if (normalized === null) return { path, staged: false, reason: "path" };
    if (!isMarkdown(normalized)) return { path: normalized, staged: false, reason: "role" };
    const record = ensureRecord(normalized, "stage");
    // Staged text belongs to a file that has no baseline yet. Once a file is
    // tracked, only a classification through the vault may move its state.
    if (!record.tracked && typeof text === "string") {
      record.stagedText = text;
      setObserved(record, text);
    }
    refreshStatus(record);
    return { path: normalized, staged: true };
  }

  // Stage one dragged Context Selection. The containing file's complete content
  // travels with the next question, so a selection from a file that is not
  // tracked yet also stages that file.
  function stageSelection({ path, from, to, text } = {}) {
    const normalized = normalizePath(path);
    if (normalized === null) return { path, staged: false, reason: "path" };
    if (!isMarkdown(normalized)) return { path: normalized, staged: false, reason: "role" };
    const selected = typeof text === "string" ? text : "";
    if (selected.length === 0) return { path: normalized, staged: false, reason: "empty" };
    ensureRecord(normalized, "stage");
    const id = `selection-${nextSelectionId}`;
    nextSelectionId += 1;
    selections.push({ id, path: normalized, from, to, text: selected });
    return { path: normalized, staged: true, id };
  }

  // A user removing a Context File stops tracking and sending later changes, but
  // does not remove the path from the session tool allowlist and does not erase
  // context already sent. Removing a file that was never sent discards it and
  // its pending selections locally.
  function removedFile(path) {
    const normalized = normalizePath(path);
    if (normalized === null) return false;
    const record = files.get(normalized);
    const sent = allowlisted.has(normalized) || record?.tracked === true;
    if (!record && !sent) return false;
    if (record && !sent) dropSelectionsFor(normalized);
    files.delete(normalized);
    dropReferencesFor(normalized);
    removedPaths.add(normalized);
    emit({ kind: "context/file-removed", path: normalized, wasSent: sent });
    return true;
  }

  // A deleted Context File stops tracking at once. Its prior model context and
  // its already staged selections survive, and the model learns about the
  // deletion with the next question. A file deleted before its first successful
  // send is dropped with its selections and reported to the user instead.
  function deletedFile(path) {
    const normalized = normalizePath(path);
    if (normalized === null) return false;
    const record = files.get(normalized);
    const sent = allowlisted.has(normalized) || record?.tracked === true;
    if (!record && !sent) return false;
    files.delete(normalized);
    dropReferencesFor(normalized);
    removedPaths.add(normalized);
    if (sent) {
      queueLifecycle({ kind: "deleted", path: normalized });
    } else {
      dropSelectionsFor(normalized);
    }
    emit({ kind: "context/file-deleted", path: normalized, wasSent: sent });
    return true;
  }

  // A renamed Context File keeps its tracking facts, its pending selections, and
  // its position, and never increments the effective-change count.
  function renamedFile(oldPath, newPath) {
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    if (from === null || to === null) return false;
    const record = files.get(from);
    const sent = allowlisted.has(from) || record?.tracked === true;
    if (!record && !sent) return false;
    if (!isMarkdown(to)) return deletedFile(from);
    // Any earlier redirect now points at the newest path, and the new path is
    // never itself stale.
    for (const [key, value] of redirects) {
      if (value === from) redirects.set(key, to);
    }
    redirects.delete(to);
    redirects.set(from, to);
    if (record) {
      files.delete(from);
      record.path = to;
      files.set(to, record);
      refreshStatus(record);
      for (const selection of selections) {
        if (selection.path === from) selection.path = to;
      }
      const reference = references.indexOf(from);
      if (reference >= 0) references[reference] = to;
    }
    if (sent) {
      queueLifecycle({ kind: "renamed", oldPath: from, newPath: to });
      emit({ kind: "context/file-renamed", oldPath: from, newPath: to });
    }
    return true;
  }

  // Removing a staged selection before send cancels it, so it never enters the
  // model context.
  function removeSelection(id) {
    const index = selections.findIndex((selection) => selection.id === id);
    if (index < 0) return false;
    selections.splice(index, 1);
    return true;
  }

  // A public Vault `modify` event only marks an explicitly tracked Markdown file
  // as changed. The read happens when the next question is prepared, never in the
  // event callback.
  function modifiedFile(path) {
    const normalized = normalizePath(path);
    if (normalized === null) return false;
    const record = files.get(normalized);
    if (!record || !record.tracked) return false;
    record.dirty = true;
    return true;
  }

  // Classify one freshly read original text against the tracked baseline. A
  // projection-identical change advances both observed states and the baseline
  // without any API input; a differing projection becomes a pending effective
  // change that stays pending until the endpoint accepts it.
  function classify(record, text) {
    record.dirty = false;
    if (typeof text !== "string") return "missing";
    if (!record.tracked) {
      if (text === record.observedRawText) return "unchanged";
      record.stagedText = text;
      setObserved(record, text);
      refreshStatus(record);
      return "staged";
    }
    if (text === record.rawText) {
      // Back at the last successfully sent content: any pending classification
      // is void, and nothing is sent.
      setObserved(record, text);
      refreshStatus(record);
      return "unchanged";
    }
    const projection = filteredProjection(text);
    if (!diffIsEffective(record.rawProjection, projection)) {
      // A filtered-only change advances both observed states with no API input
      // and no effective-diff increment.
      setBaseline(record, text);
      setObserved(record, text);
      refreshStatus(record);
      emit({ kind: "context/file-updated", path: record.path, observedRawText: text });
      return "filtered";
    }
    setObserved(record, text);
    refreshStatus(record);
    return "changed";
  }

  // Restore reconciliation. The caller performs one cached read per still-tracked
  // file; the tracker compares the returned text directly with the last
  // successfully sent content. No hash, no polling, and no background discovery.
  function reconcile(reads) {
    const provided = normalizeReads(reads);
    const result = { changed: [], filteredOnly: [], unchanged: [], missing: [] };
    for (const record of orderedRecords()) {
      if (!record.tracked || !provided.has(record.path)) continue;
      const outcome = classify(record, provided.get(record.path));
      if (outcome === "changed") result.changed.push(record.path);
      else if (outcome === "filtered") result.filteredOnly.push(record.path);
      else if (outcome === "unchanged") result.unchanged.push(record.path);
      else result.missing.push(record.path);
    }
    return result;
  }

  // A successful `get-full-file` result becomes the exact synchronization
  // baseline of a still-tracked file, with its count reset, while tracking
  // continues. An untracked path is returned unchanged: tracking is never
  // resumed and no visible file state is recreated.
  function applyFullFileResult(path, text) {
    const normalized = normalizePath(path);
    if (normalized === null) return { path, tracked: false, text };
    const record = files.get(normalized);
    if (!record || !record.tracked) return { path: normalized, tracked: false, text };
    setBaseline(record, String(text ?? ""));
    setObserved(record, record.rawText);
    record.effectiveChanges = 0;
    record.dirty = false;
    refreshStatus(record);
    emit({ kind: "context/tool-baseline", path: normalized, text: record.rawText });
    return { path: normalized, tracked: true, text: record.rawText };
  }

  // Build the ordered Context mutations for the next question. Reading happens
  // here, once per file that still needs its current text, so a retry after a
  // failure carries the change.
  async function mutationsForSend() {
    for (const record of orderedRecords()) {
      if (!record.tracked || !record.dirty) continue;
      classify(record, await readText(record.path));
    }
    for (const record of orderedRecords()) {
      if (record.tracked || typeof record.stagedText === "string") continue;
      const text = await readText(record.path);
      if (text === null) {
        // Removed before its first successful send: it and its pending
        // selections never enter model context, and the user is told the source
        // file no longer exists.
        files.delete(record.path);
        dropReferencesFor(record.path);
        dropSelectionsFor(record.path);
        removedPaths.add(record.path);
        emit({ kind: "context/file-deleted", path: record.path, wasSent: false, reason: "missing" });
        continue;
      }
      record.stagedText = text;
      setObserved(record, text);
      refreshStatus(record);
    }
    const mutations = [];
    for (const record of orderedRecords()) {
      if (!record.tracked) {
        if (typeof record.stagedText !== "string") continue;
        mutations.push({ kind: "file", path: record.path, text: record.stagedText });
        continue;
      }
      if (!diffIsEffective(record.observedProjection, record.rawProjection)) continue;
      if (record.effectiveChanges >= RENDERER_MAX_EFFECTIVE_CHANGES - 1) {
        // The fifth effective change appends the current original Vault text.
        mutations.push({ kind: "file", path: record.path, text: record.observedRawText });
        continue;
      }
      mutations.push({
        kind: "diff",
        path: record.path,
        diff: proactiveDiff(record.path, record.rawProjection, record.observedProjection),
        rawText: record.observedRawText,
        projection: record.observedProjection,
      });
    }
    for (const mutation of lifecycle) {
      mutations.push({ ...mutation });
    }
    for (const path of references) {
      mutations.push({ kind: "reference", path });
    }
    for (const selection of selections) {
      mutations.push({
        kind: "selection",
        id: selection.id,
        path: selection.path,
        from: selection.from,
        to: selection.to,
        text: selection.text,
      });
    }
    pendingSend = mutations;
    return mutations;
  }

  // `response.created` is the only transition from staged input to canonical
  // Context and tracking. Everything the endpoint accepted is applied here.
  function acceptTurn(mutations) {
    const list = Array.isArray(mutations) ? mutations : (pendingSend ?? []);
    for (const mutation of list) {
      if (!mutation || typeof mutation !== "object") continue;
      if (mutation.kind === "file") {
        const target = redirects.get(mutation.path) ?? mutation.path;
        // The user removed this file, or it left the Vault, while this request
        // was in flight. The accepted content is canonical Context and the path
        // is readable through the tool, but tracking stays stopped so the
        // visible state cannot silently come back.
        if (removedPaths.has(mutation.path) || removedPaths.has(target)) {
          const text = String(mutation.text ?? "");
          allowlisted.add(target);
          emit({ kind: "context/file-added", path: target, text });
          emit({ kind: "context/file-removed", path: target, wasSent: true });
          continue;
        }
        const record = files.get(mutation.path) ?? files.get(target) ?? ensureRecord(target, "stage");
        record.tracked = true;
        setBaseline(record, String(mutation.text ?? ""));
        setObserved(record, record.rawText);
        record.effectiveChanges = 0;
        // A modification that arrived while this turn was in flight stays
        // pending; accept never clears it.
        record.stagedText = null;
        refreshStatus(record);
        allowlisted.add(record.path);
        emit({ kind: "context/file-added", path: record.path, text: record.rawText });
      } else if (mutation.kind === "diff") {
        const record = files.get(mutation.path) ?? files.get(redirects.get(mutation.path));
        if (record) {
          // Advancing here is exactly the `response.created` boundary: the
          // endpoint accepted this diff, so it counts once and becomes baseline.
          setBaseline(record, mutation.rawText);
          record.observedRawText = mutation.rawText;
          record.observedProjection = mutation.projection;
          record.effectiveChanges += 1;
          refreshStatus(record);
        }
        emit({ kind: "context/file-diff", path: mutation.path, diff: mutation.diff });
      } else if (mutation.kind === "renamed") {
        if (allowlisted.has(mutation.oldPath)) {
          allowlisted.delete(mutation.oldPath);
          allowlisted.add(mutation.newPath);
        }
        consumeLifecycle(mutation);
      } else if (mutation.kind === "deleted") {
        consumeLifecycle(mutation);
      } else if (mutation.kind === "reference") {
        const index = references.indexOf(mutation.path);
        if (index >= 0) references.splice(index, 1);
        emit({ kind: "context/file-reference", path: mutation.path });
      } else if (mutation.kind === "selection") {
        const index = selections.findIndex((selection) => selection.id === mutation.id);
        if (index >= 0) selections.splice(index, 1);
        emit({
          kind: "context/selection-added",
          path: mutation.path,
          from: mutation.from,
          to: mutation.to,
          text: mutation.text,
        });
      }
    }
    pendingSend = null;
  }

  // A failure before `response.created` never advances tracking state, so the
  // staged input stays retryable exactly as it was.
  function rejectTurn() {
    pendingSend = null;
  }

  // Sorted Vault Paths whose content the user has successfully sent.
  function allowlist() {
    return [...allowlisted].sort();
  }

  function trackedFiles() {
    const projections = [];
    for (const record of orderedRecords()) {
      if (!record.tracked && record.source !== "stage") continue;
      projections.push({
        path: record.path,
        observedRawText: record.observedRawText,
        observedProjection: record.observedProjection,
        effectiveChanges: record.effectiveChanges,
        status: statusOf(record),
        pendingSelections: pendingSelectionsFor(record.path),
      });
    }
    return projections;
  }

  return {
    restore(records) {
      replaying = true;
      try {
        files.clear();
        allowlisted.clear();
        removedPaths.clear();
        redirects.clear();
        references.splice(0);
        selections.splice(0);
        lifecycle.splice(0);
        nextOrder = 0;
        nextSelectionId = 0;
        pendingSend = null;
        const turns = new Map();
        for (const record of records) {
          const payload = record.payload ?? {};
          if (record.kind === "turn/started") {
            turns.set(payload.turnId, payload.additions ?? []);
            // Explicit re-addition starts a new tracking lifetime. Preserve
            // removals occurring later, while this accepted input is in flight.
            for (const mutation of payload.additions ?? []) {
              if (mutation.kind === "file") stageFile(mutation.path, mutation.text);
            }
          }
          else if (record.kind === "turn/accepted") acceptTurn(turns.get(payload.turnId) ?? []);
          else if (record.kind === "context/file-removed" && payload.path) removedFile(payload.path);
          else if (record.kind === "context/file-renamed" && payload.oldPath && payload.newPath) renamedFile(payload.oldPath, payload.newPath);
          else if (record.kind === "context/file-deleted" && payload.path) deletedFile(payload.path);
          else if (record.kind === "context/tool-baseline" && payload.path && typeof payload.text === "string") applyFullFileResult(payload.path, payload.text);
        }
      } finally {
        replaying = false;
      }
    },
    // Replace only unsent input at the request boundary. A failed validation or
    // request must not retain a reference the user subsequently removed.
    replacePending(pending) {
      references.splice(0);
      selections.splice(0);
      for (const [path, record] of files) if (!record.tracked) files.delete(path);
      for (const path of pending.references ?? []) stageReference(path);
      for (const selection of pending.selections ?? []) stageSelection(selection);
    },
    stageFile,
    stageReference,
    stageSelection,
    removeSelection,
    modifiedFile,
    removedFile,
    renamedFile,
    deletedFile,
    reconcile,
    applyFullFileResult,
    mutationsForSend,
    acceptTurn,
    rejectTurn,
    allowlist,
    trackedFiles,
  };
}

module.exports = {
  RENDERER_MAX_EFFECTIVE_CHANGES,
  DIFF_CONTEXT_LINES,
  createTrackedFile,
  filteredProjection,
  diffIsEffective,
  createContextTracker,
};
