const { imagePaths, validateImageBatch, IMAGE_MAX_COUNT } = require('./images');

function imageReadFailure(error) {
  const code = ['IMAGE_SIZE', 'IMAGE_TOTAL', 'IMAGE_COUNT', 'IMAGE_FORMAT', 'IMAGE_MISSING'].includes(error?.code)
    ? error.code : 'IMAGE_MISSING';
  return `Image read failed (${code}).`;
}

// Canonical tool items keep their native text shape. Their durable record owns
// image path metadata; this index reconnects it to the item after replay without
// adding app fields to provider messages or image bytes to JSONL.
function createImageToolResults() {
  const references = new WeakMap();
  return {
    remember(item, paths) {
      if (item && Array.isArray(paths) && paths.length) references.set(item, [...paths]);
    },
    copy(from, to) { if (references.has(from)) references.set(to, references.get(from)); },
    async materialize(items, { source, allowlist, protocol, pendingImages = [], signal = null }) {
      const targets = items.filter(item => references.has(item));
      if (!targets.length) return { items, hasImages: false };
      const results = new Map(), reads = new Map();
      const failAll = output => {
        for (const item of targets) results.set(item, { error: output });
        return { items: protocol.imageToolResults(items, results), hasImages: false };
      };
      if (signal?.aborted) return failAll('Image read cancelled.');
      // Count image occurrences, not unique source files. The same path in two
      // historical results will occupy two image blocks on the wire.
      const count = targets.reduce((total, item) => total + references.get(item).length, pendingImages.length);
      if (count > IMAGE_MAX_COUNT) return failAll(imageReadFailure({ code: 'IMAGE_COUNT' }));
      for (const item of targets) {
        let paths;
        try { paths = imagePaths(references.get(item)); } catch {
          results.set(item, { error: 'Image unavailable or not authorized in this session.' });
          continue;
        }
        if (paths.some(path => !allowlist.has(path))) {
          results.set(item, { error: 'Image unavailable or not authorized in this session.' });
          continue;
        }
        const images = [];
        try {
          for (const path of paths) {
            if (signal?.aborted) return failAll('Image read cancelled.');
            if (!reads.has(path)) {
              // Cache for this request only. A later request reads the current
              // path again; no immutable source snapshot is promised.
              reads.set(path, Promise.resolve().then(() => source.readForSend([path])));
            }
            const prepared = await reads.get(path);
            if (prepared?.length !== 1 || prepared[0]?.path !== path) throw { code: 'IMAGE_MISSING' };
            images.push(prepared[0]);
            // Stop acquiring later images as soon as the aggregate exceeds the
            // request's source-byte budget, including repeated occurrences.
            try { validateImageBatch([...pendingImages, ...[...results.values()].flatMap(result => result.images ?? []), ...images]); }
            catch (error) { return failAll(imageReadFailure(error)); }
          }
          results.set(item, { images });
        } catch (error) { results.set(item, { error: imageReadFailure(error) }); }
      }
      if (signal?.aborted) return failAll('Image read cancelled.');
      const images = [...results.values()].flatMap(result => result.images ?? []);
      try { validateImageBatch([...pendingImages, ...images]); }
      catch (error) { return failAll(imageReadFailure(error)); }
      return { items: protocol.imageToolResults(items, results), hasImages: images.length > 0 };
    },
  };
}

module.exports = { createImageToolResults, imageReadFailure };
