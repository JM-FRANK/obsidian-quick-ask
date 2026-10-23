// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fitImage, constrain, zoomAt, panBy, wheelDelta, stepZoom, wheelZoomAmount } = require('../src/quick-ask/image-viewport');
const initial = { zoom: 1, x: 0, y: 0 };
const viewport = (width, height, iw, ih) => {
  const fitted = fitImage(width, height, iw, ih);
  return { width, height, imageWidth: fitted.width, imageHeight: fitted.height };
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);

test('initial fit preserves portrait/landscape aspect ratio and enlarges small images', () => {
  assert.deepEqual(fitImage(1000, 800, 100, 50), { width: 1000, height: 500 });
  assert.deepEqual(fitImage(1000, 800, 500, 1000), { width: 400, height: 800 });
  assert.deepEqual(fitImage(0, 800, 500, 1000), { width: 0, height: 0 });
  assert.deepEqual(fitImage(1000, 800, 0, 0), { width: 0, height: 0 });
});

test('wheel zoom preserves the image coordinate under the pointer until a boundary is reached', () => {
  const v = viewport(1000, 800, 1000, 800);
  let state = { zoom: 2, x: 90, y: -50 };
  const pointer = { x: 150, y: -90 };
  const imageX = (pointer.x - state.x) / state.zoom;
  const imageY = (pointer.y - state.y) / state.zoom;
  for (const zoom of [2.7, 4.2, 7, 10, 3, 2]) {
    state = zoomAt(v, state, zoom, pointer.x, pointer.y);
    near((pointer.x - state.x) / state.zoom, imageX);
    near((pointer.y - state.y) / state.zoom, imageY);
  }
});

test('double click centers the selected image point; reset clears all pan', () => {
  const v = viewport(1000, 800, 1000, 800);
  const zoomed = zoomAt(v, initial, 2.5, 100, -50, true);
  assert.deepEqual(zoomed, { zoom: 2.5, x: -250, y: 125 });
  assert.deepEqual(zoomAt(v, zoomed, 1, -400, 300, true), initial);
});

test('pan bounds prevent exposed edges and center each axis that still fits', () => {
  for (const [iw, ih] of [[4000, 100], [100, 4000], [1000, 800], [20, 20]]) {
    const v = viewport(1000, 800, iw, ih);
    for (const zoom of [.2, .5, 1, 1.1, 2.5, 10]) {
      for (const direction of [-1, 1]) {
        const state = panBy(v, { ...initial, zoom }, direction * 1e6, direction * 1e6);
        assert.equal(Math.abs(state.x), Math.max(0, (v.imageWidth * zoom - v.width) / 2));
        assert.equal(Math.abs(state.y), Math.max(0, (v.imageHeight * zoom - v.height) / 2));
        if (zoom === 1) assert.deepEqual(state, initial);
      }
    }
  }
});

test('resizing constrains the current position using the newly fitted dimensions', () => {
  const v = viewport(1000, 800, 2000, 1000);
  const state = panBy(v, { ...initial, zoom: 2 }, 500, 100);
  const resized = constrain(viewport(400, 1000, 2000, 1000), state);
  assert.deepEqual(resized, { zoom: 2, x: 200, y: 0 });
});

test('native keyboard zoom steps are bounded and wheel units normalize without rounding pinch deltas', () => {
  let zoom = 1;
  near(stepZoom(stepZoom(zoom, 1), 1), 1.2);
  for (let n = 0; n < 50; n++) zoom = stepZoom(zoom, 1);
  assert.equal(zoom, 10);
  for (let n = 0; n < 50; n++) zoom = stepZoom(zoom, -1);
  assert.equal(zoom, .2);
  assert.deepEqual([wheelDelta(.75, 0), wheelDelta(2, 1), wheelDelta(-1, 2)], [.75, 80, -800]);
  assert.equal(zoomAt(viewport(100, 100, 10, 10), initial, 500).zoom, 10);
  assert.deepEqual(zoomAt(viewport(100, 100, 10, 10), initial, -5), { zoom: .2, x: 0, y: 0 });
});

test('default window fit can shrink with wheel and keyboard and remains centered after resize', () => {
  const v = viewport(1000, 800, 2000, 1000);
  const wheelZoom = initial.zoom + wheelZoomAmount(60, 0);
  const smaller = zoomAt(v, initial, wheelZoom, 400, -300);
  assert.deepEqual(smaller, { zoom: .8, x: 0, y: 0 });
  const keyboardZoom = stepZoom(initial.zoom, -1);
  assert.ok(keyboardZoom < 1);
  assert.deepEqual(zoomAt(v, initial, keyboardZoom), { zoom: keyboardZoom, x: 0, y: 0 });
  assert.deepEqual(constrain(viewport(600, 1000, 2000, 1000), smaller), smaller);
  assert.deepEqual(panBy(v, smaller, 1000, -1000), smaller);
  assert.deepEqual(zoomAt(v, smaller, 1, 400, -300, true), initial);
});

test('fine zoom halves wheel sensitivity and has reversible keyboard steps near the 20% minimum', () => {
  for (const [delta, mode, mac] of [[120, 0, false], [-3, 1, false], [1, 2, false], [.75, 0, true]]) {
    const previousAmount = -wheelDelta(delta, mode) / 150 * (mac && !Number.isInteger(delta) ? 2 : 1);
    near(wheelZoomAmount(delta, mode, mac), previousAmount / 2);
  }
  for (const zoom of [.2, .3, .5, 1, 2.5]) {
    const enlarged = stepZoom(zoom, 1);
    assert.ok(enlarged > zoom && enlarged < zoom * 1.2);
    near(stepZoom(enlarged, -1), zoom);
  }
  const v = viewport(1000, 800, 2000, 1000);
  assert.deepEqual(zoomAt(v, initial, .1), { zoom: .2, x: 0, y: 0 });
});
