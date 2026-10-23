const { imagePaths } = require('./images');
const { isToolOutput, toolOutputId } = require('./protocol');
const { responsesFunctionCallsFrom } = require('./transport');
const { functionCallsFrom } = require('./chat-completions');
const { normalizeSources } = require('./web-search');

const TOOL_NAMES = new Set(['get-full-file', 'get-image', 'web_search']);
const bounded = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const sourceSummary = rows => normalizeSources(rows).map(({ url, title }) => ({ url, title }));
function displaySummary(value = {}) {
  return {
    ...(typeof value?.path === 'string' ? { path: bounded(value.path) } : {}),
    ...(typeof value?.error === 'string' ? { error: bounded(value.error) } : {}),
    ...(value?.image === true ? { image: true } : {}),
    ...(Number.isSafeInteger(value?.characters) && value.characters >= 0 ? { characters: value.characters } : {}),
    ...(Array.isArray(value?.sources) ? { sources: sourceSummary(value.sources) } : {}),
    ...(['limit', 'context'].includes(value?.reason) ? { reason: value.reason } : {}),
  };
}
function parameters(value) {
  let args = value;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
  return Object.fromEntries(['path', 'sourcePath', 'query'].filter(key => typeof args?.[key] === 'string').map(key => [key, bounded(args[key])]));
}

// Summaries are data facts, never another LLM call or a copy of file contents.
function toolSummary(name, result = {}) {
  if (!result.ok) return { error: bounded(name === 'web_search' ? result.result?.code ?? result.output : result.output), ...(result.path ? { path: bounded(result.path) } : {}),
    ...(['limit', 'context'].includes(result.status) ? { reason: result.status } : {}) };
  if (name === 'get-image') return { path: bounded(result.path), image: true };
  if (name === 'web_search') return { sources: sourceSummary(result.result?.sources ?? []) };
  return { path: bounded(result.path), characters: String(result.output ?? '').length };
}

function updateToolGroups(groups, activity) {
  const id = `${activity.turnId}:${activity.batchId}`;
  const previous = groups.find(group => group.id === id);
  const calls = [...(previous?.calls ?? [])];
  const index = calls.findIndex(call => call.callId === activity.callId);
  const call = { ...(index >= 0 ? calls[index] : {}), callId: activity.callId, name: activity.name,
    arguments: parameters(activity.arguments), status: activity.status, summary: displaySummary(activity.summary),
    ...(activity.server ? { server: true } : {}), ...(activity.provider ? { provider: bounded(activity.provider) } : {}) };
  if (index < 0) calls.push(call); else calls[index] = call;
  const group = { kind: 'tools', id, turnId: activity.turnId, calls };
  return { group, groups: previous ? groups.map(value => value.id === id ? group : value) : [...groups, group] };
}
function legacyResult(name, item, payload) {
  const output = item?.output ?? item?.content ?? '';
  const text = typeof output === 'string' ? output : '';
  const failure = name === 'get-full-file'
    ? ['文件不存在', '文件读取失败', '上下文空间不足，无法读取完整文件', 'Cancelled'].includes(text) || text.startsWith('Tool call not executed')
    : /^(?:Image (?:unavailable|read failed|read cancelled)|Context space exhausted|Tool call limit reached|Tool call not executed|Unsupported tool)/.test(text);
  let result = { ok: !failure, output: text, path: payload.imagePaths?.[0] };
  if (name === 'web_search') {
    try { const parsed = JSON.parse(text); result = { ok: parsed.ok === true, output: parsed.code ?? '', result: parsed }; }
    catch { result = { ok: false, output: text }; }
  }
  return { status: failure && /[Cc]ancelled|not executed/.test(text) ? 'cancelled' : result.ok ? 'complete' : 'failed', summary: toolSummary(name, result) };
}

// Optional presentation records use the existing append-only session format.
// They are never canonical model items and never grant read permissions.
function toolHistory(records = [], { runningTurnIds = new Set() } = {}) {
  const groups = [], byGroup = new Map(), byCall = new Map(), byTurn = new Map();
  let turnId = 'legacy', turnNumber = 0;
  const groupFor = (batchId, index) => {
    const id = `${turnId}:${batchId}`;
    if (!byGroup.has(id)) {
      const group = { kind: 'tools', id, turnId, calls: [], index }; byGroup.set(id, group); groups.push(group);
      if (!byTurn.has(turnId)) byTurn.set(turnId, []);
      byTurn.get(turnId).push(group);
    }
    return byGroup.get(id);
  };
  const callFor = (call, batchId, index) => {
    const key = `${turnId}:${call.callId}`;
    let target = byCall.get(key);
    if (!target && call.name === 'web_search') {
      const query = parameters(call.arguments).query;
      target = (byTurn.get(turnId) ?? []).flatMap(group => group.calls)
        .find(value => value.syntheticSearch && value.arguments.query === query);
      if (target) {
        byCall.delete(`${turnId}:${target.callId}`);
        target.callId = call.callId; delete target.syntheticSearch;
        byCall.set(key, target);
      }
    }
    if (!target) {
      target = { callId: call.callId, name: call.name, arguments: parameters(call.arguments), status: 'running', summary: {} };
      groupFor(batchId, index).calls.push(target); byCall.set(key, target);
    }
    return target;
  };
  for (const [index, record] of records.entries()) {
    const payload = record.payload ?? {};
    if (record.kind === 'turn/started') { turnId = payload.turnId ?? `legacy-${++turnNumber}`; }
    if (['turn/tool-started', 'turn/tool-finished'].includes(record.kind) && TOOL_NAMES.has(payload.name) && payload.callId) {
      const call = callFor(payload, payload.batchId ?? 'local', index);
      if (payload.server) call.server = true;
      if (payload.provider) call.provider = bounded(payload.provider);
      if (record.kind === 'turn/tool-started') call.status = payload.status === 'queued' ? 'queued' : 'running';
      if (record.kind === 'turn/tool-finished') {
        call.status = ['complete', 'failed', 'cancelled', 'interrupted'].includes(payload.status) ? payload.status : 'interrupted';
        call.summary = displaySummary(payload.summary);
        call.recorded = true;
      }
    }
    if (record.kind === 'item/output') {
      const item = payload.item;
      for (const call of [...responsesFunctionCallsFrom([item]), ...functionCallsFrom([item])]) {
        if (TOOL_NAMES.has(call.name)) callFor(call, 'legacy-local', index);
      }
      if (isToolOutput(item)) {
        const call = byCall.get(`${turnId}:${toolOutputId(item)}`);
        if (call && !call.recorded) Object.assign(call, legacyResult(call.name, item, payload));
      }
      if (item?.type === 'web_search_call') {
        const existing = (byTurn.get(turnId) ?? []).find(group => group.calls.some(call => call.callId === 'server-search' && call.server));
        const call = existing?.calls.find(call => call.server) ?? callFor({ callId: item.id ?? 'server-search', name: 'web_search' }, 'server', index);
        call.server = true;
        const queries = item.action?.queries ?? (item.action?.query ? [item.action.query] : []);
        call.arguments = { query: [...new Set([call.arguments.query, ...queries].filter(value => typeof value === 'string' && value))].map(bounded).join('\n') };
        if (!call.recorded) call.status = item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'complete' : 'running';
      }
    }
    if (record.kind === 'search/result') {
      const candidates = (byTurn.get(turnId) ?? []).flatMap(group => group.calls).filter(call => call.name === 'web_search' && call.arguments.query === payload.query);
      const previous = candidates.at(-1);
      const call = previous ?? callFor({ callId: `search-${index}`, name: 'web_search', arguments: { query: payload.query } }, 'legacy-search', index);
      if (!previous) call.syntheticSearch = true;
      call.provider = bounded(payload.provider);
      if (!call.recorded) { call.status = payload.status === 'complete' ? 'complete' : 'failed'; call.summary = { sources: sourceSummary(payload.sources ?? []), ...(payload.code ? { error: bounded(payload.code) } : {}) }; }
    }
    if (record.kind === 'turn/finished') {
      const server = (byTurn.get(turnId) ?? []).flatMap(group => group.calls).filter(call => call.server);
      if (!server.length && payload.searchStatuses?.some(status => !status.query) && !(byTurn.get(turnId) ?? []).some(group => group.calls.some(call => call.name === 'web_search'))) {
        const call = callFor({ callId: 'server-search', name: 'web_search' }, 'server', index);
        call.server = true; server.push(call);
        call.status = payload.searchStatuses.at(-1)?.status === 'complete' ? 'complete' : payload.state === 'stopped' ? 'cancelled' : 'failed';
      }
      for (const call of server) call.summary = { sources: sourceSummary(payload.sources ?? []) };
      for (const group of (byTurn.get(turnId) ?? [])) for (const call of group.calls) {
        if (['queued', 'running'].includes(call.status)) call.status = payload.state === 'stopped' ? 'cancelled' : 'interrupted';
      }
    }
  }
  for (const group of groups) for (const call of group.calls) {
    if (['queued', 'running'].includes(call.status) && !runningTurnIds.has(group.turnId)) call.status = 'interrupted';
  }
  return groups;
}

module.exports = { toolHistory, toolSummary, parameters, updateToolGroups, sourceSummary };

// Only an already resolved path or a valid direct Vault path is displayable.
// Never guess a document-relative link's target without its source contents.
function toolImagePath(call) {
  const value = call.summary?.path ?? (call.arguments?.sourcePath == null ? call.arguments?.path : null);
  try { return imagePaths([value])[0]; } catch { return null; }
}
module.exports.toolImagePath = toolImagePath;
