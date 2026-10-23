const { reasoningSummary } = require('./turn-process');

// The disclosure owns a lazily rendered, throttled Markdown body. Collapsed
// reasoning never invokes MarkdownRenderer; copying always uses the full source.
function createReasoningView(parent, { ui, label, labels, onLayout = () => {}, onToggle = () => {} }) {
  const element = ui.createEl(parent, 'details', { cls: 'scholar-quick-ask-reasoning scholar-quick-ask-process-row' });
  const summary = ui.createEl(element, 'summary');
  ui.setIcon(ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-process-icon', attributes: { 'aria-hidden': 'true' } }), 'brain');
  ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-process-label', text: label });
  const preview = ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-reasoning-preview' });
  const body = ui.createEl(element, 'div', { cls: 'scholar-quick-ask-reasoning-body' });
  const owner = element.ownerDocument.defaultView;
  let text = '', streaming = false, painted = null, timer = null, painting = false, disposed = false, generation = 0, expectedClosed = false;
  function clearBody() {
    generation++;
    if (timer !== null) owner.clearTimeout(timer);
    timer = null; painted = null;
    ui.clear(body);
  }
  async function render() {
    timer = null;
    if (disposed || !element.open || painting || painted === text) return;
    const source = text, current = generation;
    painted = source; painting = true;
    ui.clear(body);
    const copy = ui.createEl(body, 'button', { cls: 'scholar-quick-ask-reasoning-copy', attributes: { type: 'button', 'aria-label': labels.copy } });
    ui.setIcon(copy, 'copy'); ui.setTooltip(copy, labels.copy);
    copy.addEventListener('click', () => { void ui.writeClipboard(text, element).catch(() => ui.notice(labels.copyFailed)); });
    const target = ui.createEl(body, 'div', { cls: 'scholar-quick-ask-reasoning-text scholar-quick-ask-message-body' });
    try { await ui.renderMarkdown(target, source, ''); }
    catch { if (current === generation && !disposed && element.open) ui.setText(target, source); }
    finally {
      painting = false;
      if (current === generation && !disposed && element.open) onLayout();
      schedule();
    }
  }
  function schedule() {
    if (disposed || !element.open || painting || timer !== null || painted === text) return;
    timer = owner.setTimeout(() => { void render(); }, streaming ? 120 : 0);
  }
  element.addEventListener('toggle', () => {
    if (disposed) return;
    if (expectedClosed && !element.open) expectedClosed = false; else onToggle();
    if (element.open) schedule(); else clearBody();
    onLayout();
  });
  return {
    element,
    get text() { return text; },
    update(value, active = false) {
      if (value === text && active === streaming) { element.hidden = !value; return; }
      text = value; streaming = active;
      element.hidden = !text;
      element.dataset.state = streaming ? 'running' : 'complete';
      const next = reasoningSummary(text, streaming);
      if (preview.textContent !== next) ui.setText(preview, next);
      schedule();
    },
    collapse() { expectedClosed = element.open; element.open = false; clearBody(); },
    destroy() { disposed = true; clearBody(); },
  };
}

module.exports = { createReasoningView };
