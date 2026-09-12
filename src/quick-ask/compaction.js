// Conversation compaction. The older canonical-item prefix is replaced by a
// checkpoint at an explicit prefix discontinuity; the complete append-only
// local history is never rewritten.
//
// Two provider paths share one durable bracket. The official
// `POST /responses/compact` capability is preferred and its opaque output items
// are preserved exactly. When it is explicitly unsupported, a pi-agent/dsh-style
// structured summary is requested through ordinary Responses instead.

const { estimateItems, estimateText } = require("./tokens");

const FALLBACK_SUMMARY_MAX_TOKENS = 8192;
const TOOL_RESULT_CHARACTER_LIMIT = 2000;
const RETAIN_RATIO = 0.16;
const COMPACT_ENDPOINT = "/responses/compact";

const SUMMARY_SECTIONS = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Next Steps",
  "Critical Context",
];

const SUMMARY_PREAMBLE = "This is a compacted summary of earlier Quick Ask conversation. Treat it as established context and build on it without restating it.";

// The fallback summary shape, with a deterministic file inventory appended from
// the session's successful file-send allowlist.
function buildSummaryInstruction({ hasEarlierCheckpoint = false } = {}) {
  const sections = SUMMARY_SECTIONS.map((section) => `## ${section}`).join("\n");
  return [
    "Produce one consolidated checkpoint using exactly these sections:",
    sections,
    "Do not list a file inventory; it is appended deterministically.",
    // An earlier checkpoint inside the range is consolidated, not nested.
    hasEarlierCheckpoint
      ? "An earlier compacted summary is included above. Merge its still-valid facts with the newer history into one replacement summary; do not nest or quote the earlier summary."
      : null,
  ].filter(Boolean).join("\n");
}

// The framed checkpoint is what the next model context carries: the fixed
// preamble, the model's structured summary, and the deterministic
// referenced-file inventory appended by Quick Ask rather than by the model.
function frameSummary(summaryText, { allowlist = [] } = {}) {
  const inventory = allowlist.length > 0
    ? `\n\n<referenced-files>\n${allowlist.map((path) => `- ${path}`).join("\n")}\n</referenced-files>`
    : "";
  return `<compacted-summary>\n${SUMMARY_PREAMBLE}\n\n${summaryText}${inventory}\n</compacted-summary>`;
}

// A serialized get-full-file result is capped for the summarization request
// only; still-tracked files are reintroduced afterwards from their full text.
function truncateToolResult(text) {
  const own = String(text ?? "");
  if (own.length <= TOOL_RESULT_CHARACTER_LIMIT) return own;
  const omitted = own.length - TOOL_RESULT_CHARACTER_LIMIT;
  return `${own.slice(0, TOOL_RESULT_CHARACTER_LIMIT)}\n[${omitted} characters omitted]`;
}

// The retained recent tail targets 16 percent of the configured capacity and
// excludes stable instructions, the tool schema, the summary, and the complete
// contents of still-tracked files.
function chooseRetainedTail({ items = [], capacityTokens = 0 } = {}) {
  // The budget excludes stable instructions, the tool schema, the compaction
  // summary, and the complete contents of still-tracked files, so none of
  // those is subtracted here.
  const budget = Math.max(0, Math.floor(capacityTokens * RETAIN_RATIO));
  const tail = [];
  let used = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const size = estimateItems([item]);
    // A function call is never separated from its output: take the pair, or
    // neither.
    if (item?.type === "function_call_output") {
      const call = items[index - 1];
      const pairSize = size + (call?.type === "function_call" ? estimateItems([call]) : 0);
      if (used + pairSize > budget && tail.length > 0) break;
      tail.unshift(item);
      if (call?.type === "function_call") tail.unshift(call);
      used += pairSize;
      index -= call?.type === "function_call" ? 1 : 0;
      continue;
    }
    if (item?.type === "function_call") continue; // handled with its output
    if (used + size > budget && tail.length > 0) break;
    tail.unshift(item);
    used += size;
  }
  return { items: tail, tokens: used, budget };
}

// Select the compactable older prefix: everything before the retained tail.
// The tail is a contiguous newest suffix, so the prefix is the items before the
// first retained one.
function selectCompactionRange({ items = [], retained = [] } = {}) {
  const keep = new Set(retained);
  let split = items.length;
  for (let index = 0; index < items.length; index += 1) {
    if (keep.has(items[index])) { split = index; break; }
  }
  // At least the newest complete turn is retained, so a price that fits inside
  // the 16 percent budget still leaves a boundedly older prefix to compact
  // rather than making compaction a silent no-op.
  const minimumRetained = newestTurnStart(items);
  // The floor applies when the budget would otherwise retain the whole
  // history, which would leave nothing to compact. The newest turn always
  // stays retained, so it never enters the compacted prefix; a prefix the
  // budget already chose is never shrunk.
  split = split === 0 ? minimumRetained : Math.min(split, minimumRetained);
  const older = items.slice(0, split);
  const range = { from: 0, to: older.length - 1, items: older, retainedFrom: split };
  range.balanced = isStructurallyBalanced(older);
  return range;
}

// The index where the newest complete user turn begins: its user message plus
// everything that followed it.
function newestTurnStart(items) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "message" && item.role === "user") return index;
  }
  return Math.max(0, items.length - 1);
}

// A range is balanced when every function call has its output and no output is
// orphaned.
function isStructurallyBalanced(items) {
  const calls = new Map();
  for (const item of items) {
    if (item?.type === "function_call") calls.set(item.call_id ?? item.id, false);
    if (item?.type === "function_call_output") {
      const key = item.call_id ?? item.id;
      if (!calls.has(key)) return false;
      calls.set(key, true);
    }
  }
  return [...calls.values()].every(Boolean);
}

// The shrink gate: a replacement is rejected when it would not actually be
// smaller than the content it replaces.
function shrinkGate({ before, after }) {
  return Number.isFinite(before) && Number.isFinite(after) && after < before;
}

// The durable bracket. `compaction/start` is appended before the provider
// request; only a complete successful bracket activates the replacement
// surface. An unmatched bracket means the transaction died.
class CompactionTransaction {
  constructor({ sessionStore, sessionId, now = () => new Date().toISOString() }) {
    this.sessionStore = sessionStore;
    this.sessionId = sessionId;
    this.now = now;
    this.record = null;
  }

  async start({ range, mode, trigger = "pressure", shadowedIds = [], estimatedBefore = 0, provider = null, model = null }) {
    this.record = {
      range: { from: range.from, to: range.to },
      mode,
      trigger,
      shadowedIds: [...shadowedIds],
      estimatedBefore,
      provider,
      model,
      startedAt: this.now(),
    };
    await this.sessionStore.append(this.sessionId, "compaction/start", this.record);
    return this.record;
  }

  async commit({ checkpoint, estimatedAfter, usage = null, providerOutput = null }) {
    if (!this.record) throw new Error("no compaction transaction is open");
    if (!shrinkGate({ before: this.record.estimatedBefore, after: estimatedAfter })) {
      await this.fail({ code: "NO_SHRINK", message: "the checkpoint was not smaller than the content it replaces" });
      return { status: "rejected", reason: "no-shrink" };
    }
    const checkpointRecord = {
      kind: "checkpoint",
      mode: this.record.mode,
      trigger: this.record.trigger,
      estimatedBefore: this.record.estimatedBefore,
      estimatedAfter,
      range: this.record.range,
      shadowedIds: this.record.shadowedIds,
      provider: this.record.provider,
      model: this.record.model,
      usage,
      // The raw provider output is transport state required for replay.
      providerOutput,
      checkpoint,
    };
    await this.sessionStore.append(this.sessionId, "compaction/checkpoint", checkpointRecord);
    await this.sessionStore.append(this.sessionId, "compaction/end", {
      ok: true,
      estimatedBefore: this.record.estimatedBefore,
      estimatedAfter,
      range: this.record.range,
      mode: this.record.mode,
    });
    const committed = this.record;
    this.record = null;
    return { status: "committed", checkpoint: checkpointRecord, record: committed };
  }

  async fail(error) {
    await this.sessionStore.append(this.sessionId, "compaction/end", {
      ok: false,
      error: error ? { code: error.code ?? "ERROR", message: error.message ?? String(error) } : null,
      range: this.record?.range ?? null,
    });
    this.record = null;
    return { status: "failed" };
  }
}

// Activate a compacted surface only from a complete successful bracket. An
// unmatched or failed bracket never shadows the prior canonical items, and an
// unmatched start is closed as an interruption whose replacement body is
// discarded, because the recorded checkpoint output is not reconstructible
// from the body alone.
function replayCompactionSurface(records = []) {
  const checkpoints = [];
  const interruptions = [];
  let open = null;
  let pending = null;
  for (const record of records) {
    if (record.kind === "compaction/start") {
      open = record;
      pending = null;
      continue;
    }
    if (record.kind === "compaction/checkpoint" && open) {
      pending = { ...record, startSeq: open.seq };
      continue;
    }
    if (record.kind === "compaction/end") {
      if (open && record.payload?.ok === true && pending) {
        checkpoints.push({ ...pending, endSeq: record.seq });
      } else if (open) {
        interruptions.push({ startSeq: open.seq, endSeq: record.seq });
      }
      open = null;
      pending = null;
      continue;
    }
  }
  const interrupted = open !== null;
  if (interrupted) interruptions.push({ startSeq: open.seq, endSeq: null });
  return {
    active: checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null,
    checkpoints,
    interruptions,
    interrupted,
  };
}

// Only an explicit unsupported answer is a capability result. A malformed or
// unauthorised request is an ordinary error, and a 5xx never proves anything
// about capability.
const UNSUPPORTED_PATTERN = /unsupported|not supported|unknown (?:parameter|endpoint|url)|does not support|unrecognized/i;

function capabilityFromResponse(status, body) {
  if (status === 404) return false;
  if (status === 400 || status === 422) {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    return UNSUPPORTED_PATTERN.test(text) ? false : null;
  }
  return null;
}

// The official capability is attempted first. Only an explicit unsupported
// answer is a capability result; transport, auth, limit, and server failures
// stay ordinary errors.
async function requestOfficialCompaction({ network, baseUrl, apiKey, body, signal = null }) {
  let response;
  try { response = await network.request({
    url: `${baseUrl}${COMPACT_ENDPOINT}`,
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  }); } catch (error) {
    return { supported: null, error: { code: error?.name === "AbortError" ? "ABORTED" : "TRANSPORT", message: "Compaction request did not finish" } };
  }
  const status = response?.status ?? null;
  const ok = typeof status === "number" && status >= 200 && status < 300;
  const capability = capabilityFromResponse(status, response?.text ?? response?.json);
  if (capability === false) return { supported: false, status };
  if (!ok) return { supported: capability, status, error: safeParse(response?.text) };
  const parsed = typeof response.json === "object" && response.json !== null ? response.json : safeParse(response.text);
  if (!Array.isArray(parsed?.output) || parsed.output.length === 0 || parsed.output.some(item => !item || typeof item.type !== "string")) {
    return { supported: null, status, error: { code: "PROTOCOL", message: "Compaction returned no valid replacement items" } };
  }
  return { supported: true, output: parsed.output, usage: parsed.usage ?? null, raw: parsed };
}

function safeParse(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Retrieve a stored Response. Only an explicit not-found answer means the turn
// cannot be recovered; any other failure is an ordinary error.
async function requestResponseRetrieval({ network, baseUrl, apiKey, responseId, signal = null }) {
  let response;
  try {
    response = await network.request({
      url: `${baseUrl}/responses/${encodeURIComponent(responseId)}`,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
  } catch (error) {
    return { status: "error", error: error?.message ?? String(error) };
  }
  const status = response?.status ?? null;
  if (status === 404) return { status: "not-found" };
  if (!(typeof status === "number" && status >= 200 && status < 300)) {
    return { status: "error", httpStatus: status };
  }
  const parsed = typeof response.json === "object" && response.json !== null ? response.json : safeParse(response.text);
  if (!parsed || typeof parsed !== "object") return { status: "error", error: "unreadable response" };
  const state = parsed.status ?? null;
  if (state === "in_progress" || state === "queued") return { status: "in_progress", raw: parsed };
  if (state === "completed" || state === "incomplete") {
    const output = Array.isArray(parsed.output) ? parsed.output : [];
    const text = output
      .filter((item) => item?.type === "message")
      .flatMap((item) => item.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    return { status: "completed", text, output, raw: parsed };
  }
  return { status: "error", error: `unrecognized response status ${state}` };
}

// Best-effort deletion of a stored response. Remote deletion failure never
// blocks local deletion; the caller warns that provider-retained data may
// remain.
async function requestResponseDeletion({ network, baseUrl, apiKey, responseId, signal = null }) {
  try {
    const response = await network.request({
      url: `${baseUrl}/responses/${encodeURIComponent(responseId)}`,
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    const status = response?.status ?? null;
    return { ok: status !== null && status >= 200 && status < 300, status };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

// Estimate the tokens a set of items occupies, for the before/after record.
function measureItems(items) {
  return estimateItems(items);
}

function measureText(text) {
  return estimateText(text);
}



// The exact preflight: OpenAI's input-token counting capability. It is a
// billed-free counting call, so it is attempted only near the configured limit
// and only once per endpoint. An unsupported answer falls back to the marked
// local estimate and lets /responses make the authoritative decision.
const INPUT_TOKENS_ENDPOINT = "/responses/input_tokens";

async function requestInputTokens({ network, baseUrl, apiKey, body, signal = null }) {
  let response;
  try {
    response = await network.request({
      url: `${baseUrl}${INPUT_TOKENS_ENDPOINT}`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    return { supported: null, error: error?.message ?? String(error) };
  }
  const status = response?.status ?? null;
  const ok = typeof status === "number" && status >= 200 && status < 300;
  const capability = capabilityFromResponse(status, response?.text ?? response?.json);
  if (capability === false) return { supported: false, status };
  if (!ok) return { supported: capability, status, error: safeParse(response?.text) };
  const parsed = typeof response.json === "object" && response.json !== null ? response.json : safeParse(response.text);
  if (Number.isFinite(parsed?.input_tokens)) {
    return { supported: true, inputTokens: parsed.input_tokens, raw: parsed };
  }
  return { supported: null, status, error: "no input_tokens in the response" };
}

module.exports = {
  FALLBACK_SUMMARY_MAX_TOKENS,
  TOOL_RESULT_CHARACTER_LIMIT,
  RETAIN_RATIO,
  COMPACT_ENDPOINT,
  INPUT_TOKENS_ENDPOINT,
  SUMMARY_SECTIONS,
  SUMMARY_PREAMBLE,
  buildSummaryInstruction,
  frameSummary,
  truncateToolResult,
  chooseRetainedTail,
  selectCompactionRange,
  newestTurnStart,
  isStructurallyBalanced,
  shrinkGate,
  CompactionTransaction,
  replayCompactionSurface,
  requestOfficialCompaction,
  requestInputTokens,
  requestResponseDeletion,
  requestResponseRetrieval,
  measureItems,
  measureText,
  safeParse,
  capabilityFromResponse,
};
