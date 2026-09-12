const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inputHeight, draggedInputHeight, availableInputHeight } = require('../src/quick-ask/composer-layout');

test('dragging the top edge up increases input height and down decreases it', () => {
  assert.equal(draggedInputHeight(112, 300, 240, 400), 172);
  assert.equal(draggedInputHeight(112, 300, 330, 400), 82);
});

test('the height budget includes wrapping validation and remains stable during a drag', () => {
  const metrics = { pane: 800, header: 40, pending: 180, composer: 240, input: 112, padding: 24 };
  assert.equal(availableInputHeight(metrics), 380);
  assert.equal(availableInputHeight({ ...metrics, composer: 340, input: 212 }), 380);
  assert.equal(availableInputHeight({ ...metrics, composer: 300 }), 320);
  assert.equal(availableInputHeight({ ...metrics, pane: 200 }), 64);
});

test('the resize range respects minimum height and available pane space', () => {
  assert.equal(inputHeight(-20, 400), 64);
  assert.equal(inputHeight(900, 400), 400);
  assert.equal(inputHeight(112, 20), 64);
});
