const { effectiveRecords } = require("./session-editing");
const { citedAnswer } = require("./web-search");
const { isMessage, messageText, messageReasoning } = require("./protocol");
const { selectionSnapshots } = require("./history-selections");
const { toolHistory } = require('./tool-history');
// Reconstruct visible turns without losing their original Markdown or moving
// readable reasoning into a separate, later assistant message.
function questionFromInput(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("<quick_ask_context>")) return null;
  return trimmed || null;
}

function legacyConversationFromRecords(records) {
  const messages = [];
  let assistant = null;
  let nativeReasoning = "";
  let selections = [];
  let turnId = null, config = null, editable = false;
  const tools = new Map(toolHistory(records ?? []).map(group => [group.index, group]));
  for (const [index, record] of (records ?? []).entries()) {
    if (tools.has(index)) messages.push(tools.get(index));
    const payload = record.payload ?? {};
    if (record.kind === "turn/started") {
      assistant = null; nativeReasoning = ""; turnId = payload.turnId; config = payload.config ?? null; editable = Boolean(payload.editDraft);
      selections = selectionSnapshots(payload.additions);
    }
    if (record.kind === "item/output") nativeReasoning += messageReasoning(payload.item);
    if (record.kind === "item/input") {
      const items = payload.items ?? (payload.item ? [payload.item] : []);
      for (const [position, item] of items.entries()) {
        if (!isMessage(item)) continue;
        const text = messageText(item);
        // Context envelopes are data, even when a selection contains tag-like text.
        if (String(text).trim().startsWith("<quick_ask_context>")) continue;
        const question = questionFromInput(text);
        const images = position === items.length - 1 ? payload.images : null;
        if (question !== null || images?.length || selections.length) {
          messages.push({ role: "user", ...(editable && turnId ? { turnId } : {}), text: question ?? "", ...(images?.length ? { images } : {}),
            ...(selections.length ? { selections } : {}) });
          selections = [];
        }
      }
    }
    if (record.kind === "item/output" && payload.tool !== true && isMessage(payload.item)) {
      const text = messageText(payload.item);
      if (text) { assistant = { role: "assistant", text }; const displayText = citedAnswer(text, [payload.item]); if (displayText !== text) assistant.displayText = displayText; messages.push(assistant); }
    }
    if (record.kind === "turn/finished") {
      selections = [];
      if (!assistant && (payload.text || payload.reasoning || nativeReasoning)) {
        assistant = { role: "assistant", text: payload.text ?? "" };
        messages.push(assistant);
      }
      if (assistant && editable) { assistant.turnId = turnId; if ((payload.config ?? config)?.model) assistant.model = (payload.config ?? config).model; }
      if (assistant && payload.displayText && payload.displayText !== assistant.text) assistant.displayText = payload.displayText;
      if (assistant && (payload.reasoning || nativeReasoning)) assistant.reasoning = payload.reasoning || nativeReasoning;
      if (assistant && payload.sources?.length) assistant.sources = payload.sources;
      if (assistant && payload.searchSuggestions?.length) assistant.searchSuggestions = payload.searchSuggestions;
      if (assistant && payload.searchStatuses?.length) assistant.searchStatuses = payload.searchStatuses;
      if (payload.state === "interrupted") messages.push({ kind: "interrupted", text: payload.error?.message ?? "" });
    }
    if (record.kind === "compaction/checkpoint") messages.push({
      kind: "compaction", ...(payload.trigger === "manual" ? { manual: true } : {}), items: (payload.range?.to ?? 0) - (payload.range?.from ?? 0) + 1,
      before: payload.estimatedBefore, after: payload.estimatedAfter,
    });
  }
  return messages;
}

// New and old turns can share a log. Only explicitly versioned turns use the
// ordered display projection; old records keep their original interpretation.
function conversationFromRecords(records = []) {
  records = effectiveRecords(records);
  if (!(records ?? []).some(record => record.kind === "turn/started" && record.payload?.processVersion === 1))
    return legacyConversationFromRecords(records);
  const messages = [];
  let chunk = [];
  const flush = () => {
    if (!chunk.length) return;
    const start = chunk.find(record => record.kind === 'turn/started');
    messages.push(...(start?.payload?.processVersion === 1 ? processConversation(chunk) : legacyConversationFromRecords(chunk)));
    chunk = [];
  };
  for (const record of records ?? []) {
    if (record.kind === 'turn/started') flush();
    chunk.push(record);
    if (record.kind === "turn/finished") flush();
  }
  flush(); return messages;
}

function processConversation(records) {
  const { restoreProcess, processParts } = require('./turn-process');
  const base = legacyConversationFromRecords(records);
  const start = records.find(record => record.kind === 'turn/started').payload;
  const finished = records.findLast(record => record.kind === 'turn/finished')?.payload;
  const groups = toolHistory(records);
  const byGroup = new Map(groups.map(group => [group.id, group]));
  const parts = processParts(restoreProcess(records.filter(record => record.payload?.turnId === start.turnId)), finished?.text);
  const steps = parts.steps.map(step => step.kind !== 'tool' ? step : {
    ...step, call: byGroup.get(step.groupId)?.calls.find(call => call.callId === step.callId),
  });
  // Missing optional metadata must not hide readable reasoning or tool calls.
  const recordedReasoning = steps.filter(step => step.kind === 'reasoning').map(step => step.text).join('');
  const reasoning = finished?.reasoning || base.filter(entry => entry.role === 'assistant').map(entry => entry.reasoning ?? '').join('');
  if (reasoning && reasoning !== recordedReasoning) {
    const text = reasoning.startsWith(recordedReasoning) ? reasoning.slice(recordedReasoning.length) : reasoning;
    steps.push({ kind: 'reasoning', id: 'unsegmented-reasoning', text, unsegmented: true });
  }
  const knownCalls = new Set(steps.filter(step => step.kind === 'tool').map(step => `${step.groupId}\n${step.callId}`));
  for (const group of groups) for (const call of group.calls) {
    if (!knownCalls.has(`${group.id}\n${call.callId}`)) steps.push({ kind: 'tool', id: `unsegmented:${group.id}:${call.callId}`, groupId: group.id, callId: call.callId, call, unsegmented: true });
  }
  const answer = base.findLast(entry => entry.role === 'assistant');
  const firstStep = records.findIndex(record => ['turn/process', 'turn/tool-started', 'turn/tool-finished'].includes(record.kind));
  const checkpoints = records.flatMap((record, index) => record.kind === 'compaction/checkpoint' ? [index] : []);
  const result = [], afterProcess = [];
  for (const entry of base) {
    if (entry.role === 'assistant' || entry.kind === 'tools' || entry.kind === 'interrupted') continue;
    const after = entry.kind === 'compaction' && checkpoints.shift() > firstStep && firstStep >= 0;
    (after ? afterProcess : result).push(entry);
  }
  if (steps.length) result.push({ kind: 'process', id: start.turnId, turnId: start.turnId,
    status: finished?.state ?? 'interrupted', steps });
  result.push(...afterProcess);
  if (answer?.text) {
    const { reasoning: _reasoning, ...visible } = answer;
    result.push({ ...visible, turnId: start.turnId });
  } else if (finished && parts.answer) result.push({ role: 'assistant', text: parts.answer, turnId: start.turnId });
  result.push(...base.filter(entry => entry.kind === 'interrupted'));
  return result;
}

module.exports = { conversationFromRecords, questionFromInput };
