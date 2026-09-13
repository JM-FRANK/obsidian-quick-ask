const { citedAnswer } = require("./web-search");
const { isMessage, messageText, messageReasoning } = require("./protocol");
// Reconstruct visible turns without losing their original Markdown or moving
// readable reasoning into a separate, later assistant message.
function questionFromInput(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.startsWith("<quick_ask_context>")) return null;
  return trimmed || null;
}

function conversationFromRecords(records) {
  const messages = [];
  let assistant = null;
  let nativeReasoning = "";
  for (const record of records ?? []) {
    const payload = record.payload ?? {};
    if (record.kind === "turn/started") { assistant = null; nativeReasoning = ""; }
    if (record.kind === "item/output") nativeReasoning += messageReasoning(payload.item);
    if (record.kind === "item/input" && isMessage(payload.item)) {
      const text = messageText(payload.item);
      const question = questionFromInput(text);
      if (question !== null) messages.push({ role: "user", text: question });
    }
    if (record.kind === "item/output" && payload.tool !== true && isMessage(payload.item)) {
      const text = messageText(payload.item);
      if (text) { assistant = { role: "assistant", text }; const displayText = citedAnswer(text, [payload.item]); if (displayText !== text) assistant.displayText = displayText; messages.push(assistant); }
    }
    if (record.kind === "turn/finished") {
      if (!assistant && (payload.text || payload.reasoning || nativeReasoning)) {
        assistant = { role: "assistant", text: payload.text ?? "" };
        messages.push(assistant);
      }
      if (assistant && payload.displayText && payload.displayText !== assistant.text) assistant.displayText = payload.displayText;
      if (assistant && (payload.reasoning || nativeReasoning)) assistant.reasoning = payload.reasoning || nativeReasoning;
      if (assistant && payload.sources?.length) assistant.sources = payload.sources;
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

module.exports = { conversationFromRecords, questionFromInput };
