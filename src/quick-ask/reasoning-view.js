const { reasoningPage } = require("./stream-presentation");

// A closed disclosure contains no reasoning text DOM. An open disclosure
// renders one bounded page; the complete source stays available for copying.
function createReasoningView(parent, { ui, label, labels, onLayout = () => {} }) {
  const element = ui.createEl(parent, "details", { cls: "scholar-quick-ask-reasoning" });
  const summary = ui.createEl(element, "summary", { text: label });
  const body = ui.createEl(element, "div", { cls: "scholar-quick-ask-reasoning-body" });
  let text = "", streaming = false, requestedPage = null, textEl = null, controls = null;
  let previous, next, latest, count;
  let shownText = null;
  let shownLabel = label;
  let shownPage = null;
  const button = (icon, title, action) => {
    const item = ui.createEl(controls, "button", { attributes: { type: "button", "aria-label": title } });
    ui.setIcon(item, icon); ui.setTooltip(item, title); item.addEventListener("click", action); return item;
  };
  function render() {
    if (!element.open) return;
    if (!textEl) {
      controls = ui.createEl(body, "div", { cls: "scholar-quick-ask-reasoning-pages" });
      previous = button("chevron-left", labels.previous, () => { requestedPage = reasoningPage(text, requestedPage).page - 1; render(); });
      count = ui.createEl(controls, "span");
      next = button("chevron-right", labels.next, () => {
        const page = reasoningPage(text, requestedPage);
        requestedPage = page.page + 1 >= page.count - 1 ? null : page.page + 1;
        render();
      });
      latest = button("chevrons-right", labels.latest, () => { requestedPage = null; render(); });
      button("copy", labels.copy, () => { void ui.writeClipboard(text, element).catch(() => ui.notice(labels.copyFailed)); });
      textEl = ui.createEl(body, "div", { cls: "scholar-quick-ask-reasoning-text" });
      textEl.addEventListener("wheel", event => {
        if (event.deltaY < 0) requestedPage = reasoningPage(text, requestedPage).page;
      }, { passive: true });
    }
    const page = reasoningPage(text, requestedPage);
    if (shownText !== page.text) { ui.setText(textEl, page.text); shownText = page.text; }
    if (requestedPage === null) textEl.scrollTop = textEl.scrollHeight;
    else if (shownPage !== page.page) textEl.scrollTop = 0;
    shownPage = page.page;
    ui.setText(count, `${page.page + 1} / ${page.count}`);
    previous.disabled = page.page === 0;
    next.disabled = page.page === page.count - 1;
    latest.disabled = requestedPage === null;
    onLayout();
  }
  element.addEventListener("toggle", () => { render(); onLayout(); });
  return {
    element,
    get text() { return text; },
    update(value, active = false) {
      if (!text && !active) requestedPage = 0;
      const changed = value !== text || active !== streaming;
      text = value; streaming = active;
      element.hidden = !text;
      const nextLabel = label + (streaming ? "…" : "");
      if (shownLabel !== nextLabel) { ui.setText(summary, nextLabel); shownLabel = nextLabel; }
      if (changed) render();
    },
  };
}

module.exports = { createReasoningView };
