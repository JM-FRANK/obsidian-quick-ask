// Gemini search and local-function wire for a Chat Completions session. The stored session
// remains Chat-native; this boundary translates one request and preserves the
// complete native response for faithful replay of thoughts and signatures.
const { normalizeError } = require('./transport');

function protocolError(message) { throw { kind: 'protocol', message }; }
function imagePart(value) {
  const url = typeof value === 'string' ? value : value?.url;
  if (typeof url !== 'string') protocolError('Missing Gemini search image URL');
  const data = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(url);
  if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
  let parsed;
  try { parsed = new URL(url); } catch { protocolError('Invalid Gemini search image URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) protocolError('Unsupported Gemini search image URL');
  return { fileData: { mimeType: value?.mime_type ?? 'image/*', fileUri: url } };
}
function contentParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) protocolError('Unsupported Gemini search message content');
  return content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { text: part.text };
    if (part?.type === 'image_url') return imagePart(part.image_url);
    protocolError('Unsupported Gemini search content part');
  });
}
function thinkingConfig(model, effort) {
  if (effort === undefined) return undefined;
  // Off must never silently become Low. Models that cannot disable thoughts
  // must reject the explicit zero budget rather than change the user's choice.
  if (effort === 'none' && /^gemini-(?:2\.5|[34])(?:[.-]|$)/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-2\.5(?:-|$)/.test(model)) {
    // Native 2.5 uses a budget, and newer models use levels. XHigh/Max have no
    // native counterpart: both use the same documented High boundary here.
    return { thinkingBudget: effort === 'low' || effort === 'minimal' ? 1024 : effort === 'medium' ? 8192 : 24576 };
  }
  if (/^gemini-[34](?:[.-]|$)/.test(model)) return { thinkingLevel: effort === 'medium' ? 'MEDIUM'
    : ['high', 'xhigh', 'max'].includes(effort) ? 'HIGH' : 'LOW' };
  return undefined;
}
function buildGeminiSearchBody(chatBody = {}) {
  const model = String(chatBody.model ?? '').replace(/^(?:google|models)\//, '');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model)) protocolError('Invalid Gemini search model');
  if (!Array.isArray(chatBody.messages)) protocolError('Gemini search requires Chat Completions messages');
  const contents = [], systemParts = [], calls = new Map();
  for (const message of chatBody.messages) {
    if (!message || typeof message !== 'object') protocolError('Invalid Gemini search message');
    if (message.role === 'system' || message.role === 'developer') {
      const parts = contentParts(message.content);
      if (parts.some(part => !Object.hasOwn(part, 'text'))) protocolError('Gemini system instructions must contain text');
      systemParts.push(...parts);
      continue;
    }
    if (!['user', 'assistant', 'tool'].includes(message.role)) protocolError('Unsupported Gemini search message role');
    const native = message.role === 'assistant' ? message.extra_content?.google?.nativeContent : null;
    for (const call of message.tool_calls ?? []) calls.set(call.id, { name: call.function?.name, native: Boolean(native) });
    if (native) {
      if (native.role !== 'model' || !Array.isArray(native.parts) || !native.parts.length || native.parts.some(part => !part || typeof part !== 'object' || Array.isArray(part))) protocolError('Invalid preserved Gemini search content');
      contents.push(native);
      continue;
    }
    const parts = contentParts(message.content);
    if (message.role === 'assistant' && typeof message.refusal === 'string' && message.refusal) parts.push({ text: message.refusal });
    // Old Chat calls have no native thought signatures. Keep that history as
    // textual evidence rather than inventing signed Gemini function parts.
    if (message.role === 'assistant' && message.tool_calls?.length)
      parts.push({ text: JSON.stringify({ historical_tool_calls: message.tool_calls }) });
    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id);
      if (!call) protocolError('Gemini tool result has no matching function call');
      if (call.native) {
        const text = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('');
        const media = parts.filter(part => typeof part.text !== 'string');
        parts.splice(0, parts.length, { functionResponse: { id: message.tool_call_id, name: call.name, response: { output: text } } }, ...media);
      } else parts.unshift({ text: JSON.stringify({ historical_tool_result: { tool_call_id: message.tool_call_id, ...(message.name ? { name: message.name } : {}) } }) });
    }
    if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  if (!contents.length) protocolError('Gemini search requires nonempty conversation content');
  const declarations = (chatBody.tools ?? []).filter(tool => tool.type === 'function' && tool.function?.name)
    .map(tool => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
  const body = { model, contents, tools: [{ google_search: {} }, ...(declarations.length ? [{ functionDeclarations: declarations }] : [])],
    ...(declarations.length ? { toolConfig: { includeServerSideToolInvocations: true } } : {}) };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  const max = chatBody.max_completion_tokens ?? chatBody.max_tokens;
  const thinking = thinkingConfig(model, chatBody.reasoning_effort);
  if ((Number.isInteger(max) && max > 0) || thinking) {
    body.generationConfig = { ...(Number.isInteger(max) && max > 0 ? { maxOutputTokens: max } : {}),
      ...(thinking ? { thinkingConfig: thinking } : {}) };
  }
  return body;
}
function nativeUrl(baseUrl, body) {
  let base = String(baseUrl ?? '').replace(/\/+$/, '').replace(/\/openai$/, '');
  let url;
  try { url = new URL(base); } catch { protocolError('Invalid Gemini search base URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) protocolError('Invalid Gemini search base URL');
  if (url.pathname === '/' || !url.pathname) base += '/v1beta';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(String(body?.model ?? ''))) protocolError('Invalid Gemini search model');
  return `${base}/models/${encodeURIComponent(body.model)}:generateContent`;
}
function requestBody(body) {
  const { model, stream, stream_options, ...native } = body;
  return native;
}
function eventsFromResponse(payload, state, emit) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) protocolError('Invalid Gemini search response');
  if (payload.error) throw { kind: 'provider', error: payload.error, status: payload.error.code };
  state.accepted = true;
  state.responseId = typeof payload.responseId === 'string' ? payload.responseId : null;
  emit({ type: 'created', responseId: state.responseId });
  const blocked = payload.promptFeedback?.blockReason;
  if (blocked) throw { kind: 'provider', error: { code: blocked, message: payload.promptFeedback.blockReasonMessage ?? `Gemini blocked the prompt: ${blocked}` } };
  if (!Array.isArray(payload.candidates) || payload.candidates.length !== 1) protocolError('Expected one Gemini search candidate');
  const candidate = payload.candidates[0];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) protocolError('Invalid Gemini search candidate');
  if (candidate.index !== undefined && candidate.index !== 0) protocolError('Unexpected Gemini search candidate index');
  if (typeof candidate.finishReason !== 'string' || !candidate.finishReason) protocolError('Gemini search response has no finishReason');
  const native = candidate.content;
  if (native !== undefined && (!native || native.role !== 'model' || !Array.isArray(native.parts) || native.parts.some(part => !part || typeof part !== 'object' || Array.isArray(part)))) protocolError('Invalid Gemini search model content');
  const parts = native?.parts ?? [];
  // Never attach rejected media/tool payloads to partial output: conversation
  // persistence would otherwise serialize inline base64 into the session log.
  if (parts.some(part => part.functionResponse || part.inlineData || part.fileData || part.executableCode || part.codeExecutionResult)) {
    protocolError('Unexpected Gemini search tool or media output');
  }
  const text = parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('');
  const reasoning = parts.filter(part => part.thought && typeof part.text === 'string').map(part => part.text).join('');
  const calls = parts.flatMap((part, index) => {
    if (!part.functionCall) return [];
    const call = part.functionCall;
    if (typeof call.name !== 'string' || !call.name || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) protocolError('Invalid Gemini function call');
    return [{ id: call.id || `${state.responseId ?? 'gemini'}-call-${index}`, type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) } }];
  });
  const google = { ...(native ? { nativeContent: native } : {}),
    ...(candidate.groundingMetadata ? { groundingMetadata: candidate.groundingMetadata } : {}),
    finishReason: candidate.finishReason,
    ...(candidate.safetyRatings ? { safetyRatings: candidate.safetyRatings } : {}),
    ...(candidate.finishMessage ? { finishMessage: candidate.finishMessage } : {}) };
  // Preserve the original parts/signatures but give missing call IDs stable
  // names in the Chat record used to pair local results.
  for (const call of calls) {
    state.callOrder.push({ id: call.id, callId: call.id, name: call.function.name, arguments: call.function.arguments, emitted: true });
    emit({ type: 'function-call', callId: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  const message = { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}), extra_content: { google } };
  state.geminiMessage = message;
  state.text = text;
  state.reasoning = reasoning;
  const grounding = candidate.groundingMetadata;
  if ((Array.isArray(grounding?.webSearchQueries) && grounding.webSearchQueries.some(query => typeof query === 'string' && query.trim()))
      || (Array.isArray(grounding?.groundingChunks) && grounding.groundingChunks.some(chunk => typeof chunk?.web?.uri === 'string' && chunk.web.uri.trim()))
      || (typeof grounding?.searchEntryPoint?.renderedContent === 'string' && grounding.searchEntryPoint.renderedContent.trim())) emit({ type: 'search-progress' });
  if (reasoning) emit({ type: 'reasoning-text-delta', delta: reasoning });
  if (text) emit({ type: 'text-delta', delta: text });
  const usage = payload.usageMetadata;
  if (usage && typeof usage === 'object') {
    const value = { ...(Number.isFinite(usage.promptTokenCount) ? { prompt_tokens: usage.promptTokenCount } : {}),
      ...((Number.isFinite(usage.candidatesTokenCount) || Number.isFinite(usage.thoughtsTokenCount)) ? { completion_tokens: (Number.isFinite(usage.candidatesTokenCount) ? usage.candidatesTokenCount : 0) + (Number.isFinite(usage.thoughtsTokenCount) ? usage.thoughtsTokenCount : 0) } : {}),
      ...(Number.isFinite(usage.totalTokenCount) ? { total_tokens: usage.totalTokenCount } : {}),
      ...(Number.isFinite(usage.cachedContentTokenCount) ? { prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount } } : {}),
      ...(Number.isFinite(usage.thoughtsTokenCount) ? { completion_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount } } : {}) };
    state.usage = state.terminalUsage = value;
    const sample = { source: 'terminal', usage: value };
    state.usageSamples.push(sample);
    emit({ type: 'usage', ...sample });
  }
  const finish = candidate.finishReason;
  const status = !['STOP', 'MAX_TOKENS'].includes(finish) ? 'failed' : finish === 'MAX_TOKENS' ? 'incomplete' : 'completed';
  if (status === 'completed' && !text && !calls.length) protocolError('Gemini search returned no answer text');
  if (status === 'failed') state.terminalError = normalizeError({ kind: 'provider', error: {
    code: finish,
    message: candidate.finishMessage ?? `Gemini search stopped: ${finish}`,
  } });
  state.terminalOutput = [message];
  state.terminal = { type: 'terminal', status, responseId: state.responseId,
    incompleteReason: status === 'completed' ? null : finish, output: state.terminalOutput };
  emit(state.terminal);
}
const geminiSearchWire = Object.freeze({
  id: 'gemini-search',
  createUrl: nativeUrl,
  requestUrl: nativeUrl,
  requestHeaders: key => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' }),
  requestBody,
  streamRequestBody: () => protocolError('Gemini search requires non-streaming transport'),
  handleFrame: () => protocolError('Gemini search requires non-streaming transport'),
  eventsFromResponse,
  partialOutput: state => state.geminiMessage ? [state.geminiMessage] : null,
});
module.exports = { geminiSearchWire, buildGeminiSearchBody };
