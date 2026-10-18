// Ignore rounding-only overflow; require an actual visible width constraint.
function mathNeedsHorizontalScroll(viewportWidth, contentWidth) {
  return Number.isFinite(viewportWidth) && Number.isFinite(contentWidth)
    && viewportWidth > 0 && contentWidth > viewportWidth + 1;
}

function createMathOverflow() {
  const regions = new Set(), windows = new Map();
  let disposed = false;
  function update(region) {
    if (disposed) return;
    if (region.win !== region.viewport.ownerDocument.defaultView) connect(region);
    const overflowing = region.viewport.isConnected
      && mathNeedsHorizontalScroll(region.viewport.clientWidth, region.viewport.scrollWidth);
    region.viewport.classList.toggle('has-horizontal-overflow', overflowing);
    region.rail.hidden = !overflowing;
    const width = `${region.viewport.scrollWidth}px`;
    if (region.extent.style.width !== width) region.extent.style.width = width;
    region.rail.scrollLeft = region.viewport.scrollLeft;
  }
  function binding(win) {
    if (windows.has(win)) return windows.get(win);
    const targets = new WeakMap();
    const observer = new win.ResizeObserver(entries => {
      const changed = new Set(entries.map(entry => targets.get(entry.target)).filter(Boolean));
      for (const region of changed) update(region);
    });
    const value = { observer, targets };
    windows.set(win, value); return value;
  }
  function connect(region) {
    const win = region.viewport.ownerDocument.defaultView;
    if (region.win === win) return;
    if (region.win) {
      const previous = windows.get(region.win);
      previous.observer.unobserve(region.viewport); previous.observer.unobserve(region.content);
      previous.targets.delete(region.viewport); previous.targets.delete(region.content);
    }
    region.win = win;
    const value = binding(win);
    for (const target of [region.viewport, region.content]) {
      value.targets.set(target, region); value.observer.observe(target);
    }
  }
  return {
    add(viewport, content) {
      const doc = viewport.ownerDocument;
      // A separate, absolutely positioned native scroll rail overlays the
      // formula. Its scrollbar never participates in the formula's height.
      const rail = doc.createElement('span');
      rail.className = 'scholar-quick-ask-math-scrollbar';
      rail.hidden = true;
      rail.setAttribute('aria-hidden', 'true');
      rail.tabIndex = -1;
      const extent = doc.createElement('span');
      extent.className = 'scholar-quick-ask-math-scrollbar-extent';
      rail.appendChild(extent);
      viewport.parentElement.appendChild(rail);
      const fromRail = () => { if (viewport.scrollLeft !== rail.scrollLeft) viewport.scrollLeft = rail.scrollLeft; };
      const fromViewport = () => { if (rail.scrollLeft !== viewport.scrollLeft) rail.scrollLeft = viewport.scrollLeft; };
      rail.addEventListener('scroll', fromRail, { passive: true });
      viewport.addEventListener('scroll', fromViewport, { passive: true });
      const region = { viewport, content, rail, extent, fromRail, fromViewport, win: null };
      regions.add(region); connect(region); update(region);
    },
    refresh() { for (const region of regions) { connect(region); update(region); } },
    dispose() {
      disposed = true;
      for (const { observer } of windows.values()) observer.disconnect();
      for (const region of regions) {
        region.viewport.classList.remove('has-horizontal-overflow');
        region.viewport.removeEventListener('scroll', region.fromViewport);
        region.rail.removeEventListener('scroll', region.fromRail);
        region.rail.remove();
      }
      regions.clear(); windows.clear();
    },
  };
}

module.exports = { mathNeedsHorizontalScroll, createMathOverflow };
