// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inputHeight, draggedInputHeight, availableInputHeight, statusBarInset } = require('../src/quick-ask/composer-layout');

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

test('reserve only the actual status-bar overlap, including partial-width and floating bars', () => {
  const pane = { left: 600, right: 1000, top: 80, bottom: 800 };
  assert.equal(statusBarInset(pane, [{ left: 750, right: 1000, top: 776, bottom: 800 }]), 24);
  assert.equal(statusBarInset(pane, [{ left: 750, right: 990, top: 770, bottom: 790 }]), 30, 'floating bottom gap is excluded too');
  assert.equal(statusBarInset(pane, [{ left: 999, right: 1100, top: 776, bottom: 820 }]), 24, 'even a narrow horizontal intersection can cover a control');
  assert.equal(statusBarInset(pane, [{ left: 750, right: 1000, top: 775.75, bottom: 800 }]), 25, 'round up fractional pixels to keep the bottom clear');
});

test('normal-flow, hidden, absent and other-pane status bars add no blank space', () => {
  const pane = { left: 600, right: 1000, top: 80, bottom: 776 };
  assert.equal(statusBarInset(pane), 0, 'pop-out without a status bar');
  assert.equal(statusBarInset(pane, [{ left: 600, right: 1000, top: 776, bottom: 800 }]), 0, 'theme already reserves its status-bar row');
  assert.equal(statusBarInset(pane, [{ left: 0, right: 600, top: 750, bottom: 800 }]), 0, 'bar is in another horizontal pane');
  assert.equal(statusBarInset(pane, [{ left: 600, right: 1000, top: 750, bottom: 800, visible: false }]), 0);
  assert.equal(statusBarInset(pane, [{ left: 600, right: 600, top: 750, bottom: 800 }]), 0);
  assert.equal(statusBarInset(pane, [{ left: 600, right: 1000, top: 20, bottom: 80 }]), 0);
});

test('use the largest overlapping exclusion once and restore zero when the bar disappears', () => {
  const pane = { left: 600, right: 1000, top: 80, bottom: 800 };
  const bars = [{ left: 750, right: 1000, top: 776, bottom: 800 }, { left: 650, right: 900, top: 768, bottom: 790 }];
  assert.equal(statusBarInset(pane, bars), 32);
  assert.equal(statusBarInset(pane, []), 0);
  assert.equal(statusBarInset({ ...pane, bottom: 768 }, bars), 0, 'existing theme reservation is not counted twice');
  assert.equal(statusBarInset({ ...pane, right: 600 }, bars), 0, 'unlaid-out pane');
});

test('status-bar padding reduces the input height budget without depending on current input height', () => {
  const metrics = { pane: 800, header: 40, pending: 180, composer: 240, input: 112, padding: 0 };
  assert.equal(availableInputHeight({ ...metrics, padding: 24 }), availableInputHeight(metrics) - 24);
  assert.equal(availableInputHeight({ ...metrics, padding: 24, composer: 340, input: 212 }), availableInputHeight(metrics) - 24);
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
