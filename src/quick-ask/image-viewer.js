// A window-local viewer. The host supplies the originating document rather
// than using the main window, so pop-out Quick Ask views remain isolated.
function createImageViewer({ labelForClose }) {
  const viewers = new Map();
  function open({ document: doc, resource, label }) {
    viewers.get(doc)?.();
    const previous = doc.activeElement;
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
    const close = () => {
      if (viewers.get(doc) !== close) return;
      viewers.delete(doc);
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
      }
    };
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.append(image, title, closeButton);
    doc.body.appendChild(overlay);
    viewers.set(doc, close);
    doc.addEventListener('keydown', keydown, true);
    doc.defaultView?.addEventListener('pagehide', close, { once: true });
    closeButton.focus();
  }
  return { open, dispose() { for (const close of [...viewers.values()]) close(); } };
}

module.exports = { createImageViewer };
