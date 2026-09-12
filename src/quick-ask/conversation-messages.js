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
  for (const record of records ?? []) {
    const payload = record.payload ?? {};
    if (record.kind === "turn/started") assistant = null;
    if (record.kind === "item/input" && payload.item?.type === "message") {
      const text = (payload.item.content ?? []).map(block => block.text ?? "").join("");
      const question = questionFromInput(text);
      if (question !== null) messages.push({ role: "user", text: question });
    }
    if (record.kind === "item/output" && payload.tool !== true && payload.item?.type === "message") {
      const text = (payload.item.content ?? []).map(block => block.text ?? "").join("");
      if (text) { assistant = { role: "assistant", text }; messages.push(assistant); }
    }
    if (record.kind === "turn/finished") {
      if (!assistant && (payload.text || payload.reasoning)) {
        assistant = { role: "assistant", text: payload.text ?? "" };
        messages.push(assistant);
      }
      if (assistant && payload.reasoning) assistant.reasoning = payload.reasoning;
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
