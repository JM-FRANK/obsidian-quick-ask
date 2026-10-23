// A window-local viewer. The host supplies the originating document rather
// than using the main window, so pop-out Quick Ask views remain isolated.
const { fitImage, constrain, zoomAt, panBy, wheelDelta, stepZoom, wheelZoomAmount } = require('./image-viewport');

function createImageViewer({ labelForClose }) {
  const viewers = new Map();
  function open({ document: doc, resource, label }) {
    viewers.get(doc)?.();
    const previous = doc.activeElement;
    const win = doc.defaultView;
    const overlay = doc.createElement('div');
    overlay.className = 'scholar-quick-ask-image-viewer';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', label);
    overlay.tabIndex = -1;
    const image = doc.createElement('img');
    image.className = 'scholar-quick-ask-image-viewer-content';
    image.src = resource;
    image.alt = label;
    image.draggable = false;
    const title = doc.createElement('div');
    title.className = 'scholar-quick-ask-image-viewer-title';
    title.textContent = label;
    const closeButton = doc.createElement('button');
    closeButton.className = 'scholar-quick-ask-image-viewer-close';
    closeButton.type = 'button';
    closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', labelForClose());
    let state = { zoom: 1, x: 0, y: 0 };
    let viewport = { width: 0, height: 0, imageWidth: 0, imageHeight: 0 };
    let frame = null;
    let momentum = null;
    let drag = null;
    let suppressClick = false;
    let spaceHeld = false;
    const pointers = new Map();
    let pinch = null;
    const paint = () => {
      frame = null;
      image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
      image.classList.toggle('is-zoomed', state.zoom > 1);
    };
    const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(paint); };
    const stopMomentum = () => {
      if (momentum !== null) win.cancelAnimationFrame(momentum);
      momentum = null;
    };
    const measure = () => {
      if (viewers.get(doc) !== close) return;
      stopMomentum();
      const width = overlay.clientWidth, height = overlay.clientHeight;
      const fitted = fitImage(width, height, image.naturalWidth, image.naturalHeight);
      viewport = { width, height, imageWidth: fitted.width, imageHeight: fitted.height };
      image.style.width = `${fitted.width}px`;
      image.style.height = `${fitted.height}px`;
      state = constrain(viewport, state);
      schedule();
    };
    const point = event => {
      const rect = overlay.getBoundingClientRect();
      return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
    };
    const changeZoom = (zoom, x = 0, y = 0, center = false) => {
      stopMomentum();
      state = zoomAt(viewport, state, zoom, x, y, center);
      schedule();
    };
    const releasePointers = () => {
      for (const id of pointers.keys()) {
        if (image.hasPointerCapture(id)) image.releasePointerCapture(id);
      }
      pointers.clear(); pinch = null; drag = null;
      image.classList.remove('is-dragging');
    };
    const cancelGesture = () => {
      stopMomentum(); releasePointers(); spaceHeld = false;
    };
    const startMomentum = (vx, vy) => {
      let previousTime = null;
      const tick = time => {
        momentum = null;
        if (viewers.get(doc) !== close) return;
        const elapsed = previousTime === null ? 16 : Math.min(32, time - previousTime);
        previousTime = time;
        const next = panBy(viewport, state, vx * elapsed, vy * elapsed);
        if (next.x === state.x) vx = 0;
        if (next.y === state.y) vy = 0;
        state = next; schedule();
        const decay = Math.pow(.5, elapsed / 200);
        vx *= decay; vy *= decay;
        if (Math.hypot(vx, vy) > .00625) momentum = win.requestAnimationFrame(tick);
      };
      if (Math.hypot(vx, vy) >= .03) momentum = win.requestAnimationFrame(tick);
    };
    const close = () => {
      if (viewers.get(doc) !== close) return;
      viewers.delete(doc);
      cancelGesture();
      image.removeEventListener('load', measure);
      if (frame !== null) win.cancelAnimationFrame(frame);
      win.removeEventListener('resize', measure);
      win.removeEventListener('blur', cancelGesture);
      doc.removeEventListener('keydown', keydown, true);
      doc.defaultView?.removeEventListener('pagehide', close);
      overlay.remove();
      if (previous?.isConnected) previous.focus();
    };
    const keydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); close();
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); closeButton.focus();
      } else if (['=', '+', '-'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation();
        changeZoom(stepZoom(state.zoom, event.key === '-' ? -1 : 1));
      } else if (event.key === ' ' && event.target !== closeButton) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) spaceHeld = true;
      }
    };
    const keyup = event => {
      if (event.key === ' ' && spaceHeld) {
        event.preventDefault(); event.stopPropagation(); close();
      }
    };
    overlay.addEventListener('keyup', keyup);
    overlay.addEventListener('wheel', event => {
      // Native desktop lightbox: modified wheel/pinch zooms at the pointer;
      // ordinary wheel/trackpad scroll pans an already zoomed image.
      event.preventDefault(); event.stopPropagation(); stopMomentum();
      if (event.ctrlKey || event.metaKey) {
        const p = point(event);
        const mac = /Mac/.test(win.navigator.platform);
        const amount = wheelZoomAmount(event.deltaY, event.deltaMode, mac);
        changeZoom(state.zoom + amount, p.x, p.y);
      } else if (state.zoom > 1) {
        state = panBy(viewport, state, -1.5 * wheelDelta(event.deltaX, event.deltaMode), -1.5 * wheelDelta(event.deltaY, event.deltaMode));
        schedule();
      }
    }, { passive: false });
    image.addEventListener('dblclick', event => {
      event.preventDefault(); event.stopPropagation();
      const p = point(event);
      changeZoom(state.zoom !== 1 ? 1 : 2.5, p.x, p.y, true);
    });
    image.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      stopMomentum(); suppressClick = false;
      pointers.set(event.pointerId, point(event));
      image.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), state: { ...state }, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        drag = null; suppressClick = true;
      } else if (pointers.size === 1 && state.zoom > 1) {
        drag = { ...point(event), start: point(event), time: event.timeStamp, vx: 0, vy: 0, moved: false };
      }
      event.preventDefault();
      overlay.focus({ preventScroll: true });
    });
    image.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      const p = point(event);
      pointers.set(event.pointerId, p);
      if (pinch && pointers.size === 2 && pinch.distance > 0) {
        const [a, b] = [...pointers.values()];
        const zoom = pinch.state.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance;
        const anchored = zoomAt(viewport, pinch.state, zoom, pinch.x, pinch.y);
        state = panBy(viewport, anchored, (a.x + b.x) / 2 - pinch.x, (a.y + b.y) / 2 - pinch.y);
      } else if (drag && pointers.size === 1) {
        if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 5) return;
        drag.moved = true; suppressClick = true;
        image.classList.add('is-dragging');
        const elapsed = event.timeStamp - drag.time;
        if (elapsed > 0) {
          drag.vx = .5 * (p.x - drag.x) / elapsed + .5 * drag.vx;
          drag.vy = .5 * (p.y - drag.y) / elapsed + .5 * drag.vy;
        }
        state = panBy(viewport, state, p.x - drag.x, p.y - drag.y);
        Object.assign(drag, p, { time: event.timeStamp });
      } else return;
      event.preventDefault(); schedule();
    });
    const endPointer = event => {
      if (!pointers.has(event.pointerId)) return;
      const lastDrag = drag;
      // Delete before releasing capture: lostpointercapture must not cancel
      // a completed drag's momentum or a remaining touch pointer.
      pointers.delete(event.pointerId);
      if (image.hasPointerCapture(event.pointerId)) image.releasePointerCapture(event.pointerId);
      pinch = null; drag = null;
      image.classList.remove('is-dragging');
      if (event.type === 'pointerup' && lastDrag?.moved && event.timeStamp - lastDrag.time < 80) startMomentum(lastDrag.vx, lastDrag.vy);
      if (pointers.size === 1) {
        const p = [...pointers.values()][0];
        drag = { ...p, start: p, time: event.timeStamp, vx: 0, vy: 0, moved: false };
      }
    };
    image.addEventListener('pointerup', endPointer);
    image.addEventListener('pointercancel', endPointer);
    image.addEventListener('lostpointercapture', endPointer);
    image.addEventListener('click', event => {
      // A drag can end outside the image; its compatibility click must never
      // close the viewer as a background click.
      event.stopPropagation();
      if (suppressClick) event.preventDefault();
      suppressClick = false;
    });
    image.addEventListener('load', measure);
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', event => {
      if (suppressClick) { suppressClick = false; return; }
      if (event.target === overlay) close();
    });
    overlay.append(image, title, closeButton);
    doc.body.appendChild(overlay);
    viewers.set(doc, close);
    measure();
    win.addEventListener('resize', measure);
    win.addEventListener('blur', cancelGesture);
    doc.addEventListener('keydown', keydown, true);
    doc.defaultView?.addEventListener('pagehide', close, { once: true });
    closeButton.focus();
  }
  return { open, dispose() { for (const close of [...viewers.values()]) close(); } };
}

module.exports = { createImageViewer };
