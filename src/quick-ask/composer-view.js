const { Prec, RangeSetBuilder } = require("@codemirror/state");
const cmView = require("@codemirror/view");
const { EditorView, ViewPlugin, WidgetType, Decoration, keymap, placeholder } = cmView;
// EditorView.atomicRanges is the public CodeMirror name for the facet that
// makes a decorated range behave as one unit for the caret and for deletion.
const atomicRanges = EditorView.atomicRanges;
const {
  fileReferenceField, referencesOf, choosePath, stageReferences, questionText, referencedPaths, referenceDeletion, labelFor,
  editingReferenceField, openReferenceEffect, closeReferenceEffect,
} = require("./composer-state");
const { activePickerQuery } = require("./file-picker");

// The composer's DOM view: a real, owned CodeMirror 6 editor whose chip
// decorations, `[[` picker, and key handling are registered on this instance
// only. No other editor in the Vault is affected and no trigger channel is
// shared with other plugins. CodeMirror is bundled with the Composer; the host
// supplies Vault paths, supported Context types and its own fuzzy match helper.

// A rounded chip with a compact label and an exact underlying Vault Path.
class FileReferenceWidget extends WidgetType {
  constructor(path, label, ownerDocument = null, { from = 0, to = 0, selected = false, supported = true, unsupportedLabel = "" } = {}) {
    super();
    this.path = path;
    this.label = label;
    // The chip is created through the owning node's document so the sidebar
    // stays correct in a pop-out window.
    this.ownerDocument = ownerDocument;
    this.from = from;
    this.to = to;
    this.selected = selected;
    this.supported = supported;
    this.unsupportedLabel = unsupportedLabel;
  }

  eq(other) {
    return other instanceof FileReferenceWidget && other.path === this.path && other.label === this.label &&
      other.from === this.from && other.to === this.to && other.selected === this.selected && other.supported === this.supported && other.unsupportedLabel === this.unsupportedLabel;
  }

  toDOM(view) {
    const ownerDocument = this.ownerDocument ?? view?.dom?.ownerDocument ?? null;
    if (!ownerDocument) throw new Error("the composer requires the owning document");
    const chip = ownerDocument.createElement("span");
    chip.className = "scholar-quick-ask-chip";
    chip.textContent = this.label;
    chip.setAttribute("data-path", this.path);
    chip.setAttribute("data-from", String(this.from));
    chip.setAttribute("data-to", String(this.to));
    chip.setAttribute("title", this.supported ? this.path : this.unsupportedLabel);
    chip.classList.toggle("is-unsupported", !this.supported);
    chip.classList.toggle("is-selected", this.selected);
    chip.addEventListener("mousedown", event => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from, head: this.to } });
      view.focus();
    });
    chip.addEventListener("dblclick", event => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        effects: openReferenceEffect.of({ from: this.from, to: this.to }),
        selection: { anchor: this.from + 2, head: this.to - 2 },
      });
      view.focus();
    });
    return chip;
  }

  updateDOM(chip) {
    if (chip.getAttribute("data-path") !== this.path || chip.getAttribute("data-from") !== String(this.from) || chip.getAttribute("data-to") !== String(this.to)) return false;
    chip.classList.toggle("is-selected", this.selected);
    chip.classList.toggle("is-unsupported", !this.supported);
    chip.setAttribute("title", this.supported ? this.path : this.unsupportedLabel);
    return true;
  }

  ignoreEvent() {
    return true;
  }
}

function chipDecorations(state, ownerDocument = null, isSupported = () => true, unsupportedLabel = "") {
  const builder = new RangeSetBuilder();
  const editing = state.field(editingReferenceField, false);
  for (const reference of referencesOf(state)) {
    if (editing && reference.from === editing.from) continue;
    const selection = state.selection.main;
    builder.add(reference.from, reference.to, Decoration.replace({
      widget: new FileReferenceWidget(reference.path, labelFor(reference.path), ownerDocument, {
        ...reference, supported: isSupported(reference.path), unsupportedLabel, selected: !selection.empty && selection.from <= reference.from && selection.to >= reference.to,
      }),
    }));
  }
  return builder.finish();
}

function createChipPlugin(ownerDocument, isSupported, unsupportedLabel) {
  return ViewPlugin.fromClass(class {
    constructor(view) {
      this.decorations = chipDecorations(view.state, ownerDocument, isSupported, unsupportedLabel);
    }

    update(update) {
      if (update.docChanged || update.selectionSet || update.startState.field(editingReferenceField, false) !== update.state.field(editingReferenceField, false)) {
        this.decorations = chipDecorations(update.state, ownerDocument, isSupported, unsupportedLabel);
      }
    }
  }, {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) => atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  });
}

// The host's public AbstractInputSuggest owns completion rendering, keyboard
// navigation and popup placement. CodeMirror owns only text and chip state.
const { defaultKeymap, history, historyKeymap } = require("@codemirror/commands");
const { EditorState, Transaction } = require("@codemirror/state");
const VISIBLE_ROWS = 6;

function createComposerEditor({ parent, sidebar = parent, paths = [], createFileSuggester = null,
  isSupported = () => true, unsupportedLabel = "Unsupported file type",
  placeholderText = "", onChange = () => {}, onSubmit = null,
}) {
  let filePaths = paths;
  let suggest = null;
  let disposed = false;
  let refreshPending = false;
  const ownerDocument = parent.ownerDocument;
  function queryFor(state) {
    const editing = state.field(editingReferenceField, false);
    const query = activePickerQuery(state.doc.toString(), state.selection.main.head, { editingFrom: editing?.from });
    return query ? { ...query, to: editing?.from === query.from ? editing.to : query.to } : null;
  }
  function refreshSuggest() {
    if (refreshPending || disposed) return;
    refreshPending = true;
    Promise.resolve().then(() => {
      refreshPending = false;
      if (!disposed) suggest?.refresh();
    });
  }
  function deleteAdjacent(view, side) {
    const transaction = referenceDeletion(view.state, side);
    if (!transaction) return false;
    view.dispatch(transaction);
    return true;
  }
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "", extensions: [
      fileReferenceField, editingReferenceField, createChipPlugin(ownerDocument, isSupported, unsupportedLabel), history(), EditorView.lineWrapping,
      // The public theme extension outranks CodeMirror's default light theme.
      // Host CSS variables update with Obsidian's theme without a second palette.
      EditorView.theme({
        ".cm-content": { caretColor: "var(--caret-color, var(--text-normal))" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--caret-color, var(--text-normal))" },
        ".cm-content::selection, .cm-content ::selection": { backgroundColor: "var(--text-selection)" },
      }),
      Prec.highest(keymap.of([
        { key: "Enter", run: editor => {
          if (editor.composing) return false;
          if (suggest?.isOpen) return true;
          const editing = editor.state.field(editingReferenceField);
          if (editing) {
            const reference = referencesOf(editor.state).find(reference => reference.from === editing.from);
            if (reference) editor.dispatch({ effects: closeReferenceEffect.of(null), selection: { anchor: reference.to } });
            return true;
          }
          if (!onSubmit) return false;
          onSubmit();
          return true;
        }, stopPropagation: true },
        // Escape cancels an IME composition, so it must stay out of the picker
        // for as long as that composition is in flight.
        { key: "Escape", run: editor => { if (editor.composing || !suggest?.isOpen) return false; suggest.close(); return true; } },
        { key: "Backspace", run: view => deleteAdjacent(view, "end") },
        { key: "Delete", run: view => deleteAdjacent(view, "start") },
      ])),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      placeholder(placeholderText),
      EditorView.domEventHandlers({
        // CodeMirror drops key events while an IME composition is in flight but
        // still delivers composition events. Re-read the picker query once the
        // committed text has reached the document: a cancelled composition
        // leaves the old query in place, and a committed one may have replaced
        // it entirely. The refresh defers, so it reads the flushed document.
        compositionend: () => { refreshSuggest(); return false; },
        blur: (_event, editor) => {
          const editing = editor.state.field(editingReferenceField);
          if (editing && referencesOf(editor.state).some(reference => reference.from === editing.from && reference.to === editing.to)) {
            editor.dispatch({ effects: closeReferenceEffect.of(null) });
          }
        },
      }),
      EditorView.updateListener.of(update => {
        // A composing IME writes its uncommitted text into the document before
        // the user confirms it. The picker follows committed text only, so it
        // holds still until compositionend delivers the final transaction.
        if ((update.docChanged || update.selectionSet) && !update.view.composing) refreshSuggest();
        if (update.docChanged) onChange(questionText(update.state), referencedPaths(update.state, isSupported));
      }),
    ] }),
  });
  if (createFileSuggester) {
    suggest = createFileSuggester({
      input: view.contentDOM,
      // While composing, the suggester is told there is no query: the host
      // component reacts to raw DOM input, and the composition has already put
      // its uncommitted text into the document, which must not be ranked.
      getQuery: () => (view.composing ? null : queryFor(view.state)),
      getPaths: () => typeof filePaths === "function" ? filePaths() : filePaths,
      onChoose: option => {
        const query = queryFor(view.state);
        if (!query || disposed) return;
        view.dispatch(choosePath(view.state, option, query));
        view.focus();
      },
    });
  }
  const emptyState = view.state;
  return {
    view,
    getEditorView: () => view,
    get text() { return questionText(view.state); },
    get paths() { return referencedPaths(view.state, isSupported); },
    get isPickerOpen() { return suggest?.isOpen === true; },
    get isEditingReference() { return view.state.field(editingReferenceField) !== null; },
    getDraft: () => view.state.doc.toString(),
    setDraft(text = "") {
      suggest?.close();
      view.setState(emptyState.update({ changes: { from: 0, insert: text }, selection: { anchor: text.length }, annotations: Transaction.addToHistory.of(false) }).state);
    },
    insertFiles(paths, coordinates = null) {
      const at = coordinates ? view.posAtCoords(coordinates) : null;
      const transaction = stageReferences(view.state, paths, at ?? view.state.selection.main.head);
      if (!transaction) return false;
      suggest?.close(); view.dispatch(transaction); view.focus();
      return true;
    },
    setPaths(paths) { filePaths = paths ?? []; refreshSuggest(); },
    focus() { view.focus(); },
    clear() { view.dispatch({ changes: { from: 0, to: view.state.doc.length }, selection: { anchor: 0 } }); suggest?.close(); },
    destroy() { disposed = true; suggest?.dispose(); view.destroy(); },
  };
}

module.exports = { createComposerEditor, FileReferenceWidget, chipDecorations, createChipPlugin, VISIBLE_ROWS };
