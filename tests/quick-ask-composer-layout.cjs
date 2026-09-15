// quick-ask-suite: portable
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

test('profile header source keeps muted bounded text between the session selector and New session', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/quick-ask/view.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/quick-ask/styles.css'), 'utf8');
  const header = source.slice(source.indexOf('  renderHeader() {'), source.indexOf('  renderConversation() {'));
  assert.match(header, /scholar-quick-ask-session-select[\s\S]*scholar-quick-ask-profile[\s\S]*scholar-quick-ask-new-session/);
  assert.match(header, /profileName\(activeProfile\(this.getSettings\(\)\?\.quickAsk\)/);
  assert.match(header, /setTooltip\(profile,[^\n]*profiles.newSessionsOnly/);
  const profileStyle = css.match(/\.scholar-quick-ask-profile\s*\{([^}]+)\}/)?.[1] ?? '';
  for (const rule of ['color: var(--text-muted)', 'max-width: 28%', 'min-width: 0', 'text-overflow: ellipsis', 'white-space: nowrap']) assert.ok(profileStyle.includes(rule), rule);
  assert.match(css, /button\.scholar-quick-ask-session-select\s*\{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/);
});
