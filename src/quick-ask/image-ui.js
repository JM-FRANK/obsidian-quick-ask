// Shared pending/history projection; resources and full previews belong to the host.
// Keep only display ratios in memory, so a missing source can preserve a known
// preview shape without adding image metadata or bytes to the session log.
const imageRatios = new WeakMap();
function renderImages({ parent, paths, environment, translate, onRemove = null }) {
  if (!paths?.length) return;
  const { ui, images } = environment;
  let ratios = imageRatios.get(environment);
  if (!ratios) { ratios = new Map(); imageRatios.set(environment, ratios); }
  const group = ui.createEl(parent, 'div', { cls: 'scholar-quick-ask-images' });
  for (const path of paths) {
    const card = ui.createEl(group, 'div', { cls: 'scholar-quick-ask-image-card' });
    if (ratios.has(path)) card.style.aspectRatio = ratios.get(path);
    const preview = ui.createEl(card, 'button', { cls: 'scholar-quick-ask-image-preview',
      attributes: { type: 'button', 'aria-label': `${translate('images.preview')}: ${path}` } });
    ui.setTooltip(preview, path);
    const missing = () => {
      ui.clear(preview);
      preview.disabled = true;
      preview.classList.add('is-missing');
      ui.missingImage(preview, translate('images.missing'));
    };
    Promise.resolve().then(() => images.resourcePath(path)).then(resource => {
      if (!preview.isConnected) return;
      if (!resource) { missing(); return; }
      const image = ui.createEl(preview, 'img', { attributes: { src: resource, alt: path, loading: 'lazy' } });
      image.addEventListener('load', () => {
        if (!image.isConnected || !image.naturalWidth || !image.naturalHeight) return;
        const ratio = `${image.naturalWidth} / ${image.naturalHeight}`;
        ratios.set(path, ratio);
        card.style.aspectRatio = ratio;
      }, { once: true });
      image.addEventListener('error', missing, { once: true });
      preview.addEventListener('click', () => { ui.previewImage(path, resource, preview); });
    }).catch(() => { if (preview.isConnected) missing(); });
    if (onRemove) {
      const remove = ui.createEl(card, 'button', { cls: 'scholar-quick-ask-image-remove',
        attributes: { type: 'button', 'aria-label': translate('images.remove') } });
      ui.setIcon(remove, 'x');
      remove.addEventListener('click', () => onRemove(path));
    }
  }
}

module.exports = { renderImages };
