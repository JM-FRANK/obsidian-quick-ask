// Model-facing units are separate from the editor's UTF-16 offsets. A Han
// character is one unit; other letter/number runs are words (including internal
// apostrophes). Whitespace, punctuation and standalone symbols are not units.
const LETTER = '(?!\\p{Script=Han})[\\p{L}\\p{N}]';
const CONTINUE = '(?!\\p{Script=Han})[\\p{L}\\p{M}\\p{N}]';
const UNIT_PATTERN = `\\p{Script=Han}|${LETTER}(?:${CONTINUE})*(?:['’]${LETTER}(?:${CONTINUE})*)*`;

function selectionUnitPosition(source, from, to) {
  if (typeof source !== 'string' || !Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || to <= from || to > source.length) return null;
  const prefix = source.slice(0, from).split(/\r\n|\n|\r/);
  const lineFrom = from - prefix.at(-1).length;
  const tail = source.slice(from).search(/[\r\n]/);
  const lineTo = tail < 0 ? source.length : from + tail;
  const start = from - lineFrom, end = Math.min(to, lineTo) - lineFrom;
  let ordinal = 0;
  for (const match of source.slice(lineFrom, lineTo).matchAll(new RegExp(UNIT_PATTERN, 'gu'))) {
    ordinal++;
    if (match.index >= end) break;
    if (match.index + match[0].length > start) return { startLine: prefix.length, startUnit: ordinal };
  }
  return { startLine: prefix.length, startUnit: null };
}

function withSelectionUnits(additions = [], sourceFor = () => null) {
  const local = new Map();
  for (const mutation of additions) {
    if (mutation.kind === 'file' && typeof mutation.text === 'string') local.set(mutation.path, mutation.text);
    if (mutation.kind === 'diff' && typeof mutation.rawText === 'string') local.set(mutation.path, mutation.rawText);
  }
  return additions.map(mutation => {
    if (mutation.kind !== 'selection') return mutation;
    const source = local.get(mutation.path) ?? sourceFor(mutation.path);
    const matches = typeof source === 'string' && Number.isInteger(mutation.from) && Number.isInteger(mutation.to)
      && source.slice(mutation.from, mutation.to) === mutation.text;
    const position = matches ? selectionUnitPosition(source, mutation.from, mutation.to) : null;
    return { ...mutation, ...(position ?? {}),
      startUnit: position ? position.startUnit : Number.isInteger(mutation.startUnit) && mutation.startUnit > 0 ? mutation.startUnit : null };
  });
}

module.exports = { selectionUnitPosition, withSelectionUnits };
