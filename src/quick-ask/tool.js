// Read-only file and image tools, with separate session allowlists.
// A call resolves an exact normalized Vault Path from the session allowlist and
// returns the current complete content through the public read-only Vault API.

const FILE_NOT_FOUND = "文件不存在";
const FILE_READ_FAILED = "文件读取失败";
const CONTEXT_SPACE_EXHAUSTED = "上下文空间不足，无法读取完整文件";

const { createToolScheduler, DEFAULT_TOOL_CONCURRENCY } = require('./tool-scheduler');
const MAX_CONCURRENT_CALLS = DEFAULT_TOOL_CONCURRENCY;
const { imagePaths } = require('./images');
const { imageReadFailure } = require('./image-tool-results');
const { documentImagePath, exactMarkdownPath } = require('./image-link');
const GET_IMAGE_TOOL = Object.freeze({
  type: 'function', name: 'get-image', strict: true,
  description: 'Read an image authorized for access in the current session. Accepts only an exact Vault-relative path or an image link in a document previously sent by the user. Cannot search for images or access other images.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'With sourcePath null, the exact Vault-relative path of an authorized image. Otherwise, an image link from that Markdown document: its destination or complete Markdown/wikilink syntax. Markdown links are relative to the document, including paths without ./. Wikilinks starting with ./ or ../ are relative to the document; other wikilinks start at the Vault root. No same-name fallback.' },
      sourcePath: { type: ['string', 'null'], description: 'Exact Vault-relative path of a Markdown document previously sent in this session, when path is an image link from that document. Use null for a direct image path.' },
    },
    required: ['path', 'sourcePath'], additionalProperties: false,
  },
});

function createToolExecutor({
  vault,
  images = null,
  t = null,
  maxConcurrent = MAX_CONCURRENT_CALLS,
  getMaxConcurrent = () => maxConcurrent,
  onStatus = () => {},
} = {}) {
  void t;
  const scheduler = createToolScheduler(getMaxConcurrent);

  function createQuestionState({ allowlist = [], imageAllowlist = [] } = {}) {
    return { allowlist: new Set(allowlist), imageAllowlist: new Set(imageAllowlist), reads: new Map(), pendingReads: new Map() };
  }

  function cancelled(call) {
    return { ok: false, output: call?.name === 'get-image' ? 'Image read cancelled.' : call?.name === 'web_search' ? 'Search cancelled' : 'Cancelled',
      ...(call?.name === 'get-image' ? { image: true } : {}), ...(call?.name === 'web_search' ? { search: true } : {}) };
  }

  function executeCall(call, options = {}) {
    return scheduler.schedule(async () => {
      if (options.signal?.aborted) return cancelled(call);
      await options.onStart?.();
      return executeNow(call, options);
    }, { signal: options.signal, onCancel: () => cancelled(call) });
  }

  async function readFile(path, { question }) {
    // The same normalized path executes at most once per question; a repeat
    // returns the cached content without another source read.
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
  async function executeNow(call, { question, normalizePath = (value) => value, fitsInContext = () => true, search = null, signal = null } = {}) {
    if (call?.name === GET_IMAGE_TOOL.name) {
      const failure = (output, path) => ({ ok: false, image: true, output, ...(path ? { path } : {}) });
      if (signal?.aborted) return failure('Image read cancelled.');
      let path;
      // Validate before normalization so traversal/absolute paths cannot
      // normalize into an allowed path. Never reveal unrelated file state.
      const sourcePath = call.arguments?.sourcePath;
      if (sourcePath != null) {
        if (!exactMarkdownPath(sourcePath) || !question.allowlist.has(sourcePath)) return failure('Image unavailable or not authorized in this session.');
        let text;
        try { text = await vault.readText(sourcePath); }
        catch { return failure(imageReadFailure({ code: 'IMAGE_MISSING' })); }
        if (signal?.aborted) return failure('Image read cancelled.');
        if (text == null) return failure(imageReadFailure({ code: 'IMAGE_MISSING' }));
        try { path = documentImagePath(sourcePath, call.arguments?.path, text); }
        catch { return failure('Image unavailable or not authorized in this session.'); }
      } else {
        try { [path] = imagePaths([call.arguments?.path]); } catch { return failure('Image unavailable or not authorized in this session.'); }
        if (!question.imageAllowlist.has(path)) return failure('Image unavailable or not authorized in this session.');
      }
      if (!fitsInContext(path)) return failure('Context space exhausted; cannot read image.', path);
      try {
        const prepared = await images.readForSend([path]);
        if (signal?.aborted) return failure('Image read cancelled.', path);
        if (prepared?.length !== 1 || prepared[0]?.path !== path) return failure(imageReadFailure({ code: 'IMAGE_MISSING' }), path);
        question.imageAllowlist.add(path);
        return { ok: true, image: true, path, imagePaths: [path], output: `Image read: ${path}.` };
      } catch (error) {
        return failure(imageReadFailure(error), path);
      }
    }
    if (call?.name === "web_search") {
      if (signal?.aborted) return { ok: false, output: "Search cancelled", search: true };
      if (!search) return { ok: false, output: "Web search is disabled for this question", search: true };
      const result = await search(call.arguments?.query);
      return { ok: result.ok, search: true, result, output: JSON.stringify({ untrusted: true, ...result }) };
    }
    if (signal?.aborted) return { ok: false, output: "Cancelled" };
    const requested = typeof call?.arguments?.path === "string"
      ? call.arguments.path
      : typeof call?.path === "string" ? call.path : "";
    const path = normalizePath(requested);
    onStatus({ kind: "reading", path });
    let result;
    if (question.reads.has(path)) result = { status: 'cached', ...question.reads.get(path) };
    else if (!fitsInContext(path)) result = { status: 'context', output: CONTEXT_SPACE_EXHAUSTED };
    else if (question.pendingReads.has(path)) {
      result = await question.pendingReads.get(path);
      if (result.status === 'read') result = { ...result, status: 'cached' };
    } else {
      const pending = readFile(path, { question });
      question.pendingReads.set(path, pending);
      try { result = await pending; } finally { question.pendingReads.delete(path); }
    }
    if (signal?.aborted) return cancelled(call);
    const output = result.output;
    if (result.status === "read") {
      onStatus({ kind: "read", path });
      return { path, output, ok: true, read: true };
    }
    // The model sees the confirmed normalized text; the UI status names the
    // real reason so a full context is not shown as a missing file.
    const reason = result.status === "context" ? "context"
        : result.status === "denied" || result.status === "missing" ? "not-found"
          : "read-failed";
    onStatus({ kind: "error", path, reason, output });
    return { path, output, ok: result.status === "cached", read: false, status: result.status };
  }

  return { createQuestionState, executeCall, refreshConcurrency: scheduler.refresh, MAX_CONCURRENT_CALLS };
}

module.exports = {
  createToolExecutor,
  MAX_CONCURRENT_CALLS,
  FILE_NOT_FOUND,
  FILE_READ_FAILED,
  CONTEXT_SPACE_EXHAUSTED,
  GET_IMAGE_TOOL,
};
