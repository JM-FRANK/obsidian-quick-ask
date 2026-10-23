const DEFAULT_TOOL_CONCURRENCY = 3;
function normalizeToolConcurrency(value) {
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : DEFAULT_TOOL_CONCURRENCY;
}

// One FIFO queue per Quick Ask runtime, shared by every session and tool kind.
// Settings changes affect subsequent dispatch; active work finishes normally.
function createToolScheduler(getLimit = () => DEFAULT_TOOL_CONCURRENCY) {
  const queue = [];
  let active = 0;
  function drain() {
    while (active < normalizeToolConcurrency(getLimit()) && queue.length) {
      const job = queue.shift();
      job.signal?.removeEventListener('abort', job.abort);
      active++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { active--; drain(); });
    }
  }
  return {
    schedule(run, { signal, onCancel = () => undefined } = {}) {
      return new Promise((resolve, reject) => {
        const job = { run, resolve, reject, signal };
        job.abort = () => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1); signal?.removeEventListener('abort', job.abort);
          resolve(onCancel()); drain();
        };
        if (signal?.aborted) { resolve(onCancel()); return; }
        queue.push(job); signal?.addEventListener('abort', job.abort, { once: true }); drain();
      });
    },
    refresh: drain,
  };
}

module.exports = { createToolScheduler, normalizeToolConcurrency, DEFAULT_TOOL_CONCURRENCY };
