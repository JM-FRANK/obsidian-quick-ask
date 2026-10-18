// The pinned Markdown parser is supplied by the existing Composer graph so
// table copying does not bundle a second parser or depend on host internals.
function markdownTableSources(markdown, parser) {
  // Lezer expects LF input. Map every parsed boundary back to the original
  // string so CRLF, Unicode and source formatting survive copying unchanged.
  const offsets = [0];
  let normalized = '';
  for (let index = 0; index < markdown.length; index++) {
    const char = markdown[index];
    if (char === '\r' && markdown[index + 1] === '\n') index++;
    normalized += char === '\r' ? '\n' : char;
    offsets.push(index + 1);
  }
  // Ignore line-end padding only for recognition (otherwise a header ending
  // in two spaces becomes a HardBreak). Boundary mapping still includes that
  // padding in the copied original row.
  let input = '';
  const positions = [offsets[0]];
  for (let index = 0; index < normalized.length;) {
    if (normalized[index] === ' ' || normalized[index] === '\t') {
      let end = index;
      while (normalized[end] === ' ' || normalized[end] === '\t') end++;
      if (end === normalized.length || normalized[end] === '\n') {
        positions[positions.length - 1] = offsets[end];
        index = end;
        continue;
      }
    }
    input += normalized[index++];
    positions.push(offsets[index]);
  }
  const tables = [];
  parser.parse(input).iterate({
    enter(node) {
      if (node.name !== 'Table') return;
      const rows = [];
      // Direct children are header, alignment delimiter, and body rows. Their
      // spans exclude enclosing list/blockquote prefixes but retain the actual
      // Markdown cells, escaped pipes, spacing and alignment syntax.
      for (let row = node.node.firstChild; row; row = row.nextSibling) {
        if (!['TableHeader', 'TableDelimiter', 'TableRow'].includes(row.name)) continue;
        const from = positions[row.from], to = positions[row.to];
        const previous = rows.at(-1);
        const gap = previous ? markdown.slice(previous.to, from) : '';
        const separator = gap.match(/\r\n|\r|\n/)?.[0] ?? '\n';
        rows.push({ from, to, separator });
      }
      tables.push(rows.map((row, index) => `${index ? row.separator : ''}${markdown.slice(row.from, row.to)}`).join(''));
      return false;
    },
  });
  return tables;
}

module.exports = { markdownTableSources };
