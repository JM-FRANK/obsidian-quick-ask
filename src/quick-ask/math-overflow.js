const { createLayoutBatch } = require('./layout-batch');

// All answers in one window share a read/write phase, not just one answer.
const windowBindings = new WeakMap();

// Ignore rounding-only overflow; require an actual visible width constraint.
function mathNeedsHorizontalScroll(viewportWidth, contentWidth) {
  return Number.isFinite(viewportWidth) && Number.isFinite(contentWidth)
    && viewportWidth > 0 && contentWidth > viewportWidth + 1;
}

function binding(win) {
  if (!windowBindings.has(win)) {
    const targets = new WeakMap();
    const batch = createLayoutBatch({
      frame: callback => win.requestAnimationFrame(callback),
      cancelFrame: handle => win.cancelAnimationFrame(handle),
    });
    const observer = new win.ResizeObserver(entries => {
      const changed = new Set(entries.map(entry => targets.get(entry.target)).filter(Boolean));
      for (const region of changed) batch.add(region);
    });
    windowBindings.set(win, { win, observer, targets, batch, regions: new Set() });
  }
  return windowBindings.get(win);
}

function disconnect(region) {
  const value = region.binding;
  if (!value) return;
  region.binding = null;
  value.batch.remove(region);
  for (const target of [region.viewport, region.content]) {
    value.observer.unobserve(target);
    value.targets.delete(target);
  }
  value.regions.delete(region);
  if (!value.regions.size) {
    value.observer.disconnect();
    value.batch.dispose();
    windowBindings.delete(value.win);
  }
}

function connect(region) {
  const win = region.viewport.ownerDocument.defaultView;
  if (region.binding?.win === win) return;
  disconnect(region);
  const value = binding(win);
  region.binding = value;
  value.regions.add(region);
  for (const target of [region.viewport, region.content]) {
    value.targets.set(target, region);
    value.observer.observe(target);
  }
}

function createMathOverflow() {
  const regions = new Set();
  let disposed = false;
  return {
    add(viewport, content) {
      if (disposed) return;
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
      const region = {
        viewport, content, rail, extent, fromRail, fromViewport, binding: null,
        overflowing: false, width: null,
        read() {
          if (disposed || !this.binding) return null;
          if (this.binding.win !== viewport.ownerDocument.defaultView) {
            connect(this);
            this.binding.batch.add(this);
            return null;
          }
          const connected = viewport.isConnected;
          const available = connected ? viewport.clientWidth : 0;
          const width = connected ? viewport.scrollWidth : 0;
          return { binding: this.binding, width,
            overflowing: mathNeedsHorizontalScroll(available, width),
            left: connected ? viewport.scrollLeft : 0, railLeft: connected ? rail.scrollLeft : 0 };
        },
        write(measured) {
          if (disposed || !measured || this.binding !== measured.binding) return;
          const changedWidth = this.width !== measured.width;
          if (this.overflowing !== measured.overflowing) {
            viewport.classList.toggle('has-horizontal-overflow', measured.overflowing);
            rail.hidden = !measured.overflowing;
            this.overflowing = measured.overflowing;
          }
          if (changedWidth) {
            extent.style.width = `${measured.width}px`;
            this.width = measured.width;
          }
          if (changedWidth || measured.left !== measured.railLeft) rail.scrollLeft = measured.left;
        },
      };
      regions.add(region);
      connect(region);
      region.binding.batch.add(region);
    },
    refresh() {
      if (disposed) return;
      for (const region of regions) { connect(region); region.binding.batch.add(region); }
    },
    dispose() {
      disposed = true;
      for (const region of regions) {
        disconnect(region);
        region.viewport.classList.remove('has-horizontal-overflow');
        region.viewport.removeEventListener('scroll', region.fromViewport);
        region.rail.removeEventListener('scroll', region.fromRail);
        region.rail.remove();
      }
      regions.clear();
    },
  };
}

module.exports = { mathNeedsHorizontalScroll, createMathOverflow };
