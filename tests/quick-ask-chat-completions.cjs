// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamAttempt } = require('../src/quick-ask/transport');
const { protocolFor } = require('../src/quick-ask/protocol');
// The transport shell takes a protocol adapter, not a protocol name.
const CHAT = protocolFor({ protocol: 'chat-completions' });
const { sessionConfigSnapshot, validateQuickAskSettings } = require('../src/quick-ask/settings');
const scheduler = { now: Date.now, delay: (ms, fn) => setTimeout(fn, ms), cancelDelay: clearTimeout };
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null) => ({ id: 'cc1', choices: [{ index: 0, delta, finish_reason }] });

test('explicit Chat Completions streams native messages and terminal usage through the shared transport', async () => {
  const requests = [], events = [];
  const result = await streamAttempt({ protocol: CHAT, baseUrl: 'https://example.test/v1',
    body: { model: 'test', messages: [{ role: 'user', content: 'Hello' }] }, apiKey: 'fixture', scheduler,
    network: { fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return {
      status: 200, body: (async function* () {
        yield frame(chunk({ role: 'assistant', content: '' }));
        yield frame(chunk({ content: 'Hello 🌍' }));
        yield frame(chunk({}, 'stop'));
        yield frame({ id: 'cc1', choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
        yield frame('[DONE]');
      })(),
    }; } }, onEvent: e => events.push(e),
  });
  assert.equal(requests[0].url, 'https://example.test/v1/chat/completions');
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, [{ role: 'assistant', content: 'Hello 🌍' }]);
  assert.equal(result.usage.prompt_tokens, 12);
  assert.equal(events.filter(e => e.type === 'created').length, 1);
  assert.equal(events.find(e => e.type === 'text-delta').delta, 'Hello 🌍');
});

test('protocol defaults, snapshots and validation never select a different protocol implicitly', () => {
  assert.equal(sessionConfigSnapshot({}).protocol, 'responses');
  assert.equal(sessionConfigSnapshot({ protocol: 'chat-completions' }).protocol, 'chat-completions');
  assert.equal(validateQuickAskSettings({ protocol: 'unknown' }).errors.protocol, 'protocol');
  assert.equal(validateQuickAskSettings({ baseUrl: 'https://example.test/chat/completions' }).errors.baseUrl, 'baseUrlResponses');
});

const { estimateItem, createTurnUsage } = require('../src/quick-ask/tokens');
const { isStructurallyBalanced, selectCompactionRange } = require('../src/quick-ask/compaction');
test('native nested tools count toward context and compaction never separates a call batch', () => {
  const call = { role: 'assistant', content: null, tool_calls: [
    { id: 'a', type: 'function', function: { name: 'get-full-file', arguments: 'x'.repeat(4000) } },
    { id: 'b', type: 'function', function: { name: 'get-full-file', arguments: '{}' } },
  ] };
  const a = { role: 'tool', tool_call_id: 'a', content: 'file one' };
  const b = { role: 'tool', tool_call_id: 'b', content: 'file two' };
  assert.ok(estimateItem(call) >= 1000);
  assert.equal(isStructurallyBalanced([call, a]), false);
  assert.equal(isStructurallyBalanced([call, a, b]), true);
  const items = [{ role: 'user', content: 'q' }, call, a, b, { role: 'user', content: 'next' }];
  const range = selectCompactionRange({ items, retained: [b, items[4]] });
  assert.equal(range.balanced, true);
  assert.ok(range.retainedFrom <= 1);
  const usage = createTurnUsage();
  usage.record({ source: 'terminal', usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17,
    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 } } });
  assert.deepEqual(usage.totals(), { attempts: 1, input: 12, output: 5, total: 17, cachedInput: 4, reasoning: 2 });
});

async function attemptFrames(frames, extra = {}) {
  const requests = [];
  const result = await streamAttempt({ protocol: CHAT, baseUrl: 'https://example.test/v1',
    body: { model: 'test', messages: [] }, apiKey: 'fixture', scheduler,
    network: { fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) });
      return { status: 200, body: (async function* () { for (const value of frames) yield frame(value); })() };
    } }, ...extra,
  });
  return { result, requests };
}

test('fragmented tool arguments are reconstructed once in native Chat Completions output', async () => {
  const { result } = await attemptFrames([
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"qu' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'ery":"obsidian"}' } }] }),
    chunk({}, 'tool_calls'), '[DONE]',
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(result.functionCalls[0].arguments, '{"query":"obsidian"}');
  assert.deepEqual(result.output, [{ role: 'assistant', content: null, tool_calls: [
    { id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":"obsidian"}' } },
  ] }]);
});

test('truncated, malformed and wrong-protocol streams fail without automatic resubmission', async () => {
  for (const frames of [ [chunk({ content: 'partial' })], [chunk({ content: 'partial' }), '[DONE]'], [{ type: 'response.created', response: { id: 'wrong' } }], ['not JSON'] ]) {
    const { result, requests } = await attemptFrames(frames);
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'PROTOCOL'); assert.equal(requests.length, 1);
  }
  const { result } = await attemptFrames([chunk({ content: 'partial' }), chunk({}, 'length'), '[DONE]']);
  assert.equal(result.status, 'incomplete'); assert.equal(result.text, 'partial');
});

test('Chat Completions non-streaming fallback preserves native payload and never probes Responses', async () => {
  const requested = [];
  const message = { role: 'assistant', content: 'fallback' };
  const { result } = await attemptFrames([], { nonStreaming: true, network: { request: async options => {
    requested.push(options); return { status: 200, json: { id: 'cc', choices: [{ index: 0, message, finish_reason: 'stop' }] } };
  } } });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.output, [message]);
  assert.equal(requested[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(JSON.parse(requested[0].body).stream_options, undefined);
});

test('exports preserve the protocol and native history without raw credentials', () => {
  const { buildExport, parseExport } = require('../src/quick-ask/portability');
  const records = [{ kind: 'item/output', payload: { item: { role: 'assistant', content: 'answer' } } }];
  const exported = buildExport({ settings: { protocol: 'responses' }, sessions: [{ id: 'cc', header: { config: { protocol: 'chat-completions', secretId: 'key-id', apiKey: 'private-fixture' } }, records }] });
  const restored = parseExport(JSON.stringify(exported)).export.sessions[0];
  assert.equal(restored.header.config.protocol, 'chat-completions');
  assert.deepEqual(restored.records, records);
  assert.equal(JSON.stringify(exported).includes('private-fixture'), false);
});

test('cancel preserves streamed Chat Completions text and never retries the accepted request', async () => {
  const controller = new AbortController();
  const { result, requests } = await attemptFrames([chunk({ content: 'partial' })], {
    signal: controller.signal,
    onEvent: event => { if (event.type === 'text-delta') controller.abort(); },
  });
  assert.equal(result.status, 'aborted'); assert.equal(result.text, 'partial'); assert.equal(requests.length, 1);
});

test('Chat Completions pre-event fetch failure uses the same endpoint in requestUrl fallback', async () => {
  const urls = [];
  const { result } = await attemptFrames([], {
    policy: require('../src/quick-ask/transport').createRetryPolicy({ initialDelayMs: 0 }),
    network: {
      fetch: async url => { urls.push(url); throw new Error('offline fetch fixture'); },
      request: async ({ url }) => { urls.push(url); return { status: 200, json: {
        id: 'fallback', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      } }; },
    },
  });
  assert.equal(result.status, 'completed'); assert.equal(result.nonStreaming, true);
  assert.deepEqual(urls, ['https://example.test/v1/chat/completions', 'https://example.test/v1/chat/completions']);
});

test('refusal-only replies preserve native refusal and provide readable original text', async () => {
  const { result } = await attemptFrames([chunk({ role: 'assistant', refusal: 'Cannot help.' }), chunk({}, 'stop'), '[DONE]']);
  assert.equal(result.text, 'Cannot help.');
  assert.deepEqual(result.output, [{ role: 'assistant', content: null, refusal: 'Cannot help.' }]);
  assert.equal(require('../src/quick-ask/protocol').messageText(result.output[0]), 'Cannot help.');
});

test('CC readable reasoning is displayed and preserved in native history', async () => {
  const { result } = await attemptFrames([chunk({ role: 'assistant', reasoning_content: 'Think ' }), chunk({ reasoning_content: 'carefully.' }), chunk({ content: 'Answer' }), chunk({}, 'stop'), '[DONE]']);
  assert.equal(result.reasoning, 'Think carefully.');
  assert.equal(result.text, 'Answer');
  assert.equal(result.output[0].reasoning_content, 'Think carefully.');
});

test('CC reasoning alias and partial reasoning are kept separately from answer text', async () => {
  const { result } = await attemptFrames([chunk({ role: 'assistant', reasoning: 'Visible thought' })]);
  assert.equal(result.status, 'failed');
  assert.equal(result.reasoning, 'Visible thought');
  assert.equal(result.text, '');
  assert.equal(result.output[0].reasoning, 'Visible thought');
  const fallback = await attemptFrames([], { nonStreaming: true, network: { request: async () => ({ status: 200, json: {
    id: 'c', choices: [{ index: 0, message: { role: 'assistant', content: 'Answer', reasoning_content: 'Reason' }, finish_reason: 'stop' }],
  } }) } });
  assert.equal(fallback.result.reasoning, 'Reason');
});

test('reasoning effort labels cycle through five shared protocol levels', () => {
  const { REASONING_LEVELS, nextReasoningEffort } = require('../src/quick-ask/reasoning');
  assert.deepEqual(Object.values(REASONING_LEVELS), ['Off', 'Low', 'High', 'XHigh', 'Max']);
  let level = 'none';
  const sequence = [];
  for (let index = 0; index < 5; index++) { sequence.push(level); level = nextReasoningEffort(level); }
  assert.deepEqual(sequence, ['none', 'low', 'high', 'xhigh', 'max']);
  assert.equal(level, 'none');
  for (const effort of sequence) {
    const cc = require('../src/quick-ask/chat-completions').buildRequestBody({ reasoningEffort: effort });
    const responses = require('../src/quick-ask/transport').buildRequestBody({ reasoningEffort: effort });
    assert.equal(cc.reasoning_effort, effort);
    assert.equal(responses.reasoning.effort, effort);
    assert.equal(responses.reasoning.summary, effort === 'none' ? undefined : 'auto');
  }
});

test('older CC nonstreaming history recovers readable reasoning already present in native items', () => {
  const { conversationFromRecords } = require('../src/quick-ask/conversation-messages');
  const messages = conversationFromRecords([
    { kind: 'turn/started', payload: {} },
    { kind: 'item/output', payload: { item: { role: 'assistant', content: 'Answer', reasoning_content: 'Saved thought' } } },
    { kind: 'turn/finished', payload: { text: 'Answer', reasoning: '' } },
  ]);
  assert.equal(messages[0].reasoning, 'Saved thought');
});

test('CC rejection or cancellation before the first frame has no fabricated partial output', async () => {
  for (const mode of ['auth', 'abort', 'wrong-protocol']) {
    const controller = new AbortController();
    const result = await streamAttempt({ protocol: CHAT, baseUrl: 'https://example.test/v1',
      body: { messages: [] }, apiKey: 'fixture', scheduler, signal: controller.signal,
      network: { fetch: async () => mode === 'auth' ? { status: 401, text: async () => 'Unauthorized' } : {
        status: 200, body: (async function* () {
          if (mode === 'abort') controller.abort();
          else yield frame({ type: 'response.created', response: { id: 'wrong' } });
        })(),
      } },
    });
    assert.equal(result.output, null, mode);
  }
});
