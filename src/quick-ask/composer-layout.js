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

module.exports = { MIN_INPUT_HEIGHT, inputHeight, draggedInputHeight, availableInputHeight };
