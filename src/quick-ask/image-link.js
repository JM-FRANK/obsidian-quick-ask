const { parser } = require('@lezer/markdown');
const { imagePaths, imageError } = require('./images');

function exactMarkdownPath(path) {
  return typeof path === 'string' && /\.md$/i.test(path) && !/[\\\r\n\0:]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

// Parse link syntax only; never ask MetadataCache for a "best match" or scan
// the Vault. Lezer owns Markdown code/escape boundaries and link destinations.
function imageLinks(text) {
  const links = [], literals = [], references = new Map(), uses = [];
  // Obsidian comments are not rendered image links. Preserve offsets while
  // excluding their contents from both the Markdown parser and wiki scan.
  const visible = text.replace(/%%[\s\S]*?(?:%%|$)/g, comment => comment.replace(/[^\r\n]/g, ' '));
  const label = value => value.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  parser.parse(visible).iterate({ enter(node) {
    if (['InlineCode', 'FencedCode', 'CodeBlock', 'Escape', 'HTMLBlock', 'CommentBlock', 'Comment'].includes(node.name)) {
      literals.push([node.from, node.to]);
      return false;
    }
    if (!['Image', 'Link', 'LinkReference'].includes(node.name)) return;
    const own = text.slice(node.from, node.to);
    const url = node.node.getChild('URL');
    if (url) {
      const raw = text.slice(url.from, url.to).replace(/^<|>$/g, '');
      if (node.name === 'LinkReference') {
        const key = node.node.getChild('LinkLabel');
        if (key && !references.has(label(text.slice(key.from, key.to)))) references.set(label(text.slice(key.from, key.to)), raw);
      } else links.push({ raw, markdown: true, syntax: own });
      return false;
    }
    if (own.startsWith('![[') || own.startsWith('[[')) return false;
    if (node.name !== 'LinkReference') {
      const key = node.node.getChild('LinkLabel');
      const first = /^!?\[([^\]]*)\]/.exec(own)?.[1];
      uses.push({ key: label(key ? text.slice(key.from, key.to) || first : first ?? ''), syntax: own, first });
    }
  } });
  for (const use of uses) {
    const raw = references.get(use.key || label(use.first ?? ''));
    if (raw) links.push({ raw, markdown: true, syntax: use.syntax });
  }
  for (const match of visible.matchAll(/!?\[\[([^\[\]\r\n]+)\]\]/g)) {
    if (literals.some(([from, to]) => from < match.index + match[0].length && to > match.index)) continue;
    links.push({ raw: match[1].split('|', 1)[0], markdown: false, syntax: match[0] });
  }
  return links;
}

function linkDestination(link) {
  // Strip navigation before decoding, so %23 in a filename stays a filename.
  const raw = link.raw.split('#', 1)[0];
  return link.markdown ? decodeURIComponent(raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1')) : raw;
}

function resolveImageLink(sourcePath, link) {
  const target = linkDestination(link);
  if (!target || /[\\\r\n\0:]/.test(target) || target.startsWith('/')) throw imageError('IMAGE_PATH');
  // Markdown destinations are document-relative even without a leading './'.
  // Bare wikilinks retain explicit Vault-root semantics; no filesystem lookup
  // or same-name fallback participates in choosing either base directory.
  const parts = link.markdown || /^(?:\.\/|\.\.\/)/.test(target) ? sourcePath.split('/').slice(0, -1) : [];
  for (const part of target.split('/')) {
    if (part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw imageError('IMAGE_PATH');
      parts.pop();
    } else {
      if (!part) throw imageError('IMAGE_PATH');
      parts.push(part);
    }
  }
  return imagePaths([parts.join('/')])[0];
}

// This thin adapter returns the exact path consumed by readForSend. A caller
// must authorize sourcePath before reading text. The supplied link must actually
// occur in that document; arbitrary paths do not inherit its read permission.
function documentImagePath(sourcePath, path, text) {
  if (!exactMarkdownPath(sourcePath) || typeof path !== 'string' || !path || typeof text !== 'string') throw imageError('IMAGE_PATH');
  for (const link of imageLinks(text)) {
    try {
      if (path === link.raw || path === link.syntax || path === linkDestination(link)) return resolveImageLink(sourcePath, link);
    } catch { /* Invalid/external links grant no permission. */ }
  }
  throw imageError('IMAGE_PATH');
}

module.exports = { documentImagePath, exactMarkdownPath };
