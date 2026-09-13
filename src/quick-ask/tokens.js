// Token accounting for Quick Ask. Provider-reported usage is exact; everything
// derived locally is an estimate and is always marked as one. Reasoning tokens
// are an output subset and are never added to output twice.
//
// The estimator uses the dsh-web rule of four characters per token plus a fixed
// structural overhead per role and content block.

const {
  responsesUsageInputTokens, responsesUsageOutputTokens, responsesUsageTotalTokens,
  responsesUsageCachedInputTokens, responsesUsageReasoningTokens,
} = require("./transport");

const CHARACTERS_PER_TOKEN = 4;
const STRUCTURAL_OVERHEAD_TOKENS = 4;
const ROLE_OVERHEAD_TOKENS = 4;
const OCCUPANCY_WARNING_RATIO = 0.8;
const OCCUPANCY_COMPACTION_RATIO = 0.9;

function estimateText(text) {
  const length = typeof text === "string" ? text.length : 0;
  return Math.ceil(length / CHARACTERS_PER_TOKEN);
}

// Estimate one canonical Responses item, or one Context mutation, which carries
// its payload directly rather than in a content array.
function estimateItem(item) {
  if (!item || typeof item !== "object") return 0;
  if ((typeof item.role === "string" && !item.type) || item.function) {
    return STRUCTURAL_OVERHEAD_TOKENS + ROLE_OVERHEAD_TOKENS + estimateText(JSON.stringify(item));
  }
  let tokens = STRUCTURAL_OVERHEAD_TOKENS + ROLE_OVERHEAD_TOKENS;
  const content = Array.isArray(item.content) ? item.content : [];
  for (const block of content) {
    tokens += STRUCTURAL_OVERHEAD_TOKENS;
    if (typeof block?.text === "string") tokens += estimateText(block.text);
    else if (typeof block?.output === "string") tokens += estimateText(block.output);
  }
  if (typeof item.text === "string") tokens += estimateText(item.text);
  if (typeof item.diff === "string") tokens += estimateText(item.diff);
  if (typeof item.arguments === "string") tokens += estimateText(item.arguments);
  if (typeof item.output === "string") tokens += estimateText(item.output);
  // Opaque transport payloads (encrypted reasoning, a Compaction Item's
  // encrypted_content) are not readable text, but they still occupy the
  // request, so the serialized size is counted as a conservative upper bound.
  // Missing this would let the shrink gate and the remeasure loop treat a huge
  // checkpoint as nearly free.
  for (const [key, value] of Object.entries(item)) {
    if (typeof value !== "string" || value.length < 64) continue;
    if (["text", "diff", "arguments", "output"].includes(key)) continue;
    tokens += estimateText(value);
  }
  return tokens;
}

function estimateItems(items) {
  return (Array.isArray(items) ? items : []).reduce((total, item) => total + estimateItem(item), 0);
}

function estimateInstructions(instructions) {
  return STRUCTURAL_OVERHEAD_TOKENS + estimateText(instructions);
}

// The complete prospective request: stable instructions, the tool schema, the
// canonical history, new Context input, the question, and the answer reserve.
function priceProspectiveRequest({
  instructions = "",
  tools = [],
  items = [],
  additions = [],
  question = "",
  reserveTokens = 0,
} = {}) {
  const components = {
    instructions: estimateInstructions(instructions),
    tools: estimateItems(tools),
    history: estimateItems(items),
    additions: estimateItems(additions),
    question: estimateText(question),
    reserve: reserveTokens,
  };
  const total = Object.values(components).reduce((sum, value) => sum + value, 0);
  return { total, components, estimated: true };
}

// The 90 percent threshold derives from the configured capacity, while the
// effective input budget subtracts the fixed answer reserve.
function capacityBudget(capacityTokens, { reserveTokens = 0 } = {}) {
  if (!Number.isInteger(capacityTokens) || capacityTokens <= 0) {
    return { configured: false, capacity: null, reserve: reserveTokens, inputBudget: null, compactionThreshold: null };
  }
  return {
    configured: true,
    capacity: capacityTokens,
    reserve: reserveTokens,
    inputBudget: capacityTokens - reserveTokens,
    compactionThreshold: Math.floor(capacityTokens * OCCUPANCY_COMPACTION_RATIO),
  };
}

// Occupancy: the latest exact provider anchor plus signed local estimates for
// model-visible additions and removals since that request. Before the first
// anchor the whole prospective request is estimated.
function contextOccupancy({ anchor = null, deltaTokens = 0, prospectiveTokens = 0 } = {}) {
  if (!anchor) return { tokens: prospectiveTokens, exact: false, estimated: true };
  const tokens = Math.max(0, (anchor.inputTokens ?? 0) + deltaTokens);
  return { tokens, exact: true, estimated: false };
}

function occupancyColor(tokens, capacityTokens) {
  if (!Number.isInteger(capacityTokens) || capacityTokens <= 0) return "none";
  const ratio = tokens / capacityTokens;
  if (ratio >= 1) return "error";
  if (ratio >= OCCUPANCY_WARNING_RATIO) return "warning";
  return "normal";
}

function shouldCompact({ occupancyTokens, capacityTokens, boundary = true }) {
  const budget = capacityBudget(capacityTokens);
  if (!budget.configured || !boundary) return false;
  return occupancyTokens >= budget.compactionThreshold;
}

// Turn usage folds every billed attempt of one user turn, including retries and
// tool continuations. A terminal sample replaces an earlier streaming sample
// for the same attempt instead of being added twice.
function createTurnUsage() {
  const attempts = new Map();
  return {
    record(sample, { attemptId = "attempt" } = {}) {
      const entry = attempts.get(attemptId) ?? { stream: null, terminal: null };
      if (sample?.source === "terminal") entry.terminal = sample.usage ?? null;
      else entry.stream = sample?.usage ?? null;
      attempts.set(attemptId, entry);
    },
    // The optional fields appear only when every included attempt reported them,
    // so a missing fact is omitted rather than rendered as zero.
    totals() {
      const included = [...attempts.values()].map((entry) => entry.terminal ?? entry.stream).filter(Boolean);
      if (included.length === 0) return { attempts: 0 };
      const sum = (read) => included.reduce((total, usage) => {
        const value = read(usage);
        return total + (Number.isFinite(value) ? value : 0);
      }, 0);
      const reports = (read) => included.every((usage) => Number.isFinite(read(usage)));
      const totals = {
        attempts: included.length,
        input: sum(u => u.prompt_tokens ?? responsesUsageInputTokens(u)),
        output: sum(u => u.completion_tokens ?? responsesUsageOutputTokens(u)),
        total: sum(responsesUsageTotalTokens),
      };
      // A nested detail counts as reported only when every attempt carries it,
      // and cached input is a detail of input rather than an extra input.
      const cachedInput = u => u.prompt_tokens_details?.cached_tokens ?? responsesUsageCachedInputTokens(u);
      const reasoning = u => u.completion_tokens_details?.reasoning_tokens ?? responsesUsageReasoningTokens(u);
      if (reports(cachedInput)) totals.cachedInput = sum(cachedInput);
      if (reports(reasoning)) totals.reasoning = sum(reasoning);
      return totals;
    },
    attempts: () => attempts.size,
  };
}

function createSessionUsage() {
  let settled = 0;
  let turns = 0;
  return {
    addTurn(totals) {
      if (totals?.total) settled += totals.total;
      turns += 1;
    },
    total: () => settled,
    turns: () => turns,
  };
}

// Compact token text for a pill or ring, such as `15.8K tok`.
function formatTokens(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 tok";
  if (value < 1000) return `${Math.round(value)} tok`;
  if (value < 1000000) return `${(value / 1000).toFixed(1)}K tok`;
  return `${(value / 1000000).toFixed(1)}M tok`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return null;
  return `${Math.round(value * 100)}%`;
}

module.exports = {
  CHARACTERS_PER_TOKEN,
  STRUCTURAL_OVERHEAD_TOKENS,
  ROLE_OVERHEAD_TOKENS,
  OCCUPANCY_WARNING_RATIO,
  OCCUPANCY_COMPACTION_RATIO,
  estimateText,
  estimateItem,
  estimateItems,
  estimateInstructions,
  priceProspectiveRequest,
  capacityBudget,
  contextOccupancy,
  occupancyColor,
  shouldCompact,
  createTurnUsage,
  createSessionUsage,
  formatTokens,
  formatPercent,
};
