const { IMAGE_MAX_COUNT, imageError } = require('./images');

function imageDraftPaths(draft) {
  return [...new Set([...(draft?.images ?? []), ...(draft?.pending?.images ?? [])])];
}

// Resolve the captured session's latest draft after every asynchronous import.
// A deleted/adopted-away draft is never recreated by an old picker callback.
function appendImageDraft(drafts, id, paths) {
  const current = drafts.get(id);
  if (!current) return null;
  const images = [...new Set([...imageDraftPaths(current), ...paths])];
  if (images.length > IMAGE_MAX_COUNT) throw imageError('IMAGE_COUNT');
  const next = { ...current, images, pending: { ...current.pending,
    images: [...new Set([...(current.pending.images ?? []), ...paths])] } };
  drafts.set(id, next);
  return next;
}

module.exports = { imageDraftPaths, appendImageDraft };
