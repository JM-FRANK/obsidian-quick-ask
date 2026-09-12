const { AbstractInputSuggest, Component, Keymap, MarkdownView, MarkdownRenderer, Modal, Notice, Platform, TFile, Menu, normalizePath, prepareFuzzySearch, renderMatches, requestUrl, setIcon, setTooltip, editorInfoField, editorLivePreviewField } = require("obsidian");
const { t } = require("./i18n");
const { droppedFilePaths } = require("./file-input");
const { pickerOptions, isCompositionEvent } = require("./file-picker");
const { selectionRange } = require("./pending-context");
const { QUICK_ASK_VIEW_TYPE } = require("./view-type");
const { sessionMenuEntries } = require("./session-navigation");

// The Quick Ask host seam, matching the factory convention of
// src/obsidian-adapter.js. It builds the capability slices that Quick Ask core
// modules receive. The core never sees the Obsidian application object: every
// slice below exposes plain data or plain functions, and no slice hands out a
// TFile, WorkspaceLeaf, Editor, Document, or Window.
//
// ui.createEl intentionally exposes DOM element construction. The core cannot
// build a sidebar out of nothing without it, and the element comes from the
// owning container, so the sidebar still works in a pop-out window. What the
// seam forbids is the global `document` and `window`, not element access.

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

function isInsideConfigDirectory(path, configDirectory) {
  const directory = String(configDirectory || ".obsidian").replace(/^\/+|\/+$/g, "");
  return path === directory || path.startsWith(`${directory}/`);
}

// One environment function resolves a Context File's role, so extension
// classification, case rules, and plugin-directory exclusions live in a single
// place. Version 0.1 accepts Markdown only.
function createRoleResolver(configDirectory) {
  return (path) => {
    if (typeof path !== "string" || path.length === 0) return null;
    if (path.startsWith("/") || path.includes("\\")) return null;
    if (isInsideConfigDirectory(path, configDirectory)) return null;
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name.length === 0 || name.startsWith(".")) return null;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return null;
    const extension = name.slice(dot + 1).toLowerCase();
    return MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : null;
  };
}

function createQuickAskEnvironment(plugin, { getLanguage = () => "en", canNetwork = () => true, viewType = QUICK_ASK_VIEW_TYPE } = {}) {
  const { vault, workspace } = plugin.app;
  const configDirectory = vault.configDir ?? ".obsidian";
  const pluginDirectory = plugin.manifest?.dir ?? `${configDirectory}/plugins/${plugin.manifest?.id ?? "scholar-workbench"}`;
  const resolveRole = createRoleResolver(configDirectory);
  const language = { language: getLanguage };
  let fuzzyQuery = null;
  let fuzzySearch = null;
  const hoverParents = new WeakMap();
  const markdownComponents = new WeakMap();

  function fileOf(path) {
    const file = vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  function join(directory, path) {
    return directory ? `${directory}/${path}` : path;
  }

  // One place resolves the owning window for timers and the clipboard, so the
  // sidebar follows a pop-out window instead of a global.
  function ownerWindow() {
    return plugin.app?.workspace?.activeLeaf?.view?.containerEl?.ownerDocument?.defaultView ?? null;
  }

  return {
    vault: {
      listFiles() {
        return vault.getFiles().filter(file => !isInsideConfigDirectory(file.path, configDirectory)).map((file) => ({ path: file.path, mtime: file.stat?.mtime ?? 0 }));
      },
      droppedFilePaths(dataTransfer) {
        return droppedFilePaths(dataTransfer, {
          vaultName: vault.getName(),
          resolvePath: path => {
            const file = fileOf(path) ?? fileOf(`${path}.md`);
            return file && !isInsideConfigDirectory(file.path, configDirectory) ? file.path : null;
          },
        });
      },
      exists(path) {
        return fileOf(path) !== null;
      },
      async readText(path) {
        const file = fileOf(path);
        return file ? await vault.cachedRead(file) : null;
      },
      normalizePath(path) {
        return normalizePath(path);
      },
      // The preserved copy mirrors readable session files into a user-chosen
      // Vault folder through the public Vault API.
      async writeText(path, text) {
        const existing = fileOf(path);
        if (existing) {
          await vault.modify(existing, text);
          return;
        }
        let folder = "";
        for (const segment of path.split("/").slice(0, -1)) {
          folder = folder ? `${folder}/${segment}` : segment;
          if (!fileOf(folder)) {
            try {
              await vault.createFolder(folder);
            } catch {
              // A concurrent creator is not a failure.
            }
          }
        }
        try {
          await vault.create(path, text);
        } catch (error) {
          const raced = fileOf(path);
          if (raced) {
            await vault.modify(raced, text);
            return;
          }
          throw error;
        }
      },
      resolveRole,
    },

    pluginData: {
      pluginDirectory,
      dataAdapter: {
        read: (path) => vault.adapter.read(path),
        write: (path, data) => vault.adapter.write(path, data),
        append: (path, data) => vault.adapter.append(path, data),
        exists: (path) => vault.adapter.exists(path),
        mkdir: (path) => vault.adapter.mkdir(path),
        remove: (path) => vault.adapter.remove(path),
        list: async (path) => {
          const result = await vault.adapter.list(path);
          return { files: [...(result?.files ?? [])], folders: [...(result?.folders ?? [])] };
        },
        stat: async (path) => {
          const stat = await vault.adapter.stat(path);
          return stat ? { size: stat.size, mtime: stat.mtime } : null;
        },
      },
    },

    secrets: {
      resolve(id) {
        if (typeof id !== "string" || id.length === 0) return null;
        return plugin.app.secretStorage?.getSecret?.(id) ?? null;
      },
      list() {
        return (plugin.app.secretStorage?.listSecrets?.() ?? []).map((id) => ({ id, name: id }));
      },
      onChange(listener) {
        const storage = plugin.app.secretStorage;
        const ref = storage?.on?.("change", listener);
        if (ref) plugin.registerEvent(ref);
        return () => { if (ref) storage.offref(ref); };
      },
    },

    workspace: {
      openView(viewType) {
        const existing = workspace.getLeavesOfType(viewType);
        if (existing.length > 0) {
          void workspace.revealLeaf(existing[0]);
          return true;
        }
        const leaf = workspace.getRightLeaf(false);
        if (!leaf) return false;
        void leaf.setViewState({ type: viewType, active: true });
        void workspace.revealLeaf(leaf);
        return true;
      },
      onVaultEvent(name, listener) {
        return plugin.registerEvent(vault.on(name, listener));
      },
      isDesktop() {
        return Platform?.isDesktopApp === true;
      },
      async openTextRange(selection, event) {
        try {
          const file = fileOf(selection.path);
          if (!file) { new Notice(t(language, "context.fileDeleted")); return; }
          const leaf = workspace.getLeaf(Keymap.isModEvent(event));
          await leaf.openFile(file, { active: true, state: { mode: "source" } });
          if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== selection.path) return;
          const editor = leaf.view.editor;
          const range = selectionRange(editor.getValue(), selection);
          if (!range) { new Notice(t(language, "selection.locationChanged")); return; }
          const from = editor.offsetToPos(range.from);
          const to = editor.offsetToPos(range.to);
          editor.setSelection(from, to);
          editor.scrollIntoView({ from, to }, true);
        } catch { new Notice(t(language, "selection.openFailed")); }
      },
    },

    ui: {
      createEl(parent, tag, options = {}) {
        const element = parent.createEl(tag, { cls: options.cls, text: options.text });
        for (const [name, value] of Object.entries(options.attributes ?? {})) {
          element.setAttribute(name, value);
        }
        return element;
      },
      clear(element) {
        for (const component of markdownComponents.get(element) ?? []) component.unload();
        markdownComponents.delete(element);
        hoverParents.get(element)?.hoverPopover?.unload();
        hoverParents.delete(element);
        element.empty();
      },
      setText(element, text) {
        element.setText(text);
      },
      setTooltip(element, tooltip, options) {
        setTooltip(element, tooltip, options);
      },
      setIcon(element, icon) {
        setIcon(element, icon);
      },
      renderMarkdown(element, markdown, sourcePath) {
        const owner = element.closest(".scholar-quick-ask-history") ?? element;
        let components = markdownComponents.get(owner);
        if (!components) { components = new Set(); markdownComponents.set(owner, components); }
        const component = new Component();
        components.add(component);
        component.load();
        return MarkdownRenderer.render(plugin.app, markdown, element, sourcePath ?? "", component);
      },
      // The host's own fuzzy matcher and highlight helper; the picker does not
      // reinvent Obsidian's ranking.
      fuzzyMatch(text, query) {
        if (fuzzyQuery !== query || !fuzzySearch) {
          fuzzyQuery = query;
          fuzzySearch = prepareFuzzySearch(query);
        }
        return fuzzySearch(text);
      },
      highlightMatches(element, text, matches) {
        renderMatches(element, text, matches);
      },
      createFileSuggester({ input, getQuery, getPaths, onChoose }) {
        let visible = false;
        let disposed = false;
        let paths = null;
        let trigger = null;
        class FileSuggest extends AbstractInputSuggest {
          getValue() { const query = getQuery(); return query ? `[[${query.query}` : ""; }
          getSuggestions() {
            const query = getQuery();
            if (!query) { paths = null; trigger = null; return []; }
            if (!paths || trigger !== query.from) { paths = getPaths(); trigger = query.from; }
            const search = query.query ? prepareFuzzySearch(query.query) : null;
            return pickerOptions(paths, query.query, text => search?.(text) ?? null);
          }
          renderSuggestion(option, element) {
            element.empty();
            element.addClass("scholar-quick-ask-native-suggestion");
            element.style.maxWidth = `${Math.max(120, input.clientWidth - 16)}px`;
            element.setAttribute("title", option.path);
            const label = element.createSpan({ cls: "scholar-quick-ask-native-path" });
            renderMatches(label, option.label, option.matches);
            if (option.directory) {
              const directory = element.createSpan({ cls: "scholar-quick-ask-native-directory" });
              renderMatches(directory, option.directory, option.directoryMatches ?? []);
            }
          }
          selectSuggestion(option, event) {
            // Enter and Escape belong to the IME while it is composing, so a
            // composing key event never chooses a file even when the picker is
            // still rendered. A plain mouse selection is unaffected.
            if (isCompositionEvent(event)) return;
            event?.preventDefault();
            event?.stopPropagation();
            this.close();
            if (!disposed && getQuery()) onChoose(option);
          }
          open() { if (!disposed && getQuery()) { visible = true; super.open(); } }
          close() { visible = false; super.close(); }
        }
        const suggest = new FileSuggest(plugin.app, input);
        suggest.limit = 50;
        return {
          get isOpen() { return visible; },
          refresh() {
            if (disposed) return;
            if (input.ownerDocument.activeElement !== input) { suggest.close(); return; }
            if (!getQuery()) { paths = null; trigger = null; suggest.close(); return; }
            // The public input suggester listens to DOM input. Publish after
            // CodeMirror has committed the transaction, without touching its DOM.
            input.dispatchEvent(new input.ownerDocument.defaultView.Event("input"));
          },
          close() { suggest.close(); },
          dispose() { disposed = true; suggest.close(); },
        };
      },
      sessionMenu(anchor, sessions, { activeSessionId, ...actions }) {
        if (sessions.length === 0) return null;
        const doc = anchor.ownerDocument, owner = doc.defaultView;
        const panel = anchor.parentElement.createDiv({ cls: "scholar-quick-ask-session-panel" });
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", t(language, "sidebar.sessionSelector"));
        anchor.setAttribute("aria-expanded", "true");
        const viewport = anchor.closest(".scholar-quick-ask-view").getBoundingClientRect();
        panel.style.maxHeight = `${Math.max(64, Math.min(360, viewport.bottom - anchor.getBoundingClientRect().bottom - 12))}px`;
        let closed = false, actionMenu = null;
        const closePanel = (focus = false) => {
          if (closed) return;
          closed = true;
          doc.removeEventListener("pointerdown", outside, true);
          doc.removeEventListener("focusin", focusOutside);
          owner.removeEventListener("blur", windowBlur);
          panel.remove();
          anchor.setAttribute("aria-expanded", "false");
          if (focus && anchor.isConnected) anchor.focus();
        };
        const outside = event => { if (!panel.contains(event.target) && !anchor.contains(event.target)) closePanel(); };
        const focusOutside = event => { if (!panel.contains(event.target) && !anchor.contains(event.target)) closePanel(); };
        const windowBlur = () => closePanel();
        const dispatch = action => {
          closePanel();
          actionMenu?.hide();
          owner.setTimeout(() => { Promise.resolve().then(action).catch(() => new Notice(t(language, "sidebar.actionFailed"))); }, 0);
        };
        const entries = sessionMenuEntries(sessions, activeSessionId, actions);
        const buttons = [];
        for (const entry of entries) {
          const row = panel.createDiv({ cls: "scholar-quick-ask-session-row" });
          row.classList.toggle("is-current", entry.current);
          const open = row.createEl("button", { cls: "scholar-quick-ask-session-name", attr: { type: "button", "aria-current": String(entry.current) } });
          const status = open.createSpan({ cls: "scholar-quick-ask-session-state" });
          if (entry.running || entry.current || entry.unread) setIcon(status, entry.running ? "loader" : entry.current ? "check" : "circle-dot");
          open.createSpan({ text: entry.title });
          setTooltip(open, entry.title);
          open.addEventListener("click", () => dispatch(entry.open));
          buttons.push(open);
          const more = row.createEl("button", { cls: "scholar-quick-ask-session-more", attr: { type: "button", "aria-label": t(language, "sidebar.manageSession", { title: entry.title }) } });
          setIcon(more, "ellipsis");
          setTooltip(more, t(language, "sidebar.manageSession", { title: entry.title }));
          more.addEventListener("click", event => {
            event.stopPropagation();
            const rect = more.getBoundingClientRect();
            // Close the list before opening the public native action menu so
            // its click/focus events cannot be swallowed by outside dismissal.
            closePanel();
            actionMenu = new Menu().setUseNativeMenu(false).setParentElement(anchor);
            actionMenu.addItem(item => item.setTitle(entry.title).setDisabled(true));
            actionMenu.addSeparator();
            actionMenu.addItem(item => item.setTitle(t(language, "sidebar.renameSession")).setIcon("pencil").onClick(() => dispatch(entry.rename)));
            actionMenu.addItem(item => item.setTitle(t(language, "sidebar.deleteSession")).setIcon("trash").setWarning(true).onClick(() => dispatch(entry.remove)));
            actionMenu.onHide(() => { if (anchor.isConnected) anchor.focus(); });
            actionMenu.showAtPosition({ x: rect.left, y: rect.bottom }, doc);
          });
          row.addEventListener("keydown", event => {
            const index = buttons.indexOf(open);
            const target = event.key === "ArrowDown" ? (index + 1) % entries.length
              : event.key === "ArrowUp" ? (index + entries.length - 1) % entries.length
                : event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : null;
            if (target !== null) { event.preventDefault(); buttons[target].focus(); }
          });
        }
        panel.addEventListener("keydown", event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePanel(true); }
        });
        doc.addEventListener("pointerdown", outside, true);
        doc.addEventListener("focusin", focusOutside);
        owner.addEventListener("blur", windowBlur);
        buttons[Math.max(0, entries.findIndex(entry => entry.current))].focus();
        return () => { closePanel(); actionMenu?.hide(); };
      },
      promptTitle(value) {
        return new Promise(resolve => {
          const modal = new Modal(plugin.app);
          let result = null;
          modal.onOpen = () => {
            modal.setTitle(t(language, "sidebar.renameSession"));
            const input = modal.contentEl.createEl("input", { type: "text", value });
            input.style.width = "100%";
            const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
            const cancel = buttons.createEl("button", { text: t(language, "common.cancel") });
            const save = buttons.createEl("button", { text: t(language, "common.save"), cls: "mod-cta" });
            const update = () => { save.disabled = !input.value.trim(); };
            const finish = () => { if (input.value.trim()) { result = input.value.trim(); modal.close(); } };
            input.addEventListener("input", update);
            input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); finish(); } });
            cancel.addEventListener("click", () => modal.close());
            save.addEventListener("click", finish);
            update();
            input.focus();
            input.select();
          };
          modal.onClose = () => resolve(result);
          modal.open();
        });
      },
      removeElement(element) {
        element.remove();
      },
      // Clipboard access is a host capability. The window comes from a
      // reachable node so a pop-out window uses its own clipboard.
      writeClipboard(text, element = null) {
        const owner = element?.ownerDocument?.defaultView ?? ownerWindow();
        if (!owner?.navigator?.clipboard) return Promise.reject(new Error("Clipboard unavailable"));
        return owner.navigator.clipboard.writeText(text);
      },
      readClipboard() {
        const owner = ownerWindow();
        return owner?.navigator?.clipboard?.readText?.() ?? Promise.resolve(null);
      },
      renderInternalLink(parent, { path, label, sourcePath, previewOwner = parent }) {
        const anchor = parent.createEl("a", { text: label ?? `@${path}`, cls: "internal-link" });
        anchor.setAttribute("data-href", path);
        anchor.setAttribute("href", path);
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void workspace.openLinkText(path, sourcePath ?? "", Keymap.isModEvent(event));
        });
        anchor.addEventListener("mouseover", event => {
          let hoverParent = hoverParents.get(previewOwner);
          if (!hoverParent) {
            hoverParent = { hoverPopover: null };
            hoverParents.set(previewOwner, hoverParent);
          }
          workspace.trigger("hover-link", {
            event, source: viewType, hoverParent,
            targetEl: anchor, linktext: path, sourcePath: sourcePath ?? "",
          });
        });
        return anchor;
      },
      notice(message) {
        new Notice(message);
      },
      confirm(message, { title = t(language, "common.dialogTitle") } = {}) {
        return new Promise(resolve => {
          let confirmed = false;
          const modal = new Modal(plugin.app);
          modal.onOpen = () => {
            modal.setTitle(title);
            modal.contentEl.createEl("p", { text: message });
            const buttons = modal.contentEl.createDiv({ cls: "modal-button-container" });
            buttons.createEl("button", { text: t(language, "common.cancel") }).addEventListener("click", () => modal.close());
            buttons.createEl("button", { text: t(language, "common.delete"), cls: "mod-warning" }).addEventListener("click", () => { confirmed = true; modal.close(); });
          };
          modal.onClose = () => resolve(confirmed);
          modal.open();
        });
      },
    },

    network: {
      // The SSE decoder and the abort controller are part of the transport
      // capability, so a host without the globals still streams and stops.
      TextDecoder: typeof globalThis.TextDecoder === "function" ? globalThis.TextDecoder : undefined,
      AbortController: typeof globalThis.AbortController === "function" ? globalThis.AbortController : undefined,
      fetch(url, options) {
        if (!canNetwork() || options?.signal?.aborted) return Promise.reject(Object.assign(new Error("Quick Ask is disabled"), { name: "AbortError" }));
        const owner = ownerWindow();
        const fetch = owner?.fetch?.bind(owner) ?? globalThis.fetch.bind(globalThis);
        return fetch(url, options);
      },
      request(options) {
        const { signal, ...request } = options;
        const aborted = () => Object.assign(new Error("Quick Ask request stopped"), { name: "AbortError" });
        if (!canNetwork() || signal?.aborted) return Promise.reject(aborted());
        // requestUrl has no transport cancellation API. Stop awaiting it on
        // abort, discard its late result, and never start a follow-up request.
        return new Promise((resolve, reject) => {
          const stop = () => reject(aborted());
          signal?.addEventListener("abort", stop, { once: true });
          Promise.resolve().then(() => {
            if (!canNetwork() || signal?.aborted) throw aborted();
            return requestUrl({ throw: false, ...request });
          }).then(resolve, reject).finally(() => signal?.removeEventListener("abort", stop));
        });
      },
    },

    // The scheduler capability owns the clock and the timers. The functions are
    // resolved from the owning window when one is reachable, because a bundle
    // host may not expose them as globals.
    scheduler: {
      now() {
        return Date.now();
      },
      delay(milliseconds, callback) {
        const owner = ownerWindow();
        const setTimer = owner?.setTimeout?.bind(owner) ?? globalThis.setTimeout;
        return setTimer ? setTimer(callback, milliseconds) : undefined;
      },
      cancelDelay(handle) {
        const owner = ownerWindow();
        const clearTimer = owner?.clearTimeout?.bind(owner) ?? globalThis.clearTimeout;
        if (clearTimer) clearTimer(handle);
      },
      frame(callback) {
        const owner = ownerWindow();
        const request = owner?.requestAnimationFrame?.bind(owner) ?? globalThis.requestAnimationFrame;
        return request ? request(callback) : undefined;
      },
      cancelFrame(handle) {
        const owner = ownerWindow();
        const cancel = owner?.cancelAnimationFrame?.bind(owner) ?? globalThis.cancelAnimationFrame;
        if (cancel) cancel(handle);
      },
    },
  };
}

module.exports = { createQuickAskEnvironment, createRoleResolver, MARKDOWN_EXTENSIONS };
