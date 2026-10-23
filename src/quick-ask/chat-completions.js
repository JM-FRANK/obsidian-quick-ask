// Chat Completions wire adapter. The shared transport owns networking/retries;
// this module only builds native messages and folds protocol payloads.
function userMessage(content) { return { role: "user", content }; }
function assistantMessage(content) { return { role: "assistant", content }; }
function buildRequestBody({ model, instructions, input = [], tools = [], toolChoice = "auto", parallelToolCalls = true, maxOutputTokens, reasoningEffort, serverSearch } = {}) {
  const messages = serverSearch?.native ? input : input.map(item => {
    if (!item?.extra_content?.google?.nativeContent) return item;
    // Native search metadata belongs to our preserved response. Standard Chat
    // requests replay its text, without sending app-owned native wrapper fields.
    const { extra_content, ...message } = item;
    const { nativeContent, groundingMetadata, finishReason, safetyRatings, finishMessage, ...google } = extra_content.google;
    const remaining = { ...extra_content };
    if (Object.keys(google).length) remaining.google = google;
    else delete remaining.google;
    if (Object.keys(remaining).length) message.extra_content = remaining;
    return message;
  });
  const body = { model, messages: [{ role: "system", content: instructions ?? "" }, ...messages] };
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
  if (tools.length) Object.assign(body, { tools, tool_choice: toolChoice, parallel_tool_calls: parallelToolCalls });
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) body.max_completion_tokens = maxOutputTokens;
  if (serverSearch?.chatSearch === 'google-search') {
    // CPA's AGY Chat translator recognizes the native-shaped google_search
    // tool alongside the ordinary local function declarations.
    body.tools = [...tools, { google_search: {} }];
  } else if (serverSearch?.provider === "google") body.web_search_options = {};
  return body;
}
function functionTool(tool) {
  const { type, ...definition } = tool;
  return { type: "function", function: definition };
}
function functionCallsFrom(output) {
  return (output ?? []).flatMap(item => (item.tool_calls ?? []).map(call => ({
    id: call.id, callId: call.id, name: call.function?.name, arguments: call.function?.arguments ?? "",
  })));
}
function toolContinuationItems({ calls, outputs }) {
  return calls.map((call, index) => ({ role: "tool", tool_call_id: call.callId, content: outputs[index] ?? "" }));
}
function protocolError(message) { throw { kind: "protocol", message }; }
function accept(state, payload, emit) {
  if (state.chatCreated) return;
  state.chatCreated = true;
  state.responseId = typeof payload.id === "string" ? payload.id : null;
  emit({ type: "created", responseId: state.responseId });
}
function usage(state, value, emit) {
  if (!value || typeof value !== "object") return;
  state.usage = state.terminalUsage = value;
  const sample = { source: "terminal", usage: value };
  state.usageSamples.push(sample);
  emit({ type: "usage", ...sample });
}
function searchMetadata(state, message, emit) {
  if (Array.isArray(message.annotations)) {
    state.chatAnnotations ??= [];
    state.chatAnnotations.push(...message.annotations);
    if (message.annotations.some(annotation => annotation?.type === "url_citation")) emit({ type: "search-progress" });
  }
  // Keep opaque provider extensions without guessing a vendor-specific schema.
  if (message.extra_content && typeof message.extra_content === "object" && !Array.isArray(message.extra_content)) {
    state.chatExtraContent = { ...state.chatExtraContent, ...message.extra_content };
  }
}
function metadataFields(state) {
  return { ...(state.chatAnnotations ? { annotations: state.chatAnnotations } : {}),
    ...(state.chatExtraContent ? { extra_content: state.chatExtraContent } : {}) };
}
function complete(state, emit) {
  if (!state.chatFinish) protocolError("Chat Completions stream ended without a finish_reason");
  const calls = state.callOrder;
  if (state.chatFinish === "tool_calls" && !calls.length) protocolError("Missing Chat Completions tool calls");
  const ids = new Set();
  for (const call of calls) {
    if (ids.has(call.callId)) protocolError("Duplicate Chat Completions tool call ID");
    ids.add(call.callId);
    if (!call.callId || !call.name) protocolError("Incomplete Chat Completions tool call");
    call.emitted = state.chatFinish === "tool_calls";
    if (call.emitted) emit({ type: "function-call", ...call });
  }
  const message = state.chatMessage ?? assistantMessage(state.chatContent || (calls.length || state.chatRefusal ? null : ""));
  if (!state.chatMessage) Object.assign(message, state.chatReasoning ?? {});
  if (!state.chatMessage) Object.assign(message, metadataFields(state));
  if (!state.chatMessage && state.chatRefusal) message.refusal = state.chatRefusal;
  if (!state.chatMessage && calls.length) message.tool_calls = calls.map(call => ({
    id: call.callId, type: "function", function: { name: call.name, arguments: call.arguments },
  }));
  state.terminalOutput = [message];
  state.terminal = { type: "terminal", status: ["stop", "tool_calls"].includes(state.chatFinish) ? "completed" : "incomplete",
    responseId: state.responseId, incompleteReason: state.chatFinish === "stop" ? null : state.chatFinish, output: state.terminalOutput };
  emit(state.terminal);
}
function handleFrame(frame, state, emit) {
  if (state.terminal) return;
  if (frame.data.trim() === "[DONE]") { complete(state, emit); return; }
  let payload;
  try { payload = JSON.parse(frame.data); } catch { protocolError("Invalid Chat Completions stream JSON"); }
  if (payload.error) throw { kind: "provider", error: payload.error };
  if (!Array.isArray(payload.choices)) protocolError("Expected Chat Completions choices; check the selected protocol");
  if (payload.choices.length > 1 || payload.choices.some(choice => choice.index !== 0)) protocolError("Only one Chat Completions choice is supported");
  usage(state, payload.usage, emit);
  const choice = payload.choices[0];
  if (!choice) return;
  if (!choice.delta || typeof choice.delta !== "object") protocolError("Missing Chat Completions delta");
  accept(state, payload, emit);
  const delta = choice.delta;
  searchMetadata(state, delta, emit);
  for (const key of ["reasoning_content", "reasoning"]) {
    if (typeof delta[key] !== "string" || !delta[key]) continue;
    state.chatReasoning ??= {};
    state.chatReasoning[key] = (state.chatReasoning[key] ?? "") + delta[key];
  }
  // Pick one readable alias for this stream and append deltas directly;
  // comparing the growing prefix on every token makes long reasoning quadratic.
  state.chatReasoningKey ??= ["reasoning_content", "reasoning"].find(key => typeof delta[key] === "string" && delta[key]);
  const reasoningDelta = delta[state.chatReasoningKey];
  if (typeof reasoningDelta === "string" && reasoningDelta) {
    state.reasoning += reasoningDelta;
    emit({ type: "reasoning-text-delta", delta: reasoningDelta });
  }
  if (typeof delta.content === "string" && delta.content.length) {
    state.chatContent = (state.chatContent ?? "") + delta.content;
    state.text += delta.content; emit({ type: "text-delta", delta: delta.content });
  }
  if (typeof delta.refusal === "string" && delta.refusal.length) {
    state.chatRefusal = (state.chatRefusal ?? "") + delta.refusal;
    state.text += delta.refusal; emit({ type: "text-delta", delta: delta.refusal });
  }
  for (const part of delta.tool_calls ?? []) {
    if (part.type && part.type !== "function") protocolError("Unsupported Chat Completions tool type");
    if (!Number.isInteger(part.index) || part.index < 0) protocolError("Invalid Chat Completions tool index");
    let call = state.calls.get(part.index);
    if (!call) { call = { id: null, callId: null, name: "", arguments: "", emitted: false }; state.calls.set(part.index, call); state.callOrder.push(call); }
    if (part.id) call.id = call.callId = part.id;
    if (part.function?.name) call.name += part.function.name;
    if (part.function?.arguments) call.arguments += part.function.arguments;
  }
  if (choice.finish_reason != null) state.chatFinish = choice.finish_reason;
}
function fromResponse(payload, state, emit) {
  if (payload.error) throw { kind: "provider", error: payload.error };
  if (!Array.isArray(payload.choices) || payload.choices.length !== 1 || payload.choices[0].message?.role !== "assistant") {
    protocolError("Expected a Chat Completions assistant choice; check the selected protocol");
  }
  const choice = payload.choices[0];
  state.accepted = true;
  accept(state, payload, emit);
  state.chatMessage = choice.message;
  searchMetadata(state, choice.message, emit);
  state.reasoning = readableReasoning(choice.message);
  if (state.reasoning) emit({ type: "reasoning-text-delta", delta: state.reasoning });
  state.text = (typeof choice.message.content === "string" ? choice.message.content : "") + (choice.message.refusal ?? "");
  if (state.text) emit({ type: "text-delta", delta: state.text });
  state.callOrder = functionCallsFrom([choice.message]).map(call => ({ ...call, emitted: false }));
  state.chatFinish = choice.finish_reason;
  usage(state, payload.usage, emit);
  complete(state, emit);
}
// Prefer the explicit reasoning_content alias if both strings are supplied.
// Opaque/encrypted provider state is never interpreted as readable reasoning.
function readableReasoning(message) {
  return typeof message?.reasoning_content === "string" && message.reasoning_content
    ? message.reasoning_content : typeof message?.reasoning === "string" ? message.reasoning : "";
}
function partialOutput(state) {
  if (!state.chatCreated) return null;
  return [{ ...assistantMessage(state.chatContent ?? ""), ...state.chatReasoning,
    ...metadataFields(state),
    ...(state.chatRefusal ? { refusal: state.chatRefusal } : {}) }];
}
// The Chat Completions wire adapter: everything the shared transport shell
// needs in order to run one attempt without knowing which protocol it is.
const CHAT_COMPLETIONS_PATH = "/chat/completions";
const CHAT_STREAM_BODY_EXTRAS = Object.freeze({
  stream_options: Object.freeze({ include_usage: true }),
});
const chatWire = Object.freeze({
  id: "chat-completions",
  createUrl: baseUrl => `${baseUrl}${CHAT_COMPLETIONS_PATH}`,
  streamBodyExtras: CHAT_STREAM_BODY_EXTRAS,
  handleFrame,
  eventsFromResponse: fromResponse,
  partialOutput,
});
module.exports = { chatWire, readableReasoning, partialOutput, userMessage, assistantMessage, buildRequestBody, functionTool, functionCallsFrom, toolContinuationItems, handleFrame, fromResponse };
