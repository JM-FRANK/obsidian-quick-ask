// Decide from a snapshot of the native rendered image; never resolve a model's
// Markdown path here or reinterpret the browser-selected resource URL.
function answerImagePreview({ active = true, event = {}, image } = {}, fallbackLabel = '') {
  if (!active || event.defaultPrevented || event.button !== 0
    || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
    || !image?.contained || image.excluded || !(image.naturalWidth > 0)) return null;
  const resource = image.currentSrc || image.src;
  if (!resource) return null;
  return { resource, label: image.alt || image.title || fallbackLabel };
}

module.exports = { answerImagePreview };
