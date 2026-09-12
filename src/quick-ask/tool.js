// The read-only `get-full-file` tool. It is the only tool Quick Ask exposes:
// no built-in tools, no file mutation, no Vault search, and no file discovery.
// A call resolves an exact normalized Vault Path from the session allowlist and
// returns the current complete content through the public read-only Vault API.

const FILE_NOT_FOUND = "文件不存在";
const FILE_READ_FAILED = "文件读取失败";
const CONTEXT_SPACE_EXHAUSTED = "上下文空间不足，无法读取完整文件";

// At most three calls execute at once; a larger per-question budget is queued in
// batches while the total limit is preserved.
const MAX_CONCURRENT_CALLS = 3;

function createToolExecutor({
  vault,
  t = null,
  maxConcurrent = MAX_CONCURRENT_CALLS,
  onStatus = () => {},
} = {}) {
  void t;
  const queue = [];
  let active = 0;

  function runNext() {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      void job.run();
    }
  }

  function schedule(execute) {
    return new Promise((resolve) => {
      queue.push({
        run: async () => {
          try {
            resolve(await execute());
          } finally {
            active -= 1;
            runNext();
          }
        },
      });
      runNext();
    });
  }

  // One question's tool state: the remaining call allowance, the paths already
  // read, and the allowlist snapshot for that session.
  function createQuestionState({ allowlist = [], callLimit = 3 } = {}) {
    return {
      allowlist: new Set(allowlist),
      callLimit,
      callsUsed: 0,
      reads: new Map(),
    };
  }

  async function readFile(path, { question }) {
    // The same normalized path executes at most once per question; a repeat
    // returns the cached content without consuming another call.
    if (question.reads.has(path)) return { status: "cached", ...question.reads.get(path) };
    if (!question.allowlist.has(path)) {
      // A non-allowlisted path and a missing allowlisted path return the same
      // text, so the result never discloses whether another Vault path exists.
      return { status: "denied", output: FILE_NOT_FOUND };
    }
    let text;
    try {
      text = await vault.readText(path);
    } catch {
      // The normalized error never carries the operating-system path or the
      // underlying exception.
      return { status: "failed", output: FILE_READ_FAILED };
    }
    if (typeof text !== "string") return { status: "missing", output: FILE_NOT_FOUND };
    const record = { output: text, path };
    question.reads.set(path, record);
    return { status: "read", ...record };
  }

  // Execute one tool call from the model. `normalizePath` comes from the host's
  // public normalizePath so the requested path matches the allowlist exactly.
  async function executeCall(call, { question, normalizePath = (value) => value, fitsInContext = () => true } = {}) {
    const requested = typeof call?.arguments?.path === "string"
      ? call.arguments.path
      : typeof call?.path === "string" ? call.path : "";
    const path = normalizePath(requested);
    onStatus({ kind: "reading", path });
    const result = await schedule(async () => {
      // A repeated path was already answered for this question, so it neither
      // reads the file again nor consumes another execution.
      if (question.reads.has(path)) return { status: "cached", ...question.reads.get(path) };
      if (question.callsUsed >= question.callLimit) {
        return { status: "limit", output: FILE_READ_FAILED };
      }
      // Every other execution consumes one call from the question, including an
      // attempt rejected because its result cannot fit the context window.
      question.callsUsed += 1;
      if (!fitsInContext(path)) {
        return { status: "context", output: CONTEXT_SPACE_EXHAUSTED };
      }
      return await readFile(path, { question });
    });
    const output = result.output;
    if (result.status === "read") {
      onStatus({ kind: "read", path });
      return { path, output, ok: true, read: true };
    }
    // The model sees the confirmed normalized text; the UI status names the
    // real reason so a spent budget is not shown as a missing file.
    const reason = result.status === "limit" ? "limit"
      : result.status === "context" ? "context"
        : result.status === "denied" || result.status === "missing" ? "not-found"
          : "read-failed";
    onStatus({ kind: "error", path, reason, output });
    return { path, output, ok: result.status === "cached", read: false, status: result.status };
  }

  return { createQuestionState, executeCall, MAX_CONCURRENT_CALLS };
}

module.exports = {
  createToolExecutor,
  MAX_CONCURRENT_CALLS,
  FILE_NOT_FOUND,
  FILE_READ_FAILED,
  CONTEXT_SPACE_EXHAUSTED,
};
