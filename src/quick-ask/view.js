const { sessionNavigation, createSessionActionQueue, adoptUnassignedDraft } = require("./session-navigation");
const { prepareSubmission, recoverSubmittedDraft } = require("./submission-state");
const { createScrollFollow } = require("./stream-presentation");
const { createReasoningView } = require("./reasoning-view");
const { normalizeDisplaySettings } = require("./settings");
const { conversationFromRecords, questionFromInput } = require("./conversation-messages");
const { MIN_INPUT_HEIGHT, inputHeight, draggedInputHeight, availableInputHeight } = require("./composer-layout");
const {
  createPendingContext, addFile, addSelection, removeFile, removeSelection, clearSelections,
  derivePendingView, showsExpandBar,
} = require("./pending-context");
const { supportedReferences, canReferencePath } = require("./file-input");
const { validateDrop, isAcceptedDropTarget } = require("./drag-source");

// The Quick Ask sidebar: a real Obsidian ItemView built through the host
// capability slices. It owns the session header, the scrollable conversation
// area, the two pending-context stacks above the composer, and the composer
// itself. Presentation state here is deliberately separate from internal
// Context tracking; a visible File Row is not the tracked-file model.

const { QUICK_ASK_VIEW_TYPE } = require("./view-type");
const { formatTokens, formatPercent, occupancyColor } = require("./tokens");

// Open sidebars, so a streaming turn that belongs to a background session can
// still update the view that is showing it. The plugin may open more than one
// Quick Ask leaf in a pop-out window.
const openViews = new Set();
let messageLabelId = 0;

class QuickAskView {
  constructor(leaf, {
    environment, sessionStore, getSettings, t: translate, createComposer = null, viewType = QUICK_ASK_VIEW_TYPE,
    conversation = null, trackerFor = null, getConfig = () => ({}), deleteSessionData = null,
    captureHolder = null, retrieveResponse = null,
    drafts = new Map(), sessionActions = createSessionActionQueue(),
  }) {
    this.leaf = leaf;
    this.environment = environment;
    this.viewType = viewType;
    this.sessionStore = sessionStore;
    this.getSettings = getSettings;
    this.t = translate;
    this.ui = environment.ui;
    this.pending = createPendingContext();
    this.expanded = false;
    this.sessions = [];
    this.activeSessionId = null;
    // The session whose turn this view is watching; switching sessions only
    // changes what is displayed, never what keeps running.
    this.trackedSessionId = null;
    this.messages = [];
    this.createComposer = createComposer;
    this.runtime = conversation;
    this.trackerFor = trackerFor;
    this.getConfig = getConfig;
    this.deleteSessionData = deleteSessionData;
    this.captureHolder = captureHolder;
    this.retrieveResponse = retrieveResponse;
    this.drafts = drafts;
    this.sessionActions = sessionActions;
    this.loadingSessions = true;
    this.activationGeneration = 0;
    this.roots = {};
    this.mounted = false;
    this.streaming = null;
    this.sending = false;
    this.scrollFollow = createScrollFollow();
    this.paintFrame = null;
    this.followFrame = null;
  }

  getViewType() {
    return this.viewType;
  }

  getDisplayText() {
    return this.t(this.getSettings(), "view.displayName");
  }

  getIcon() {
    return "message-circle-question";
  }

  // Called once Obsidian opens the view, with the leaf's content element.
  async onOpen() {
    if (!this.contentEl) return;
    await this.render(this.contentEl);
  }

  async onClose() {
    this.saveDraft();
    this.activationGeneration += 1;
    this.cancelConversationPaint();
    if (this.followFrame !== null) this.followWindow.cancelAnimationFrame(this.followFrame);
    this.followFrame = null;
    this.scrollObserver?.disconnect();
    this.stopResizing?.();
    this.resizeObserver?.disconnect();
    if (this.roots.pending) this.ui.clear(this.roots.pending);
    if (this.roots.history) this.ui.clear(this.roots.history);
    if (this.roots.conversation) this.ui.clear(this.roots.conversation);
    this.closeSessionMenu?.();
    this.composer?.destroy?.();
    this.mounted = false;
    openViews.delete(this);
  }

  // Builds the sidebar into the given element; the host passes the leaf's
  // content element.
  async render(container) {
    const ui = this.ui;
    this.mounted = true;
    this.renderedMessages = null;
    openViews.add(this);
    ui.clear(container);
    this.roots = {
      container,
      header: ui.createEl(container, "div", { cls: "scholar-quick-ask-header" }),
      conversation: ui.createEl(container, "div", { cls: "scholar-quick-ask-conversation" }),
      pending: ui.createEl(container, "div", { cls: "scholar-quick-ask-pending" }),
      composer: ui.createEl(container, "div", { cls: "scholar-quick-ask-composer" }),
    };
    this.roots.history = ui.createEl(this.roots.conversation, "div", { cls: "scholar-quick-ask-history" });
    this.roots.live = ui.createEl(this.roots.conversation, "div", { cls: "scholar-quick-ask-live" });
    this.mountScrollFollow();
    this.renderHeader();
    this.renderPending();
    this.mountComposer();
    this.applyAppearance();
    try {
      const { reset } = await this.sessionStore.init();
      if (reset) this.environment.ui.notice(this.t(this.getSettings(), "sidebar.indexRebuilt"));
      await this.reloadSessions();
    } catch {
      this.sessionUnavailable = true;
      this.environment.ui.notice(this.t(this.getSettings(), "sidebar.actionFailed"));
    } finally {
      this.loadingSessions = false;
      this.renderHeader();
      this.renderPending();
      this.renderConversation();
      this.renderSendButton();
    }
  }

  renderHeader() {
    this.closeSessionMenu?.();
    this.closeSessionMenu = null;
    const ui = this.ui;
    const header = this.roots.header;
    ui.clear(header);
    const select = ui.createEl(header, "button", {
      cls: "scholar-quick-ask-session-select",
      attributes: { "aria-label": this.t(this.getSettings(), "sidebar.sessionSelector"), "aria-haspopup": "dialog", "aria-expanded": "false", type: "button" },
    });
    const navigation = this.navigation();
    select.disabled = !navigation.canSelect;
    ui.createEl(select, "span", { text: navigation.active?.title || this.t(this.getSettings(), navigation.active ? "sidebar.untitled" : "sidebar.noSession") });
    ui.setIcon(ui.createEl(select, "span"), "chevron-down");
    select.addEventListener("click", () => {
      if (!this.navigation().canSelect) return;
      const wasOpen = select.getAttribute("aria-expanded") === "true";
      this.closeSessionMenu?.();
      this.closeSessionMenu = null;
      if (wasOpen) return;
      this.closeSessionMenu = ui.sessionMenu(select, this.sessions.map(session => ({ ...session, title: session.title || this.t(this.getSettings(), "sidebar.untitled") })), {
        activeSessionId: this.activeSessionId,
        select: id => this.selectSession(id),
        rename: id => this.renameSession(id),
        remove: id => this.deleteSession(id),
      });
    });
    const create = ui.createEl(header, "button", {
      cls: "scholar-quick-ask-new-session",
      attributes: { "aria-label": this.t(this.getSettings(), "sidebar.newSession"), type: "button" },
    });
    ui.setIcon(create, "plus");
    ui.setTooltip(create, this.t(this.getSettings(), "sidebar.newSession"));
    this.roots.newSessionButton = create;
    this.refreshNewSessionButton();
    create.addEventListener("click", () => {
      void this.newSession();
    });
  }

  renderConversation() {
    this.cancelConversationPaint();
    const ui = this.ui;
    const area = this.roots.history;
    const rendered = this.renderedMessages ?? [];
    const appendOnly = rendered.length <= this.messages.length && rendered.every((entry, index) => entry === this.messages[index]);
    if (!appendOnly) ui.clear(area);
    for (const entry of this.messages.slice(appendOnly ? rendered.length : 0)) {
      if (entry.kind === "compaction") { this.renderCompactionDivider(area, entry); continue; }
      const bubble = ui.createEl(area, "div", { cls: `scholar-quick-ask-message scholar-quick-ask-message-${entry.role}` });
      this.labelMessageRole(bubble, entry.role);
      if (entry.role === "assistant" && entry.reasoning) {
        const reasoning = this.settlingReasoning ?? this.makeReasoning(bubble);
        this.settlingReasoning = null;
        bubble.appendChild(reasoning.element);
        reasoning.update(entry.reasoning, false);
      }
      const body = ui.createEl(bubble, "div", { cls: "scholar-quick-ask-message-body" });
      if (entry.role === "assistant" && entry.settled !== false) {
        void ui.renderMarkdown(body, entry.text, entry.sourcePath ?? "").then(() => this.scheduleFollow()).catch(() => {
          body.style.whiteSpace = "pre-wrap"; ui.setText(body, entry.text); this.scheduleFollow();
        });
        if (entry.text) this.renderCopyButton(bubble, entry.text);
      } else ui.setText(body, entry.text);
      if (entry.retry) {
        const retry = ui.createEl(bubble, "button", { text: this.t(this.getSettings(), "submission.retry"), attributes: { type: "button" } });
        retry.addEventListener("click", () => { void this.send(entry.retry); });
      }
      if (entry.role === "assistant" && entry.usage?.total) this.renderUsagePill(area, entry);
    }
    this.renderedMessages = [...this.messages];
    this.renderLive();
    if (this.scrollFollow.following) this.scrollToBottom();
  }

  makeReasoning(parent) {
    const tr = key => this.t(this.getSettings(), key);
    return createReasoningView(parent, {
      ui: this.ui, label: tr("composer.reasoning"), onLayout: () => this.scheduleFollow(),
      labels: { previous: tr("reasoning.previous"), next: tr("reasoning.next"), latest: tr("reasoning.latest"), copy: tr("reasoning.copy"), copyFailed: tr("composer.copyFailed") },
    });
  }

  labelMessageRole(parent, role) {
    if (role === "assistant" || role === "user") {
      const id = `scholar-quick-ask-role-${++messageLabelId}`;
      this.ui.createEl(parent, "span", {
        cls: "scholar-quick-ask-sr-only", text: this.t(this.getSettings(), `message.${role}`),
        attributes: { id },
      });
      parent.setAttribute("role", "group");
      // Obsidian turns aria-label into a tooltip on pointerover. A group name
      // labels the whole message for assistive technology, not a hover target.
      parent.removeAttribute("aria-label");
      parent.setAttribute("aria-labelledby", id);
    }
  }

  resetLive() {
    this.ui.clear(this.roots.live);
    this.liveParts = null;
  }

  renderLive() {
    const live = this.roots.live;
    const stream = this.streaming;
    if (this.compacting) {
      this.resetLive(); live.hidden = false;
      this.ui.createEl(live, "div", { cls: "scholar-quick-ask-compaction-running", text: this.t(this.getSettings(), "compaction.running") });
      return;
    }
    live.hidden = !stream;
    if (!stream) { this.resetLive(); return; }
    const ui = this.ui;
    if (!this.liveParts) {
      const bubble = ui.createEl(live, "div", { cls: "scholar-quick-ask-message scholar-quick-ask-message-assistant is-streaming" });
      this.labelMessageRole(bubble, "assistant");
      const reasoning = this.makeReasoning(bubble);
      const tools = ui.createEl(bubble, "div", { cls: "scholar-quick-ask-tool-status" });
      const answer = ui.createEl(bubble, "div", { cls: "scholar-quick-ask-stream-text" });
      const textNode = answer.ownerDocument.createTextNode("");
      answer.appendChild(textNode);
      const thinking = ui.createEl(bubble, "div", { text: this.t(this.getSettings(), "composer.thinking") });
      const error = ui.createEl(live, "div", { cls: "scholar-quick-ask-error" });
      const errorText = ui.createEl(error, "span");
      const retry = ui.createEl(error, "button", { text: this.t(this.getSettings(), "common.retry"), attributes: { type: "button" } });
      retry.addEventListener("click", () => { void this.retryFailedSubmission(); });
      this.liveParts = { bubble, reasoning, tools, textNode, thinking, error, errorText, retry, length: 0, toolLabel: null, errorLabel: null };
    }
    const parts = this.liveParts;
    parts.reasoning.update(stream.reasoning ?? "", stream.status === "running" && !stream.text);
    const text = stream.text ?? "";
    // Stream deltas are append-only within a turn. Only the new suffix touches
    // the Text node, so old text and its selection stay in place.
    if (text.length < parts.length) parts.textNode.data = text;
    else if (text.length > parts.length) parts.textNode.appendData(text.slice(parts.length));
    parts.length = text.length;
    const toolLabel = this.toolStatus ? toolStatusLabel(this.t, this.getSettings(), this.toolStatus) : "";
    parts.tools.hidden = !toolLabel;
    if (parts.toolLabel !== toolLabel) { ui.setText(parts.tools, toolLabel); parts.toolLabel = toolLabel; }
    parts.thinking.hidden = Boolean(text || (stream.reasoning && !this.roots.container.classList.contains("hide-reasoning")) || stream.status !== "running");
    parts.bubble.classList.toggle("is-streaming", stream.status === "running");
    parts.bubble.hidden = stream.status !== "running" && !text && !stream.reasoning && !toolLabel;
    parts.retry.hidden = this.messages.some(entry => entry.retry && entry.retry === this.lastSubmission);
    parts.error.hidden = !["failed", "interrupted"].includes(stream.status);
    if (!parts.error.hidden) {
      const message = stream.error?.code === "CAPACITY" ? this.t(this.getSettings(), "composer.capacityFailed")
        : stream.error?.code === "COMPACTION" ? this.t(this.getSettings(), "compaction.failed")
          : stream.error?.message ?? this.t(this.getSettings(), "composer.failed");
      if (parts.errorLabel !== message) { ui.setText(parts.errorText, message); parts.errorLabel = message; }
    }
  }

  scheduleConversationPaint() {
    if (!this.mounted || this.paintFrame !== null) return;
    this.paintWindow = this.roots.container.ownerDocument.defaultView;
    this.paintFrame = this.paintWindow.requestAnimationFrame(() => {
      this.paintFrame = null;
      if (this.mounted) this.renderConversation();
    });
  }

  cancelConversationPaint() {
    if (this.paintFrame !== null) this.paintWindow.cancelAnimationFrame(this.paintFrame);
    this.paintFrame = null;
  }

  mountScrollFollow() {
    const area = this.roots.conversation;
    this.scrollFollow.submit();
    area.addEventListener("scroll", () => this.scrollFollow.scroll({ top: area.scrollTop, height: area.scrollHeight, viewport: area.clientHeight }), { passive: true });
    area.addEventListener("wheel", event => {
      if (event.deltaY < 0) this.scrollFollow.pause();
      else if (event.deltaY > 0 && this.isNearBottom()) { this.scrollFollow.submit(); this.scheduleFollow(); }
    }, { passive: true });
    const owner = area.ownerDocument.defaultView;
    this.scrollObserver = new owner.ResizeObserver(() => this.scheduleFollow());
    this.scrollObserver.observe(area);
    this.scrollObserver.observe(this.roots.history);
    this.scrollObserver.observe(this.roots.live);
  }

  scheduleFollow() {
    if (!this.mounted || !this.scrollFollow.following || this.followFrame !== null) return;
    this.followWindow = this.roots.container.ownerDocument.defaultView;
    this.followFrame = this.followWindow.requestAnimationFrame(() => {
      this.followFrame = null;
      if (this.mounted && this.scrollFollow.following) this.scrollToBottom();
    });
  }

  applyAppearance() {
    const display = normalizeDisplaySettings(this.getSettings()?.quickAsk?.display);
    const root = this.roots.container;
    if (!root) return;
    for (const [property, value] of Object.entries({
      "--scholar-chat-font-size": `${display.fontSize}px`,
      "--scholar-chat-line-height": String(display.lineHeight),
      "--scholar-chat-paragraph-spacing": `${display.paragraphSpacing}em`,
      "--scholar-chat-message-spacing": `${display.messageSpacing}px`,
    })) root.style.setProperty(property, value);
    for (const [property, field] of [["--scholar-user-bubble-tint", "userBubbleColor"], ["--scholar-assistant-bubble-tint", "assistantBubbleColor"]]) {
      if (display.customBubbleColors) root.style.setProperty(property, display[field]);
      else root.style.removeProperty(property);
    }
    root.classList.toggle("hide-reasoning", !display.showReasoning);
    root.classList.toggle("hide-usage", !display.showUsage);
    this.scheduleConversationPaint();
  }

  renderCopyButton(parent, text) {
    const button = this.ui.createEl(parent, "button", {
      cls: "scholar-quick-ask-copy", attributes: { type: "button", "aria-label": this.t(this.getSettings(), "composer.copySource") },
    });
    this.ui.setIcon(button, "copy");
    this.ui.setTooltip(button, this.t(this.getSettings(), "composer.copySource"));
    button.addEventListener("click", async () => {
      try {
        await this.ui.writeClipboard(text, button);
        this.ui.notice(this.t(this.getSettings(), "composer.copied"));
      } catch { this.ui.notice(this.t(this.getSettings(), "composer.copyFailed")); }
    });
  }

  // A small `database` icon pill showing compact total text; clicking opens the
  // anchored detail panel.
  renderUsagePill(area, entry) {
    const ui = this.ui;
    const pill = ui.createEl(area, "button", {
      cls: "scholar-quick-ask-token-pill",
      attributes: { type: "button", "aria-label": this.t(this.getSettings(), "token.turnUsage") },
    });
    ui.setIcon(pill, "database");
    ui.createEl(pill, "span", { text: formatTokens(entry.usage.total) });
    const panel = ui.createEl(area, "div", { cls: "scholar-quick-ask-token-panel" });
    panel.hidden = true;
    panel.appendChild(this.buildUsageDetail(panel, entry.usage, entry.model));
    pill.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
    });
    this.registerTokenPanel(panel);
  }

  buildUsageDetail(parent, usage, model) {
    const ui = this.ui;
    const list = ui.createEl(parent, "dl", { cls: "scholar-quick-ask-token-detail" });
    const rows = [
      ["token.model", model ?? this.t(this.getSettings(), "token.unknownModel")],
      ["token.input", usage.input],
      ["token.cachedInput", usage.cachedInput],
      ["token.output", usage.output],
      ["token.reasoning", usage.reasoning],
      ["token.total", usage.total],
    ];
    for (const [key, value] of rows) {
      // A missing fact is omitted rather than rendered as zero.
      if (value === undefined || value === null) continue;
      ui.createEl(list, "dt", { text: this.t(this.getSettings(), key) });
      ui.createEl(list, "dd", { text: typeof value === "number" ? String(value) : value });
    }
    return list;
  }

  // The compaction divider is a UI projection of the durable bracket, never a
  // persisted chat message, and has no click-to-expand interaction.
  renderCompactionDivider(area, entry) {
    const ui = this.ui;
    const divider = ui.createEl(area, "div", { cls: "scholar-quick-ask-compaction-divider" });
    ui.setIcon(divider, "minimize-2");
    ui.createEl(divider, "span", { text: this.t(this.getSettings(), entry.manual ? "compaction.manualDivider" : "compaction.divider") });
    const freed = Math.max(0, (entry.before ?? 0) - (entry.after ?? 0));
    ui.setTooltip(divider, this.t(this.getSettings(), "compaction.tooltip", {
      items: entry.items ?? 0, freed: `~${formatTokens(freed)}`,
    }));
  }

  registerTokenPanel(panel) {
    this.tokenPanels ??= new Set();
    this.tokenPanels.add(panel);
  }

  closeTokenPanels() {
    for (const panel of this.tokenPanels ?? []) panel.hidden = true;
    this.occupancyPanelOpen = false;
    this.roots.occupancyButton?.setAttribute("aria-expanded", "false");
  }

  isNearBottom() {
    const area = this.roots.conversation;
    if (!area || typeof area.scrollHeight !== "number") return true;
    return area.scrollHeight - area.scrollTop - area.clientHeight <= 24;
  }

  scrollToBottom() {
    const area = this.roots.conversation;
    if (area && typeof area.scrollHeight === "number") {
      area.scrollTop = area.scrollHeight;
      this.scrollFollow.positioned(area.scrollTop);
    }
  }

  // Streaming projections arrive at most once per animation frame, so the DOM
  // is not rewritten per token.
  applyProjection(projection) {
    if (!projection) return;
    if (projection.kind === "text") {
      this.streaming = { ...(this.streaming ?? { status: "running", reasoning: "", text: "", error: null }) , text: projection.text, status: "running" };
      this.scheduleConversationPaint();
      return;
    }
    if (projection.kind === "reasoning") {
      this.streaming = {
        ...(this.streaming ?? { status: "running", reasoning: "", text: "", error: null }),
        reasoning: projection.text,
      };
      this.scheduleConversationPaint();
      return;
    }
    if (projection.kind === "usage") {
      this.usage = projection.turn;
      this.sessionUsage = projection.session;
      this.renderConversation();
      this.renderSendButton();
      return;
    }
    if (projection.kind === "compaction-idle") {
      this.compacting = false;
      this.resetLive(); this.renderConversation();
      this.refreshTokenFacts(); this.renderSendButton();
      return;
    }
    if (projection.kind === "compaction") {
      if (projection.status === "running") {
        const running = this.roots.live;
        this.resetLive();
        running.hidden = false;
        this.ui.createEl(running, "div", {
          cls: "scholar-quick-ask-compaction-running",
          text: this.t(this.getSettings(), "compaction.running"),
        });
        // Keep the question field editable but disable this session's send.
        this.compacting = true;
        this.renderSendButton();
        return;
      }
      this.compacting = false;
      this.refreshTokenFacts();
      this.resetLive();
      if (projection.status === "committed") {
        this.messages.push({ kind: "compaction", manual: projection.reason === "manual", items: projection.items ?? 0, before: projection.before, after: projection.after });
      } else if (projection.status === "failed") {
        this.environment.ui.notice(this.t(this.getSettings(), "compaction.failed"));
      }
      this.renderConversation();
      this.renderSendButton();
      return;
    }
    if (projection.kind === "tool-status") {
      this.toolStatus = projection.status;
      this.renderConversation();
      return;
    }
    if (projection.kind === "turn") {
      if (projection.status !== "running") this.toolStatus = null;
      this.streaming = {
        ...(this.streaming ?? { reasoning: "", text: "" }),
        status: projection.status,
      };
      this.renderSendButton();
      this.renderConversation();
    }
  }

  // Two full-width stacks: every File Row, then every Selection Preview Row.
  renderPending() {
    const ui = this.ui;
    const area = this.roots.pending;
    ui.clear(area);
    const view = derivePendingView(this.pending, { expanded: this.expanded });
    this.expanded = view.expanded;
    area.classList.toggle("is-collapsed", !view.expanded);
    area.hidden = view.fileCount + view.selectionCount === 0;
    if (area.hidden) { this.refreshNewSessionButton(); return; }
    const panel = ui.createEl(area, "div", { cls: "scholar-quick-ask-context-panel" });
    if (view.showBar) {
      const action = this.t(this.getSettings(), view.expanded ? "context.collapse" : "context.expand");
      const button = ui.createEl(panel, "button", {
        cls: "scholar-quick-ask-expand-bar",
        attributes: { type: "button", "aria-expanded": String(view.expanded), "aria-label": action },
      });
      for (const [key, count] of [["context.fileCount", view.fileCount], ["context.selectionCount", view.selectionCount]]) {
        if (count) ui.createEl(button, "span", { text: this.t(this.getSettings(), key, { count }) });
      }
      ui.setIcon(ui.createEl(button, "span", { cls: "scholar-quick-ask-expand-icon" }), view.expanded ? "chevrons-down" : "chevrons-up");
      ui.setTooltip(button, action);
      button.addEventListener("click", () => {
        this.expanded = !this.expanded;
        this.renderPending();
        area.scrollTop = 0;
      });
    }
    const rows = ui.createEl(panel, "div", { cls: "scholar-quick-ask-context-rows" });
    if (view.files.length) {
      const group = ui.createEl(rows, "div", { cls: "scholar-quick-ask-file-group" });
      for (const row of view.files) this.renderFileRow(group, row);
    }
    if (view.selections.length) {
      const group = ui.createEl(rows, "div", { cls: "scholar-quick-ask-selection-group" });
      for (const row of view.selections) this.renderSelectionRow(group, row);
    }
    this.refreshNewSessionButton();
  }

  renderFileRow(area, row) {
    const ui = this.ui;
    const element = ui.createEl(area, "div", { cls: "scholar-quick-ask-file-row" });
    // An `@folder/file.md` row renders with Obsidian's native internal-link
    // behavior, including ordinary opening and page preview.
    ui.renderInternalLink(element, { path: row.path, label: `@${row.path}`, sourcePath: row.path, previewOwner: this.roots.pending });
    const remove = ui.createEl(element, "button", {
      cls: "scholar-quick-ask-remove",
      attributes: { type: "button", "aria-label": this.t(this.getSettings(), "context.removeFile", { path: row.path }) },
    });
    ui.setIcon(remove, "x");
    remove.addEventListener("click", () => {
      const tracker = this.currentTracker();
      const sent = tracker?.allowlist?.().includes(row.path) === true;
      tracker?.removedFile?.(row.path);
      this.pending = removeFile(this.pending, row.path);
      if (!sent) this.pending.selections = this.pending.selections.filter(selection => selection.path !== row.path);
      this.saveDraft();
      this.renderPending();
    });
  }

  renderSelectionRow(area, row) {
    const ui = this.ui;
    const element = ui.createEl(area, "div", { cls: "scholar-quick-ask-selection-row" });
    const preview = ui.createEl(element, "button", {
      cls: "scholar-quick-ask-selection-text", attributes: { type: "button" },
    });
    ui.createEl(preview, "span", { text: row.text });
    preview.addEventListener("click", event => { void this.environment.workspace.openTextRange(row, event); });
    // The source file is identified by a native tooltip, not by visible text.
    ui.setTooltip(preview, this.t(this.getSettings(), "selection.tooltip", { path: row.path }));
    const remove = ui.createEl(element, "button", {
      cls: "scholar-quick-ask-remove",
      attributes: { type: "button", "aria-label": this.t(this.getSettings(), "context.removeSelection") },
    });
    ui.setIcon(remove, "x");
    remove.addEventListener("click", () => {
      this.pending = removeSelection(this.pending, row.index);
      this.saveDraft();
      this.renderPending();
    });
  }

  mountComposer() {
    const settings = this.getSettings();
    // The composer's CodeMirror modules load only when the sidebar actually
    // opens, so nothing touches CodeMirror on a mobile startup or while the
    // feature is off.
    if (typeof this.createComposer !== "function") {
      const { createComposerEditor } = require("./composer-view");
      this.createComposer = (options) => createComposerEditor(options);
    }
    this.roots.shell = this.ui.createEl(this.roots.composer, "div", { cls: "scholar-quick-ask-composer-shell" });
    this.roots.input = this.ui.createEl(this.roots.shell, "div", { cls: "scholar-quick-ask-input" });
    this.mountResizeHandle();
    this.composer = this.createComposer({
      parent: this.roots.input,
      sidebar: this.roots.container,
      paths: () => this.environment.vault.listFiles().map(file => file.path).filter(canReferencePath),
      isSupported: path => this.environment.vault.resolveRole?.(path) === "markdown",
      unsupportedLabel: this.t(settings, "composer.unsupportedFile"),
      createFileSuggester: this.environment.ui.createFileSuggester,
      onSubmit: () => { void this.send(); },
      onChange: () => {
        const draft = this.drafts.get(this.activeSessionId);
        if (draft?.failedSubmission) draft.failedSubmission.restored = false;
        this.saveDraft();
        this.refreshNewSessionButton();
      },
      t: this.t,
      placeholderText: this.t(settings, "composer.placeholder"),
    });
    const unassigned = this.drafts.get(null);
    if (!this.activeSessionId && unassigned) {
      this.pending = unassigned.pending;
      this.composer.setDraft(unassigned.composer);
      this.renderPending();
    }
    const dropRegion = this.roots.container;
    dropRegion.addEventListener("dragover", event => {
      const types = Array.from(event.dataTransfer?.types ?? []);
      if (!this.captureHolder?.get?.() && !types.includes("text/uri-list")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      this.roots.composer.classList.add("is-drag-over");
    });
    dropRegion.addEventListener("dragleave", event => {
      if (!dropRegion.contains(event.relatedTarget)) this.roots.composer.classList.remove("is-drag-over");
    });
    // Capture before CodeMirror handles a URI as plain text. Files may land
    // anywhere in this Quick Ask pane; selected prose keeps its narrower target.
    dropRegion.addEventListener("drop", event => { void this.handleDrop(event, event.target); }, true);
    const controls = this.ui.createEl(this.roots.shell, "div", { cls: "scholar-quick-ask-composer-controls" });
    this.roots.controls = controls;
    this.renderSendButton();

  }

  mountResizeHandle() {
    const handle = this.ui.createEl(this.roots.shell, "div", {
      cls: "scholar-quick-ask-resize-handle",
      attributes: { role: "separator", tabindex: "0", "aria-orientation": "horizontal", "aria-label": this.t(this.getSettings(), "composer.resize") },
    });
    this.ui.setTooltip(handle, this.t(this.getSettings(), "composer.resize"), { placement: "top" });
    let ownerDocument = handle.ownerDocument;
    let ownerWindow = ownerDocument.defaultView;
    const available = () => {
      const style = ownerWindow.getComputedStyle(this.roots.container);
      return availableInputHeight({
        pane: this.roots.container.clientHeight,
        header: this.roots.header.offsetHeight,
        pending: this.roots.pending.offsetHeight,
        composer: this.roots.composer.offsetHeight,
        input: this.roots.input.offsetHeight,
        padding: (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0),
      });
    };
    let requestedHeight = 112;
    const setHeight = height => {
      requestedHeight = height;
      const next = inputHeight(height, available());
      this.roots.input.style.height = `${next}px`;
      this.composer?.getEditorView?.()?.requestMeasure();
      handle.setAttribute("aria-valuenow", String(next));
      handle.setAttribute("aria-valuemin", String(MIN_INPUT_HEIGHT));
      handle.setAttribute("aria-valuemax", String(available()));
    };
    let drag = null;
    const stop = () => {
      drag = null;
      handle.classList.remove("is-resizing");
      ownerDocument.removeEventListener("pointermove", move, true);
      ownerDocument.removeEventListener("pointerup", stop, true);
      ownerDocument.removeEventListener("pointercancel", stop, true);
      ownerDocument.removeEventListener("mousemove", mouseMove, true);
      ownerDocument.removeEventListener("mouseup", stop, true);
      ownerWindow.removeEventListener("blur", stop);
    };
    const move = event => {
      if (!drag || drag.id !== event.pointerId) return;
      drag.sawPointerMove = true;
      event.preventDefault();
      event.stopPropagation();
      setHeight(draggedInputHeight(drag.height, drag.y, event.clientY, available()));
    };
    const mouseMove = event => {
      if (!drag || drag.pointerType !== "mouse" || drag.sawPointerMove) return;
      event.preventDefault();
      event.stopPropagation();
      setHeight(draggedInputHeight(drag.height, drag.y, event.clientY, available()));
    };
    this.stopResizing = stop;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      stop();
      ownerDocument = handle.ownerDocument;
      ownerWindow = ownerDocument.defaultView;
      drag = { id: event.pointerId, pointerType: event.pointerType, sawPointerMove: false, y: event.clientY, height: this.roots.input.getBoundingClientRect().height };
      ownerDocument.addEventListener("pointermove", move, true);
      ownerDocument.addEventListener("pointerup", stop, true);
      ownerDocument.addEventListener("pointercancel", stop, true);
      ownerDocument.addEventListener("mousemove", mouseMove, true);
      ownerDocument.addEventListener("mouseup", stop, true);
      ownerWindow.addEventListener("blur", stop);
      // Keep native mouse events available. On the affected desktop the
      // captured pointer delivered down/up but no move events. Document
      // listeners cover the gesture without taking pointer capture; mouse
      // movement is a fallback until a pointer move has actually arrived.
      handle.classList.add("is-resizing");
    });
    handle.addEventListener("mousedown", event => { event.preventDefault(); event.stopPropagation(); });
    handle.addEventListener("keydown", event => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const height = this.roots.input.getBoundingClientRect().height;
      setHeight(event.key === "Home" ? MIN_INPUT_HEIGHT : event.key === "End" ? available() : height + (event.key === "ArrowUp" ? 16 : -16));
    });
    this.resizeObserver = new ownerWindow.ResizeObserver(() => {
      if (!drag && this.roots.container.clientHeight > 0) setHeight(requestedHeight);
    });
    this.resizeObserver.observe(this.roots.container);
    this.resizeObserver.observe(this.roots.pending);
    this.resizeObserver.observe(this.roots.composer);
  }

  renderSendButton() {
    const ui = this.ui;
    const controls = this.roots.controls;
    if (!controls) return;
    // One rebuild of the whole action row keeps the ring and the action from
    // accumulating duplicates across repeated renders.
    if (this.roots.occupancyPanel) this.tokenPanels?.delete(this.roots.occupancyPanel);
    ui.clear(controls);
    this.renderOccupancyRing(controls);
    const running = this.streaming?.status === "running" || this.sending;
    const compacting = this.compacting === true;
    const button = ui.createEl(controls, "button", {
      cls: `scholar-quick-ask-send${running ? " is-running" : ""}`,
      attributes: { type: "button" },
    });
    ui.setIcon(button, running ? "square" : "send");
    ui.setTooltip(button, this.t(this.getSettings(), running ? "composer.stop" : "composer.send"), { placement: "top" });
    if (compacting || (!running && (this.loadingSessions || this.sessionActions.busy))) button.disabled = true;
    button.addEventListener("click", () => {
      if (compacting) return;
      if (running) void this.stopTurn();
      else void this.send();
    });
  }

  // A 14 px occupancy ring in a 28 px hit target. With a configured capacity it
  // shows `~used / capacity` and fills by percentage; without one it shows only
  // `~used tok` and no percentage.
  renderOccupancyRing(controls) {
    const ui = this.ui;
    this.roots.ring = controls;
    const occupancy = this.occupancy ?? { tokens: 0, estimated: true };
    const capacity = this.capacityTokens ?? null;
    const color = occupancyColor(occupancy.tokens, capacity);
    const ring = ui.createEl(controls, "button", {
      cls: `scholar-quick-ask-occupancy is-${color}`,
      attributes: { type: "button", "aria-label": this.t(this.getSettings(), "token.occupancy") },
    });
    const ratio = capacity ? Math.min(1, occupancy.tokens / capacity) : null;
    if (ratio !== null) {
      ring.style.setProperty("--scholar-quick-ask-occupancy", `${Math.round(ratio * 100)}%`);
    }
    const estimated = occupancy.exact ? "" : "~";
    const label = capacity
      ? `${estimated}${formatTokens(occupancy.tokens)} / ${formatTokens(capacity)}`
      : `${estimated}${formatTokens(occupancy.tokens)}`;
    ui.setTooltip(ring, label, { placement: "top" });
    const panel = ui.createEl(controls, "div", { cls: "scholar-quick-ask-token-panel" });
    panel.hidden = true;
    this.roots.occupancyPanel = panel;
    this.roots.occupancyButton = ring;
    panel.hidden = !this.occupancyPanelOpen;
    ring.setAttribute("aria-expanded", String(!panel.hidden));
    const list = ui.createEl(panel, "dl", { cls: "scholar-quick-ask-token-detail" });
    ui.createEl(list, "dt", { text: this.t(this.getSettings(), "token.currentContext") });
    ui.createEl(list, "dd", { text: label + (occupancy.exact ? "" : ` (${this.t(this.getSettings(), "token.estimated")})`) });
    if (capacity) {
      ui.createEl(list, "dt", { text: this.t(this.getSettings(), "token.percent") });
      ui.createEl(list, "dd", { text: formatPercent(ratio) });
    }
    ui.createEl(list, "dt", { text: this.t(this.getSettings(), "token.sessionUsage") });
    ui.createEl(list, "dd", { text: formatTokens(this.sessionUsage ?? 0) });
    const composition = this.composition ?? null;
    if (composition) {
      for (const key of ["instructions", "tools", "messages"]) {
        ui.createEl(list, "dt", { text: this.t(this.getSettings(), `token.${key}`) });
        ui.createEl(list, "dd", { text: `~${formatTokens(composition[key] ?? 0)}` });
      }
    }
    const actions = ui.createEl(panel, "div", { cls: "scholar-quick-ask-context-actions" });
    const compact = ui.createEl(actions, "button", { cls: "scholar-quick-ask-compact-action", attributes: { type: "button" } });
    ui.setIcon(compact, "minimize-2");
    ui.createEl(compact, "span", { text: this.t(this.getSettings(), this.compacting ? "compaction.running" : "compaction.action") });
    const snapshot = this.activeSessionId ? this.runtime?.snapshot?.(this.activeSessionId) : null;
    compact.disabled = !snapshot || !snapshot.items?.length || snapshot.status === "running" || this.compacting || this.loadingSessions || this.sessionActions.busy;
    compact.addEventListener("click", () => { void this.compactContext(); });
    ui.createEl(actions, "small", { cls: "scholar-quick-ask-compact-hint", text: this.t(this.getSettings(), "compaction.actionHint") });
    ring.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      this.occupancyPanelOpen = !panel.hidden;
      ring.setAttribute("aria-expanded", String(!panel.hidden));
    });
    this.registerTokenPanel(panel);
  }

  async compactContext() {
    const sessionId = this.activeSessionId;
    if (!sessionId || this.compacting || this.sending || this.loadingSessions || this.sessionActions.busy) return;
    try {
      const result = await this.runtime.compactNow(sessionId);
      if (!this.mounted || this.activeSessionId !== sessionId) return result;
      if (result.status === "invalid") this.showValidationError(result.errors);
      else if (result.status === "skipped" || result.status === "rejected") this.ui.notice(this.t(this.getSettings(), "compaction.nothing"));
      else if (result.status === "no-viable-space") this.ui.notice(this.t(this.getSettings(), "composer.capacityFailed"));
      else if (result.status === "busy") this.ui.notice(this.t(this.getSettings(), "composer.busy"));
      return result;
    } catch { this.ui.notice(this.t(this.getSettings(), "compaction.failed")); }
    finally {
      if (this.mounted && this.activeSessionId === sessionId) {
        this.compacting = false;
        this.refreshTokenFacts(); this.renderSendButton();
      }
    }
  }

  // Submitting a question stages the pending context, sends the turn, and keeps
  // the UI a projection of the durable records.
  async send(retrySubmission = null) {
    if (!this.runtime || this.sending || this.loadingSessions || this.sessionActions.busy) return null;
    if (!this.activeSessionId) { await this.newSession(); if (!this.activeSessionId) return null; }
    if (!retrySubmission && this.composer?.isEditingReference) return null;
    if (this.runtime.snapshot?.(this.activeSessionId)?.status === "running") return null;
    const sessionId = this.activeSessionId;
    const captured = this.captureDraft();
    const submission = retrySubmission ?? {
      draft: captured.composer, pending: captured.pending,
      question: (this.composer?.text ?? "").trim(), references: [...(this.composer?.paths ?? [])],
    };
    if (!submission.question) return null;
    const validation = this.runtime.validateForSend?.(this.runtime.stateFor(sessionId));
    if (validation && !validation.valid) { this.showValidationError(validation.errors); return { status: "invalid" }; }
    this.roots.validation?.remove?.(); this.roots.validation = null;
    this.sending = true;
    const prepared = prepareSubmission(this.messages,
      { ...this.drafts.get(sessionId), ...captured }, submission, Boolean(retrySubmission));
    this.pending = prepared.draft.pending;
    if (prepared.draft.composer !== captured.composer) this.composer.setDraft(prepared.draft.composer);
    this.drafts.set(sessionId, prepared.draft);
    this.saveDraft();
    const entry = prepared.entry;
    this.messages = prepared.messages;
    this.lastSubmission = submission;
    this.streaming = { status: "running", reasoning: "", text: "", error: null };
    this.resetLive();
    this.scrollFollow.submit();
    this.renderPending();
    this.renderSendButton();
    this.renderConversation();
    this.scheduleFollow();
    let result;
    try {
      const additions = submission.additions ?? await this.stagedMutations(submission.references, submission.pending.selections, sessionId);
      submission.additions = additions;
      result = await this.runtime.send(sessionId, submission.question, { additions });
    } catch {
      result = { status: "failed", accepted: false };
      this.environment.ui.notice(this.t(this.getSettings(), "composer.failed"));
    }
    const accepted = result?.accepted || ["complete", "incomplete"].includes(result?.status);
    const visible = this.activeSessionId === sessionId && this.mounted;
    if (!accepted && (visible || this.drafts.has(sessionId))) {
      const current = visible ? { ...this.drafts.get(sessionId), ...this.captureDraft() }
        : this.drafts.get(sessionId) ?? { composer: "", pending: createPendingContext() };
      const recovered = recoverSubmittedDraft(current, submission, { restoreDraft: !retrySubmission });
      this.drafts.set(sessionId, recovered);
      if (visible && recovered.failedSubmission.restored) {
        this.pending = recovered.pending;
        this.composer.setDraft(recovered.composer);
      }
      // Retain a retry of this exact question even if a different draft is
      // already being typed. It must never send or clear that newer draft.
      const index = this.messages.indexOf(entry);
      if (index >= 0) this.messages[index] = { ...entry, retry: submission };
    }
    if (!visible) return result;
    this.sending = false;
    if (result?.status === "complete" || result?.status === "incomplete" || (result?.status === "stopped" && accepted)) {
      this.settlingReasoning = this.liveParts?.reasoning ?? null;
      if (result.text || result.reasoning) this.messages.push({
        role: "assistant", text: result.text ?? "", reasoning: result.reasoning ?? "", settled: true,
        usage: this.usage ?? null, model: (this.getConfig?.(sessionId) ?? {}).model ?? null,
      });
      this.streaming = null;
      this.stagedReferences = new Set(); this.stagedSelections = new Set();
    } else if (result?.status === "invalid" || result?.status === "busy") {
      this.streaming = null;
      if (result.status === "invalid") this.showValidationError(result.errors);
      else this.ui.notice(this.t(this.getSettings(), "composer.busy"));
    } else {
      this.streaming = { ...(this.streaming ?? {}), status: "failed", text: result?.text ?? this.streaming?.text ?? "",
        reasoning: result?.reasoning ?? this.streaming?.reasoning ?? "", error: result?.error ?? null };
    }
    this.refreshPendingFiles();
    this.saveDraft();
    this.refreshTokenFacts();
    this.renderPending();
    this.renderConversation();
    this.renderSendButton();
    return result;
  }

  retryFailedSubmission() {
    const failed = this.drafts.get(this.activeSessionId)?.failedSubmission;
    if (failed?.submission || this.lastSubmission) return this.send(failed?.submission ?? this.lastSubmission);
    const turn = this.runtime.stateFor(this.activeSessionId)?.turn;
    if (turn?.question) return this.send({ question: turn.question, draft: turn.question, references: [],
      pending: { files: [], selections: [] }, additions: turn.additions ?? [] });
    return null;
  }

  // The staged input for this question: newly referenced files and dragged
  // selections. The internal tracker learns about every staged item, so it can
  // start tracking exactly when the endpoint accepts the turn. Staging the same
  // item twice is idempotent per question.
  async stagedMutations(references, selections = this.pending.selections, sessionId = this.activeSessionId) {
    references = supportedReferences(references, path => this.environment.vault.resolveRole?.(path) === "markdown");
    const tracker = this.trackerFor?.(sessionId);
    tracker?.replacePending?.({ references, selections });
    if (tracker?.replacePending && tracker?.mutationsForSend) return await tracker.mutationsForSend();
    const mutations = [];
    const seenReferences = new Set(this.stagedReferences ?? (this.stagedReferences = new Set()));
    const seenSelections = new Set(this.stagedSelections ?? (this.stagedSelections = new Set()));
    for (const path of references) {
      if (seenReferences.has(path)) continue;
      seenReferences.add(path);
      tracker?.stageReference?.(path);
      mutations.push({ kind: "reference", path });
    }
    for (const selection of selections) {
      const key = [selection.path, selection.from ?? "", selection.to ?? "", selection.text].join("\u0000");
      if (seenSelections.has(key)) continue;
      seenSelections.add(key);
      tracker?.stageSelection?.({ ...selection });
      mutations.push({ kind: "selection", path: selection.path, text: selection.text, from: selection.from, to: selection.to });
    }
    return mutations;
  }

  // Pull the live token facts from the conversation runtime: the occupancy ring
  // and the detail panels are projections of it, never a second source of truth.
  refreshTokenFacts() {
    if (!this.runtime?.snapshot || !this.activeSessionId) return null;
    const snapshot = this.runtime.snapshot(this.activeSessionId);
    if (!snapshot) return null;
    this.occupancy = snapshot.occupancy;
    this.sessionUsage = snapshot.sessionUsage ?? 0;
    this.usage = snapshot.turnUsage ?? null;
    const config = this.getConfig?.(this.activeSessionId) ?? {};
    this.capacityTokens = config.contextWindowTokens ?? null;
    this.composition = snapshot.price?.components
      ? {
        instructions: snapshot.price.components.instructions,
        tools: snapshot.price.components.tools,
        messages: snapshot.price.components.history + snapshot.price.components.additions + snapshot.price.components.question,
      }
      : null;
    return snapshot;
  }

  currentTracker() {
    if (typeof this.trackerFor !== "function" || !this.activeSessionId) return null;
    return this.trackerFor(this.activeSessionId);
  }

  showValidationError(errors) {
    const key = errors?.baseUrl ? "composer.validationBaseUrl"
      : errors?.contextWindowTokens ? "composer.validationContextWindow"
        : "composer.validationRequired";
    this.roots.validation?.remove?.();
    this.roots.validation = this.ui.createEl(this.roots.composer, "div", {
      cls: "scholar-quick-ask-error", text: this.t(this.getSettings(), key),
      attributes: { role: "status" },
    });
  }

  async stopTurn() {
    if (!this.runtime || !this.activeSessionId) return false;
    return this.runtime.stop(this.activeSessionId);
  }

  // File explorer URIs stage Composer chips. Editor-selection captures keep
  // their existing exact-text validation and restricted pending/composer targets.
  async handleDrop(event, region) {
    this.roots.composer.classList.remove("is-drag-over");
    const capture = this.captureHolder?.get?.();
    if (!capture) {
      const paths = this.environment.vault.droppedFilePaths?.(event.dataTransfer) ?? [];
      if (paths.length === 0) {
        // Do not let an unresolvable/foreign URI turn into raw Composer text.
        if (Array.from(event.dataTransfer?.types ?? []).includes("text/uri-list")) {
          event.preventDefault(); event.stopPropagation();
        }
        return;
      }
      event.preventDefault(); event.stopPropagation();
      const coordinates = this.roots.input.contains(event.target) ? { x: event.clientX, y: event.clientY } : null;
      this.composer.insertFiles(paths, coordinates);
      if (paths.some(path => !canReferencePath(path))) this.ui.notice(this.t(this.getSettings(), "composer.unrepresentablePath"));
      return;
    }
    if (!isAcceptedDropTarget(region, { pendingArea: this.roots.pending, composerArea: this.roots.composer })) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    region.classList?.remove("is-drag-over");
    // Only the issuing host editor can authorize the origin. A MIME payload
    // alone never grants access to a file.
    const sessionId = this.activeSessionId;
    const result = await validateDrop({
      capture,
      vault: this.environment.vault,
      normalizePath: (path) => this.environment.vault.normalizePath(path),
    });
    if (this.activeSessionId !== sessionId) return;
    if (!result.accepted) {
      if (result.reason === "stale-text") {
        this.environment.ui.notice(this.t(this.getSettings(), "context.staleSelection"));
      }
      return;
    }
    this.pending = addSelection(this.pending, result.selection);
    this.pending = addFile(this.pending, result.selection.path);
    this.saveDraft();
    this.renderPending();
  }

  async reloadSessions() {
    this.loadingSessions = true;
    const { sessionConfigSnapshot } = require("./settings");
    await this.sessionStore.ensureActiveSession(sessionConfigSnapshot(this.getSettings()?.quickAsk));
    this.sessions = await this.sessionStore.listSessions();
    const index = await this.sessionStore.loadIndex();
    if (!this.activeSessionId && index.activeSessionId) adoptUnassignedDraft(this.drafts, index.activeSessionId, this.captureDraft());
    this.activeSessionId = index.activeSessionId;
    this.trackedSessionId = this.activeSessionId;
    this.restoreDraft();
    await this.activateSession(this.activeSessionId, { recover: true });
    this.loadingSessions = false;
    this.renderHeader();
    return this.sessions;
  }

  // Activation is the one place a session body loads. It replays the visible
  // conversation from the canonical records, prepares the runtime state, and
  // reconciles still-tracked files with one cached read each.
  async activateSession(id, { recover = false } = {}) {
    const generation = ++this.activationGeneration;
    this.lastSubmission = null;
    this.settlingReasoning = null;
    this.cancelConversationPaint();
    this.resetLive();
    this.scrollFollow.submit();
    this.messages = [];
    this.hasSessionHistory = false;
    this.sessionUnavailable = false;
    this.streaming = null;
    this.toolStatus = null;
    this.usage = null;
    this.occupancy = null;
    this.sessionUsage = 0;
    this.capacityTokens = null;
    this.compacting = false;
    this.closeTokenPanels();
    this.roots.validation?.remove?.();
    this.roots.validation = null;
    // Paint the new (initially empty) projection before awaiting recovery;
    // an error must never leave the previous session's conversation visible.
    if (this.roots.conversation) this.renderConversation();
    if (this.roots.pending) this.renderPending();
    this.renderSendButton();
    if (!id || !this.runtime?.load) return null;
    let loaded = null;
    try {
      loaded = await this.runtime.load(id);
    } catch (error) {
      this.sessionUnavailable = true;
      this.environment.ui.notice(this.t(settings0(this), "sidebar.sessionUnavailable"));
      return null;
    }
    if (generation !== this.activationGeneration) return null;
    this.messages = conversationFromRecords(loaded?.parsed?.records ?? []);
    this.hasSessionHistory = (loaded?.parsed?.records ?? []).some(record => ["turn/started", "item/input", "item/output"].includes(record.kind));
    if (recover && this.runtime.recover) {
      // A pending turn with a recoverable stored Response is retrieved; the
      // runtime marks everything else interrupted and retryable.
      const recovered = await this.runtime.recover(id, { retrieve: this.retrieveResponse ? responseId => this.retrieveResponse(id, responseId) : null });
      if (recovered?.status === "interrupted") {
        this.environment.ui.notice(this.t(settings0(this), "sidebar.turnInterrupted"));
      }
    }
    if (generation !== this.activationGeneration) return null;
    await this.reconcileTracking(id);
    if (generation !== this.activationGeneration) return null;
    this.refreshPendingFiles();
    this.refreshTokenFacts();
    const snapshot = this.runtime.snapshot?.(id);
    this.compacting = snapshot?.compaction?.running === true;
    if (!this.compacting && snapshot && ["running", "failed", "interrupted"].includes(snapshot.status)) {
      this.streaming = { status: snapshot.status, text: snapshot.text ?? "", reasoning: snapshot.reasoning ?? "", error: snapshot.error };
    }
    return loaded;
  }

  // Restore reconciliation: one cached read per still-tracked file, compared
  // directly with the last successfully sent content. No hash, no polling.
  async reconcileTracking(sessionId) {
    const tracker = this.trackerFor?.(sessionId);
    if (!tracker?.trackedFiles || !tracker.reconcile) return null;
    const tracked = tracker.trackedFiles().filter((file) => file.status !== "staged");
    if (tracked.length === 0) return null;
    const reads = [];
    for (const file of tracked) {
      const text = await this.environment.vault.readText(file.path);
      if (typeof text === "string") reads.push({ path: file.path, text });
    }
    return tracker.reconcile(reads);
  }

  navigation() {
    return sessionNavigation({
      sessions: this.sessions, activeSessionId: this.activeSessionId,
      busy: this.loadingSessions || this.sessionActions.busy,
      unavailable: this.sessionUnavailable,
      hasHistory: Boolean(this.hasSessionHistory || this.messages.length || this.streaming || this.sending),
      hasDraft: Boolean((this.composer?.getDraft?.() ?? this.composer?.text ?? "").trim() || this.pending.files.length || this.pending.selections.length),
    });
  }

  async runSessionAction(work) {
    const task = this.sessionActions.run(work);
    this.renderHeader();
    try { return await task; }
    catch {
      this.environment.ui.notice(this.t(this.getSettings(), "sidebar.actionFailed"));
      return null;
    } finally {
      this.loadingSessions = false;
      if (this.mounted) {
        this.renderHeader();
        this.renderPending();
        this.renderConversation();
        this.renderSendButton();
      }
    }
  }

  async newSession() {
    if (!this.canCreateSession()) return this.activeSessionId;
    return this.runSessionAction(async () => {
      const { sessionConfigSnapshot } = require("./settings");
      this.saveDraft();
      const created = await this.sessionStore.createSession({ config: sessionConfigSnapshot(this.getSettings()?.quickAsk) });
      await this.reloadSessions();
      this.sending = false;
      this.renderPending();
      this.renderConversation();
      return created.id;
    });
  }

  canCreateSession() { return this.navigation().canCreate; }

  refreshNewSessionButton() {
    if (this.roots.newSessionButton) this.roots.newSessionButton.disabled = !this.canCreateSession();
  }

  async selectSession(id) {
    if (id === this.activeSessionId || this.sessionActions.busy) return id;
    return this.runSessionAction(async () => {
      this.saveDraft();
      const index = await this.sessionStore.setActive(id);
      if (!index) return null;
      this.activeSessionId = id;
      this.trackedSessionId = id;
      this.streaming = null;
      this.sending = false;
      this.restoreDraft();
      await this.activateSession(id, { recover: true });
      this.renderPending();
      this.renderConversation();
      this.renderSendButton();
      return id;
    });
  }

  // A projection from the owning session's run. Projections for another
  // session are ignored here; that session's own view, if open, receives them.
  applySessionProjection(sessionId, projection) {
    const summary = this.sessions.find(session => session.id === sessionId);
    if (summary && projection.kind === "title") {
      summary.title = projection.title;
      if (this.mounted) this.renderHeader();
    }
    if (summary && projection.kind === "turn") {
      summary.running = projection.status === "running";
      if (!summary.running && sessionId !== this.activeSessionId) summary.unread = true;
      if (this.mounted) this.renderHeader();
    }
    if (sessionId !== this.trackedSessionId) return false;
    if (projection.kind === "accepted") this.refreshPendingFiles();
    this.applyProjection(projection);
    return true;
  }

  async renameSession(id, title) {
    if (this.sessionActions.busy || !this.sessions.some(session => session.id === id)) return null;
    return this.runSessionAction(async () => {
      const current = this.sessions.find(session => session.id === id);
      const value = title === undefined ? await this.ui.promptTitle(current.title) : title;
      if (value === null || !String(value).trim()) return false;
      await this.sessionStore.rename(id, value);
      this.sessions = await this.sessionStore.listSessions();
      return true;
    });
  }

  async deleteSession(id) {
    if (this.sessionActions.busy || !this.sessions.some(session => session.id === id)) return false;
    return this.runSessionAction(async () => {
      const target = this.sessions.find(session => session.id === id);
      const confirmed = await this.environment.ui.confirm(this.t(this.getSettings(), "sidebar.deleteNamedConfirm", { title: target.title || this.t(this.getSettings(), "sidebar.untitled") }), { title: this.t(this.getSettings(), "sidebar.deleteSession") });
      if (!confirmed) return false;
      this.saveDraft();
      if (typeof this.deleteSessionData === "function") await this.deleteSessionData(id);
      else await this.sessionStore.delete(id);
      this.drafts.delete(id);
      if (this.activeSessionId === id) await this.reloadSessions();
      else this.sessions = await this.sessionStore.listSessions();
      this.renderPending();
      this.renderConversation();
      this.renderSendButton();
      return true;
    });
  }

  // The next question's staged input: the composer's own text, its staged file
  // references, and the dragged selections. Sending is ticket 02's concern.
  pendingQuestion() {
    return {
      question: this.composer?.text ?? "",
      references: this.composer?.paths ?? [],
      selections: this.pending.selections.map((selection) => ({ ...selection })),
      files: this.pending.files.map((file) => file.path),
    };
  }

  addFileReference(path) {
    this.pending = addFile(this.pending, path);
    this.renderPending();
  }

  clearSelections() {
    this.pending = clearSelections(this.pending);
    this.renderPending();
  }

  hasExpandBar() {
    return showsExpandBar(this.pending);
  }

  saveDraft() {
    this.drafts.set(this.activeSessionId, { ...this.drafts.get(this.activeSessionId), ...this.captureDraft() });
  }

  captureDraft() {
    return { composer: this.composer?.getDraft?.() ?? this.composer?.text ?? "", pending: this.pending };
  }

  restoreDraft() {
    const draft = this.drafts.get(this.activeSessionId);
    this.pending = draft?.pending ?? createPendingContext();
    this.expanded = false;
    if (this.composer?.setDraft) this.composer.setDraft(draft?.composer ?? "");
    else this.composer?.clear?.();
  }

  refreshPendingFiles() {
    const files = this.currentTracker()?.trackedFiles?.() ?? [];
    for (const file of files) if (file.status !== "staged") this.pending = addFile(this.pending, file.path);
    if (this.roots.pending) this.renderPending();
  }
}

function createQuickAskViewClass(ItemView) {
  return class QuickAskItemView extends ItemView {
    constructor(leaf, options) {
      super(leaf);
      this.contentEl.addClass("scholar-quick-ask-view");
      this.controller = new QuickAskView(leaf, options);
      this.controller.contentEl = this.contentEl;
    }
    getViewType() { return this.controller.getViewType(); }
    getDisplayText() { return this.controller.getDisplayText(); }
    getIcon() { return this.controller.getIcon(); }
    async onOpen() { await this.controller.onOpen(); }
    async onClose() { await this.controller.onClose(); }
  };
}

// Tool status text for the in-progress turn. A spent budget and a full context
// window say so instead of looking like a missing file.
function toolStatusLabel(translate, settings, status) {
  if (status.kind === "read") return translate(settings, "tool.read", { path: status.path });
  if (status.reason === "limit") return translate(settings, "tool.limitReached");
  if (status.reason === "context") return translate(settings, "tool.contextFull", { path: status.path ?? "" });
  return translate(settings, "tool.error", { path: status.path ?? "", message: status.output ?? "" });
}

// The view's own translation helper reads the whole settings object.
function settings0(view) {
  return view.getSettings();
}

module.exports = { QuickAskView, createQuickAskViewClass, QUICK_ASK_VIEW_TYPE, openViews, conversationFromRecords, questionFromInput };
