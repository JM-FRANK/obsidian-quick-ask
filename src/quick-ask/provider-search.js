const { protocolFor } = require('./protocol');
const { streamAttempt } = require('./transport');
const { buildGeminiSearchBody, geminiSearchWire } = require('./gemini-search');
const { normalizeSources, responseSources, searchUnsupported } = require('./web-search');

// A provider-search tool has no Vault capability and no main conversation.
// It runs a search-only request through the shared transport and returns bounded, untrusted evidence.
async function runProviderSearch(query, { environment, config, route, apiKey, signal, policy, idleTimeoutMs }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 500)
    return { ok: false, code: 'QUERY', sources: [], usageSamples: [] };
  if (signal?.aborted) return { ok: false, code: 'ABORTED', sources: [], usageSamples: [] };
  const server = route.server, protocol = protocolFor(config);
  let body = protocol.buildRequestBody({
    model: config.model,
    input: [protocol.userMessage(query.trim())],
    tools: server.tool ? [server.tool] : [],
    toolChoice: config.protocol === 'chat-completions' ? 'auto' : 'required',
    parallelToolCalls: false,
    serverSearch: server,
    maxOutputTokens: 2048,
    store: false,
  });
  // The ordinary Chat builder supplies an empty system message. Search forwards
  // only the query; neither a custom prompt nor an empty role is needed here.
  if (body.messages) body.messages = body.messages.filter(message => message.role !== 'system');
  if (server.native) body = buildGeminiSearchBody(body);
  const result = await streamAttempt({
    protocol: server.native ? geminiSearchWire : protocol,
    network: environment.network, scheduler: environment.scheduler,
    baseUrl: config.baseUrl, body, apiKey, signal, policy, idleTimeoutMs,
    nonStreaming: server.native === true,
    onEvent: () => {},
  });
  const usageSamples = result.usageSamples ?? [];
  if (result.status !== 'completed') return { ok: false, code: result.error?.code ?? 'SEARCH_FAILED',
    sources: [], usageSamples };
  // A child request can never execute a returned function, regardless of name.
  if (result.functionCalls?.length) return { ok: false, code: 'UNEXPECTED_TOOL', sources: [], usageSamples };
  const answer = String(result.text ?? '').trim().slice(0, 12000);
  const sources = normalizeSources(responseSources(result.output ?? []), 5);
  if (!answer && !sources.length) return { ok: false, code: 'EMPTY_RESPONSE', sources: [], usageSamples };
  return { ok: true, query: query.trim(), provider: route.provider, answer, sources, usageSamples };
}

function mixedSearchErrorHint(error, route) {
  if (route?.kind !== 'server' || !error || ['AUTH', 'RATE_LIMIT', 'TIMEOUT', 'ABORTED', 'NETWORK'].includes(error.code)) return null;
  const message = String(error.message ?? '');
  return searchUnsupported(error) || /(?:tool|function|search|grounding).*(?:unsupported|not supported|cannot|incompatib)|(?:unsupported|not supported|cannot|incompatib).*(?:tool|function|search|grounding)/i.test(message)
    ? 'search.switchIndependent' : null;
}

module.exports = { runProviderSearch, mixedSearchErrorHint };
