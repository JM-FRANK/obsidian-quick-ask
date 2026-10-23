// All coordinates are CSS pixels relative to the viewport center. Zoom is
// relative to the fitted image, rather than to its intrinsic pixel size.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const MIN_ZOOM = .2;
const MAX_ZOOM = 10;

function fitImage(width, height, naturalWidth, naturalHeight) {
  if (!(width > 0 && height > 0 && naturalWidth > 0 && naturalHeight > 0)) return { width: 0, height: 0 };
  const ratio = Math.min(width / naturalWidth, height / naturalHeight);
  return { width: naturalWidth * ratio, height: naturalHeight * ratio };
}

function constrain(viewport, state) {
  const zoom = clamp(state.zoom, MIN_ZOOM, MAX_ZOOM);
  const maxX = Math.max(0, (viewport.imageWidth * zoom - viewport.width) / 2);
  const maxY = Math.max(0, (viewport.imageHeight * zoom - viewport.height) / 2);
  return { zoom, x: clamp(state.x, -maxX, maxX) || 0, y: clamp(state.y, -maxY, maxY) || 0 };
}

function zoomAt(viewport, state, zoom, x = 0, y = 0, center = false) {
  zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const ratio = zoom / state.zoom;
  return constrain(viewport, {
    zoom,
    x: (state.x - x) * ratio + (center ? 0 : x),
    y: (state.y - y) * ratio + (center ? 0 : y),
  });
}

function panBy(viewport, state, x, y) {
  return constrain(viewport, { ...state, x: state.x + x, y: state.y + y });
}

function wheelDelta(delta, mode) {
  return delta * (mode === 1 ? 40 : mode === 2 ? 800 : 1);
}

function stepZoom(zoom, direction) {
  // Two fine steps cover the previous 1.2x step, without coarse 0.1 rounding.
  const factor = Math.sqrt(1.2);
  return clamp(zoom * (direction > 0 ? factor : 1 / factor), MIN_ZOOM, MAX_ZOOM);
}

function wheelZoomAmount(delta, mode, mac = false) {
  return -wheelDelta(delta, mode) / 300 * (mac && !Number.isInteger(delta) ? 2 : 1);
}

module.exports = { fitImage, constrain, zoomAt, panBy, wheelDelta, stepZoom, wheelZoomAmount };
