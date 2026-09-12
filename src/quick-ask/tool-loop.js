// The read-only tool continuation. When a completed attempt asks for
// `get-full-file`, Quick Ask executes the calls, appends the canonical
// function-call and function-call-output items, and continues the same turn.
// Tool calls, outputs, and the resulting synchronization baselines are
// append-only additions to the conversation.

const { GET_FULL_FILE_TOOL } = require("./prompt-renderer");

function functionCallsFrom(output) {
  if (!Array.isArray(output)) return [];
  return output
    .filter((item) => item?.type === "function_call" && item.name === GET_FULL_FILE_TOOL.name)
    .map((item) => ({
      id: item.id ?? null,
      callId: item.call_id ?? item.callId ?? null,
      name: item.name,
      arguments: parseArguments(item.arguments),
    }));
}

function parseArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Turn one batch of calls into the canonical continuation items.
function continuationItems({ calls, results }) {
  const items = [];
  calls.forEach((call, index) => {
    const result = results[index];
    items.push({
      type: "function_call",
      id: call.id ?? undefined,
      call_id: call.callId ?? undefined,
      name: call.name,
      arguments: typeof call.rawArguments === "string" ? call.rawArguments : JSON.stringify(call.arguments ?? {}),
    });
    items.push({
      type: "function_call_output",
      call_id: call.callId ?? undefined,
      output: result?.output ?? "",
    });
  });
  return items;
}

function createToolLoop({ executor, tracker = null, config = {} }) {
  const callLimit = Number.isInteger(config.callLimit) ? config.callLimit : 3;

  // A question's tool budget is fixed when the question starts.
  function beginQuestion({ allowlist = [], callLimit: limit } = {}) {
    return {
      state: executor.createQuestionState({ allowlist, callLimit: limit ?? callLimit }),
      statuses: [],
    };
  }

  // Execute one batch and return the items to append plus the status UI facts.
  async function runBatch(calls, question, { normalizePath = (value) => value, fitsInContext = () => true } = {}) {
    const results = [];
    for (const call of calls) {
      const result = await executor.executeCall(call, { question: question.state, normalizePath, fitsInContext });
      results.push(result);
      question.statuses.push(result.ok
        ? { kind: "read", path: result.path }
        : { kind: "error", path: result.path, output: result.output });
      // A successful read refreshes the synchronization baseline of a still
      // tracked file, and never restores tracking for a removed File Row.
      if (result.ok && tracker?.applyFullFileResult) tracker.applyFullFileResult(result.path, result.output);
    }
    return { items: continuationItems({ calls, results }), results };
  }

  function remaining(question) {
    return Math.max(0, question.state.callLimit - question.state.callsUsed);
  }

  return { beginQuestion, runBatch, remaining, callLimit };
}

module.exports = { createToolLoop, functionCallsFrom, continuationItems, parseArguments };
