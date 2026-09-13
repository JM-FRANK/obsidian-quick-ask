const { REASONING_LEVELS } = require("./reasoning");
const { createQuickAskEnvironment } = require("./environment");
const { normalizeQuickAskSettings } = require("./settings");
const { QuickAskSessionStore, parseLog, isSupportedSession } = require("./sessions");
const { Plugin, ItemView, SuggestModal } = require("obsidian");
const { QUICK_ASK_VIEW_TYPE, quickAskViewType, quickAskCommandId } = require("./view-type");
const { createConversation } = require("./conversation");
const { createContextTracker } = require("./tracking");
const { createPreservedCopy, buildExport, parseExport, planImport, clearQuickAskData } = require("./portability");
const { requestResponseDeletion, requestResponseRetrieval } = require("./compaction");
const { createQuickAskDragExtension, createCaptureHolder } = require("./drag-source");
const { derivePendingView } = require("./pending-context");
const { t } = require("./i18n");
const { createSessionActionQueue } = require("./session-navigation");

// The one Quick Ask integration entry point. Scholar Workbench calls it with
// the host plugin, and it registers the view, commands, composer dependencies,
// and editor drag extension only while Quick Ask is available: desktop, with
// the enable setting on. Enabling the UI never sends note content.
//
// Registration and disposal are integration concerns, not environment
// capabilities, so the host's register* helpers are used here and nowhere else.

// The host passes its whole settings object, whose Quick Ask block holds the
// enable flag.
function shouldRegisterQuickAsk({ isDesktop, settings }) {
  return isDesktop === true && normalizeQuickAskSettings(settings?.quickAsk).enable === true;
}

// Compact human-readable storage size for the settings page.
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createQuickAsk({ plugin, getSettings, loadEditorModules, moduleVersions = {}, composerFactory = null }) {
  const settings = () => getSettings() ?? {};
  const viewType = quickAskViewType(plugin.manifest?.id);
  let storageSummary = { text: "" };
  const environment = createQuickAskEnvironment(plugin, {
    getLanguage: () => settings().language ?? "en",
    viewType,
    canNetwork: () => registered && shouldRegisterQuickAsk({ isDesktop: environment.workspace.isDesktop(), settings: settings() }),
  });
  // The preserved copy mirrors affected files after each durable local commit;
  // a failure is reported in settings and never rolls back the live session.
  const preservedCopy = createPreservedCopy({
    pluginData: environment.pluginData,
    vault: environment.vault,
    getSettings: () => settings().quickAsk ?? settings(),
  });
  const sessionStore = new QuickAskSessionStore({
    pluginData: environment.pluginData,
    scheduler: environment.scheduler,
    onError: (error) => console.error("Scholar Workbench: Quick Ask session write failed", error),
    onCommitted: async (sessionId) => {
      if (!preservedCopy.isEnabled()) return;
      const parsed = await sessionStore.readLog(sessionId);
      if (!parsed?.header) return;
      const index = await sessionStore.loadIndex();
      await preservedCopy.syncSession({ id: sessionId, header: parsed.header, records: parsed.records, index });
    },
  });
  // One capture holder shared by the registered editor extensions and the
  // sidebar's drop targets.
  const captureHolder = createCaptureHolder();
  // The conversation runtime and the Context tracker per session; the tracker
  // owns what is actually tracked, the view only renders it.
  const trackers = new Map();
  const drafts = new Map();
  const sessionActions = createSessionActionQueue();
  function trackerFor(sessionId) {
    let tracker = trackers.get(sessionId);
    if (!tracker) {
      tracker = createContextTracker({
        vault: environment.vault,
        scheduler: environment.scheduler,
        // Durable tracking facts are appended to the owning session's log as
        // they happen; accepted content is appended when the turn is accepted.
        onEvent: ({ kind, ...payload }) => void sessionStore.append(sessionId, kind, payload).catch(() => {}),
      });
      trackers.set(sessionId, tracker);
    }
    return tracker;
  }

  // Public Vault events only mark an explicitly tracked file as changed. The
  // callback performs no network work and no Vault search.
  function registerVaultTracking(owner) {
    const on = (name, listener) => owner.registerEvent(plugin.app.vault.on(name, listener));
    on("modify", (file) => {
      const path = file?.path;
      if (typeof path !== "string") return;
      for (const tracker of trackers.values()) tracker.modifiedFile(path);
    });
    on("rename", (file, oldPath) => {
      const path = file?.path;
      if (typeof path !== "string" || typeof oldPath !== "string") return;
      for (const tracker of trackers.values()) tracker.renamedFile(oldPath, path);
    });
    on("delete", (file) => {
      const path = file?.path;
      if (typeof path !== "string") return;
      for (const tracker of trackers.values()) tracker.deletedFile(path);
    });
  }
  const conversation = createConversation({
    sessionStore,
    // Every open sidebar that shows the owning session receives its
    // projections; background turns keep updating their own session only.
    onSessionChange: (sessionId, projection) => {
      const { openViews } = require("./view");
      for (const view of openViews) view.applySessionProjection(sessionId, projection);
    },
    trackerFor,
    environment,
    getSettings: settings,
    isEnabled: () => registered && shouldRegisterQuickAsk({ isDesktop: environment.workspace.isDesktop(), settings: settings() }),
    // Whether a complete file still fits the configured window. This is what
    // makes the context-space error reachable instead of always reading.
    getContextBudget: (path, sessionId) => {
      if (!sessionId) return true;
      const snapshot = conversation.snapshot(sessionId);
      const capacity = snapshot?.config?.contextWindowTokens
        ?? normalizeQuickAskSettings(settings().quickAsk).contextWindowTokens;
      if (!Number.isInteger(capacity) || capacity <= 0) return true;
      const tracked = trackerFor(sessionId).trackedFiles().find((file) => file.path === path);
      const estimate = tracked?.observedRawText ? Math.ceil(tracked.observedRawText.length / 4) : 0;
      const used = snapshot?.occupancy?.tokens ?? 0;
      return used + estimate + 16384 <= capacity;
    },
  });
  let dragExtension = null;
  let registrations = null;

  let registered = false;
  let registeredCreator = null;
  // The composer factory is resolved when the sidebar opens, so the host (or a
  // test) can supply one after construction.
  let activeComposerFactory = composerFactory;

  function register() {
    if (registered) return;
    // The view module loads only while registering on desktop.
    const { createQuickAskViewClass } = require("./view");
    const View = createQuickAskViewClass(ItemView, { viewType, getDisplayText: () => t(settings(), "view.displayName") });
    registeredCreator = (leaf) => new View(leaf, {
      environment,
      viewType,
      sessionStore,
      getSettings: settings,
      conversation,
      trackerFor: (sessionId) => trackerFor(sessionId),
      drafts,
      sessionActions,
      captureHolder,
      retrieveResponse: (sessionId, responseId) => integration.retrieveResponse(sessionId, responseId),
      deleteSessionData: (sessionId) => integration.deleteSession(sessionId),
      // The ring and panels read the active session's own snapshot, never the
      // current global settings.
      getConfig: (sessionId) => conversation.snapshot(sessionId)?.config
        ?? conversation.stateFor?.(sessionId)?.config
        ?? settings().quickAsk
        ?? {},
      t,
      // Load the bundled owned editor lazily when its view actually opens.
      createComposer: ((options) => {
        const factory = activeComposerFactory;
        if (factory) return factory(options);
        const { createComposerEditor } = require("./composer-view");
        return createComposerEditor(options);
      }),
    });
    // A stock Obsidian Plugin component owns these public register* cleanups.
    // It shares the release's identity; it is never installed or enabled as a
    // second plugin. Removing the child unloads exactly this feature's hooks.
    registrations = plugin.addChild(new Plugin(plugin.app, plugin.manifest));
    registrations.registerView(viewType, registeredCreator);
    registrations.registerHoverLinkSource(viewType, { display: `${plugin.manifest?.name ?? "Scholar Workbench"}: Quick Ask`, defaultMod: true });
    dragExtension = createQuickAskDragExtension({
      ...(loadEditorModules ? loadEditorModules() : moduleVersions), captureHolder,
      isEnabled: () => registered,
    });
    registrations.registerEditorExtension(dragExtension.extension);
    registerVaultTracking(registrations);
    registrations.addRibbonIcon("message-circle-question", t(settings(), "command.openSidebar"), () => {
      if (registered && shouldRegisterQuickAsk({ isDesktop: environment.workspace.isDesktop(), settings: settings() })) {
        environment.workspace.openView(viewType);
      }
    }).addClass("scholar-quick-ask-ribbon");
    registrations.addCommand({
      id: quickAskCommandId(plugin.manifest?.id),
      name: t(settings(), plugin.manifest?.id === "quick-ask" ? "command.openStandaloneSidebar" : "command.openSidebar"),
      // Check the current setting even if an already-open palette retains
      // the previous command object during deactivation.
      checkCallback: (checking) => {
        const available = shouldRegisterQuickAsk({
          isDesktop: environment.workspace.isDesktop(),
          settings: settings(),
        });
        if (available && !checking) environment.workspace.openView(viewType);
        return available;
      },
    });
    let effortPicker = null;
    registrations.register(() => effortPicker?.close());
    registrations.addCommand({
      id: "set-reasoning-effort",
      name: t(settings(), "command.reasoningEffort"),
      checkCallback: checking => {
        const sessionId = sessionStore.index?.activeSessionId;
        if (!registered || !sessionId) return false;
        if (!checking) {
          class EffortPicker extends SuggestModal {
            getSuggestions(query) { return Object.keys(REASONING_LEVELS).filter(value => REASONING_LEVELS[value].toLowerCase().includes(query.toLowerCase())); }
            renderSuggestion(value, element) { element.setText(`${REASONING_LEVELS[value]}${conversation.reasoningEffort(sessionId) === value ? " ✓" : ""}`); }
            onChooseSuggestion(value) { if (registered && sessionStore.index?.sessions.some(session => session.id === sessionId)) conversation.setReasoningEffort(sessionId, value); }
          }
          effortPicker?.close();
          const picker = effortPicker = new EffortPicker(plugin.app);
          picker.setPlaceholder(t(settings(), "reasoning.effort"));
          picker.open();
        }
        return true;
      },
    });
    registered = true;
  }

  // The enable setting applies immediately, without a plugin reload. Turning it
  // off leaves no registered command or editor extension and performs no
  // network work.
  function sync() {
    if (shouldRegisterQuickAsk({ isDesktop: environment.workspace.isDesktop(), settings: settings() })) {
      register();
    } else if (registered) {
      deactivate();
    }
    return registered;
  }

  // Removing the owned Obsidian component executes the public registration
  // cleanups; the session data remains untouched.
  function deactivate() {
    registered = false;
    captureHolder.clear();
    conversation.suspend();
    plugin.app.workspace.detachLeavesOfType(viewType);
    if (registrations) plugin.removeChild(registrations);
    registrations = null;
    registeredCreator = null;
  }

  const integration = {
    environment,
    sessionStore,
    conversation,
    trackerFor,
    captureHolder,
    get dragExtension() { return dragExtension; },
    sync,
    isRegistered: () => registered,
    shouldRegister: () => shouldRegisterQuickAsk({
      isDesktop: environment.workspace.isDesktop(),
      settings: settings(),
    }),
    derivePendingView,
    open: () => registered && environment.workspace.openView(viewType),
    createView: (leaf) => registeredCreator?.(leaf),
    setComposerFactory: (factory) => { activeComposerFactory = factory; },
    // The settings page calls this after the enable setting changes, so the
    // setting applies immediately without reloading the plugin.
    syncEnabled: sync,
    refreshAppearance: () => {
      const { openViews } = require("./view");
      for (const view of openViews) view.applyAppearance();
    },
    // The preserved copy is an explicit status report, not a second sync path.
    secrets: () => environment.secrets.list(),
    // Settings shows the local session count and calculated storage use. The
    // tally is best-effort: an unreadable directory reports nothing rather than
    // failing the settings page.
    storageSummary: () => storageSummary,
    preservedCopy: () => preservedCopy.status(),
    // Export, import, and clear are explicit user actions from settings.
    exportData: async () => {
      const index = await sessionStore.loadIndex();
      const sessions = [];
      for (const session of index.sessions) {
        const parsed = await sessionStore.readLog(session.id);
        if (parsed?.header) sessions.push({ id: session.id, header: parsed.header, records: parsed.records ?? [] });
      }
      const exported = buildExport({
        settings: normalizeQuickAskSettings(settings().quickAsk),
        index,
        sessions,
      });
      return { status: "exported", text: JSON.stringify(exported) };
    },
    importData: async (text) => {
      const parsed = parseExport(text);
      if (!parsed.ok) return { status: "invalid", reason: parsed.reason };
      const index = await sessionStore.loadIndex();
      for (const source of parsed.export.sessions) {
        if (!source || !/^[A-Za-z0-9_-]+$/.test(source.id) || !source.header || !Array.isArray(source.records) || source.header.sessionId !== source.id) return { status: "invalid", reason: "invalid-session" };
        const replay = parseLog([source.header, ...source.records].map(line => JSON.stringify(line)).join("\n") + "\n");
        if (!isSupportedSession(replay)) return { status: "invalid", reason: "invalid-session" };
        source.title = replay.title;
      }
      const planned = planImport({
        localIds: index.sessions.map((session) => session.id),
        backupSessions: parsed.export.sessions.map((session) => ({ id: session.id, title: session.title })),
        suffix: t(settings(), "sidebar.importSuffix"),
      });
      let imported = 0;
      for (const plan of planned) {
        // The plan keeps the backup's original id so a colliding import can be
        // renamed while a missing one keeps its identity.
        const source = parsed.export.sessions.find((session) => session.id === plan.sourceId);
        if (!source) continue;
        await sessionStore.importSession({
          id: plan.id,
          header: source.header,
          records: source.records,
          title: plan.title,
        });
        imported += 1;
      }
      await sessionStore.loadIndex();
      return { status: "imported", imported };
    },
    deleteSession: async (sessionId) => {
      // Abort the session's active run before its local state disappears.
      await conversation.stop(sessionId);
      await conversation.waitForTurn(sessionId);
      const parsed = await sessionStore.readLog(sessionId);
      const responseIds = (parsed.records ?? [])
        .filter((record) => record.kind === "turn/response-created" && record.payload?.stored !== false && typeof record.payload?.responseId === "string")
        .map((record) => record.payload.responseId);
      const config = parsed.header?.config ?? {};
      let remoteFailures = 0;
      if ((config.protocol ?? "responses") === "responses" && responseIds.length > 0 && config.baseUrl) {
        for (const responseId of responseIds) {
          const result = await requestResponseDeletion({
            network: environment.network,
            baseUrl: config.baseUrl,
            apiKey: environment.secrets.resolve(config.secretId),
            responseId,
          });
          if (!result.ok) remoteFailures += 1;
        }
      }
      await sessionStore.delete(sessionId);
      trackers.delete(sessionId);
      drafts.delete(sessionId);
      conversation.forget(sessionId);
      // A remote failure never blocks local deletion, but the user is told that
      // provider-retained data may remain.
      if (remoteFailures > 0) environment.ui.notice(t(settings(), "sidebar.remoteDeleteFailed"));
      return { status: "deleted", remoteFailures };
    },
    // Restart recovery retrieves a stored pending Response for its session.
    retrieveResponse: async (sessionId, responseId) => {
      const parsed = await sessionStore.readLog(sessionId);
      const config = parsed.header?.config ?? {};
      if (!config.baseUrl || (config.protocol ?? "responses") !== "responses") return null;
      return requestResponseRetrieval({
        network: environment.network,
        baseUrl: config.baseUrl,
        apiKey: environment.secrets.resolve(config.secretId),
        responseId,
      });
    },
    // The destructive clear asks the host's own confirmation first.
    confirmClear: () => environment.ui.confirm(t(settings(), "settings.quickAsk.data.clearConfirm")),
    clearData: async () => {
      const result = await clearQuickAskData({
        pluginData: environment.pluginData,
        sessionsDirectory: sessionStore.sessionsDirectory,
        indexPath: sessionStore.indexPath,
      });
      // Drop the in-memory index so the next access rebuilds from an empty
      // sessions directory instead of returning deleted sessions.
      sessionStore.index = null;
      return { status: "cleared", ...result };
    },
    // The clipboard is a ui capability, never read from a global.
    writeClipboard: (text) => environment.ui.writeClipboard(text),
    readClipboard: () => environment.ui.readClipboard(),
    refreshStorageSummary: async () => {
      try {
        const sessions = await sessionStore.listSessions();
        let bytes = 0;
        for (const session of sessions) {
          const parsed = await sessionStore.readLog(session.id);
          if (parsed?.header) bytes += JSON.stringify(parsed.header).length + (parsed.records?.length ?? 0) * 64;
        }
        storageSummary = { text: t(settings(), "settings.quickAsk.storage.value", {
          count: sessions.length, size: formatBytes(bytes),
        }) };
      } catch (error) {
        console.error("Scholar Workbench: Quick Ask storage summary failed", error);
        storageSummary = { text: "" };
      }
      return storageSummary;
    },
    registerView: register,
    dispose() {
      deactivate();
    },
  };
  plugin.register(() => integration.dispose());
  return integration;
}

module.exports = { createQuickAsk, shouldRegisterQuickAsk, QUICK_ASK_VIEW_TYPE, formatBytes };
