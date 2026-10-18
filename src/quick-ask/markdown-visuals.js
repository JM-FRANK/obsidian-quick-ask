const { createSourceCopy } = require('./source-copy');
const { createMathOverflow } = require('./math-overflow');

// Decorate only this host's settled assistant Markdown. Capture source before
// the native postprocessors replace math/code; keep native rendering and its
// lifecycle, rather than guessing source from MathJax/SVG output.
function createMarkdownVisuals({ ui, translate, tableSources = () => [], onLayout = () => {} }) {
  const diagrams = new Set();
  const observers = new Set();
  const copies = new Set();
  const mathOverflow = createMathOverflow();
  let disposed = false;

  function button(parent, icon, key, action) {
    const element = ui.createEl(parent, 'button', { cls: 'scholar-quick-ask-visual-action',
      attributes: { type: 'button', 'aria-label': translate(key) } });
    ui.setIcon(element, icon);
    ui.setTooltip(element, translate(key));
    element.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (!disposed) action();
    });
    return element;
  }

  function decorate(original, { source, inline = false, kind = 'math' }) {
    const mermaid = kind === 'mermaid';
    const toggleable = kind === 'math' || mermaid;
    const wrapper = ui.createEl(original.parentElement, 'span', {
      cls: `scholar-quick-ask-visual ${inline ? 'is-inline' : 'is-block'} is-${kind}`,
    });
    original.before(wrapper);
    const rendered = ui.createEl(wrapper, 'span', { cls: 'scholar-quick-ask-visual-rendered' });
    rendered.appendChild(original);
    if (kind === 'math') mathOverflow.add(rendered, original);
    // Inline math keeps local overflow handling without introducing controls
    // or reserving space inside the surrounding sentence.
    if (inline) return;
    const toolbar = ui.createEl(wrapper, 'span', { cls: 'scholar-quick-ask-visual-toolbar' });
    const code = toggleable ? ui.createEl(wrapper, 'code', { cls: 'scholar-quick-ask-visual-source', text: source }) : null;
    if (code) code.hidden = true;
    let showingSource = false;
    const displaySource = show => {
      showingSource = show;
      wrapper.classList.toggle('is-source', show);
      code.hidden = !show;
      rendered.hidden = show;
      toggle.setAttribute('aria-pressed', String(show));
      const label = translate(show ? 'rendering.viewRendered' : 'rendering.viewSource');
      toggle.setAttribute('aria-label', label);
      ui.setTooltip(toggle, label);
      if (zoom) zoom.hidden = show || !rendered.querySelector('svg');
      if (kind === 'math') mathOverflow.refresh();
      onLayout();
    };
    const zoom = mermaid ? button(toolbar, 'zoom-in', 'images.preview', () => {
      const svg = rendered.querySelector('svg');
      if (svg) ui.previewDiagram(svg, zoom);
    }) : null;
    if (zoom) zoom.hidden = true;
    const toggle = toggleable ? button(toolbar, 'code-xml', 'rendering.viewSource', () => displaySource(!showingSource)) : null;
    toggle?.setAttribute('aria-pressed', 'false');
    const copy = button(toolbar, 'copy', 'composer.copySource', () => { void copying.copy(source); });
    copy.classList.add('scholar-quick-ask-visual-copy');
    const win = wrapper.ownerDocument.defaultView;
    const copying = createSourceCopy({
      write: text => ui.writeClipboard(text, copy),
      feedback: copied => {
        wrapper.classList.toggle('has-copy-feedback', copied);
        copy.classList.toggle('is-copied', copied);
        ui.setIcon(copy, copied ? 'check' : 'copy');
        const label = translate(copied ? 'composer.copied' : 'composer.copySource');
        copy.setAttribute('aria-label', label);
        ui.setTooltip(copy, label);
      },
      failed: () => ui.notice(translate('composer.copyFailed')),
      delay: (ms, callback) => win.setTimeout(callback, ms),
      cancelDelay: timer => win.clearTimeout(timer),
    });
    copies.add(copying);
    if (source === null) {
      copy.disabled = true;
      copy.setAttribute('aria-label', translate('rendering.tableSourceUnavailable'));
      ui.setTooltip(copy, translate('rendering.tableSourceUnavailable'));
    }

    if (mermaid) {
      const error = ui.createEl(wrapper, 'span', { cls: 'scholar-quick-ask-visual-error', text: translate('rendering.diagramFailed'),
        attributes: { role: 'status' } });
      error.hidden = true;
      let settled = false, fallback = false, userChoice = false;
      toggle.addEventListener('click', () => { userChoice = true; });
      const update = () => {
        if (disposed) return;
        const ready = !!rendered.querySelector('svg');
        error.hidden = !settled || ready;
        if (!ready && settled && !userChoice && !fallback) { fallback = true; displaySource(true); }
        if (ready && fallback && !userChoice) { fallback = false; displaySource(false); }
        if (zoom) zoom.hidden = !ready || showingSource;
        onLayout();
      };
      const Observer = wrapper.ownerDocument.defaultView.MutationObserver;
      const observer = new Observer(update);
      observer.observe(rendered, { childList: true, subtree: true });
      observers.add(observer);
      diagrams.add(() => { settled = true; update(); });
    }
  }

  return {
    prepare(section) {
      if (disposed) return;
      const tables = [...section.querySelectorAll('table')].filter(table => !table.closest('.scholar-quick-ask-visual'));
      if (tables.length) {
        let sources = [];
        try { sources = tableSources(); } catch { /* Never copy a different table after a parser mismatch. */ }
        for (const [index, table] of tables.entries()) {
          decorate(table, { kind: 'table', source: sources.length === tables.length ? sources[index] : null });
        }
      }
      for (const math of section.querySelectorAll('.math:not(.is-loaded)')) {
        if (math.closest('.scholar-quick-ask-visual.is-math')) continue;
        const block = math.classList.contains('math-block');
        const body = math.textContent ?? '';
        decorate(math, { inline: !block, source: block ? `$$\n${body}\n$$` : `$${body}$` });
      }
      for (const code of section.querySelectorAll('pre > code')) {
        if (code.closest('.scholar-quick-ask-visual.is-code, .scholar-quick-ask-visual.is-mermaid')) continue;
        const source = code.textContent ?? '';
        // Match native copying: omit the one newline added by the Markdown
        // code-block renderer, keeping any actual trailing blank lines.
        decorate(code.parentElement, { source: source.endsWith('\n') ? source.slice(0, -1) : source,
          kind: code.classList.contains('language-mermaid') ? 'mermaid' : 'code' });
      }
    },
    settled(element) {
      if (disposed) return;
      // Replace only the native copy buttons inside our owned code/diagram
      // regions. Native highlighting and specialized renderers stay in place.
      for (const copy of element.querySelectorAll('.scholar-quick-ask-visual pre > .copy-code-button')) copy.remove();
      for (const update of diagrams) update();
      mathOverflow.refresh();
    },
    dispose() {
      disposed = true;
      mathOverflow.dispose();
      for (const observer of observers) observer.disconnect();
      for (const copying of copies) copying.dispose();
      copies.clear();
      observers.clear(); diagrams.clear();
    },
  };
}

module.exports = { createMarkdownVisuals };
