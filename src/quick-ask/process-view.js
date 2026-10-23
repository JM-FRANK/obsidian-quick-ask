const { createReasoningView } = require('./reasoning-view');
const { createToolHistoryView } = require('./tool-history-view');
const { createScrollFollow } = require('./stream-presentation');

// One ordered process list per turn. Inner disclosures always start closed.
function createProcessView(parent, { ui, translate, onLayout = () => {}, onToggle = () => {} }) {
  const element = ui.createEl(parent, 'details', { cls: 'scholar-quick-ask-process' });
  const summary = ui.createEl(element, 'summary');
  ui.setIcon(ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-process-chevron', attributes: { 'aria-hidden': 'true' } }), 'chevron-right');
  ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-process-heading', text: translate('process.title') });
  const status = ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-process-status' });
  const body = ui.createEl(element, 'div', { cls: 'scholar-quick-ask-process-body' });
  const rows = new Map(), follow = createScrollFollow();
  const owner = element.ownerDocument.defaultView;
  let value = null, initial = true, previousStatus = null, frame = null, disposed = false, expectedOpen = null;
  function layout() {
    if (disposed || frame !== null) return;
    frame = owner.requestAnimationFrame(() => {
      frame = null;
      if (element.open && value?.status === 'running' && follow.following) {
        body.scrollTop = body.scrollHeight; follow.positioned(body.scrollTop);
      }
      onLayout();
    });
  }
  const pause = () => { follow.pause(); onToggle(); };
  body.addEventListener('scroll', () => follow.scroll({ top: body.scrollTop, height: body.scrollHeight, viewport: body.clientHeight }), { passive: true });
  body.addEventListener('wheel', event => { if (event.deltaY < 0) follow.pause(); }, { passive: true });
  body.addEventListener('touchstart', () => follow.pause(), { passive: true });
  function collapseRows() { for (const row of rows.values()) row.collapse?.(); }
  function paint() {
    if (!element.open || !value) return;
    const visible = new Set();
    for (const [index, step] of value.steps.entries()) {
      visible.add(step.id);
      let row = rows.get(step.id);
      if (!row) {
        if (step.kind === 'reasoning') row = createReasoningView(body, { ui, label: translate('composer.reasoning'),
          labels: { copy: translate('reasoning.copy'), copyFailed: translate('composer.copyFailed') }, onLayout: layout, onToggle: pause });
        else if (step.kind === 'tool') row = createToolHistoryView(body, { ui, translate, onLayout: layout, onToggle: pause });
        else {
          const text = ui.createEl(body, 'div', { cls: 'scholar-quick-ask-process-note' });
          row = { element: text, update(source) { if (text.textContent !== source) ui.setText(text, source); } };
        }
        rows.set(step.id, row);
      }
      if (step.unsegmented && !value.steps[index - 1]?.unsegmented && !row.recordNote)
        row.recordNote = ui.createEl(body, 'div', { cls: 'scholar-quick-ask-process-record-note', text: translate('process.unsegmented') });
      if (step.kind === 'reasoning') row.update(step.text, value.activeStepId === step.id);
      else if (step.kind === 'tool') {
        row.element.hidden = !step.call;
        if (step.call && row.call !== step.call) { row.call = step.call; row.update({ id: step.groupId, calls: [step.call] }); }
      } else row.update(step.text);
    }
    for (const [id, row] of rows) if (!visible.has(id)) {
      row.destroy?.(); row.recordNote?.remove(); row.element.remove(); rows.delete(id);
    }
    // A live text tail becomes an intermediate note when the model calls a tool.
    // Existing disclosures retain their nodes, focus and open state.
    let position = body.firstChild;
    for (const step of value.steps) {
      const row = rows.get(step.id);
      for (const node of [row.recordNote, row.element].filter(Boolean)) {
        if (node !== position) body.insertBefore(node, position);
        position = node.nextSibling;
      }
    }
  }
  element.addEventListener('toggle', event => {
    if (disposed || event.target !== element) return;
    if (expectedOpen === element.open) expectedOpen = null; else pause();
    if (!element.open) collapseRows(); else paint();
    layout();
  });
  return {
    element,
    update(next) {
      value = next;
      element.hidden = !value.steps.length;
      element.dataset.state = value.status;
      element.dataset.reasoningOnly = String(value.steps.every(step => step.kind === "reasoning"));
      const label = ['complete', 'running', 'incomplete', 'failed', 'stopped', 'interrupted'].includes(value.status) ? value.status : 'interrupted';
      const nextStatus = translate(`process.${label}`);
      if (status.textContent !== nextStatus) ui.setText(status, nextStatus);
      if (initial) { expectedOpen = value.status === 'running'; element.open = expectedOpen; initial = false; }
      else if (previousStatus === 'running' && value.status === 'complete') { expectedOpen = false; element.open = false; collapseRows(); }
      previousStatus = value.status;
      paint(); layout();
    },
    destroy() {
      disposed = true;
      if (frame !== null) owner.cancelAnimationFrame(frame);
      for (const row of rows.values()) row.destroy?.();
      rows.clear();
    },
  };
}

module.exports = { createProcessView };
