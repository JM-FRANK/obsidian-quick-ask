// Provider usage belongs to one request, never to the cumulative bill. Keep a
// local baseline for that same request so only subsequent changes are estimated.
const count = value => Number.isFinite(value) && value >= 0 ? value : null;

function inputUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  // Compatible APIs normally expose totals. Cache details are subsets, except
  // native Anthropic's explicitly disjoint input/cache-read/cache-write fields.
  if (count(usage.prompt_tokens) !== null) return usage.prompt_tokens;
  if (count(usage.input_tokens) !== null) return usage.input_tokens
    + (count(usage.cache_read_input_tokens) ?? 0) + (count(usage.cache_creation_input_tokens) ?? 0);
  return count(usage.promptTokenCount);
}

function occupancyAnchor(usage, request) {
  const inputTokens = inputUsage(usage);
  if (inputTokens === null || !request || !Number.isFinite(request.localTokens)) return null;
  return { version: 1, inputTokens, localTokens: request.localTokens,
    imageKeys: request.imageKeys ?? [], transientImages: request.transientImages ?? 0 };
}

function calibratedOccupancy(anchor, localTokens, imageKeys = [], transientImages = 0) {
  const fallback = () => ({ tokens: localTokens, exact: false, estimated: true });
  if (anchor?.version !== 1 || count(anchor.inputTokens) === null || count(anchor.localTokens) === null
    || !Array.isArray(anchor.imageKeys) || !anchor.imageKeys.every(key => typeof key === 'string')
    || !Number.isSafeInteger(anchor.transientImages) || anchor.transientImages < 0) return fallback();
  // A source set change invalidates image calibration. We do not invent a
  // common pixels-to-token formula for arbitrary model names or proxy URLs.
  if (JSON.stringify(anchor.imageKeys) !== JSON.stringify(imageKeys)) return fallback();
  // One-shot attachments are absent from later replay. Their old request total
  // cannot calibrate that context; do not try to subtract image-specific usage.
  if (anchor.transientImages !== transientImages || transientImages) return fallback();
  const delta = localTokens - anchor.localTokens;
  const exact = delta === 0 && imageKeys.length === 0;
  return { tokens: Math.max(0, anchor.inputTokens + delta), exact, estimated: !exact, source: 'provider' };
}

// Never let a text tokenizer see base64 or image URLs in compatible CC items.
function withoutImageBytes(value) {
  if (Array.isArray(value)) return value.filter(part => !['input_image', 'image_url', 'image'].includes(part?.type)).map(withoutImageBytes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['inlineData', 'fileData'].includes(key))
    .map(([key, child]) => [key, withoutImageBytes(child)]));
}

module.exports = { inputUsage, occupancyAnchor, calibratedOccupancy, withoutImageBytes };
