// Quick Ask transport: the Responses API request body, SSE framing, normalized
// failure classification, the bounded retry policy, and one streaming attempt.
//
// The module is pure Node-compatible CommonJS. It never requires `obsidian`,
// never reads the global `fetch`, and never touches `document` or `window`: the
// caller injects the `network` and `scheduler` capability slices built by
// src/quick-ask/environment.js. The API key is resolved by the caller and used
// only to build a request header; it is never stored here.
//
// Vocabulary follows the confirmed streaming lifecycle in
// .scratch/ai-sidebar-quick-ask/spec.md: one "attempt" is one request/stream
// cycle; the retry budget is shared across both native fetch and the
// non-streaming requestUrl fallback.

const { createParser } = require("eventsource-parser");

// At most two automatic retries after the first attempt, so at most three
// attempts total.
const MAX_ATTEMPTS = 3;

// The retryable failure classes. AUTH, PROTOCOL, and ABORTED are deliberately
// absent: authentication failure is never retried, a protocol failure is the
// endpoint's explicit answer, and an aborted turn is the user's decision.
const RETRYABLE_CODES = Object.freeze([
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

// Deadlines that belong to this module rather than to a setting.
const INITIAL_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
const JITTER_RATIO = 0.1;
const MAX_RETRY_AFTER_MS = 60_000;
// A stream that produces no data for five minutes is a TIMEOUT. The idle window
// is not a setting.
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

const TERMINAL_EVENT_TYPES = new Set(["response.completed", "response.incomplete", "response.failed"]);

// Build the JSON body for POST {baseUrl}/responses. The caller owns policy:
// this function only refuses to invent chaining state. `truncation`,
// `tool_choice`, and `parallel_tool_calls` are always present because the spec
// pins them on every ordinary Responses request.
function buildRequestBody({
  instructions,
  input,
  tools,
  toolChoice,
  parallelToolCalls,
  previousResponseId,
  store,
  model,
  maxOutputTokens,
} = {}) {
  const body = {
    model,
    instructions,
    input,
    tool_choice: toolChoice ?? "auto",
    parallel_tool_calls: parallelToolCalls ?? true,
    truncation: "disabled",
  };
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;
  if (typeof store === "boolean") body.store = store;
  if (typeof previousResponseId === "string" && previousResponseId.length > 0) {
    body.previous_response_id = previousResponseId;
  }
  // The fallback summarizer requests its fixed output cap; an ordinary turn
  // does not send the field at all.
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) {
    body.max_output_tokens = maxOutputTokens;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Failure normalization
// ---------------------------------------------------------------------------

// Neutral fallbacks used only when neither the provider nor the thrown error
// supplied any text. They describe the transport fact, never a diagnosed cause.
const FALLBACK_MESSAGES = Object.freeze({
  AUTH: "The endpoint rejected the credential",
  RATE_LIMIT: "The endpoint rate limited the request",
  TIMEOUT: "The request timed out",
  SERVER: "The endpoint reported a server error",
  TRANSPORT: "Transport failure",
  EMPTY_RESPONSE: "The endpoint returned no response payload",
  PROTOCOL: "The endpoint returned an unexpected response",
  // A provider context-window overflow is labelled so the caller can compact
  // and retry it; it is never a retryable transport class.
  CONTEXT_OVERFLOW: "The request exceeded the context window",
  ABORTED: "The request was aborted",
});

function isNormalizedError(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.code === "string"
    && Object.hasOwn(FALLBACK_MESSAGES, value.code)
    && typeof value.message === "string";
}

function isAbortError(error) {
  if (error === null || typeof error !== "object") return false;
  return error.kind === "abort" || error.name === "AbortError" || error.code === "ABORT_ERR";
}

function errorMessage(error, fallback) {
  if (typeof error === "string" && error.length > 0) return error;
  if (error !== null && typeof error === "object" && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return fallback;
}

function statusOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Every failure leaves this module in one stable shape. `retryable` describes
// the failure class; the acceptance checkpoint and the attempt budget are
// decided by the retry policy, which knows the attempt's history.
function createFailure(code, { status = null, message, retryAfterMs = null } = {}) {
  return {
    code,
    status: statusOrNull(status),
    message: typeof message === "string" && message.length > 0 ? message : FALLBACK_MESSAGES[code],
    retryAfterMs: typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : null,
    retryable: RETRYABLE_CODES.includes(code),
  };
}

// A Response-like object and Obsidian's requestUrl header record must both be
// readable, because native fetch and the non-streaming fallback use different
// header shapes.
function getHeader(headers, name) {
  if (headers === null || headers === undefined) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value : null;
  }
  if (typeof headers !== "object") return null;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (typeof value === "string") return value;
    return value === null || value === undefined ? null : String(value);
  }
  return null;
}

// Honor retry-after-ms first, then Retry-After in seconds or as an HTTP date.
// The 60 s cap belongs to the retry policy: this function only reports what the
// provider asked for, and reports nothing when the asked-for wait already passed.
function parseRetryAfterMs(headers, now) {
  const milliseconds = getHeader(headers, "retry-after-ms");
  if (milliseconds !== null && /^\d+(\.\d+)?$/.test(milliseconds.trim())) {
    const value = Number.parseFloat(milliseconds);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const raw = getHeader(headers, "retry-after");
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const millisecondsFromSeconds = Number.parseFloat(value) * 1000;
    return Number.isFinite(millisecondsFromSeconds) && millisecondsFromSeconds > 0
      ? millisecondsFromSeconds
      : null;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const wait = at - now();
  return wait > 0 ? wait : null;
}

// The provider's own error payload, kept verbatim. `error` may be nested under
// `error` or be the top-level object, matching the shapes OpenAI-compatible
// endpoints actually return.
function parseProviderError(bodyText) {
  if (typeof bodyText !== "string" || bodyText.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const source = parsed.error !== null && typeof parsed.error === "object" ? parsed.error : parsed;
  const message = typeof source.message === "string" && source.message.length > 0 ? source.message : null;
  const code = typeof source.code === "string" && source.code.length > 0
    ? source.code
    : (typeof source.type === "string" && source.type.length > 0 ? source.type : null);
  if (message === null && code === null) return null;
  return { message, code };
}

function providerErrorDetail(error) {
  if (error === null || typeof error !== "object") return { message: null, code: null };
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : null;
  const code = typeof error.code === "string" && error.code.length > 0
    ? error.code
    : (typeof error.type === "string" && error.type.length > 0 ? error.type : null);
  return { message, code };
}

// The spec's retryable HTTP classes: 408, 409, 429, and 5xx. Everything else is
// the endpoint's explicit answer. Authentication is never retried.
function httpErrorCode(status) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 408) return "TIMEOUT";
  if (status === 409) return "TRANSPORT";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "SERVER";
  return "PROTOCOL";
}

// A terminal `response.failed` or top-level `error` event carries the provider's
// own code. The mapping only names a class; the provider's message is preserved.
function providerFailureCode(error, status) {
  if (typeof status === "number" && Number.isFinite(status) && status >= 400) return httpErrorCode(status);
  const { code } = providerErrorDetail(error);
  const detail = typeof code === "string" ? code.toLowerCase() : "";
  if (/rate.?limit|too.?many.?requests/.test(detail)) return "RATE_LIMIT";
  if (/auth|api.?key|unauthorized|forbidden|permission/.test(detail)) return "AUTH";
  if (/timeout|timed.?out/.test(detail)) return "TIMEOUT";
  if (/server|internal|overload|unavailable/.test(detail)) return "SERVER";
  if (/empty/.test(detail)) return "EMPTY_RESPONSE";
  return "PROTOCOL";
}

// Provider overflow wording is the one failure Quick Ask can act on by
// compacting; every other class stays an ordinary error.
const OVERFLOW_PATTERN = /context[_ ]length|context window|maximum context|too many tokens|too long/i;

function isContextOverflow({ code, status, message, bodyText } = {}) {
  if (code === "CONTEXT_OVERFLOW") return true;
  if (status !== 400 && status !== 413 && status !== 422) return false;
  return OVERFLOW_PATTERN.test(String(message ?? "")) || OVERFLOW_PATTERN.test(String(bodyText ?? ""));
}

function normalizeError(error, { now = () => Date.now() } = {}) {
  if (isNormalizedError(error)) return { ...error };
  if (isAbortError(error)) {
    return createFailure("ABORTED", { message: errorMessage(error, FALLBACK_MESSAGES.ABORTED) });
  }
  const kind = error !== null && typeof error === "object" ? error.kind : null;
  if (kind === "timeout") {
    return createFailure("TIMEOUT", { message: errorMessage(error, FALLBACK_MESSAGES.TIMEOUT) });
  }
  if (kind === "empty") {
    return createFailure("EMPTY_RESPONSE", {
      status: error.status,
      message: errorMessage(error, FALLBACK_MESSAGES.EMPTY_RESPONSE),
    });
  }
  if (kind === "protocol") {
    return createFailure("PROTOCOL", {
      status: error.status,
      message: errorMessage(error, FALLBACK_MESSAGES.PROTOCOL),
    });
  }
  if (kind === "http") {
    const providerError = parseProviderError(error.bodyText);
    const providerMessage = providerError?.message ?? providerError?.code ?? null;
    const rawText = typeof error.bodyText === "string" ? error.bodyText.trim() : "";
    // A provider context-window overflow is the one 4xx Quick Ask can recover
    // from by compacting, so it is labelled instead of being a generic 4xx.
    if (isContextOverflow({ status: error.status, message: providerMessage, bodyText: error.bodyText })) {
      return createFailure("CONTEXT_OVERFLOW", {
        status: error.status,
        message: providerMessage ?? rawText.slice(0, 500) ?? FALLBACK_MESSAGES.PROTOCOL,
      });
    }
    const message = providerMessage
      ?? (rawText.length > 0 ? rawText.slice(0, 500) : errorMessage(error, FALLBACK_MESSAGES[httpErrorCode(error.status)]));
    return createFailure(httpErrorCode(error.status), {
      status: error.status,
      message,
      retryAfterMs: parseRetryAfterMs(error.headers, now),
    });
  }
  if (kind === "provider") {
    const detail = providerErrorDetail(error.error);
    const message = detail.message ?? detail.code ?? null;
    if (isContextOverflow({ status: error.status, message, bodyText: error.bodyText })) {
      return createFailure("CONTEXT_OVERFLOW", { status: error.status, message: message ?? FALLBACK_MESSAGES.PROTOCOL });
    }
    const code = providerFailureCode(error.error, error.status);
    return createFailure(code, {
      status: error.status,
      message,
      retryAfterMs: parseRetryAfterMs(error.headers, now),
    });
  }
  if (kind === "transport") {
    return createFailure("TRANSPORT", { message: errorMessage(error, FALLBACK_MESSAGES.TRANSPORT) });
  }
  return createFailure("TRANSPORT", { message: errorMessage(error, FALLBACK_MESSAGES.TRANSPORT) });
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

// One policy governs both transports. Its defaults are the confirmed ones:
// two automatic retries after the first attempt, 500 ms exponential backoff
// with 10 percent jitter under a 10 s local ceiling, and a 60 s cap on a
// provider-requested wait.
function createRetryPolicy(overrides = {}) {
  const initialDelayMs = overrides.initialDelayMs ?? INITIAL_DELAY_MS;
  const maxDelayMs = overrides.maxDelayMs ?? MAX_DELAY_MS;
  const jitterRatio = overrides.jitterRatio ?? JITTER_RATIO;
  const maxAttempts = overrides.maxAttempts ?? MAX_ATTEMPTS;
  const retryableCodes = overrides.retryableCodes ?? [...RETRYABLE_CODES];
  const maxRetryAfterMs = overrides.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
  const random = typeof overrides.random === "function" ? overrides.random : Math.random;

  function classify(error) {
    if (typeof error === "string") return error;
    return normalizeError(error).code;
  }

  function backoffDelay(attempt) {
    const exponent = Math.min(Math.max(attempt - 1, 0), 30);
    const exponential = Math.min(initialDelayMs * 2 ** exponent, maxDelayMs);
    const jitter = 1 - jitterRatio + 2 * jitterRatio * random();
    return Math.min(exponential * jitter, maxDelayMs);
  }

  // `attempt` is the number of attempts already made, so the first failure is
  // attempt 1. `accepted` is the acceptance checkpoint: once any SSE event or
  // response.created has arrived, no automatic retry may happen, because the
  // endpoint already took responsibility for the turn.
  function decide({ error, attempt = 1, accepted = false } = {}) {
    if (accepted === true) return { retry: false, delayMs: null, reason: "accepted" };
    const normalized = normalizeError(error);
    if (normalized.code === "ABORTED") return { retry: false, delayMs: null, reason: "aborted" };
    // The proven retryable classes are transport, rate limit, timeout, server,
    // and empty response. A failure the normalizer marked non-retryable, such as
    // a provider context-window overflow, must not consume the budget: repeating
    // it cannot succeed, and the caller has a recovery path of its own.
    if (normalized.retryable !== true || !retryableCodes.includes(normalized.code)) {
      return { retry: false, delayMs: null, reason: "not-retryable" };
    }
    if (attempt >= maxAttempts) {
      return { retry: false, delayMs: null, reason: "attempts-exhausted" };
    }
    const requested = normalized.retryAfterMs;
    if (requested !== null) {
      if (requested > maxRetryAfterMs) {
        return { retry: false, delayMs: null, reason: "retry-after-exceeds-cap" };
      }
      return { retry: true, delayMs: requested, reason: "retry-after" };
    }
    return { retry: true, delayMs: backoffDelay(attempt), reason: "backoff" };
  }

  return Object.freeze({
    initialDelayMs,
    maxDelayMs,
    jitterRatio,
    maxAttempts,
    retryableCodes: Object.freeze([...retryableCodes]),
    maxRetryAfterMs,
    classify,
    decide,
  });
}

// ---------------------------------------------------------------------------
// SSE framing
// ---------------------------------------------------------------------------

// Frame fields, event boundaries, BOM handling, and CRLF rules belong to the
// pinned eventsource-parser. This module only has to know where the trailing
// partial frame begins so the caller can re-feed it with the next chunk; the
// parser's own API keeps that leftover private.
//
// A frame ends at a blank line. The scan below returns the offset just past the
// last blank line, treating a lone trailing CR as possibly the first half of a
// CRLF that spans two chunks.
function frameTailStart(text) {
  let lineStart = 0;
  let restStart = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "\n") {
      if (index === lineStart) restStart = index + 1;
      lineStart = index + 1;
      index += 1;
      continue;
    }
    if (char === "\r") {
      if (index === text.length - 1) break;
      const next = text[index + 1] === "\n" ? index + 2 : index + 1;
      if (index === lineStart) restStart = next;
      lineStart = next;
      index = next;
      continue;
    }
    index += 1;
  }
  return restStart;
}

// The text decoder is a host capability: the network slice supplies it, and a
// host without the global still works because a string chunk needs no decoding.
// The abort controller comes from the network capability; a host without the
// global still gets a controller that aborts its own signal.
function createAbortController(network) {
  const Controller = network?.AbortController ?? (typeof AbortController === "function" ? AbortController : null);
  if (Controller) return new Controller();
  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  return {
    signal,
    abort() {
      if (signal.aborted) return;
      signal.aborted = true;
      for (const listener of listeners) listener();
    },
  };
}

function createTextDecoder(network) {
  const Decoder = network?.TextDecoder ?? (typeof TextDecoder === "function" ? TextDecoder : null);
  return Decoder ? new Decoder() : null;
}

function decodeChunk(decoder, chunk) {
  if (typeof chunk === "string") return chunk;
  if (decoder === null) return String(chunk);
  return decoder.decode(chunk, { stream: true });
}

function decodeChunks(chunks, decoder = createTextDecoder(null)) {
  let text = "";
  for (const chunk of chunks) {
    if (chunk === null || chunk === undefined) continue;
    text += decodeChunk(decoder, chunk);
  }
  return text;
}

// Incremental framing: feed the unconsumed `rest` back in with the next chunk.
function parseSseEvents(chunksOrText) {
  const text = Array.isArray(chunksOrText) ? decodeChunks(chunksOrText) : decodeChunks([chunksOrText]);
  const restStart = frameTailStart(text);
  const events = [];
  if (restStart > 0) {
    const parser = createParser({
      onEvent(message) {
        events.push({ event: message.event ?? null, id: message.id ?? null, data: message.data });
      },
    });
    parser.feed(text.slice(0, restStart));
  }
  return { events, rest: text.slice(restStart) };
}

// ---------------------------------------------------------------------------
// Streaming attempt
// ---------------------------------------------------------------------------

// The scheduler slice owns time. A missing or partial slice falls back to the
// host clock rather than failing the attempt.
function attemptClock(scheduler) {
  return () => (typeof scheduler?.now === "function" ? scheduler.now() : Date.now());
}

function isOkResponse(response) {
  if (response === null || typeof response !== "object") return false;
  if (typeof response.ok === "boolean") return response.ok;
  return typeof response.status === "number" && response.status >= 200 && response.status < 300;
}

function emptyAttemptState() {
  return {
    accepted: false,
    responseId: null,
    text: "",
    reasoning: "",
    usage: null,
    terminalUsage: null,
    usageSamples: [],
    calls: new Map(),
    callOrder: [],
    terminal: null,
    terminalError: null,
  };
}

function indexKey(outputIndex) {
  return `index:${outputIndex}`;
}

function callRecordFor(state, key, outputIndex) {
  const existing = (key !== null && state.calls.get(key))
    ?? (typeof outputIndex === "number" ? state.calls.get(indexKey(outputIndex)) : undefined);
  if (existing) return existing;
  const record = { id: null, callId: null, name: null, arguments: "", emitted: false };
  state.callOrder.push(record);
  if (key !== null) state.calls.set(key, record);
  if (typeof outputIndex === "number") state.calls.set(indexKey(outputIndex), record);
  return record;
}

function finalizeCall(record, emit) {
  if (record.emitted) return;
  record.emitted = true;
  emit({
    type: "function-call",
    call: { id: record.id, callId: record.callId, name: record.name, arguments: record.arguments },
  });
}

function emitUsage(state, payload, source, emit) {
  const usage = payload !== null && typeof payload === "object"
    ? (payload.response !== null && typeof payload.response === "object" && payload.response.usage
      ? payload.response.usage
      : payload.usage)
    : null;
  if (usage === null || typeof usage !== "object") return;
  const sample = { source, usage };
  state.usageSamples.push(sample);
  if (source === "terminal") state.terminalUsage = usage;
  else state.usage = usage;
  emit({ type: "usage", source, usage });
}

// Normalize one framed Responses event into the transport's event vocabulary.
// Unknown events still count as the acceptance checkpoint; they simply emit
// nothing.
function handleFrame(frame, state, emit) {
  let payload = null;
  if (typeof frame.data === "string" && frame.data.length > 0) {
    try {
      payload = JSON.parse(frame.data);
    } catch {
      payload = null;
    }
  }
  const declared = typeof frame.event === "string" && frame.event.length > 0 ? frame.event : null;
  const type = declared ?? (payload !== null && typeof payload.type === "string" ? payload.type : null);
  if (type === null) return;

  if (TERMINAL_EVENT_TYPES.has(type)) {
    for (const record of state.callOrder) finalizeCall(record, emit);
    emitUsage(state, payload, "terminal", emit);
    const response = payload !== null && typeof payload.response === "object" ? payload.response : null;
    if (response !== null && typeof response.id === "string" && response.id.length > 0) {
      state.responseId = response.id;
    }
    const output = response !== null && Array.isArray(response.output) ? response.output : [];
    // Keep the canonical items on the attempt state so the caller can persist
    // them for local replay and tool continuations.
    state.terminalOutput = output;
    if (type === "response.completed") {
      state.terminal = {
        type: "terminal", status: "completed", responseId: state.responseId, incompleteReason: null, output,
      };
    } else if (type === "response.incomplete") {
      const reason = response?.incomplete_details?.reason;
      state.terminal = {
        type: "terminal",
        status: "incomplete",
        responseId: state.responseId,
        incompleteReason: typeof reason === "string" && reason.length > 0 ? reason : null,
        output,
      };
    } else {
      state.terminalError = normalizeError({
        kind: "provider",
        error: response?.error ?? payload?.error ?? payload,
      });
      state.terminal = {
        type: "terminal", status: "failed", responseId: state.responseId, incompleteReason: null, output,
      };
    }
    emit(state.terminal);
    return;
  }

  if (type === "error") {
    for (const record of state.callOrder) finalizeCall(record, emit);
    state.terminalError = normalizeError({
      kind: "provider",
      error: payload !== null && typeof payload.error === "object" && payload.error !== null
        ? payload.error
        : payload,
    });
    state.terminal = {
      type: "terminal", status: "failed", responseId: state.responseId, incompleteReason: null, output: [],
    };
    emit(state.terminal);
    return;
  }

  emitUsage(state, payload, "stream", emit);

  switch (type) {
    case "response.created": {
      const responseId = payload?.response?.id;
      if (typeof responseId === "string" && responseId.length > 0) {
        state.responseId = responseId;
        emit({ type: "created", responseId });
      } else {
        emit({ type: "created", responseId: null });
      }
      break;
    }
    case "response.output_text.delta": {
      const delta = payload?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        state.text += delta;
        emit({ type: "text-delta", delta });
      }
      break;
    }
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_summary.delta": {
      const delta = payload?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        state.reasoning += delta;
        emit({ type: "reasoning-summary-delta", delta });
      }
      break;
    }
    case "response.reasoning_text.delta": {
      const delta = payload?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        state.reasoning += delta;
        emit({ type: "reasoning-text-delta", delta });
      }
      break;
    }
    case "response.output_item.added": {
      const item = payload?.item;
      if (item !== null && typeof item === "object" && item.type === "function_call") {
        const record = callRecordFor(state, item.id ?? null, payload?.output_index);
        record.id = item.id ?? record.id;
        record.callId = item.call_id ?? record.callId;
        record.name = item.name ?? record.name;
        if (typeof item.arguments === "string" && item.arguments.length > 0) record.arguments = item.arguments;
      }
      break;
    }
    case "response.function_call_arguments.delta": {
      const itemId = typeof payload?.item_id === "string" && payload.item_id.length > 0 ? payload.item_id : null;
      const record = callRecordFor(state, itemId, payload?.output_index);
      record.id = record.id ?? itemId;
      const delta = typeof payload?.delta === "string" ? payload.delta : "";
      record.arguments += delta;
      emit({ type: "function-call-delta", itemId: record.id, delta });
      break;
    }
    case "response.function_call_arguments.done": {
      const itemId = typeof payload?.item_id === "string" && payload.item_id.length > 0 ? payload.item_id : null;
      const record = callRecordFor(state, itemId, payload?.output_index);
      record.id = record.id ?? itemId;
      if (typeof payload?.arguments === "string" && payload.arguments.length > 0) record.arguments = payload.arguments;
      // Completion itself is announced by output_item.done or the terminal
      // event, so an endpoint that sends the done item afterwards can still
      // supply the function name and call id.
      break;
    }
    case "response.output_item.done": {
      const item = payload?.item;
      if (item !== null && typeof item === "object" && item.type === "function_call") {
        const record = callRecordFor(state, item.id ?? null, payload?.output_index);
        record.id = item.id ?? record.id;
        record.callId = item.call_id ?? record.callId;
        record.name = item.name ?? record.name;
        if (typeof item.arguments === "string" && item.arguments.length > 0) record.arguments = item.arguments;
        finalizeCall(record, emit);
      }
      break;
    }
    default:
      break;
  }
}

// The idle window is five minutes by default and resets on any received data.
// It is local transport state, never a setting.
function createIdleWatchdog({ scheduler, idleTimeoutMs, onFire }) {
  const enabled = typeof idleTimeoutMs === "number" && idleTimeoutMs > 0;
  let handle = null;
  let armed = false;
  function clear() {
    if (!armed) return;
    armed = false;
    scheduler.cancelDelay(handle);
    handle = null;
  }
  function arm() {
    if (!enabled) return;
    clear();
    armed = true;
    handle = scheduler.delay(idleTimeoutMs, () => {
      armed = false;
      handle = null;
      onFire();
    });
  }
  return { arm, clear, touch: arm };
}

// An abort is the user's decision, so nothing is retried. Partial output that
// already streamed is preserved: a stopped turn commits what the user saw.
function abortedAttempt(attempts, nonStreaming, state = emptyAttemptState()) {
  return attemptResultFrom(state, {
    status: "aborted",
    error: normalizeError({ kind: "abort" }),
    attempts,
    nonStreaming,
  });
}

function attemptResultFrom(state, { status, error, attempts, nonStreaming }) {
  return {
    status,
    ok: status === "completed" || status === "incomplete",
    responseId: state.responseId,
    text: state.text,
    reasoning: state.reasoning,
    functionCalls: state.callOrder
      .filter((record) => record.emitted)
      .map((record) => ({
        id: record.id,
        callId: record.callId,
        name: record.name,
        arguments: record.arguments,
      })),
    // The endpoint's canonical output items, kept verbatim (including opaque
    // reasoning items) so local replay and tool continuations have the real
    // protocol shapes.
    output: state.terminalOutput ?? null,
    usage: state.terminalUsage ?? state.usage,
    usageSamples: state.usageSamples,
    accepted: state.accepted,
    attempts,
    nonStreaming,
    error: error ?? null,
  };
}

async function runStreamAttempt({
  network,
  scheduler,
  url,
  apiKey,
  body,
  signal,
  onEvent,
  idleTimeoutMs,
  attempts,
}) {
  const state = emptyAttemptState();
  // The abort controller is a host global; a test context may not provide one.
  const controller = typeof AbortController === "function"
    ? new AbortController()
    : { signal: { aborted: false }, abort() { this.signal.aborted = true; } };
  let callerAborted = false;
  let idleTimedOut = false;

  function onCallerAbort() {
    callerAborted = true;
    controller.abort(signal.reason);
  }
  if (signal !== null && signal !== undefined && signal.addEventListener) {
    signal.addEventListener("abort", onCallerAbort);
  }
  const watchdog = createIdleWatchdog({
    scheduler,
    idleTimeoutMs,
    onFire() {
      idleTimedOut = true;
      controller.abort();
    },
  });

  function idleTimeoutFailure() {
    return normalizeError({
      kind: "timeout",
      message: `Stream idle timeout after ${idleTimeoutMs} ms`,
    });
  }

  function release() {
    watchdog.clear();
    if (signal !== null && signal !== undefined && signal.removeEventListener) {
      signal.removeEventListener("abort", onCallerAbort);
    }
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };

  watchdog.arm();
  let response;
  try {
    response = await network.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal: controller.signal,
    });
  } catch (error) {
    release();
    if (callerAborted) return abortedAttempt(attempts, false);
    if (idleTimedOut) return failedAttempt(state, idleTimeoutFailure(), attempts, false);
    return failedAttempt(state, normalizeError(error), attempts, false);
  }

  if (!isOkResponse(response)) {
    let bodyText = "";
    try {
      bodyText = typeof response.text === "function" ? await response.text() : "";
    } catch {
      bodyText = "";
    }
    release();
    if (callerAborted) return abortedAttempt(attempts, false);
    if (idleTimedOut) return failedAttempt(state, idleTimeoutFailure(), attempts, false);
    return failedAttempt(state, normalizeError({
      kind: "http",
      status: response.status,
      headers: response.headers,
      bodyText,
    }, { now: attemptClock(scheduler) }), attempts, false);
  }

  const httpStatus = typeof response.status === "number" ? response.status : null;
  if (response.body === null || response.body === undefined) {
    release();
    return failedAttempt(state, normalizeError({ kind: "empty", status: httpStatus }), attempts, false);
  }

  const decoder = createTextDecoder(network);
  let buffer = "";
  let failure = null;
  try {
    for await (const chunk of response.body) {
      watchdog.touch();
      const text = decodeChunk(decoder, chunk);
      if (text.length === 0) continue;
      buffer += text;
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.events) {
        state.accepted = true;
        handleFrame(frame, state, onEvent);
      }
      if (state.terminal !== null) break;
    }
  } catch (error) {
    if (callerAborted) {
      release();
      return abortedAttempt(attempts, false, state);
    }
    if (idleTimedOut) {
      release();
      return failedAttempt(state, idleTimeoutFailure(), attempts, false);
    }
    failure = normalizeError(error);
  }
  release();

  if (callerAborted) return abortedAttempt(attempts, false, state);
  if (failure !== null) return failedAttempt(state, failure, attempts, false);
  if (state.terminal !== null) {
    if (state.terminal.status === "failed") {
      return failedAttempt(state, state.terminalError ?? normalizeError({ kind: "protocol", status: httpStatus }), attempts, false);
    }
    return attemptResultFrom(state, {
      status: state.terminal.status,
      attempts,
      nonStreaming: false,
    });
  }
  if (!state.accepted) {
    return failedAttempt(state, normalizeError({ kind: "empty", status: httpStatus }), attempts, false);
  }
  return failedAttempt(state, normalizeError({
    kind: "protocol",
    status: httpStatus,
    message: "The response stream ended without a terminal event",
  }), attempts, false);
}

function failedAttempt(state, error, attempts, nonStreaming) {
  return attemptResultFrom(state, {
    status: "failed",
    error: normalizeError(error),
    attempts,
    nonStreaming,
  });
}

// Non-streaming transport: Obsidian's requestUrl returns the complete Responses
// payload, so the same normalized events are derived from the finished response.
function derivedEventsFromResponse(payload, state, emit) {
  state.accepted = true;
  const responseId = typeof payload.id === "string" && payload.id.length > 0 ? payload.id : null;
  state.responseId = responseId;
  emit({ type: "created", responseId });

  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (item === null || typeof item !== "object") continue;
    if (item.type === "reasoning") {
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
      if (summary.length > 0) {
        state.reasoning += summary;
        emit({ type: "reasoning-summary-delta", delta: summary });
      }
      const content = Array.isArray(item.content)
        ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
      if (content.length > 0) {
        state.reasoning += content;
        emit({ type: "reasoning-text-delta", delta: content });
      }
    } else if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        const text = typeof part?.text === "string" ? part.text : "";
        if (text.length > 0 && (part.type === "output_text" || part.type === "text")) {
          state.text += text;
          emit({ type: "text-delta", delta: text });
        }
      }
    } else if (item.type === "function_call") {
      const record = callRecordFor(state, typeof item.id === "string" ? item.id : null, undefined);
      record.id = typeof item.id === "string" ? item.id : record.id;
      record.callId = typeof item.call_id === "string" ? item.call_id : record.callId;
      record.name = typeof item.name === "string" ? item.name : record.name;
      record.arguments = typeof item.arguments === "string" ? item.arguments : record.arguments;
      finalizeCall(record, emit);
    }
  }

  emitUsage(state, { response: { usage: payload.usage } }, "terminal", emit);

  const status = typeof payload.status === "string" ? payload.status : "completed";
  if (status === "failed" || (payload.error !== null && typeof payload.error === "object")) {
    state.terminalError = normalizeError({ kind: "provider", error: payload.error });
    state.terminal = { type: "terminal", status: "failed", responseId, incompleteReason: null, output };
    emit(state.terminal);
    return;
  }
  const reason = payload.incomplete_details?.reason;
  state.terminal = {
    type: "terminal",
    status: status === "incomplete" ? "incomplete" : "completed",
    responseId,
    incompleteReason: typeof reason === "string" && reason.length > 0 ? reason : null,
    output,
  };
  emit(state.terminal);
}

async function runRequestAttempt({ network, scheduler, url, apiKey, body, signal, onEvent, attempts }) {
  const state = emptyAttemptState();
  const requestBody = { ...body };
  delete requestBody.stream;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  let response;
  try {
    response = await network.request({
      url,
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    if (signal !== null && signal !== undefined && signal.aborted) return abortedAttempt(attempts, true);
    return failedAttempt(state, normalizeError(error), attempts, true);
  }
  if (signal !== null && signal !== undefined && signal.aborted) return abortedAttempt(attempts, true);

  const status = typeof response?.status === "number" ? response.status : null;
  if (!(status !== null && status >= 200 && status < 300)) {
    return failedAttempt(state, normalizeError({
      kind: "http",
      status,
      headers: response?.headers,
      bodyText: typeof response?.text === "string" ? response.text : "",
    }, { now: attemptClock(scheduler) }), attempts, true);
  }

  let payload = null;
  try {
    payload = response?.json;
  } catch {
    payload = null;
  }
  if (payload === null || typeof payload !== "object") {
    try {
      payload = JSON.parse(typeof response?.text === "string" ? response.text : "");
    } catch {
      payload = null;
    }
  }
  if (payload === null || typeof payload !== "object") {
    return failedAttempt(state, normalizeError({ kind: "empty", status }), attempts, true);
  }

  derivedEventsFromResponse(payload, state, onEvent);
  if (state.terminal !== null && state.terminal.status === "failed") {
    return failedAttempt(state, state.terminalError, attempts, true);
  }
  return attemptResultFrom(state, { status: state.terminal.status, attempts, nonStreaming: true });
}

// An abortable wait: the injected scheduler owns the timer, and an abort during
// the wait settles it immediately so a stopped turn never hangs on backoff.
function waitForDelay(scheduler, signal, milliseconds) {
  return new Promise((resolve) => {
    if (signal !== null && signal !== undefined && signal.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      if (signal !== null && signal !== undefined && signal.removeEventListener) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(value);
    }
    function onAbort() {
      scheduler.cancelDelay(handle);
      finish(false);
    }
    const handle = scheduler.delay(milliseconds, () => finish(true));
    if (signal !== null && signal !== undefined && signal.addEventListener) {
      signal.addEventListener("abort", onAbort);
    }
  });
}

// One turn is one or more attempts. Automatic retries happen only before the
// acceptance checkpoint: as soon as any SSE event or response.created arrives,
// the endpoint owns the turn and no retry may duplicate it.
async function streamAttempt(options = {}) {
  const {
    network,
    scheduler,
    baseUrl,
    body,
    apiKey,
    signal = null,
    onEvent = () => {},
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    policy = createRetryPolicy(),
    nonStreaming = false,
  } = options;
  const url = `${baseUrl}/responses`;
  // A caller-marked endpoint starts on the non-streaming transport. A pre-event
  // native transport failure switches to it once, and the caller marks the
  // endpoint for the rest of the plugin lifecycle from the result.
  let useRequestTransport = nonStreaming === true;
  let attempt = 0;

  for (;;) {
    if (signal !== null && signal !== undefined && signal.aborted) {
      return abortedAttempt(Math.max(attempt, 1), useRequestTransport);
    }
    attempt += 1;
    // A retry always starts a fresh attempt with a fresh response buffer.
    const result = useRequestTransport
      ? await runRequestAttempt({
        network, scheduler, url, apiKey, body, signal, onEvent, attempts: attempt,
      })
      : await runStreamAttempt({
        network,
        scheduler,
        url,
        apiKey,
        body,
        signal,
        onEvent,
        idleTimeoutMs,
        attempts: attempt,
      });
    if (result.ok || result.status === "aborted" || attempt >= MAX_ATTEMPTS) return result;
    const decision = policy.decide({ error: result.error, attempt, accepted: result.accepted });
    if (!decision.retry) return result;
    if (decision.delayMs > 0) {
      const waited = await waitForDelay(scheduler, signal, decision.delayMs);
      if (!waited) return abortedAttempt(attempt, useRequestTransport);
    }
    if (!useRequestTransport && result.accepted !== true && result.error.code === "TRANSPORT") {
      useRequestTransport = true;
    }
  }
}

module.exports = {
  normalizeError,
  isContextOverflow,
  buildRequestBody,
  parseSseEvents,
  streamAttempt,
  createRetryPolicy,
  createAbortController,
  RETRYABLE_CODES,
  MAX_ATTEMPTS,
};