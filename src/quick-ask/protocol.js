const responses = require("./transport");
const chat = require("./chat-completions");
// The one place that knows both request protocols. Every protocol difference
// lives in these two descriptors: the wire adapter the shared transport shell
// runs (endpoint, streaming extras, frame and payload folding, partial output),
// the request body and message shapes, the tool wire shape, the continuation
// items, and the supported-capability flags. Adding a protocol means adding a
// descriptor here, not editing the transport or the conversation.
const RESPONSE_PROTOCOL = Object.freeze({
  ...responses.RESPONSES_WIRE,
  remoteCompaction: true, inputTokens: true, serverSearch: true,
  // A stored response can still be retrieved for a run interrupted before the
  // local replay model became the default.
  storedResponses: true,
  // A finished turn does not have to spell out unexecuted tool calls: the next
  // request replays the call items and their outputs as they stand.
  answersEveryToolCall: false,
  // An empty tools array is a valid request here.
  emptyToolsAreInvalid: false,
  userMessage: responses.responsesUserMessage,
  assistantMessage: responses.responsesAssistantMessage,
  buildRequestBody: responses.buildRequestBody,
  functionTool: tool => tool,
  toolContinuationItems: responses.responsesToolContinuationItems,
});
const CHAT_PROTOCOL = Object.freeze({
  ...chat.chatWire,
  remoteCompaction: false, inputTokens: false, serverSearch: false,
  storedResponses: false,
  // Every native tool call keeps a matching tool message, so a turn that ends
  // without a usable tool batch still records explicit non-execution results.
  answersEveryToolCall: true,
  // Sending `tools: []` is rejected, so the fields are dropped instead.
  emptyToolsAreInvalid: true,
  userMessage: chat.userMessage, assistantMessage: chat.assistantMessage,
  buildRequestBody: chat.buildRequestBody, functionTool: chat.functionTool,
  toolContinuationItems: chat.toolContinuationItems,
});
function protocolFor(config) {
  const id = config?.protocol ?? "responses";
  if (id === "responses") return RESPONSE_PROTOCOL;
  if (id === "chat-completions") return CHAT_PROTOCOL;
  throw new Error("Unsupported Quick Ask request protocol");
}
// Reading a preserved protocol-native item is not conversion. These projections
// are used by display, compaction boundaries and metering, never to rewrite logs.
function isMessage(item) { return responses.isResponsesMessage(item) || (!item?.type && ["user", "assistant", "system"].includes(item?.role)); }
function messageText(item) { return (typeof item?.content === "string" ? item.content : responses.responsesMessageText(item)) + (typeof item?.refusal === "string" ? item.refusal : ""); }
// Readable reasoning carried inside a message item. Only Chat Completions puts
// it in the message fields; Responses keeps dedicated reasoning items, which the
// turn record already restores, so this stays empty for them.
function messageReasoning(item) { return chat.readableReasoning(item); }
function isUserMessage(item) { return isMessage(item) && item.role === "user"; }
function isToolOutput(item) { return responses.isResponsesFunctionCallOutput(item) || item?.role === "tool"; }
function callsFromItem(item) {
  return responses.isResponsesFunctionCall(item) ? [{ callId: item.call_id ?? item.id }]
    : chat.functionCallsFrom([item]);
}
function toolOutputId(item) { return item.tool_call_id ?? item.call_id ?? item.id; }
function truncateOutput(item, truncate) { return item.role === "tool" ? { ...item, content: truncate(item.content) } : { ...item, output: truncate(item.output) }; }
module.exports = { protocolFor, isMessage, messageText, messageReasoning, isUserMessage, isToolOutput, callsFromItem, toolOutputId, truncateOutput };
