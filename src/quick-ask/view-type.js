// The view type lives on its own so the integration entry point can register
// and open the sidebar without loading the view's CodeMirror dependencies.
const QUICK_ASK_VIEW_TYPE = "scholar-quick-ask-view";

function quickAskViewType(pluginId) {
  return pluginId === "quick-ask" ? "quick-ask-view" : QUICK_ASK_VIEW_TYPE;
}

module.exports = { QUICK_ASK_VIEW_TYPE, quickAskViewType };
