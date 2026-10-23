// Presentation is replaceable latest state, not another conversation log.
function createProjectionPublisher(scheduler, publish) {
  const pending = new Map();
  let frame = null;
  const cancel = () => { if (frame !== null) scheduler.cancelFrame(frame); frame = null; };
  const flush = () => {
    cancel();
    const values = [...pending.values()];
    pending.clear();
    for (const value of values) publish(value);
  };
  return {
    push(value) {
      if (value.kind !== "text" && value.kind !== "reasoning") { flush(); publish(value); return; }
      pending.set(value.kind, value);
      if (frame === null) frame = scheduler.frame(flush);
    },
    flush,
    dispose() { cancel(); pending.clear(); },
  };
}

// Content growth must not be mistaken for the reader scrolling upward.
function createScrollFollow(threshold = 24) {
  let following = true;
  let lastTop = 0;
  return {
    get following() { return following; },
    submit() { following = true; },
    pause() { following = false; },
    positioned(top) { lastTop = top; },
    scroll({ top, height, viewport }) {
      if (top < lastTop - 1) following = false;
      else if (top > lastTop + 1 && height - viewport - top <= threshold) following = true;
      lastTop = top;
      return following;
    },
  };
}

module.exports = { createProjectionPublisher, createScrollFollow };
