// Some Obsidian installers use Chromium versions that can read custom
// properties by name but do not enumerate them in getComputedStyle().
const DIAGRAM_THEME_PROPERTIES = [
  '--link-color',
  '--pele-bg', '--pele-fg', '--pele-fg-on-light', '--pele-fg-on-dark', '--pele-muted',
  '--pele-line', '--pele-surface', '--pele-surface-alt', '--pele-border',
  '--pele-accent', '--pele-critical', '--pele-error', '--pele-radius',
  '--pele-font', '--pele-font-mono', '--pele-title-weight', '--pele-heading-weight', '--pele-bold-weight',
  '--pele-series-1', '--pele-series-2', '--pele-series-3', '--pele-series-4',
  '--pele-series-5', '--pele-series-6', '--pele-series-7', '--pele-series-8',
];

function createDiagramPreview(svg, label) {
  const doc = svg.ownerDocument;
  const { defaultView: owner } = doc;
  const copy = svg.cloneNode(true);
  const pele = svg.classList.contains('pele');
  const box = svg.viewBox?.baseVal;
  // Pele's in-pane zoom crops the viewBox and keeps the full diagram size in
  // the width and height attributes. Start the viewer with the entire diagram.
  const width = (pele && Number(svg.getAttribute('width'))) || box?.width;
  const height = (pele && Number(svg.getAttribute('height'))) || box?.height;
  const hasSize = width > 0 && height > 0;
  if (hasSize) {
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
  }
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.style.maxWidth = 'none';
  const style = owner.getComputedStyle(svg);
  copy.style.color = style.color;
  copy.style.backgroundColor = style.getPropertyValue('--background-primary');

  if (!pele || !hasSize) {
    const serialized = new owner.XMLSerializer().serializeToString(copy);
    return { resource: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}` };
  }

  // A separate document keeps SVG IDs local and lets MathJax use the host's
  // local fonts, which an SVG loaded as an image cannot fetch.
  for (const property of DIAGRAM_THEME_PROPERTIES) {
    copy.style.setProperty(property, style.getPropertyValue(property));
  }
  copy.setAttribute('viewBox', `0 0 ${width} ${height}`);
  copy.removeAttribute('tabindex');
  copy.style.fontFamily = style.fontFamily;
  copy.style.display = 'block';
  copy.style.width = '100%';
  copy.style.height = '100%';
  copy.style.margin = '0';

  const mathStyles = copy.querySelector('mjx-container') ? doc.getElementById('MJX-CHTML-styles')?.sheet : null;
  const frame = doc.createElement('iframe');
  frame.title = label;
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; font-src 'self' data:; img-src data:">
    <style>html,body{height:100%;margin:0;overflow:hidden}.pele a.internal-link{fill:var(--link-color)}</style>
    <body></body>`;
  frame.addEventListener('load', () => {
    const preview = frame.contentDocument;
    if (!preview?.body) return;
    if (mathStyles) {
      // MathJax inserts its generated rules through CSSOM after typesetting.
      const stylesheet = preview.createElement('style');
      stylesheet.textContent = Array.from(mathStyles.cssRules, rule => rule.cssText).join('\n');
      preview.head.appendChild(stylesheet);
    }
    preview.body.appendChild(copy);
  }, { once: true });
  const surface = doc.createElement('div');
  surface.appendChild(frame);
  return { diagram: { surface, width, height } };
}

module.exports = { createDiagramPreview };
