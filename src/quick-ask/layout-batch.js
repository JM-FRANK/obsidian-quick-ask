// Coalesce invalidations and keep geometry reads ahead of every style write.
// Tasks provide read()/write(value); no DOM or global window is required here.
function createLayoutBatch({ frame, cancelFrame }) {
  const pending = new Set();
  let scheduled = null;
  const flush = () => {
    scheduled = null;
    const tasks = [...pending];
    pending.clear();
    const measurements = tasks.map(task => [task, task.read()]);
    for (const [task, value] of measurements) task.write(value);
  };
  return {
    add(task) {
      pending.add(task);
      if (scheduled === null) scheduled = frame(flush);
    },
    remove(task) {
      pending.delete(task);
      if (!pending.size && scheduled !== null) {
        cancelFrame(scheduled);
        scheduled = null;
      }
    },
    dispose() {
      if (scheduled !== null) cancelFrame(scheduled);
      scheduled = null;
      pending.clear();
    },
  };
}

module.exports = { createLayoutBatch };
