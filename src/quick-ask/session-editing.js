// Pure projections shared by runtime, storage and presentation. Physical logs
// retain billed attempts; only the effective conversation can grant permissions.
const { normalizeProviderProfiles } = require('./provider-profiles');
const { normalizeProfiles } = require('./profiles');
const { createTurnUsage, createSessionUsage } = require('./tokens');
const { callsFromItem, isToolOutput, toolOutputId } = require('./protocol');

const LIFECYCLE = new Set(['context/file-renamed', 'context/file-deleted', 'context/file-removed']);
// Legacy logs have prompt text but no role identity. Infer a display label only
// from one exact match; never attach that inferred identity to request config.
function legacyRoleProfile(config, settings) {
  if (!config || config.systemProfileId || config.systemProfileName || typeof config.systemPrompt !== 'string') return null;
  let match = null;
  for (const profile of normalizeProfiles(settings).systemProfiles) {
    if (profile.prompt !== config.systemPrompt) continue;
    if (match) return null;
    match = { id: profile.id, name: profile.name };
  }
  return match;
}
function effectiveRecords(records = []) {
  records ??= [];
  const withdrawn = new Set(records.filter(r => r.kind === 'session/withdrawn').map(r => r.payload?.turnId));
  let owner = null;
  return records.filter(record => {
    if (record.kind === 'turn/started') owner = record.payload?.turnId;
    if (record.kind.startsWith('session/') || LIFECYCLE.has(record.kind)) return true;
    return !withdrawn.has(record.payload?.turnId ?? owner);
  });
}
function latestTurn(records) { return effectiveRecords(records).findLast(r => r.kind === 'turn/started'); }
function recoverableDraft(value) {
  return value?.version === 1 && typeof value.composer === 'string' &&
    Array.isArray(value.pending?.files) && Array.isArray(value.pending?.selections) && Array.isArray(value.images);
}
function restoredDraft(records = []) {
  const record = records.findLast(r => ['session/withdrawn', 'turn/started'].includes(r.kind));
  return record?.kind === 'session/withdrawn' && recoverableDraft(record.payload?.draft) ? record.payload.draft : null;
}
function compactionUsage(value) {
  const usage = createTurnUsage();
  for (const sample of Array.isArray(value) ? value : value ? [{ source: 'terminal', usage: value }] : [])
    usage.record(sample, { attemptId: sample.attemptId });
  return usage.totals();
}
function sessionUsage(records = []) {
  const total = createSessionUsage();
  let usage = createTurnUsage();
  for (const record of records) {
    const p = record.payload ?? {};
    if (record.kind === 'turn/started') usage = createTurnUsage();
    if (record.kind === 'turn/usage') usage.record(p, { attemptId: p.attemptId ?? `attempt-${usage.attempts() + 1}` });
    if (record.kind === 'compaction/checkpoint' && p.usage) total.addTurn(compactionUsage(p.usage));
    if (record.kind === 'turn/finished') {
      if (Array.isArray(p.usageSamples)) {
        usage = createTurnUsage();
        for (const sample of p.usageSamples) usage.record(sample, { attemptId: sample.attemptId });
      }
      total.addTurn(usage.totals());
    }
  }
  return total;
}
function modelChoices(settings, protocol, defaultName = 'Default connection') {
  const entries = normalizeProviderProfiles(settings).providerProfiles.flatMap(profile => profile.models
    .filter(model => model.id && model.protocol === protocol).map(model => ({
      profileId: profile.id, profileName: profile.name ?? defaultName, model: model.id,
      config: { providerProfileId: profile.id, providerProfileName: profile.name, providerSearchMode: profile.searchMode,
        baseUrl: profile.baseUrl, secretId: profile.secretId, protocol: model.protocol, model: model.id,
        contextWindowTokens: model.contextWindowTokens },
    })));
  const counts = new Map();
  for (const entry of entries) counts.set(entry.model, (counts.get(entry.model) ?? 0) + 1);
  return entries.map(entry => ({ ...entry, label: counts.get(entry.model) > 1 ? `${entry.profileName} · ${entry.model}` : entry.model }));
}
// Keep the display policy independent of selection state for a future setting.
function selectionLabel(model, effort, mode = 'effort') {
  return mode === 'model' ? model : mode === 'both' ? `${model} · ${effort}` : effort;
}
function hasPendingDraft(draft, trackedFiles = []) {
  const tracked = new Set(trackedFiles.filter(file => file.status !== 'staged').map(file => file.path));
  return Boolean(draft?.composer || draft?.pending?.selections?.length || draft?.images?.length || draft?.pending?.images?.length ||
    draft?.pending?.files?.some(file => !tracked.has(file.path)) || trackedFiles.some(file => file.status === 'staged'));
}
function inheritSessionRole(defaults, current) {
  if (!current) return { ...defaults };
  return { ...defaults, systemPrompt: current.systemPrompt ?? '',
    systemProfileId: current.systemProfileId ?? null, systemProfileName: current.systemProfileName ?? null };
}
function changedConnection(a, b) {
  return ['baseUrl', 'secretId', 'model'].some(key => a?.[key] !== b?.[key]);
}
function portableItems(items, protocol, copy = () => {}) {
  const projected = [];
  for (const [index, item] of items.entries()) {
    let next;
    if (protocol === 'responses') {
      if (item.type === 'message') {
        if (!['user', 'assistant'].includes(item.role) || !Array.isArray(item.content)) throw new Error('HISTORY_INCOMPATIBLE');
        const content = item.content.map(block => {
          if (['input_text', 'output_text'].includes(block.type)) return { type: block.type, text: block.text };
          if (block.type === 'refusal') return { type: 'refusal', refusal: block.refusal };
          if (block.type === 'input_image') return { type: 'input_image', image_url: block.image_url };
          throw new Error('HISTORY_INCOMPATIBLE');
        });
        next = { type: 'message', role: item.role, content };
      } else if (item.type === 'function_call') next = { type: item.type, call_id: item.call_id, name: item.name, arguments: item.arguments };
      else if (item.type === 'function_call_output') next = { type: item.type, call_id: item.call_id, output: item.output };
      else if (['reasoning', 'web_search_call', 'compaction'].includes(item.type)) continue;
      else throw new Error('HISTORY_INCOMPATIBLE');
    } else {
      if (!['user', 'assistant', 'tool'].includes(item.role)) throw new Error('HISTORY_INCOMPATIBLE');
      let content = item.content ?? null;
      if (Array.isArray(content)) content = content.map(block => {
        if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
        if (block.type === 'image_url' && typeof block.image_url?.url === 'string') return { type: 'image_url', image_url: { url: block.image_url.url } };
        throw new Error('HISTORY_INCOMPATIBLE');
      });
      else if (content !== null && typeof content !== 'string') throw new Error('HISTORY_INCOMPATIBLE');
      next = { role: item.role, content };
      if (typeof item.refusal === 'string') next.refusal = item.refusal;
      if (item.role === 'tool') next.tool_call_id = item.tool_call_id;
      if (item.tool_calls) next.tool_calls = item.tool_calls.map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } }));
    }
    copy(item, next, index); projected.push(next);
  }
  // Refuse unmatched / duplicate tool calls instead of silently dropping them.
  const pending = new Set(), seen = new Set();
  for (const item of projected) {
    const calls = callsFromItem(item);
    if (!isToolOutput(item) && pending.size && !calls.length) throw new Error('HISTORY_INCOMPATIBLE');
    for (const call of calls) {
      if (!call.callId || seen.has(call.callId)) throw new Error('HISTORY_INCOMPATIBLE');
      pending.add(call.callId); seen.add(call.callId);
    }
    if (isToolOutput(item) && !pending.delete(toolOutputId(item))) throw new Error('HISTORY_INCOMPATIBLE');
  }
  if (pending.size) throw new Error('HISTORY_INCOMPATIBLE');
  return projected;
}
module.exports = { effectiveRecords, latestTurn, recoverableDraft, restoredDraft, sessionUsage, modelChoices, selectionLabel, changedConnection, portableItems, inheritSessionRole, compactionUsage, hasPendingDraft, legacyRoleProfile };
