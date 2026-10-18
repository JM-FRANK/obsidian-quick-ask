const { renderContextEnvelope, RENDERER_VERSION } = require('./prompt-renderer');
const { isUserMessage, messageText } = require('./protocol');
const { withSelectionUnits } = require('./selection-position');

// Canonical records remain untouched. Rebuild only renderer-owned selection
// headers from their structured mutations; a regex over message bodies would
// corrupt quoted text containing XML-like examples.
function createContextProjection() {
  const projected = new WeakMap(), unavailable = new WeakSet(), sources = new Map();
  let additions = [], version = 1;
  return {
    sourceRecord(record) {
      const value = record.payload ?? {};
      if (['context/file-added', 'context/tool-baseline'].includes(record.kind) && typeof value.text === 'string') sources.set(value.path, value.text);
      if (record.kind === 'context/file-renamed' && sources.has(value.oldPath)) {
        sources.set(value.newPath, sources.get(value.oldPath)); sources.delete(value.oldPath);
      }
      if (record.kind === 'context/file-deleted') sources.delete(value.path);
    },
    beginTurn(next = [], rendererVersion = 1) {
      additions = next; version = rendererVersion;
      for (const mutation of additions) {
        if (mutation.kind === 'file' && typeof mutation.text === 'string') sources.set(mutation.path, mutation.text);
        if (mutation.kind === 'diff' && typeof mutation.rawText === 'string') sources.set(mutation.path, mutation.rawText);
        if (mutation.kind === 'renamed' && sources.has(mutation.oldPath)) {
          sources.set(mutation.newPath, sources.get(mutation.oldPath)); sources.delete(mutation.oldPath);
        }
        if (mutation.kind === 'deleted') sources.delete(mutation.path);
      }
    },
    add(item, contextInput = false) {
      if (!isUserMessage(item) || version >= 7) return;
      const before = messageText(item);
      if (!before.startsWith('<quick_ask_context>\n')) return;
      const expected = renderContextEnvelope(additions, { rendererVersion: version });
      if (before !== expected) {
        // Malformed legacy context cannot silently disclose old editor columns.
        // It stays readable locally but fails before any provider request.
        if (contextInput && /<context_selection\b[^>]*\bstart_column=/.test(before)) unavailable.add(item);
        return;
      }
      const after = renderContextEnvelope(withSelectionUnits(additions, path => sources.get(path)), {
        rendererVersion: version, selectionPositionVersion: RENDERER_VERSION,
      });
      if (before === after) return;
      if (typeof item.content === 'string') projected.set(item, { ...item, content: after });
      else projected.set(item, { ...item, content: item.content.map(block => block.text === before ? { ...block, text: after } : block) });
    },
    items(items = []) {
      return items.map(item => {
        if (unavailable.has(item)) throw new Error('Legacy selection context cannot be projected without editor offsets. Its structured source metadata is missing or inconsistent.');
        return projected.get(item) ?? item;
      });
    },
  };
}

module.exports = { createContextProjection };
