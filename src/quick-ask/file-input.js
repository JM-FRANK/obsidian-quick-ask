// Standard Obsidian open URIs from DataTransfer, resolved only inside this Vault.
// No filesystem imports, attachment copies, private drag manager or file reads.
function droppedFilePaths(dataTransfer, { vaultName, resolvePath }) {
  const text = dataTransfer?.getData?.('text/uri-list') || dataTransfer?.getData?.('text/plain') || '';
  const paths = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    let uri;
    try { uri = new URL(line.trim()); } catch { continue; }
    if (uri.protocol !== 'obsidian:' || uri.hostname !== 'open' || uri.searchParams.has('path')) continue;
    if (uri.searchParams.get('vault') !== vaultName) continue;
    const path = uri.searchParams.get('file');
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) continue;
    const resolved = resolvePath(path);
    if (typeof resolved === 'string' && resolved.length > 0) paths.add(resolved);
  }
  return [...paths];
}

// A chip's serialization must remain an unambiguous single-line wikilink.
function canReferencePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\[\]\r\n]/u.test(path);
}

function supportedReferences(paths, isSupported) {
  return [...new Set(paths ?? [])].filter(path => canReferencePath(path) && isSupported(path));
}

module.exports = { droppedFilePaths, canReferencePath, supportedReferences };
