// These protocol values are shared by every provider. Unsupported levels are
// reported by the configured API; the plugin does not guess provider mappings.
const REASONING_LEVELS = Object.freeze({ none: "Off", low: "Low", high: "High", xhigh: "XHigh", max: "Max" });
const DEFAULT_REASONING_EFFORT = "high";
function normalizeReasoningEffort(value) { return Object.hasOwn(REASONING_LEVELS, value) ? value : DEFAULT_REASONING_EFFORT; }
function nextReasoningEffort(value) {
  const levels = Object.keys(REASONING_LEVELS);
  return levels[(levels.indexOf(normalizeReasoningEffort(value)) + 1) % levels.length];
}
module.exports = { REASONING_LEVELS, DEFAULT_REASONING_EFFORT, normalizeReasoningEffort, nextReasoningEffort };
