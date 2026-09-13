const { normalizeSources, safeSourceUrl } = require('./web-search');
const { createAbortController } = require('./transport');
const LIMIT = 5;
const ENDPOINTS = { firecrawl: 'https://api.firecrawl.dev/v2/search', exa: 'https://api.exa.ai/search',
  parallel: 'https://api.parallel.ai/v1/search', perplexity: 'https://api.perplexity.ai/search' };
function textFromHTML(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
    if (entity[0] === '#') { const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[entity.toLowerCase()];
  }).replace(/\s+/g, ' ').trim();
}
function parseDuckDuckGo(html) {
  if (/anomaly\.js|challenge-form|bots use duckduckgo|verify you are human/i.test(html)) throw new Error('CHALLENGE');
  const rows = [];
  const anchors = [...html.matchAll(/<a\b[^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi)];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    const href = /href=["']([^"']+)["']/i.exec(anchor[0])?.[1];
    if (!href) continue;
    let url = textFromHTML(href);
    if (url.startsWith('//')) url = 'https:' + url;
    try { const parsed = new URL(url); if (parsed.hostname === 'duckduckgo.com' && parsed.searchParams.has('uddg')) url = parsed.searchParams.get('uddg'); } catch { continue; }
    const section = html.slice(anchor.index + anchor[0].length, anchors[i + 1]?.index ?? html.length);
    const snippet = /<(?:a|div|span)\b[^>]*class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(section)?.[1];
    rows.push({ url, title: textFromHTML(anchor[0]), snippet: textFromHTML(snippet) });
  }
  const sources = normalizeSources(rows, LIMIT);
  if (!sources.length && !/no results|result--no-result/i.test(html)) throw new Error('PARSE');
  return sources;
}
function requestFor(provider, query, key) {
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (provider === 'firecrawl') { headers.Authorization = `Bearer ${key}`; body = { query, limit: LIMIT, sources: ['web'] }; }
  if (provider === 'exa') { headers['x-api-key'] = key; body = { query, numResults: LIMIT, contents: { highlights: { maxCharacters: 2000 } } }; }
  if (provider === 'parallel') { headers['x-api-key'] = key; body = { objective: query, search_queries: [query], advanced_settings: { max_results: LIMIT, excerpt_settings: { max_chars_per_result: 2000 } } }; }
  if (provider === 'perplexity') { headers.Authorization = `Bearer ${key}`; body = { query, max_results: LIMIT, max_tokens_per_page: 512 }; }
  return { url: ENDPOINTS[provider], method: 'POST', headers, body: JSON.stringify(body) };
}
function createSearchClient({ network, secrets, scheduler }) {
  async function request(options, signal) {
    if (signal?.aborted) throw new Error('ABORTED');
    const controller = createAbortController(network);
    let timer, onAbort;
    const stop = new Promise((_, reject) => {
      onAbort = () => { reject(new Error('ABORTED')); controller.abort(); };
      if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
      timer = scheduler.delay(30000, () => { reject(new Error('TIMEOUT')); controller.abort(); });
    });
    try {
      const result = await Promise.race([network.request({ ...options, signal: controller.signal }), stop]);
      if ((result.text?.length ?? 0) > 2_000_000) throw new Error('TOO_LARGE');
      return result;
    } finally { scheduler.cancelDelay(timer); signal?.removeEventListener('abort', onAbort); }
  }
  async function search(query, route, { signal, config, onRoute = () => {} } = {}) {
    if (route?.kind === 'off' || route?.kind === 'server') return { ok: false, code: 'DISABLED', sources: [] };
    if (typeof query !== 'string' || !query.trim() || query.length > 500) return { ok: false, code: 'QUERY', sources: [] };
    query = query.trim();
    try {
      let response;
      if (route.kind === 'independent') {
        const key = secrets.resolve(route.secretId);
        if (!key) return { ok: false, code: 'MISSING_SECRET', sources: [] };
        response = await request(requestFor(route.provider, query, key), signal);
      } else response = await request({ url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, method: 'GET' }, signal);
      const status = response.status;
      if (!(status >= 200 && status < 300)) {
        return { ok: false, code: status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : 'HTTP', status, sources: [] };
      }
      let sources;
      if (route.kind === 'local') sources = parseDuckDuckGo(response.text ?? '');
      else {
        const data = response.json && typeof response.json === 'object' ? response.json : JSON.parse(response.text);
        const rows = route.provider === 'firecrawl' ? data.data?.web : data.results;
        if (data.success === false || !Array.isArray(rows)) throw new Error('PARSE');
        sources = normalizeSources(rows, LIMIT);
        if (rows.length && !sources.length) throw new Error('PARSE');
      }
      onRoute(route);
      return { ok: true, query, provider: route.provider, sources };
    } catch (error) {
      const code = signal?.aborted ? 'ABORTED' : ['CHALLENGE','PARSE','TIMEOUT','TOO_LARGE'].includes(error.message) ? error.message : 'NETWORK';
      return { ok: false, code, sources: [] };
    }
  }
  return { search };
}
module.exports = { createSearchClient, requestFor, parseDuckDuckGo, textFromHTML };
