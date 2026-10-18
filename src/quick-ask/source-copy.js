// Clipboard feedback shared by code, diagrams, formulas and Markdown tables.
// The caller owns the window-local timer and visible button.
function createSourceCopy({ write, feedback, failed, delay, cancelDelay }) {
  let disposed = false, revision = 0, timer = null;
  return {
    async copy(source) {
      const current = ++revision;
      if (disposed) return;
      try {
        await write(source);
        if (disposed || current !== revision) return;
        if (timer !== null) cancelDelay(timer);
        feedback(true);
        timer = delay(1000, () => { timer = null; if (!disposed) feedback(false); });
      } catch {
        if (disposed || current !== revision) return;
        if (timer !== null) cancelDelay(timer);
        timer = null;
        feedback(false);
        failed();
      }
    },
    dispose() {
      disposed = true;
      revision++;
      if (timer !== null) cancelDelay(timer);
      timer = null;
    },
  };
}

module.exports = { createSourceCopy };
