const { statusBarInset } = require('./composer-layout');

// Host-side geometry only. Never change the status bar or assume a theme's
// height. Observe the owning window, so pop-outs without a bar reserve nothing.
function observeStatusBarInset(element, subscribe) {
  const property = '--scholar-status-bar-inset';
  let win = null;
  let resize = null;
  let structure = null;
  let attributes = null;
  let frame = null;
  let bars = new Set();
  let watched = new Set();
  let stopped = false;

  function disconnectWindow() {
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null;
    resize?.disconnect(); structure?.disconnect(); attributes?.disconnect();
    win?.removeEventListener('resize', schedule);
    win?.document.removeEventListener('transitionend', onTransition, true);
    bars = new Set(); watched = new Set();
  }
  function onTransition(event) {
    if (watched.has(event.target)) schedule();
  }
  function connectWindow() {
    win = element.ownerDocument.defaultView;
    resize = new win.ResizeObserver(schedule);
    resize.observe(element);
    attributes = new win.MutationObserver(schedule);
    structure = new win.MutationObserver(records => {
      // Ignore conversation streaming and Composer mutations. Only structural
      // changes involving a status bar or the pane can change this inset.
      if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches('.status-bar') || node.querySelector('.status-bar') || node.contains(element))))) schedule();
    });
    structure.observe(win.document.body, { childList: true, subtree: true });
    win.addEventListener('resize', schedule);
    win.document.addEventListener('transitionend', onTransition, true);
  }
  function schedule() {
    if (stopped) return;
    if (win !== element.ownerDocument.defaultView) {
      disconnectWindow();
      connectWindow();
    }
    if (frame === null) frame = win.requestAnimationFrame(update);
  }
  function update() {
    frame = null;
    if (stopped) return;
    if (win !== element.ownerDocument.defaultView) { schedule(); return; }
    const nextBars = new Set(win.document.querySelectorAll('.status-bar'));
    for (const bar of bars) if (!nextBars.has(bar)) resize.unobserve(bar);
    for (const bar of nextBars) if (!bars.has(bar)) resize.observe(bar);
    bars = nextBars;
    const nextWatched = new Set();
    const addAncestors = node => { for (; node; node = node.parentElement) nextWatched.add(node); };
    // Exclude our own style writes. Ancestors cover theme/body/workspace and
    // pane positioning; bars cover hidden/class/style visibility changes.
    addAncestors(element.parentElement);
    for (const bar of bars) addAncestors(bar);
    if (nextWatched.size !== watched.size || [...nextWatched].some(node => !watched.has(node))) {
      attributes.disconnect();
      for (const node of nextWatched) attributes.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      watched = nextWatched;
    }
    const rectangles = [...bars].map(bar => {
      const style = win.getComputedStyle(bar);
      return { ...rect(bar), visible: style.display !== 'none' && style.visibility === 'visible' &&
        !(Number(style.opacity) === 0 && style.pointerEvents === 'none') };
    });
    const inset = element.isConnected ? statusBarInset(rect(element), rectangles) : 0;
    const value = `${inset}px`;
    // No feedback loop: padding changes the content box, not this border box.
    if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
    element.classList.toggle('has-status-bar-overlap', inset > 0);
  }
  function rect(node) {
    const { top, right, bottom, left } = node.getBoundingClientRect();
    return { top, right, bottom, left };
  }
  const unsubscribe = subscribe(schedule);
  schedule();
  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    disconnectWindow();
    element.style.removeProperty(property);
    element.classList.remove('has-status-bar-overlap');
  };
}

module.exports = { observeStatusBarInset };
