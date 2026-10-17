const MIN_INPUT_HEIGHT = 64;

function inputHeight(height, availableHeight) {
  const max = Math.max(MIN_INPUT_HEIGHT, Math.floor(availableHeight));
  return Math.round(Math.max(MIN_INPUT_HEIGHT, Math.min(max, height)));
}

// The input is docked at the bottom: moving its top edge upward increases it.
function draggedInputHeight(initialHeight, startY, currentY, availableHeight) {
  return inputHeight(initialHeight + startY - currentY, availableHeight);
}

// Reserve the measured composer chrome (including validation), rather than a
// fixed allowance that silently becomes wrong when text wraps or panes shrink.
function availableInputHeight({ pane, header, pending, composer, input, padding = 0 }) {
  return Math.max(MIN_INPUT_HEIGHT, pane - padding - header - pending - (composer - input) - 48);
}

// Reserve from the top of a visible overlapping status bar to the pane bottom.
// A floating bar's gap below it also belongs to that exclusion area. A bar
// outside this pane (including one already occupying normal flow) costs zero.
function statusBarInset(pane, bars = []) {
  if (!pane || pane.right <= pane.left || pane.bottom <= pane.top) return 0;
  let inset = 0;
  for (const bar of bars) {
    if (!bar || bar.visible === false || bar.right <= bar.left || bar.bottom <= bar.top) continue;
    if (bar.left >= pane.right || bar.right <= pane.left || bar.top >= pane.bottom || bar.bottom <= pane.top) continue;
    inset = Math.max(inset, Math.ceil(pane.bottom - Math.max(pane.top, bar.top)));
  }
  return inset;
}

module.exports = { MIN_INPUT_HEIGHT, inputHeight, draggedInputHeight, availableInputHeight, statusBarInset };
