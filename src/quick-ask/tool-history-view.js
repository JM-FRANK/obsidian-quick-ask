const { toolImagePath } = require('./tool-history');
const { safeSourceUrl } = require('./web-search');

// Native details/summary supplies mouse and keyboard disclosure behavior.
// No Markdown execution, image loads, file reads or network requests on expand.
function createToolHistoryView(parent, { ui, translate, onLayout = () => {}, onToggle = () => {} }) {
  const element = ui.createEl(parent, 'details', { cls: 'scholar-quick-ask-tool-history scholar-quick-ask-process-row' });
  const summary = ui.createEl(element, 'summary');
  const icon = ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-process-icon', attributes: { 'aria-hidden': 'true' } });
  const title = ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-tool-history-title' });
  const label = ui.createEl(title, 'span', { cls: 'scholar-quick-ask-tool-history-label' });
  const target = ui.createEl(title, 'span', { cls: 'scholar-quick-ask-tool-history-target' });
  const prefix = ui.createEl(target, 'span', { cls: 'scholar-quick-ask-tool-history-prefix', attributes: { 'aria-hidden': 'true' } });
  const prefixText = ui.createEl(prefix, 'span');
  const targetText = ui.createEl(target, 'span', { cls: 'scholar-quick-ask-tool-history-tail' });
  const status = ui.createEl(summary, 'span', { cls: 'scholar-quick-ask-tool-history-status' });
  const body = ui.createEl(element, 'div', { cls: 'scholar-quick-ask-tool-history-body' });
  let group = null, painted = null, expectedClosed = false, destroyed = false;
  const name = call => translate(call.server ? 'tools.serverSearch' : call.name === 'get-full-file' ? 'tools.file' : call.name === 'get-image' ? 'tools.image' : 'tools.search');
  const row = (parent, label, value) => {
    if (!value) return;
    const line = ui.createEl(parent, 'div', { cls: 'scholar-quick-ask-tool-field' });
    ui.createEl(line, 'span', { cls: 'scholar-quick-ask-tool-field-label', text: label });
    ui.createEl(line, 'span', { text: String(value) });
  };
  function render() {
    if (!element.open || !group || painted === group.calls) return;
    painted = group.calls;
    ui.clear(body);
    for (const call of group.calls) {
      const item = ui.createEl(body, 'section', { cls: 'scholar-quick-ask-tool-call' });
      ui.createEl(item, 'div', { cls: 'scholar-quick-ask-tool-call-title', text: `${name(call)} · ${translate(`tools.${call.status}`)}` });
      const args = call.arguments ?? {}, result = call.summary ?? {};
      row(item, translate('tools.source'), args.sourcePath);
      if (call.name === 'get-image') row(item, translate('tools.imagePath'), toolImagePath(call) ?? translate('tools.pathUnknown'));
      else row(item, translate('tools.path'), args.path);
      row(item, translate('tools.query'), args.query);
      row(item, translate('tools.provider'), call.provider);
      if (call.server) ui.createEl(item, 'small', { text: translate('tools.serverNote') });
      if (Number.isFinite(result.characters)) row(item, translate('tools.result'), translate('tools.characters', { count: result.characters }));
      else if (result.image) row(item, translate('tools.result'), translate('tools.imageRead'));
      else if (Array.isArray(result.sources)) row(item, translate('tools.result'), translate('tools.sources', { count: result.sources.length }));
      row(item, translate('tools.error'), ['limit', 'context'].includes(result.reason) ? translate(`tools.${result.reason}`) : result.error);
      for (const source of result.sources ?? []) {
        const url = safeSourceUrl(source.url);
        if (url) ui.createEl(item, 'a', { text: source.title || url,
          attributes: { href: url, target: '_blank', rel: 'noopener noreferrer' } });
      }
    }
  }
  element.addEventListener('toggle', () => { if (destroyed) return; if (expectedClosed && !element.open) expectedClosed = false; else onToggle(); render(); onLayout(); });
  return {
    element,
    collapse() { expectedClosed = element.open; element.open = false; },
    destroy() { destroyed = true; ui.clear(body); },
    update(value) {
      group = value;
      const calls = group.calls;
      ui.setIcon(icon, calls[0]?.name === 'get-image' ? 'image' : calls[0]?.name === 'web_search' ? 'globe' : 'file-text');
      const state = calls.some(call => call.status === 'running') ? 'running'
        : calls.some(call => call.status === 'queued') ? 'queued'
        : calls.some(call => call.status === 'failed') ? 'failed'
          : calls.some(call => call.status === 'interrupted') ? 'interrupted'
            : calls.some(call => call.status === 'cancelled') ? 'cancelled' : 'complete';
      const single = calls.length === 1 ? calls[0] : null;
      const path = single ? single.arguments?.path ?? single.arguments?.query ?? '' : '';
      const file = single?.name === 'get-full-file';
      const parts = file ? path.split('/') : [];
      const tail = file ? parts.slice(-2).join('/') : path;
      const before = file && parts.length > 2 ? `${parts.slice(0, -2).join('/')}/` : '';
      ui.setText(label, single ? `${name(single)}${path ? ' ·' : ''}` : translate('tools.batch', { count: calls.length }));
      target.hidden = !path;
      prefix.hidden = !before;
      ui.setText(prefixText, before);
      ui.setText(targetText, tail);
      target.classList.toggle('is-file-path', file);
      ui.setText(status, translate(`tools.${state}`));
      element.dataset.state = state;
      render();
    },
  };
}

module.exports = { createToolHistoryView };
