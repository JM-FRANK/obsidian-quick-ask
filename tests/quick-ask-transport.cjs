// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');

// The Quick Ask transport is pure Node-compatible CommonJS. It receives the
// `network` and `scheduler` capability slices and never reads a global fetch,
// document, or window. Every behavioral rule asserted here comes from
// .scratch/ai-sidebar-quick-ask/spec.md.
const {
  normalizeError,
  buildRequestBody,
  parseSseEvents,
  streamAttempt,
  createRetryPolicy,
  RETRYABLE_CODES,
  MAX_ATTEMPTS,
  responsesMessageText,
  responsesInputTokenCount,
} = require('../src/quick-ask/transport');

const BASE_URL = 'https://api.example.com/v1';
const RESPONSES_URL = `${BASE_URL}/responses`;
const BASE_NOW = Date.parse('2026-09-12T10:00:00.000Z');

test('Responses message text treats a malformed non-array content field as empty', () => {
  assert.equal(responsesMessageText({ type: 'message', content: 'not-blocks' }), '');
  assert.equal(responsesMessageText({ type: 'message', content: { text: 'not-a-block-list' } }), '');
  assert.equal(responsesMessageText({ type: 'message', content: [{ text: 'one' }, { text: ' two' }] }), 'one two');
});

test('the input-token endpoint count is distinct from usage vocabulary', () => {
  assert.equal(responsesInputTokenCount({ input_tokens: 42 }), 42);
  assert.equal(responsesInputTokenCount({}), undefined);
});

// --- shared fakes -----------------------------------------------------------

// A controllable clock: backoff waits are asserted instead of slept.
function makeScheduler() {
  let now = BASE_NOW;
  let nextId = 1;
  const pending = [];
  const cancelled = [];
  const fired = [];
  return {
    now: () => now,
    delay(milliseconds, callback) {
      const handle = { id: nextId++, milliseconds, callback };
      pending.push(handle);
      return handle;
    },
    cancelDelay(handle) {
      cancelled.push(handle);
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
    pending: () => pending.slice(),
    cancelled,
    fired,
    lastPending: () => pending[pending.length - 1] ?? null,
    firePending() {
      const handle = pending.shift();
      if (!handle) throw new Error('no scheduled delay to fire');
      now += handle.milliseconds;
      fired.push(handle);
      handle.callback();
      return handle;
    },
    advance(milliseconds) { now += milliseconds; },
  };
}

// A hand-rolled AbortSignal so tests own the abort moment. The module forwards
// it to an internal controller, which the fake network observes.
function makeAbortController() {
  const listeners = new Set();
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(name, listener) { if (name === 'abort') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'abort') listeners.delete(listener); },
  };
  return {
    signal,
    abort(reason) {
      if (signal.aborted) return;
      signal.aborted = true;
      signal.reason = reason;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function encode(text) {
  return new TextEncoder().encode(text);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Drive an attempt to settlement by firing each scheduled backoff on the
// injected clock instead of sleeping.
async function drain(promise, scheduler, { maxSteps = 20 } = {}) {
  let settled = false;
  let value;
  promise.then(
    (result) => { value = result; settled = true; },
    (error) => { value = { rejected: error }; settled = true; },
  );
  for (let step = 0; step < maxSteps; step += 1) {
    await tick();
    if (settled) return value;
    const handle = scheduler.lastPending();
    if (handle) scheduler.firePending();
  }
  await tick();
  if (!settled) throw new Error('the attempt did not settle within the scheduled delays');
  return value;
}

function sseFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function makeResponse({ status = 200, headers = {}, chunks = [], stream = null, body = true } = {}) {
  const headerMap = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headerMap.get(name.toLowerCase()) ?? null },
    body: body ? (stream ?? byteStream(chunks)) : null,
    async text() { return chunks.join(''); },
  };
}

async function* byteStream(chunks) {
  for (const chunk of chunks) {
    yield typeof chunk === 'string' ? encode(chunk) : chunk;
  }
}

// A stream that delivers some frames and then fails, like a dropped connection.
function failingStream(chunks, error) {
  return (async function* generate() {
    for (const chunk of chunks) yield encode(chunk);
    throw error;
  }());
}

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

// A stream that delivers its frames and then produces nothing until the
// transport aborts it, like a provider that stops sending data.
function stalledStream(chunks, signal) {
  return (async function* generate() {
    for (const chunk of chunks) yield encode(chunk);
    await new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  }());
}

// A stream the test pushes frames into, so idle-window resets are observable.
function controlledStream() {
  const queued = [];
  let wake = null;
  return {
    push(chunk) {
      queued.push(chunk);
      if (wake !== null) {
        const resolve = wake;
        wake = null;
        resolve();
      }
    },
    stream: (async function* generate() {
      for (;;) {
        if (queued.length > 0) {
          yield encode(queued.shift());
          continue;
        }
        await new Promise((resolve) => { wake = resolve; });
      }
    }()),
  };
}

// `fetchSteps` and `requestSteps` scripts: a step may be a Response-like value
// or a function returning one; an Error step means that call threw.
function makeNetwork({ fetchSteps = [], requestSteps = [] } = {}) {
  const fetchCalls = [];
  const requestCalls = [];
  async function run(steps, calls, record, args) {
    const index = calls.length;
    calls.push(record);
    const step = steps[Math.min(index, steps.length - 1)];
    if (typeof step === 'function') return step(...args, index + 1);
    if (step instanceof Error) throw step;
    return step;
  }
  return {
    fetchCalls,
    requestCalls,
    network: {
      fetch: (url, options) => run(fetchSteps, fetchCalls, { url, options }, [url, options]),
      request: (options) => run(requestSteps, requestCalls, options, [options]),
    },
  };
}

function baseAttemptOptions(overrides = {}) {
  return {
    baseUrl: BASE_URL,
    body: buildRequestBody({ instructions: 'i', input: [], model: 'gpt-5' }),
    apiKey: 'sk-test',
    scheduler: makeScheduler(),
    signal: makeAbortController().signal,
    ...overrides,
  };
}

test('buildRequestBody always includes the confirmed request fields and omits previous_response_id when absent', () => {
  const body = buildRequestBody({
    instructions: 'stable instructions',
    input: [{ role: 'user', content: 'hi' }],
    store: true,
    model: 'gpt-5',
  });
  assert.equal(body.model, 'gpt-5');
  assert.equal(body.instructions, 'stable instructions');
  assert.deepEqual(body.input, [{ role: 'user', content: 'hi' }]);
  assert.equal(body.truncation, 'disabled');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.parallel_tool_calls, true);
  assert.equal(body.store, true);
  assert.equal('previous_response_id' in body, false);
  assert.equal('tools' in body, false);
});

test('buildRequestBody carries caller-supplied tools, chaining, and store values without inventing them', () => {
  const tool = { type: 'function', name: 'get-full-file' };
  const body = buildRequestBody({
    instructions: 'i',
    input: [],
    tools: [tool],
    toolChoice: 'required',
    parallelToolCalls: false,
    previousResponseId: 'resp_123',
    store: false,
    model: 'm',
  });
  assert.deepEqual(body.tools, [tool]);
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.previous_response_id, 'resp_123');
  assert.equal(body.store, false);

  const withoutStore = buildRequestBody({ instructions: 'i', input: [], model: 'm' });
  assert.equal('store' in withoutStore, false);
  assert.equal('previous_response_id' in withoutStore, false);
});

test('normalizeError maps a thrown transport failure to TRANSPORT and keeps the original message', () => {
  assert.deepEqual(normalizeError(new TypeError('fetch failed')), {
    code: 'TRANSPORT',
    status: null,
    message: 'fetch failed',
    retryAfterMs: null,
    retryable: true,
  });
});

test('normalizeError reports abort, idle timeout, empty response, and protocol failures distinctly', () => {
  const aborted = normalizeError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  assert.deepEqual(aborted, {
    code: 'ABORTED', status: null, message: 'The operation was aborted', retryAfterMs: null, retryable: false,
  });

  const timeout = normalizeError({ kind: 'timeout', message: 'Stream idle timeout after 300000 ms' });
  assert.equal(timeout.code, 'TIMEOUT');
  assert.equal(timeout.status, null);
  assert.equal(timeout.message, 'Stream idle timeout after 300000 ms');
  assert.equal(timeout.retryable, true);

  // EMPTY_RESPONSE is a 2xx that carried no response payload at all.
  const empty = normalizeError({ kind: 'empty', status: 200 });
  assert.equal(empty.code, 'EMPTY_RESPONSE');
  assert.equal(empty.status, 200);
  assert.equal(empty.retryable, true);

  const protocol = normalizeError({
    kind: 'protocol',
    status: 200,
    message: 'The response stream ended without a terminal event',
  });
  assert.equal(protocol.code, 'PROTOCOL');
  assert.equal(protocol.message, 'The response stream ended without a terminal event');
  assert.equal(protocol.retryable, false);
});

test('normalizeError is idempotent, and the exported retry budget matches the spec', () => {
  const once = normalizeError({ kind: 'empty', status: 200 });
  assert.deepEqual(normalizeError(once), once);
  assert.deepEqual([...RETRYABLE_CODES].sort(), ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']);
  assert.equal(MAX_ATTEMPTS, 3);
});

test('normalizeError preserves provider error text from a JSON error body and classifies the HTTP status', () => {
  const rateLimited = normalizeError({
    kind: 'http',
    status: 429,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? '2' : null) },
    bodyText: JSON.stringify({
      error: { message: 'Rate limit reached for gpt-5', code: 'rate_limit_exceeded', type: 'requests' },
    }),
  });
  assert.deepEqual(rateLimited, {
    code: 'RATE_LIMIT',
    status: 429,
    message: 'Rate limit reached for gpt-5',
    retryAfterMs: 2000,
    retryable: true,
  });

  const unauthorized = normalizeError({
    kind: 'http',
    status: 403,
    bodyText: '{"error":{"message":"You do not have access to this model","code":"model_not_found"}}',
  });
  assert.deepEqual(unauthorized, {
    code: 'AUTH',
    status: 403,
    message: 'You do not have access to this model',
    retryAfterMs: null,
    retryable: false,
  });

  // 408 and 409 are explicit transient transport failures; 5xx is a server failure.
  assert.equal(normalizeError({ kind: 'http', status: 408, bodyText: '' }).code, 'TIMEOUT');
  assert.equal(normalizeError({ kind: 'http', status: 409, bodyText: '' }).code, 'TRANSPORT');
  assert.equal(normalizeError({ kind: 'http', status: 409, bodyText: '' }).retryable, true);
  assert.equal(normalizeError({ kind: 'http', status: 503, bodyText: '' }).code, 'SERVER');
  assert.equal(normalizeError({ kind: 'http', status: 503, bodyText: '' }).retryable, true);

  // An explicit request rejection is the endpoint's answer, not a transient fault.
  const rejected = normalizeError({
    kind: 'http',
    status: 400,
    bodyText: '{"error":{"message":"Unsupported parameter: store"}}',
  });
  assert.equal(rejected.code, 'PROTOCOL');
  assert.equal(rejected.message, 'Unsupported parameter: store');
  assert.equal(rejected.retryable, false);
});

test('normalizeError reads retry-after-ms, Retry-After seconds, and an HTTP date', () => {
  const now = Date.parse('2026-09-12T10:00:00.000Z');
  const headersWith = (values) => ({ get: (name) => values[name.toLowerCase()] ?? null });
  const retryAfterOf = (values) => normalizeError(
    { kind: 'http', status: 429, headers: headersWith(values), bodyText: '' },
    { now: () => now },
  ).retryAfterMs;

  assert.equal(retryAfterOf({ 'retry-after-ms': '2500' }), 2500);
  assert.equal(retryAfterOf({ 'retry-after': '12' }), 12000);
  assert.equal(retryAfterOf({ 'retry-after': new Date(now + 45000).toUTCString() }), 45000);
  // A requested wait that already elapsed is not a wait.
  assert.equal(retryAfterOf({ 'retry-after': new Date(now - 5000).toUTCString() }), null);
  // retry-after-ms wins over the seconds form, as the pinned reference does.
  assert.equal(retryAfterOf({ 'retry-after-ms': '1000', 'retry-after': '12' }), 1000);
});

test('normalizeError maps a provider-reported terminal failure without inventing a cause', () => {
  const rateLimited = normalizeError({
    kind: 'provider',
    status: 429,
    error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' },
  });
  assert.deepEqual(rateLimited, {
    code: 'RATE_LIMIT',
    status: 429,
    message: 'Rate limit reached',
    retryAfterMs: null,
    retryable: true,
  });

  const unknown = normalizeError({ kind: 'provider', error: { code: 'weird_provider_state' } });
  assert.equal(unknown.code, 'PROTOCOL');
  assert.equal(unknown.message, 'weird_provider_state');
  assert.equal(unknown.retryable, false);
});

test('the retry policy retries pre-event TRANSPORT failures with exponential backoff from 500 ms', () => {
  const policy = createRetryPolicy({ random: () => 0.5 });
  assert.equal(policy.initialDelayMs, 500);
  assert.equal(policy.maxDelayMs, 10000);
  assert.equal(policy.jitterRatio, 0.1);
  assert.equal(policy.maxAttempts, MAX_ATTEMPTS);
  assert.equal(policy.maxRetryAfterMs, 60000);

  const error = normalizeError(new TypeError('fetch failed'));
  assert.equal(policy.classify(error), 'TRANSPORT');
  assert.equal(policy.classify(new TypeError('fetch failed')), 'TRANSPORT');
  assert.deepEqual(policy.decide({ error, attempt: 1, accepted: false }), {
    retry: true, delayMs: 500, reason: 'backoff',
  });
  assert.deepEqual(policy.decide({ error, attempt: 2, accepted: false }), {
    retry: true, delayMs: 1000, reason: 'backoff',
  });
  assert.deepEqual(policy.decide({ error, attempt: 3, accepted: false }), {
    retry: false, delayMs: null, reason: 'attempts-exhausted',
  });
});

test('the retry policy never retries AUTH, PROTOCOL, or ABORTED failures', () => {
  const policy = createRetryPolicy({ random: () => 0.5 });
  const unauthorized = normalizeError({ kind: 'http', status: 401, bodyText: '' });
  assert.deepEqual(policy.decide({ error: unauthorized, attempt: 1, accepted: false }), {
    retry: false, delayMs: null, reason: 'not-retryable',
  });
  const rejected = normalizeError({ kind: 'http', status: 400, bodyText: '' });
  assert.deepEqual(policy.decide({ error: rejected, attempt: 1, accepted: false }), {
    retry: false, delayMs: null, reason: 'not-retryable',
  });
  const aborted = normalizeError({ kind: 'abort' });
  assert.deepEqual(policy.decide({ error: aborted, attempt: 1, accepted: false }), {
    retry: false, delayMs: null, reason: 'aborted',
  });
});

test('the retry policy stops permanently once any SSE event or response.created has been accepted', () => {
  const policy = createRetryPolicy({ random: () => 0.5 });
  const timeout = normalizeError({ kind: 'timeout' });
  assert.deepEqual(policy.decide({ error: timeout, attempt: 1, accepted: true }), {
    retry: false, delayMs: null, reason: 'accepted',
  });
});

test('backoff jitter stays within ten percent and the final delay never exceeds the ten second ceiling', () => {
  // A wider attempt budget isolates the backoff formula from the retry budget.
  const low = createRetryPolicy({ random: () => 0, maxAttempts: 10 });
  const high = createRetryPolicy({ random: () => 1, maxAttempts: 10 });
  const error = normalizeError(new TypeError('fetch failed'));
  assert.equal(low.decide({ error, attempt: 1, accepted: false }).delayMs, 450);
  assert.equal(high.decide({ error, attempt: 1, accepted: false }).delayMs, 550);
  assert.equal(low.decide({ error, attempt: 5, accepted: false }).delayMs, 7200);
  assert.equal(high.decide({ error, attempt: 5, accepted: false }).delayMs, 8800);
  assert.equal(low.decide({ error, attempt: 9, accepted: false }).delayMs, 9000);
  assert.equal(high.decide({ error, attempt: 9, accepted: false }).delayMs, 10000);
});

test('a provider-requested wait is honored exactly within 60 s and otherwise stops retries', () => {
  const policy = createRetryPolicy({ random: () => 0.5 });
  const withRetryAfter = (seconds) => normalizeError({
    kind: 'http',
    status: 429,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? seconds : null) },
    bodyText: '',
  });

  const withinBound = withRetryAfter('42');
  assert.deepEqual(policy.decide({ error: withinBound, attempt: 1, accepted: false }), {
    retry: true, delayMs: 42000, reason: 'retry-after',
  });

  const beyondBound = withRetryAfter('120');
  assert.equal(beyondBound.retryAfterMs, 120000);
  assert.deepEqual(policy.decide({ error: beyondBound, attempt: 1, accepted: false }), {
    retry: false, delayMs: null, reason: 'retry-after-exceeds-cap',
  });
});

test('parseSseEvents frames complete events and keeps a partial frame in rest', () => {
  const complete = parseSseEvents(
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
  );
  assert.equal(complete.events.length, 1);
  assert.equal(complete.events[0].event, 'response.created');
  assert.equal(complete.events[0].data, '{"type":"response.created","response":{"id":"resp_1"}}');
  assert.equal(complete.rest, '');

  const partial = parseSseEvents('event: response.created\ndata: {"type":"resp');
  assert.deepEqual(partial.events, []);
  assert.equal(partial.rest, 'event: response.created\ndata: {"type":"resp');

  // A data-only frame is a message frame, and multi-line data joins per the SSE spec.
  const dataOnly = parseSseEvents('data: one\ndata: two\n\n');
  assert.equal(dataOnly.events.length, 1);
  assert.equal(dataOnly.events[0].event, null);
  assert.equal(dataOnly.events[0].data, 'one\ntwo');
});

test('parseSseEvents re-feeds a frame that arrived split across chunks', () => {
  const chunks = [
    'event: response.output_text.delta\r\ndata: {"type":"response.out',
    'put_text.delta","delta":"Hel',
    'lo"}\r\n\r\n',
  ];
  let rest = '';
  const events = [];
  for (const chunk of chunks) {
    const parsed = parseSseEvents(rest + chunk);
    events.push(...parsed.events);
    rest = parsed.rest;
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'response.output_text.delta');
  assert.equal(JSON.parse(events[0].data).delta, 'Hello');
  assert.equal(rest, '');
});

test('parseSseEvents accepts a list of chunks and leaves only the trailing partial frame', () => {
  const parsed = parseSseEvents([
    'data: {"a":1}\n\n',
    'data: {"b":2}\n\n',
    'data: {"c"',
  ]);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].data, '{"a":1}');
  assert.equal(parsed.events[1].data, '{"b":2}');
  assert.equal(parsed.rest, 'data: {"c"');

  const bytes = parseSseEvents(new TextEncoder().encode('data: {"d":4}\n\n'));
  assert.equal(bytes.events.length, 1);
  assert.equal(bytes.events[0].data, '{"d":4}');
});

test('streamAttempt streams a completed response and emits normalized events in order', async () => {
  const chunks = [
    sseFrame('response.created', { type: 'response.created', response: { id: 'resp_abc', status: 'in_progress' } }),
    sseFrame('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', delta: 'Weighing options. ',
    }),
    sseFrame('response.reasoning_text.delta', { type: 'response.reasoning_text.delta', delta: 'Raw chain.' }),
    // One frame arrives split across two network chunks; the transport must
    // re-feed the partial frame instead of losing or duplicating it.
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel',
    'lo "}\n\n',
    sseFrame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'world' }),
    sseFrame('response.in_progress', {
      type: 'response.in_progress',
      response: { id: 'resp_abc', usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } },
    }),
    sseFrame('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_abc',
        status: 'completed',
        usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
      },
    }),
  ];
  const streamUsage = { input_tokens: 11, output_tokens: 3, total_tokens: 14 };
  const terminalUsage = { input_tokens: 12, output_tokens: 5, total_tokens: 17 };
  const { network, fetchCalls, requestCalls } = makeNetwork({
    fetchSteps: [makeResponse({ chunks })],
  });
  const scheduler = makeScheduler();
  const events = [];

  // The module must never reach for the host global.
  const globalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the transport read the global fetch'); };
  let result;
  try {
    result = await streamAttempt(baseAttemptOptions({
      network, scheduler, onEvent: (event) => events.push(event),
    }));
  } finally {
    globalThis.fetch = globalFetch;
  }

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, RESPONSES_URL);
  assert.equal(fetchCalls[0].options.method, 'POST');
  assert.equal(fetchCalls[0].options.headers.Authorization, 'Bearer sk-test');
  assert.match(fetchCalls[0].options.headers['Content-Type'], /^application\/json/);
  assert.equal(fetchCalls[0].options.headers.Accept, 'text/event-stream');
  const sent = JSON.parse(fetchCalls[0].options.body);
  assert.equal(sent.model, 'gpt-5');
  assert.equal(sent.stream, true);
  assert.equal(sent.truncation, 'disabled');
  assert.equal(sent.tool_choice, 'auto');
  assert.equal(sent.parallel_tool_calls, true);
  assert.equal(requestCalls.length, 0);

  assert.deepEqual(events, [
    { type: 'created', responseId: 'resp_abc' },
    { type: 'reasoning-summary-delta', delta: 'Weighing options. ' },
    { type: 'reasoning-text-delta', delta: 'Raw chain.' },
    { type: 'text-delta', delta: 'Hello ' },
    { type: 'text-delta', delta: 'world' },
    { type: 'usage', source: 'stream', usage: streamUsage },
    { type: 'usage', source: 'terminal', usage: terminalUsage },
    { type: 'terminal', status: 'completed', responseId: 'resp_abc', incompleteReason: null, output: [] },
  ]);

  assert.deepEqual(result, {
    status: 'completed',
    ok: true,
    responseId: 'resp_abc',
    text: 'Hello world',
    reasoning: 'Weighing options. Raw chain.',
    functionCalls: [],
    // A terminal response that carries no output array yields an empty list.
    output: [],
    usage: terminalUsage,
    usageSamples: [
      { source: 'stream', usage: streamUsage },
      { source: 'terminal', usage: terminalUsage },
    ],
    accepted: true,
    attempts: 1,
    nonStreaming: false,
    error: null,
  });
  // The idle watchdog is armed while the stream is live and released at the end.
  assert.deepEqual(scheduler.pending(), []);
});

const CREATED = sseFrame('response.created', {
  type: 'response.created', response: { id: 'resp_abc', status: 'in_progress' },
});
const TEXT_DELTA = sseFrame('response.output_text.delta', {
  type: 'response.output_text.delta', delta: 'Hello',
});
const COMPLETED = sseFrame('response.completed', {
  type: 'response.completed', response: { id: 'resp_abc', status: 'completed' },
});

test('a retryable pre-event HTTP failure waits the scheduled backoff and the retry can succeed', async () => {
  const { network, fetchCalls, requestCalls } = makeNetwork({
    fetchSteps: [
      makeResponse({ status: 503, chunks: ['{"error":{"message":"Service unavailable"}}'] }),
      makeResponse({ chunks: [CREATED, TEXT_DELTA, COMPLETED] }),
    ],
  });
  const scheduler = makeScheduler();
  const events = [];
  const pending = streamAttempt(baseAttemptOptions({
    network,
    scheduler,
    policy: createRetryPolicy({ random: () => 0.5 }),
    onEvent: (event) => events.push(event),
  }));

  await tick();
  assert.equal(fetchCalls.length, 1);
  // First retry waits 500 ms on the injected clock; nothing is slept for real.
  assert.equal(scheduler.lastPending().milliseconds, 500);

  const result = await drain(pending, scheduler);
  assert.equal(fetchCalls.length, 2);
  assert.equal(requestCalls.length, 0);
  assert.equal(result.status, 'completed');
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Hello');
  assert.equal(result.attempts, 2);
  assert.equal(result.nonStreaming, false);
  assert.equal(result.error, null);
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [500]);
  assert.deepEqual(scheduler.pending(), []);
  // The first attempt never produced an event, so the second attempt's events are the only ones.
  assert.deepEqual(events.map((event) => event.type), ['created', 'text-delta', 'terminal']);
});

test('retries stop after two automatic retries and the final normalized error is returned', async () => {
  const { network, fetchCalls } = makeNetwork({
    fetchSteps: [makeResponse({ status: 500, chunks: ['{"error":{"message":"Internal error"}}'] })],
  });
  const scheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    scheduler,
  );

  assert.equal(fetchCalls.length, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.error, {
    code: 'SERVER',
    status: 500,
    message: 'Internal error',
    retryAfterMs: null,
    retryable: true,
  });
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [500, 1000]);
  assert.deepEqual(scheduler.pending(), []);
});

test('a pre-event native transport failure waits the backoff and retries on the non-streaming transport', async () => {
  const { network, fetchCalls, requestCalls } = makeNetwork({
    fetchSteps: [new TypeError('fetch failed')],
    requestSteps: [{ status: 200, text: JSON.stringify(FALLBACK_PAYLOAD), headers: {} }],
  });
  const scheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    scheduler,
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(requestCalls.length, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.nonStreaming, true);
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [500]);
});

test('the fallback switch is used once and the remaining budget stays on the non-streaming transport', async () => {
  const { network, fetchCalls, requestCalls } = makeNetwork({
    fetchSteps: [new TypeError('fetch failed')],
    requestSteps: [new TypeError('requestUrl failed')],
  });
  const scheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    scheduler,
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(requestCalls.length, 2);
  assert.equal(result.attempts, 3);
  assert.equal(result.status, 'failed');
  assert.equal(result.nonStreaming, true);
  assert.equal(result.error.code, 'TRANSPORT');
  assert.equal(result.error.message, 'requestUrl failed');
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [500, 1000]);
});

test('no retry happens after response.created, and partial output is preserved as failed', async () => {
  const withText = makeNetwork({
    fetchSteps: [
      makeResponse({ stream: failingStream([CREATED, TEXT_DELTA], new TypeError('socket closed')) }),
      makeResponse({ chunks: [COMPLETED] }),
    ],
  });
  const withTextScheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network: withText.network,
      scheduler: withTextScheduler,
      policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    withTextScheduler,
  );

  assert.equal(withText.fetchCalls.length, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.accepted, true);
  assert.equal(result.text, 'Hello');
  assert.equal(result.responseId, 'resp_abc');
  assert.equal(result.error.code, 'TRANSPORT');
  assert.equal(result.error.message, 'socket closed');
  assert.deepEqual(withTextScheduler.fired, []);

  // The checkpoint is the raw event, not visible text: a failure right after
  // response.created still ends the attempt.
  const withoutText = makeNetwork({
    fetchSteps: [
      makeResponse({ stream: failingStream([CREATED], new TypeError('socket closed')) }),
      makeResponse({ chunks: [COMPLETED] }),
    ],
  });
  const withoutTextScheduler = makeScheduler();
  const bare = await drain(
    streamAttempt(baseAttemptOptions({
      network: withoutText.network,
      scheduler: withoutTextScheduler,
      policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    withoutTextScheduler,
  );
  assert.equal(withoutText.fetchCalls.length, 1);
  assert.equal(bare.accepted, true);
  assert.equal(bare.text, '');
  assert.equal(bare.status, 'failed');
  assert.deepEqual(withoutTextScheduler.fired, []);
});

test('an authentication failure is never retried and keeps the provider text', async () => {
  const { network, fetchCalls } = makeNetwork({
    fetchSteps: [
      makeResponse({
        status: 401,
        chunks: ['{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}'],
      }),
      makeResponse({ chunks: [CREATED, COMPLETED] }),
    ],
  });
  const scheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    scheduler,
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.error, {
    code: 'AUTH',
    status: 401,
    message: 'Incorrect API key provided',
    retryAfterMs: null,
    retryable: false,
  });
  assert.deepEqual(scheduler.fired, []);
});

test('a provider Retry-After is honored within 60 s and stops retries beyond it', async () => {
  const rateLimited = (seconds) => makeResponse({
    status: 429,
    headers: { 'retry-after': seconds },
    chunks: ['{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}'],
  });

  const withinBound = makeNetwork({
    fetchSteps: [rateLimited('2'), makeResponse({ chunks: [CREATED, TEXT_DELTA, COMPLETED] })],
  });
  const scheduler = makeScheduler();
  const pending = streamAttempt(baseAttemptOptions({
    network: withinBound.network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
  }));
  await tick();
  assert.equal(scheduler.lastPending().milliseconds, 2000);
  const waited = await drain(pending, scheduler);
  assert.equal(waited.status, 'completed');
  assert.equal(waited.attempts, 2);
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [2000]);

  // An HTTP-date Retry-After is measured against the injected scheduler clock.
  const dated = makeNetwork({
    fetchSteps: [
      makeResponse({
        status: 429,
        headers: { 'retry-after': new Date(BASE_NOW + 30000).toUTCString() },
        chunks: ['{"error":{"message":"Rate limit reached"}}'],
      }),
      makeResponse({ chunks: [CREATED, TEXT_DELTA, COMPLETED] }),
    ],
  });
  const datedScheduler = makeScheduler();
  const datedPending = streamAttempt(baseAttemptOptions({
    network: dated.network, scheduler: datedScheduler, policy: createRetryPolicy({ random: () => 0.5 }),
  }));
  await tick();
  assert.equal(datedScheduler.lastPending().milliseconds, 30000);
  assert.equal((await drain(datedPending, datedScheduler)).status, 'completed');

  const beyondBound = makeNetwork({ fetchSteps: [rateLimited('120')] });
  const schedulerBeyond = makeScheduler();
  const stopped = await drain(
    streamAttempt(baseAttemptOptions({ network: beyondBound.network, scheduler: schedulerBeyond })),
    schedulerBeyond,
  );
  assert.equal(beyondBound.fetchCalls.length, 1);
  assert.equal(stopped.status, 'failed');
  assert.deepEqual(stopped.error, {
    code: 'RATE_LIMIT',
    status: 429,
    message: 'Rate limit reached',
    retryAfterMs: 120000,
    retryable: true,
  });
  assert.deepEqual(schedulerBeyond.fired, []);
});

test('a stream that produces no data for five minutes is a TIMEOUT, retried when pre-event', async () => {
  const { network, fetchCalls } = makeNetwork({
    fetchSteps: [
      (url, options) => makeResponse({ stream: stalledStream([], options.signal) }),
      makeResponse({ chunks: [CREATED, TEXT_DELTA, COMPLETED] }),
    ],
  });
  const scheduler = makeScheduler();
  const pending = streamAttempt(baseAttemptOptions({
    network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
  }));

  await tick();
  // Five minutes is the default idle window, not a setting.
  assert.equal(scheduler.lastPending().milliseconds, 300000);
  scheduler.firePending();
  const result = await drain(pending, scheduler);

  assert.equal(result.status, 'completed');
  assert.equal(result.attempts, 2);
  assert.equal(fetchCalls.length, 2);
  // The idle watchdog aborted the stalled stream.
  assert.equal(fetchCalls[0].options.signal.aborted, true);
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [300000, 500]);
  assert.deepEqual(scheduler.pending(), []);
});

test('the idle window resets on any received data', async () => {
  const controlled = controlledStream();
  const { network } = makeNetwork({ fetchSteps: [makeResponse({ stream: controlled.stream })] });
  const scheduler = makeScheduler();
  const pending = streamAttempt(baseAttemptOptions({ network, scheduler }));

  await tick();
  const firstWatch = scheduler.lastPending();
  assert.equal(firstWatch.milliseconds, 300000);

  controlled.push(CREATED);
  await tick();
  const secondWatch = scheduler.lastPending();
  assert.notEqual(secondWatch, firstWatch);
  assert.equal(scheduler.cancelled.includes(firstWatch), true);
  assert.equal(secondWatch.milliseconds, 300000);

  controlled.push(TEXT_DELTA);
  controlled.push(COMPLETED);
  const result = await drain(pending, scheduler);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Hello');
  assert.deepEqual(scheduler.fired, []);
  assert.deepEqual(scheduler.pending(), []);
});

test('an accepted stream that goes idle fails as TIMEOUT without retrying', async () => {
  const { network, fetchCalls } = makeNetwork({
    fetchSteps: [
      (url, options) => makeResponse({ stream: stalledStream([CREATED, TEXT_DELTA], options.signal) }),
      makeResponse({ chunks: [COMPLETED] }),
    ],
  });
  const scheduler = makeScheduler();
  const pending = streamAttempt(baseAttemptOptions({
    network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
  }));
  await tick();
  scheduler.firePending();
  const result = await drain(pending, scheduler);

  assert.equal(fetchCalls.length, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.accepted, true);
  assert.equal(result.text, 'Hello');
  assert.equal(result.responseId, 'resp_abc');
  assert.deepEqual(result.error, {
    code: 'TIMEOUT',
    status: null,
    message: 'Stream idle timeout after 300000 ms',
    retryAfterMs: null,
    retryable: true,
  });
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [300000]);
});

test('the idle window is an option with a five-minute default', async () => {
  const controlled = controlledStream();
  const { network } = makeNetwork({ fetchSteps: [makeResponse({ stream: controlled.stream })] });
  const scheduler = makeScheduler();
  const pending = streamAttempt(baseAttemptOptions({ network, scheduler, idleTimeoutMs: 1000 }));
  await tick();
  assert.equal(scheduler.lastPending().milliseconds, 1000);
  controlled.push(COMPLETED);
  const result = await drain(pending, scheduler);
  assert.equal(result.status, 'completed');
});

test('an aborted turn returns ABORTED promptly, keeps partial output, and never retries', async () => {
  // Aborting before the first attempt starts spends no request at all.
  const preAborted = makeAbortController();
  preAborted.abort();
  const idle = makeNetwork({ fetchSteps: [makeResponse({ chunks: [COMPLETED] })] });
  const idleScheduler = makeScheduler();
  const immediate = await streamAttempt(baseAttemptOptions({
    network: idle.network, scheduler: idleScheduler, signal: preAborted.signal,
  }));
  assert.equal(idle.fetchCalls.length, 0);
  assert.equal(immediate.status, 'aborted');
  assert.deepEqual(immediate.error, {
    code: 'ABORTED',
    status: null,
    message: 'The request was aborted',
    retryAfterMs: null,
    retryable: false,
  });

  // Aborting mid-stream stops the attempt at once, keeps what already arrived,
  // and never schedules a retry.
  const mid = makeNetwork({
    fetchSteps: [
      (url, options) => makeResponse({ stream: stalledStream([CREATED, TEXT_DELTA], options.signal) }),
      makeResponse({ chunks: [CREATED, COMPLETED] }),
    ],
  });
  const scheduler = makeScheduler();
  const controller = makeAbortController();
  const pending = streamAttempt(baseAttemptOptions({
    network: mid.network,
    scheduler,
    signal: controller.signal,
    policy: createRetryPolicy({ random: () => 0.5 }),
  }));
  await tick();
  assert.equal(scheduler.lastPending().milliseconds, 300000);
  controller.abort();
  const result = await pending;

  assert.equal(mid.fetchCalls.length, 1);
  assert.equal(result.status, 'aborted');
  assert.equal(result.ok, false);
  assert.equal(result.accepted, true);
  assert.equal(result.text, 'Hello');
  assert.equal(result.responseId, 'resp_abc');
  assert.equal(result.error.code, 'ABORTED');
  assert.equal(result.error.retryable, false);
  assert.deepEqual(scheduler.fired, []);
  assert.deepEqual(scheduler.pending(), []);
  assert.equal(controller.listenerCount(), 0);
});

const FALLBACK_PAYLOAD = {
  id: 'resp_fallback',
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Considered.' }] },
    { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Fallback answer' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get-full-file', arguments: '{"path":"a.md"}' },
  ],
  usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
};

test('a pre-event native transport failure falls back to the non-streaming transport within the budget', async () => {
  const { network, fetchCalls, requestCalls } = makeNetwork({
    fetchSteps: [new TypeError('fetch failed')],
    requestSteps: [{ status: 200, text: JSON.stringify(FALLBACK_PAYLOAD), headers: {} }],
  });
  const scheduler = makeScheduler();
  const events = [];
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network,
      scheduler,
      policy: createRetryPolicy({ random: () => 0.5 }),
      onEvent: (event) => events.push(event),
    })),
    scheduler,
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(requestCalls.length, 1);
  assert.equal(requestCalls[0].url, RESPONSES_URL);
  assert.equal(requestCalls[0].method, 'POST');
  assert.equal(requestCalls[0].headers.Authorization, 'Bearer sk-test');
  // The non-streaming call does not ask the endpoint for a stream.
  assert.equal('stream' in JSON.parse(requestCalls[0].body), false);

  assert.equal(result.status, 'completed');
  assert.equal(result.accepted, true);
  assert.equal(result.attempts, 2);
  // The caller marks this endpoint non-streaming for the rest of the lifecycle.
  assert.equal(result.nonStreaming, true);
  assert.equal(result.responseId, 'resp_fallback');
  assert.equal(result.text, 'Fallback answer');
  assert.equal(result.reasoning, 'Considered.');
  assert.deepEqual(result.functionCalls, [
    { id: 'fc_1', callId: 'call_1', name: 'get-full-file', arguments: '{"path":"a.md"}' },
  ]);
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
  assert.deepEqual(result.usageSamples, [
    { source: 'terminal', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    'created', 'reasoning-summary-delta', 'text-delta', 'function-call', 'usage', 'terminal',
  ]);
  // The non-streaming path supplies the same canonical items for local replay.
  assert.deepEqual(events[events.length - 1].output, FALLBACK_PAYLOAD.output);
  assert.deepEqual(scheduler.fired.map((handle) => handle.milliseconds), [500]);
});

test('a caller-marked non-streaming endpoint never touches native fetch', async () => {
  const { network, fetchCalls, requestCalls } = makeNetwork({
    fetchSteps: [new TypeError('fetch must not be reached for a marked endpoint')],
    requestSteps: [{ status: 200, text: JSON.stringify(FALLBACK_PAYLOAD), headers: {} }],
  });
  const scheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({ network, scheduler, nonStreaming: true })),
    scheduler,
  );

  assert.equal(fetchCalls.length, 0);
  assert.equal(requestCalls.length, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.nonStreaming, true);
  assert.equal(result.text, 'Fallback answer');
});

test('the non-streaming path normalizes its own HTTP and transport failures', async () => {
  const rejected = makeNetwork({
    requestSteps: [{ status: 401, text: '{"error":{"message":"Incorrect API key provided"}}', headers: {} }],
  });
  const scheduler = makeScheduler();
  const unauthorized = await drain(
    streamAttempt(baseAttemptOptions({
      network: rejected.network, scheduler, nonStreaming: true, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    scheduler,
  );
  assert.equal(unauthorized.status, 'failed');
  assert.equal(unauthorized.nonStreaming, true);
  assert.deepEqual(unauthorized.error, {
    code: 'AUTH',
    status: 401,
    message: 'Incorrect API key provided',
    retryAfterMs: null,
    retryable: false,
  });

  const offline = makeNetwork({ requestSteps: [new TypeError('requestUrl failed')] });
  const offlineScheduler = makeScheduler();
  const failed = await drain(
    streamAttempt(baseAttemptOptions({
      network: offline.network,
      scheduler: offlineScheduler,
      nonStreaming: true,
      policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    offlineScheduler,
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'TRANSPORT');
  assert.equal(failed.error.message, 'requestUrl failed');
  assert.deepEqual(offlineScheduler.fired.map((handle) => handle.milliseconds), [500, 1000]);
});

test('a 2xx response with no response payload is EMPTY_RESPONSE and is retried before any event', async () => {
  const { network, fetchCalls } = makeNetwork({
    fetchSteps: [makeResponse({ status: 200, chunks: [] }), makeResponse({ chunks: [CREATED, TEXT_DELTA, COMPLETED] })],
  });
  const scheduler = makeScheduler();
  const recovered = await drain(
    streamAttempt(baseAttemptOptions({
      network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    scheduler,
  );
  assert.equal(fetchCalls.length, 2);
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.attempts, 2);

  // Exhausted, the failure keeps the HTTP status and the empty-response class.
  const alwaysEmpty = makeNetwork({ fetchSteps: [makeResponse({ status: 200, chunks: [] })] });
  const schedulerEmpty = makeScheduler();
  const failed = await drain(
    streamAttempt(baseAttemptOptions({
      network: alwaysEmpty.network, scheduler: schedulerEmpty, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    schedulerEmpty,
  );
  assert.equal(alwaysEmpty.fetchCalls.length, 3);
  assert.deepEqual(failed.error, {
    code: 'EMPTY_RESPONSE',
    status: 200,
    message: 'The endpoint returned no response payload',
    retryAfterMs: null,
    retryable: true,
  });

  // A 2xx with no body at all is the same class.
  const withoutBody = makeNetwork({ fetchSteps: [makeResponse({ status: 200, body: false })] });
  const schedulerNoBody = makeScheduler();
  const noBody = await drain(
    streamAttempt(baseAttemptOptions({
      network: withoutBody.network, scheduler: schedulerNoBody, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    schedulerNoBody,
  );
  assert.equal(noBody.error.code, 'EMPTY_RESPONSE');
  assert.equal(noBody.error.status, 200);
});

test('a UTF-8 character split across two chunks is decoded exactly once', async () => {
  const prefix = encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"');
  const tail = encode('你好"}\n\n');
  // Cut the three-byte 你 in half, mid-character.
  const { network } = makeNetwork({
    fetchSteps: [makeResponse({ body: true, stream: byteStream([prefix, tail.slice(0, 1), tail.slice(1)]) })],
  });
  const result = await drain(
    streamAttempt(baseAttemptOptions({ network, scheduler: makeScheduler() })),
    makeScheduler(),
  );
  assert.equal(result.text, '你好');
});

test('function-call arguments stream as deltas and complete as one call', async () => {
  const chunks = [
    sseFrame('response.created', { type: 'response.created', response: { id: 'resp_tools' } }),
    sseFrame('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get-full-file', arguments: '' },
    }),
    sseFrame('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":',
    }),
    sseFrame('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"notes/a.md"}',
    }),
    sseFrame('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'get-full-file', arguments: '{"path":"notes/a.md"}',
      },
    }),
    COMPLETED,
  ];
  const { network } = makeNetwork({ fetchSteps: [makeResponse({ chunks })] });
  const scheduler = makeScheduler();
  const events = [];
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network,
      scheduler,
      onEvent: (event) => events.push(event),
    })),
    scheduler,
  );

  assert.deepEqual(events, [
    { type: 'created', responseId: 'resp_tools' },
    { type: 'function-call-delta', itemId: 'fc_1', delta: '{"path":' },
    { type: 'function-call-delta', itemId: 'fc_1', delta: '"notes/a.md"}' },
    {
      type: 'function-call',
      call: { id: 'fc_1', callId: 'call_1', name: 'get-full-file', arguments: '{"path":"notes/a.md"}' },
    },
    { type: 'terminal', status: 'completed', responseId: 'resp_abc', incompleteReason: null, output: [] },
  ]);
  assert.deepEqual(result.functionCalls, [
    { id: 'fc_1', callId: 'call_1', name: 'get-full-file', arguments: '{"path":"notes/a.md"}' },
  ]);

  // An endpoint that only sends the arguments-done event still completes the call once.
  const doneOnly = makeNetwork({
    fetchSteps: [makeResponse({
      chunks: [
        sseFrame('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done', item_id: 'fc_9', output_index: 0, arguments: '{"path":"x.md"}',
        }),
        sseFrame('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'fc_9', type: 'function_call', call_id: 'call_9', name: 'get-full-file', arguments: '{"path":"x.md"}' },
        }),
      ],
    })],
  });
  const doneOnlyEvents = [];
  const doneOnlyResult = await drain(
    streamAttempt(baseAttemptOptions({
      network: doneOnly.network, scheduler: makeScheduler(), onEvent: (event) => doneOnlyEvents.push(event),
    })),
    makeScheduler(),
  );
  assert.deepEqual(doneOnlyResult.functionCalls, [
    { id: 'fc_9', callId: 'call_9', name: 'get-full-file', arguments: '{"path":"x.md"}' },
  ]);
  assert.deepEqual(doneOnlyEvents.filter((event) => event.type === 'function-call'), [{
    type: 'function-call',
    call: { id: 'fc_9', callId: 'call_9', name: 'get-full-file', arguments: '{"path":"x.md"}' },
  }]);
});

test('a terminal response.failed reports the provider error and preserves partial output', async () => {
  const failedFrame = sseFrame('response.failed', {
    type: 'response.failed',
    response: { id: 'resp_abc', status: 'failed', error: { code: 'server_error', message: 'The model failed' } },
  });
  const { network, fetchCalls } = makeNetwork({
    fetchSteps: [makeResponse({ chunks: [CREATED, TEXT_DELTA, failedFrame] })],
  });
  const scheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({
      network, scheduler, policy: createRetryPolicy({ random: () => 0.5 }),
    })),
    scheduler,
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.accepted, true);
  assert.equal(result.text, 'Hello');
  assert.deepEqual(result.error, {
    code: 'SERVER',
    status: null,
    message: 'The model failed',
    retryAfterMs: null,
    retryable: true,
  });
});

test('the terminal event carries the canonical output items for local replay', async () => {
  const items = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-state' },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
  ];
  const { network } = makeNetwork({
    fetchSteps: [makeResponse({
      chunks: [
        sseFrame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: items[0] }),
        sseFrame('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: items[1] }),
        sseFrame('response.completed', {
          type: 'response.completed',
          response: { id: 'resp_canon', status: 'completed', output: items },
        }),
      ],
    })],
  });
  const events = [];
  await drain(
    streamAttempt(baseAttemptOptions({ network, scheduler: makeScheduler(), onEvent: (event) => events.push(event) })),
    makeScheduler(),
  );

  assert.deepEqual(events[events.length - 1], {
    type: 'terminal',
    status: 'completed',
    responseId: 'resp_canon',
    incompleteReason: null,
    output: items,
  });
});

test('an incomplete terminal state keeps its reason and commits the partial answer', async () => {
  const incomplete = sseFrame('response.incomplete', {
    type: 'response.incomplete',
    response: {
      id: 'resp_abc',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 3, output_tokens: 9, total_tokens: 12 },
    },
  });
  const { network } = makeNetwork({ fetchSteps: [makeResponse({ chunks: [CREATED, TEXT_DELTA, incomplete] })] });
  const events = [];
  const scheduler = makeScheduler();
  const result = await drain(
    streamAttempt(baseAttemptOptions({ network, scheduler, onEvent: (event) => events.push(event) })),
    scheduler,
  );

  assert.equal(result.status, 'incomplete');
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.text, 'Hello');
  assert.deepEqual(events[events.length - 1], {
    type: 'terminal',
    status: 'incomplete',
    responseId: 'resp_abc',
    incompleteReason: 'max_output_tokens',
    output: [],
  });
});

test('a provider context-window overflow is labelled for recovery, not as a generic 4xx', () => {
  const overflow = normalizeError({
    kind: 'http',
    status: 400,
    bodyText: JSON.stringify({ error: { code: 'context_length_exceeded', message: 'This model maximum context length is 128000 tokens' } }),
  });
  assert.equal(overflow.code, 'CONTEXT_OVERFLOW');
  assert.equal(overflow.status, 400);
  assert.equal(overflow.retryable, false, 'the transport does not retry it; compaction is what changes the outcome');

  const ordinary = normalizeError({ kind: 'http', status: 400, bodyText: 'invalid request' });
  assert.equal(ordinary.code, 'PROTOCOL', 'an ordinary 400 is not treated as an overflow');

  const provider = normalizeError({
    kind: 'provider',
    status: 400,
    error: { code: 'context_length_exceeded', message: 'too long' },
  });
  assert.equal(provider.code, 'CONTEXT_OVERFLOW');
});

test('a completed attempt returns its canonical output items verbatim', async () => {
  const output = [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get-full-file', arguments: '{"path":"a.md"}' },
  ];
  const events = [
    { type: 'response.created', data: { response: { id: 'resp_1' } } },
    { type: 'response.completed', data: { response: { id: 'resp_1', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join('');
  const result = await streamAttempt({
    network: {
      fetch: async () => ({
        ok: true, status: 200, headers: { get: () => null },
        body: (async function* stream() { yield new TextEncoder().encode(body); })(),
      }),
    },
    scheduler: { now: () => 0, delay: (ms, cb) => setTimeout(cb, ms), cancelDelay: clearTimeout },
    baseUrl: 'https://api.openai.com/v1',
    body: { model: 'gpt-5' },
    apiKey: 'sk',
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, output, 'the caller can persist the exact protocol shapes');
});

test('a normalized error round-trips instead of degrading to a transport failure', () => {
  // Re-normalizing a labelled failure must keep its code: the retry policy and
  // the conversation both normalize more than once, and a silent downgrade
  // would hide the recovery path.
  const overflow = normalizeError({
    kind: 'http', status: 400,
    bodyText: JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }),
  });
  assert.equal(overflow.code, 'CONTEXT_OVERFLOW');
  assert.equal(overflow.retryable, false);
  assert.equal(normalizeError(overflow).code, 'CONTEXT_OVERFLOW', 'the code survives a second pass');
  assert.equal(normalizeError(normalizeError(overflow)).code, 'CONTEXT_OVERFLOW');
  for (const code of ['AUTH', 'RATE_LIMIT', 'TIMEOUT', 'SERVER', 'TRANSPORT', 'EMPTY_RESPONSE', 'PROTOCOL', 'ABORTED', 'CONTEXT_OVERFLOW']) {
    const once = normalizeError({ kind: 'http', status: 500, bodyText: code });
    assert.equal(normalizeError({ ...once, code }).code, code, `${code} round-trips`);
  }
});

test('the retry policy never spends its budget on a non-retryable failure', () => {
  const policy = createRetryPolicy();
  const overflow = normalizeError({
    kind: 'http', status: 400,
    bodyText: JSON.stringify({ error: { code: 'context_length_exceeded' } }),
  });
  assert.deepEqual(policy.decide({ error: overflow, attempt: 1, accepted: false }),
    { retry: false, delayMs: null, reason: 'not-retryable' });
  // The confirmed transient classes still retry.
  for (const code of ['TRANSPORT', 'RATE_LIMIT', 'TIMEOUT', 'SERVER', 'EMPTY_RESPONSE']) {
    assert.equal(policy.decide({ error: { code, retryable: true, message: 'x' }, attempt: 1 }).retry, true, `${code} retries`);
  }
  assert.equal(policy.decide({ error: normalizeError({ kind: 'http', status: 401, bodyText: 'bad' }), attempt: 1 }).retry, false,
    'AUTH never retries');
});

// The shell owns retrying, framing, abort and failure classification. Which
// protocol it is talking to arrives as an adapter, so the shell must not name,
// import or branch on any protocol itself; that knowledge lives in
// src/quick-ask/protocol.js.
test('the transport shell carries no protocol knowledge of its own', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/quick-ask/transport.js'), 'utf8');
  assert.equal(source.includes('chat-completions'), false, 'the shell names no protocol');
  assert.equal(/require\(["']\.\/chat-completions["']\)/.test(source), false, 'the shell imports no protocol adapter');
});

test('an attempt refuses anything that is not a protocol adapter', async () => {
  const result = await streamAttempt(baseAttemptOptions({ protocol: 'chat-completions' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'PROTOCOL');
  assert.equal(result.attempts, 0, 'a bad adapter spends no attempt');
});
