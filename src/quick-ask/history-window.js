// Display pagination only. The canonical log and model context stay complete.
const HISTORY_PAGE_TURNS = 8;
const HISTORY_PAGE_ENTRIES = 48;

function historyPageStart(messages, end = messages.length) {
  let turns = 0;
  for (let index = end - 1; index >= 0; index--) {
    if (messages[index].role === 'user') turns += 1;
    // Prefer whole user turns; bound legacy/tool-heavy histories as well.
    if (turns >= HISTORY_PAGE_TURNS || end - index >= HISTORY_PAGE_ENTRIES) return index;
  }
  return 0;
}

module.exports = { historyPageStart, HISTORY_PAGE_TURNS, HISTORY_PAGE_ENTRIES };
