const { protocolFor } = require("./protocol");
// The read-only tool continuation. When a completed attempt asks for
// `get-full-file`, Quick Ask executes the calls, appends the canonical
// function-call and function-call-output items, and continues the same turn.
// Tool calls, outputs, and the resulting synchronization baselines are
// append-only additions to the conversation.

const { GET_FULL_FILE_TOOL, numberLines } = require("./prompt-renderer");
const { responsesFunctionCallsFrom } = require("./transport");
const { GET_IMAGE_TOOL } = require('./tool');

// Which calls Quick Ask accepts is domain policy. Reading the wire function
// calls belongs to transport with the rest of the Responses vocabulary.
const TOOL_NAMES = Object.freeze([GET_FULL_FILE_TOOL.name, "web_search", GET_IMAGE_TOOL.name]);

function functionCallsFrom(output) {
  return responsesFunctionCallsFrom(output).filter((call) => TOOL_NAMES.includes(call.name));
}

// A domain call record becomes a wire-ready call: its arguments are serialized
// once here, so transport only pairs wire calls with their outputs.
function wireCalls(calls) {
  return calls.map((call) => ({
    id: call.id,
    callId: call.callId,
    name: call.name,
    arguments: typeof call.rawArguments === "string" ? call.rawArguments : JSON.stringify(call.arguments ?? {}),
  }));
}

function createToolLoop({ executor, tracker = null, config = {} }) {

  function beginQuestion({ allowlist = [], imageAllowlist = [] } = {}) {
    return {
      state: executor.createQuestionState({ allowlist, imageAllowlist }),
      statuses: [],
    };
  }

  // Execute one batch and return the items to append plus the status UI facts.
  async function runBatch(calls, question, { normalizePath = (value) => value, fitsInContext = () => true, search = null, signal = null,
    onCallQueued = async () => {}, onCallStart = async () => {}, onCallEnd = async () => {} } = {}) {
    const results = await Promise.all(calls.map(async (call, index) => {
      await onCallQueued(call, index);
      let result;
      try {
        result = TOOL_NAMES.includes(call.name)
          ? await executor.executeCall(call, { question: question.state, normalizePath, fitsInContext, search, signal,
            onStart: () => onCallStart(call, index) })
          : { ok: false, output: 'Unsupported tool; not executed' };
      } catch {
        result = { ok: false, output: signal?.aborted ? 'Cancelled' : 'Tool execution failed.' };
      }
      await onCallEnd(call, index, result);
      return result;
    }));
    // Native continuation results and file baselines stay in model call order,
    // regardless of completion order. One failure never cancels its siblings.
    for (const result of results) {
      question.statuses.push(result.search ? { kind: "search", ok: result.ok, code: result.result?.code, sources: result.result?.sources ?? [] } : result.ok
        ? { kind: "read", path: result.path }
        : { kind: "error", path: result.path, output: result.output });
      // A successful read refreshes the synchronization baseline of a still
      // tracked file, and never restores tracking for a removed File Row.
      if (result.ok && !result.search && !result.image && tracker?.applyFullFileResult) tracker.applyFullFileResult(result.path, result.output);
    }
    return {
      items: protocolFor(config).toolContinuationItems({
        calls: wireCalls(calls),
        outputs: results.map(result => config.rendererVersion >= 2 && result.ok && !result.search && !result.image ? numberLines(result.output) : result?.output ?? ""),
      }),
      results,
    };
  }

  return { beginQuestion, runBatch };
}

module.exports = { createToolLoop, functionCallsFrom, TOOL_NAMES };
