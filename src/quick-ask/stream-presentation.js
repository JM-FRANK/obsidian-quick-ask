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

const REASONING_PAGE_SIZE = 4096;
function reasoningPage(text, requested = null) {
  const count = Math.max(1, Math.ceil(text.length / REASONING_PAGE_SIZE));
  const page = requested === null ? count - 1 : Math.max(0, Math.min(count - 1, requested));
  const boundary = at => at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at]) && /[\uD800-\uDBFF]/.test(text[at - 1]) ? at - 1 : at;
  const from = boundary(page * REASONING_PAGE_SIZE);
  const to = boundary(Math.min(text.length, (page + 1) * REASONING_PAGE_SIZE));
  return { page, count, from, to, text: text.slice(from, to) };
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

module.exports = { createProjectionPublisher, reasoningPage, REASONING_PAGE_SIZE, createScrollFollow };
