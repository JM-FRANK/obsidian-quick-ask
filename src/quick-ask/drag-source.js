// The editor drag source. A Context Selection always ships with its containing
// file, so the drag is captured at its origin inside the editor extension:
// only the issuing editor can resolve the authoring Vault Path. Nothing here
// acts on another editor, and no Obsidian private API is used.
//
// The host side supplies this module with the public `editorInfoField` and
// registers the returned extension through `registerEditorExtension()`.

const DRAG_MIME = "application/x-scholar-quick-ask-selection";

// A drag capture is host-independent data: Vault Path, the captured range, the
// exact text, and the file text at drag time.
function createDragCapture({ path, from, to, text, fileText }) {
  if (typeof path !== "string" || path.length === 0) return null;
  if (typeof text !== "string" || text.length === 0) return null;
  return {
    path,
    from: Number.isInteger(from) ? from : null,
    to: Number.isInteger(to) ? to : null,
    text,
    fileText: typeof fileText === "string" ? fileText : null,
  };
}

// Capture from an editor state. The Vault Path comes from the public
// editorInfoField, an empty selection is rejected, and an editor without a
// file is ignored.
function captureFromState({ state, info, readText }) {
  const path = info?.file?.path;
  if (typeof path !== "string" || path.length === 0) return null;
  const selection = state.selection.main;
  if (selection.empty) return null;
  const text = state.sliceDoc(selection.from, selection.to);
  if (text.length === 0) return null;
  const line = state.doc.lineAt(selection.from);
  const capture = createDragCapture({
    path,
    from: selection.from,
    to: selection.to,
    text,
    fileText: null,
  });
  if (!capture) return null;
  capture.startLine = line.number;
  capture.startColumn = selection.from - line.from;
  void readText;
  return capture;
}

// Serialize the capture for the drop event. Only Quick Ask reads this type, so
// text dragged in from another application or an Obsidian internal drag type
// carries no editor origin and is rejected.
function serializeCapture(capture) {
  return JSON.stringify({
    path: capture.path,
    from: capture.from,
    to: capture.to,
    text: capture.text,
  });
}

function deserializeCapture(dataTransfer) {
  if (!dataTransfer || typeof dataTransfer.getData !== "function") return null;
  const raw = dataTransfer.getData(DRAG_MIME);
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return createDragCapture(parsed);
}

// A drop is accepted only for a captured editor drag whose exact text is still
// present in the Vault file. Re-reading at drop time is what makes a stale
// range detectable without a hash or a poller.
async function validateDrop({ capture, vault, normalizePath }) {
  if (!capture) return { accepted: false, reason: "no-capture" };
  const path = typeof normalizePath === "function" ? normalizePath(capture.path) : capture.path;
  if (vault.resolveRole && vault.resolveRole(path) !== "markdown") return { accepted: false, reason: "unsupported-file" };
  let current;
  try { current = await vault.readText(path); }
  catch { return { accepted: false, reason: "read-failed" }; }
  if (typeof current !== "string") return { accepted: false, reason: "missing-file" };
  const at = capture.from;
  if (!Number.isInteger(at) || !Number.isInteger(capture.to) || at < 0 || capture.to <= at ||
      current.slice(at, capture.to) !== capture.text) return { accepted: false, reason: "stale-text" };
  return {
    accepted: true,
    selection: {
      path,
      from: at,
      to: at + capture.text.length,
      text: capture.text,
      startLine: capture.startLine ?? null,
      startColumn: capture.startColumn ?? null,
    },
  };
}

// The one capture holder shared by the registered editor extensions and the
// sidebar's drop target. It holds at most one capture and clears on dragend.
function createCaptureHolder() {
  let current = null;
  return {
    set(capture) {
      current = capture;
    },
    get() {
      return current;
    },
    clear() {
      current = null;
    },
  };
}

// Accept a drop only on the pending-context area or the composer. The caller
// passes the two host elements; anything else in the sidebar is ignored.
function contains(region, target) {
  if (!region || !target || typeof region.contains !== "function") return false;
  return region.contains(target) === true;
}

function isAcceptedDropTarget(target, { pendingArea, composerArea } = {}) {
  if (!target || typeof target !== "object") return false;
  return contains(pendingArea, target) || contains(composerArea, target);
}

// The CodeMirror extension. `view.state.field(editorInfoField)` is the public
// way to reach the authoring file and the live-preview flag.
function createQuickAskDragExtension({
  EditorView = require("@codemirror/view").EditorView, editorInfoField, captureHolder = createCaptureHolder(), isEnabled = () => true,
}) {
  const handlers = {
    dragstart(event, view) {
      // An already-dispatched drag may race with feature deactivation.
      if (!isEnabled()) {
        captureHolder.clear();
        return false;
      }
      const info = editorInfoField ? view.state.field(editorInfoField, false) : null;
      const capture = captureFromState({ state: view.state, info });
      if (!capture) {
        captureHolder.clear();
        return false;
      }
      captureHolder.set(capture);
      try {
        event?.dataTransfer?.setData?.(DRAG_MIME, serializeCapture(capture));
      } catch {
        // A dataTransfer that refuses writes still leaves the in-memory
        // capture; the drop handler prefers it.
      }
      return false;
    },
    dragend() {
      captureHolder.clear();
      return false;
    },
  };
  return {
    captureHolder,
    handlers,
    extension: EditorView.domEventHandlers(handlers),
  };
}

module.exports = {
  DRAG_MIME,
  createDragCapture,
  captureFromState,
  serializeCapture,
  deserializeCapture,
  validateDrop,
  createCaptureHolder,
  isAcceptedDropTarget,
  createQuickAskDragExtension,
};
