// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { geminiSearchWire: wire, buildGeminiSearchBody: build } = require('../src/quick-ask/gemini-search');

function response(candidate = {}, extra = {}) {
  return { responseId: 'gemini-1', candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Answer' }] }, finishReason: 'STOP', ...candidate }], ...extra };
}
function fold(payload) {
  const state = { accepted: false, usageSamples: [], text: '', reasoning: '', callOrder: [] }, events = [];
  wire.eventsFromResponse(payload, state, event => events.push(event));
  return { state, events };
}

test('Gemini search converts the complete Chat conversation, images and historical tool batches without mutation', () => {
  const messages = [
    { role: 'system', content: 'System instructions' },
    { role: 'developer', content: 'Additional instructions' },
    { role: 'user', content: [{ type: 'text', text: 'Context\nQuestion' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] },
    { role: 'assistant', content: 'Checking', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get-full-file', arguments: '{"path":"note.md"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: '# Complete file\nimportant details' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }, { type: 'text', text: 'Search now' }] },
  ];
  const input = { model: 'gemini-2.5-flash', messages, tools: [{ type: 'function' }], tool_choice: 'auto', web_search_options: {}, max_completion_tokens: 2048, reasoning_effort: 'none' };
  const before = JSON.stringify(input);
  const body = build(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'System instructions' }, { text: 'Additional instructions' }] });
  assert.deepEqual(body.contents[0], { role: 'user', parts: [{ text: 'Context\nQuestion' }, { inlineData: { mimeType: 'image/png', data: 'YWJj' } }] });
  assert.equal(body.contents[1].role, 'model');
  assert.deepEqual(JSON.parse(body.contents[1].parts[1].text).historical_tool_calls, messages[3].tool_calls);
  assert.equal(JSON.parse(body.contents[2].parts[0].text).historical_tool_result.tool_call_id, 'call-1');
  assert.equal(body.contents[2].parts[1].text, '# Complete file\nimportant details');
  assert.equal(body.contents[3].parts[0].text, 'Earlier answer');
  assert.deepEqual(body.contents[4].parts[0], { fileData: { mimeType: 'image/*', fileUri: 'https://example.test/image.png' } });
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } });
  assert.equal(body.tool_choice, undefined);
});

test('native Gemini history restores every original part and thought signature', () => {
  const nativeContent = { role: 'model', parts: [{ text: 'Private thought', thought: true, thoughtSignature: 'opaque' }, { text: 'Earlier answer', thoughtSignature: 'also-opaque' }] };
  const body = build({ model: 'google/gemini-3.1-pro-preview', messages: [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'Earlier answer', extra_content: { google: { nativeContent, groundingMetadata: { webSearchQueries: ['earlier'] } } } },
    { role: 'user', content: 'Follow up' },
  ], reasoning_effort: 'high' });
  assert.deepEqual(body.contents[1], nativeContent);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' });
  assert.equal(body.model, 'gemini-3.1-pro-preview');
});

test('Off remains an explicit zero budget even when a model may reject disabling thoughts', () => {
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-4-argon']) {
    const body = build({ model, messages: [{ role: 'user', content: 'Search' }], reasoning_effort: 'none' });
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  }
});

test('Gemini search URL and API-key headers support official bases and explicit proxy prefixes', () => {
  const model = { model: 'gemini-2.5-flash' };
  for (const [base, expected] of [
    ['https://generativelanguage.googleapis.com/v1beta/openai/', 'https://generativelanguage.googleapis.com/v1beta'],
    ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta'],
    ['https://proxy.test/gemini/v1/openai', 'https://proxy.test/gemini/v1'],
    ['https://proxy.test/gemini/v1beta', 'https://proxy.test/gemini/v1beta'],
  ]) {
    assert.equal(wire.createUrl(base, model), `${expected}/models/gemini-2.5-flash:generateContent`);
    assert.equal(wire.requestUrl(base, model), wire.createUrl(base, model));
  }
  const headers = wire.requestHeaders('fixture-key');
  assert.equal(headers['x-goog-api-key'], 'fixture-key');
  assert.equal(headers.Authorization, undefined);
  assert.throws(() => wire.createUrl('https://proxy.test/v1?key=bad', model));
  assert.throws(() => wire.createUrl('https://proxy.test/v1', { model: '../secret' }));
});

test('native request body strips transport and URL-only fields without mutating input', () => {
  const native = build({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Search' }] });
  const sent = wire.requestBody({ ...native, stream: false, stream_options: { include_usage: true } });
  assert.deepEqual(Object.keys(sent).sort(), ['contents', 'tools']);
  assert.equal(native.model, 'gemini-2.5-flash');
  assert.throws(() => wire.streamRequestBody(native), error => /non-streaming/.test(error.message));
  assert.throws(() => wire.handleFrame({ data: '{}' }, {}, () => {}), error => /non-streaming/.test(error.message));
});

test('Gemini native answer, grounding and suggestions are preserved together without interpreting citation indices', () => {
  const groundingMetadata = { webSearchQueries: ['查询'], searchEntryPoint: { renderedContent: '<style>p{color:red}</style><p>Google Search</p>' },
    groundingChunks: [{ web: { uri: 'https://example.test/source', title: 'Source' } }],
    groundingSupports: [{ segment: { startIndex: 0, endIndex: 6, text: '答案' }, groundingChunkIndices: [0] }] };
  const nativeContent = { role: 'model', parts: [{ thought: true, text: 'Reason', thoughtSignature: 'sig' }, { text: '答案' }] };
  const payload = response({ content: nativeContent, groundingMetadata }, { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 19, cachedContentTokenCount: 2 } });
  const before = JSON.stringify(payload);
  const { state, events } = fold(payload);
  assert.equal(JSON.stringify(payload), before);
  assert.equal(state.accepted, true);
  assert.equal(state.terminal.status, 'completed');
  assert.equal(state.text, '答案');
  assert.equal(state.reasoning, 'Reason');
  assert.deepEqual(state.terminalOutput[0].extra_content.google.nativeContent, nativeContent);
  assert.deepEqual(state.terminalOutput[0].extra_content.google.groundingMetadata, groundingMetadata);
  assert.equal(state.terminalOutput[0].annotations, undefined);
  assert.deepEqual(state.terminalUsage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } });
  assert.equal(events.filter(event => event.type === 'search-progress').length, 1);
  assert.equal(events.filter(event => event.type === 'terminal').length, 1);
  assert.deepEqual(wire.partialOutput(state), state.terminalOutput);
});

test('Google may answer without searching: no metadata means no invented search event or sources', () => {
  const { state, events } = fold(response());
  assert.equal(state.terminal.status, 'completed');
  assert.equal(state.terminalOutput[0].extra_content.google.groundingMetadata, undefined);
  assert.equal(events.some(event => event.type === 'search-progress'), false);
  assert.equal(wire.partialOutput({}), null);
});

test('token limits are incomplete, while safety and unexpected finish reasons fail explicitly', () => {
  assert.equal(fold(response({ finishReason: 'MAX_TOKENS' })).state.terminal.status, 'incomplete');
  for (const finishReason of ['SAFETY', 'RECITATION', 'MALFORMED_FUNCTION_CALL', 'OTHER', 'UNEXPECTED_NEW_REASON']) {
    const { state } = fold(response({ finishReason, finishMessage: 'Provider detail' }));
    assert.equal(state.terminal.status, 'failed');
    assert.equal(state.terminalError.message, 'Provider detail');
    assert.equal(state.terminalOutput[0].extra_content.google.finishReason, finishReason);
  }
  assert.equal(fold(response({ content: undefined, finishReason: 'SAFETY' })).state.terminal.status, 'failed');
});

test('prompt blocks, provider errors, wrong protocols and malformed success cannot fabricate completion', () => {
  for (const payload of [
    { error: { code: 403, message: 'API key rejected', status: 'PERMISSION_DENIED' } },
    { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'Blocked' } },
    { choices: [{ message: { role: 'assistant', content: 'Wrong protocol' } }] },
    { candidates: [] },
    { candidates: [{ finishReason: 'STOP' }, { finishReason: 'STOP' }] },
    response({ finishReason: undefined }),
    response({ content: { role: 'model', parts: [] } }),
    response({ content: { role: 'model', parts: [null] } }),
    { candidates: [null] },
  ]) assert.throws(() => fold(payload));
  assert.throws(() => fold(response({ content: { role: 'model', parts: [null] } })), error => error.kind === 'protocol');
});

test('unexpected native functions or media fail before attaching persistable native content', () => {
  for (const part of [{ functionCall: { name: 'get-full-file', args: {} } }, { inlineData: { mimeType: 'image/png', data: 'YWJj' } }]) {
    const content = { role: 'model', parts: [part] };
    const state = { usageSamples: [], text: '', reasoning: '', callOrder: [] };
    assert.throws(() => wire.eventsFromResponse(response({ content }), state, () => {}), error => error.kind === 'protocol');
    assert.equal(wire.partialOutput(state), null);
    assert.equal(state.terminalOutput, undefined);
    assert.equal(JSON.stringify(state).includes('YWJj'), false);
  }
});

test('empty grounding metadata does not claim a search and real evidence triggers progress', () => {
  for (const groundingMetadata of [{}, { webSearchQueries: [], groundingChunks: [] }, { webSearchQueries: ['  '], groundingChunks: [null], searchEntryPoint: { renderedContent: '' } }]) {
    const { events } = fold(response({ groundingMetadata }));
    assert.equal(events.some(event => event.type === 'search-progress'), false);
  }
  for (const groundingMetadata of [{ webSearchQueries: ['query'] }, { groundingChunks: [{ web: { uri: 'https://example.test' } }] }, { searchEntryPoint: { renderedContent: '<div>Search</div>' } }]) {
    const { events } = fold(response({ groundingMetadata }));
    assert.equal(events.some(event => event.type === 'search-progress'), true);
  }
});

test('unsupported history content fails before a request rather than silently dropping context', () => {
  for (const messages of [
    [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }],
    [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///secret.png' } }] }],
    [{ role: 'unknown', content: 'content' }],
    [{ role: 'assistant', content: 'Answer', extra_content: { google: { nativeContent: { role: 'model', parts: [null] } } } }],
    [],
  ]) assert.throws(() => build({ model: 'gemini-2.5-flash', messages }));
});

test('shared transport sends one native API-key request and folds the native answer into Chat history', async () => {
  const { streamAttempt } = require('../src/quick-ask/transport');
  const requested = [];
  const body = build({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Search now' }] });
  const result = await streamAttempt({ protocol: wire, nonStreaming: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', body, apiKey: 'fixture-key',
    scheduler: { now: Date.now, delay: setTimeout, cancelDelay: clearTimeout },
    network: { request: async options => { requested.push(options); return { status: 200, json: response() }; } },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Answer');
  assert.equal(result.output[0].role, 'assistant');
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(requested[0].headers['x-goog-api-key'], 'fixture-key');
  assert.equal(requested[0].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requested[0].body), { contents: [{ role: 'user', parts: [{ text: 'Search now' }] }], tools: [{ google_search: {} }] });
});

test('a provider rejection of Off is surfaced without retrying at a different thinking level', async () => {
  const { streamAttempt } = require('../src/quick-ask/transport');
  const requested = [];
  const body = build({ model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'Search now' }], reasoning_effort: 'none' });
  const result = await streamAttempt({ protocol: wire, nonStreaming: true,
    baseUrl: 'https://proxy.test/v1beta/openai', body, apiKey: 'fixture-key',
    scheduler: { now: Date.now, delay: setTimeout, cancelDelay: clearTimeout },
    network: { request: async options => { requested.push(options); return { status: 400, text: JSON.stringify({ error: { message: 'Thinking budget zero is not supported' } }) }; } },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /Thinking budget zero/);
  assert.equal(requested.length, 1);
  assert.deepEqual(JSON.parse(requested[0].body).generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('rejected inline media cannot enter session output through shared transport partial recovery', async () => {
  const { streamAttempt } = require('../src/quick-ask/transport');
  const result = await streamAttempt({ protocol: wire, nonStreaming: true,
    baseUrl: 'https://proxy.test/v1beta/openai', apiKey: 'fixture-key',
    body: build({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Search' }] }),
    scheduler: { now: Date.now, delay: setTimeout, cancelDelay: clearTimeout },
    network: { request: async () => ({ status: 200, json: response({ content: { role: 'model', parts: [{ text: 'Partial' }, { inlineData: { mimeType: 'image/png', data: 'YWJjRE9OT1RQRVJTSVNU' } }] } }) }) },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.output, null);
  assert.equal(JSON.stringify(result).includes('YWJjRE9OT1RQRVJTSVNU'), false);
});
