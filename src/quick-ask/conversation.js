const { effectiveRecords, latestTurn, recoverableDraft, restoredDraft, sessionUsage: replaySessionUsage, changedConnection, portableItems, compactionUsage, legacyRoleProfile } = require("./session-editing");
const { providerSearchMode } = require("./provider-profiles");
const { runProviderSearch, mixedSearchErrorHint } = require("./provider-search");
const { PROCESS_VERSION, createTurnProcess, restoreProcess } = require("./turn-process");
const { geminiSearchWire, buildGeminiSearchBody } = require("./gemini-search");
const { imagePaths: normalizeImagePaths } = require("./images");
const { normalizeReasoningEffort } = require("./reasoning");
const { protocolFor, messageText, isToolOutput, toolOutputId, truncateOutput, callsFromItem } = require("./protocol");
const { createImageToolResults } = require('./image-tool-results');
const { toolHistory, toolSummary, parameters: toolParameters, updateToolGroups, sourceSummary } = require('./tool-history');
const { WEB_SEARCH_TOOL, normalizeSearchSettings, searchRoute, responseSources, responseSuggestions, normalizeSources, citedAnswer } = require("./web-search");
const { createSearchClient } = require("./search-client");
const { createStore } = require("zustand/vanilla");
const { createProjectionPublisher } = require("./stream-presentation");
const { deriveTitle, isSupportedSession } = require("./sessions");
const {
  streamAttempt, createRetryPolicy, normalizeError,
  isResponsesFunctionCall,
  isResponsesWebSearchCall,
  parseToolArguments, isResponsesStateUnsupported, responsesUsageInputTokens,
} = require("./transport");
const { renderTurn, renderContextEnvelope, RENDERER_VERSION, buildInstructions, getFullFileTool } = require("./prompt-renderer");
const { createContextProjection } = require('./context-projection');
const { withSelectionUnits } = require('./selection-position');
const { validateQuickAskSettings, normalizeQuickAskSettings, ANSWER_RESERVE_TOKENS } = require("./settings");
const { createToolLoop, TOOL_NAMES } = require("./tool-loop");
const { createToolExecutor, GET_IMAGE_TOOL } = require("./tool");
const { createAbortController } = require("./transport");
const {
  priceProspectiveRequest, capacityBudget, contextOccupancy, shouldCompact,
  createTurnUsage, createSessionUsage,
} = require("./tokens");
const {
  CompactionTransaction, chooseRetainedTail, selectCompactionRange,
  buildSummaryInstruction, frameSummary, truncateToolResult, requestOfficialCompaction,
  requestInputTokens, measureItems, measureText, replayCompactionSurface,
} = require("./compaction");
const { ANSWER_RESERVE_TOKENS: RESERVE } = require("./settings");

// The Quick Ask conversation runtime: one turn at a time per session, at most
// three turns in flight across sessions, durable state before every request,
// and a complete local canonical item history that stays authoritative even
// when the endpoint supports server-side state.

const MAX_CONCURRENT_TURNS = 3;
const STREAM_EVENT_KINDS = Object.freeze([
  "created", "text-delta", "reasoning-summary-delta", "reasoning-text-delta",
  "function-call-delta", "function-call", "usage", "terminal",
]);

function createConversation(options) {
  const {
    sessionStore,
    tracker,
    trackerFor = () => tracker,
    isEnabled = () => true,
    environment,
    getSettings,
    onSessionChange = () => {},
    policy = createRetryPolicy(),
    idleTimeoutMs,
    // The read-only tool surface. A caller without a vault still gets a valid
    // executor that answers every call with the normalized missing-file text.
    toolExecutor = createToolExecutor({ vault: options.environment?.vault ?? { readText: async () => null }, images: options.environment?.images,
      getMaxConcurrent: () => normalizeQuickAskSettings(getSettings()?.quickAsk).toolConcurrency }),
    getContextBudget = () => null,
  } = options;

  const searchClient = createSearchClient(environment);
  function toolsFor(state, rendererVersion = RENDERER_VERSION) {
    const route = state.requestSearch;
    const protocol = protocolFor(state.config);
    const tools = [protocol.functionTool(getFullFileTool(rendererVersion)), protocol.functionTool(GET_IMAGE_TOOL)];
    if (route?.kind === "server") {
      if (route.tool) tools.push(route.tool);
    } else if (route && route.kind !== "off") {
      const searchTool = route.queryLimit ? { ...WEB_SEARCH_TOOL,
        description: WEB_SEARCH_TOOL.description.replace('500', String(route.queryLimit)),
        parameters: { ...WEB_SEARCH_TOOL.parameters, properties: { query: { ...WEB_SEARCH_TOOL.parameters.properties.query, maxLength: route.queryLimit } } } } : WEB_SEARCH_TOOL;
      tools.push(protocol.functionTool(searchTool));
    }
    return tools;
  }

  function searchEnabled(sessionId) {
    const state = stateFor(sessionId);
    return typeof state.searchEnabled === "boolean" ? state.searchEnabled : normalizeSearchSettings(getSettings()?.quickAsk?.webSearch).defaultEnabled;
  }
  // Draft controls stay in memory. Their request/post-send state is committed
  // once in turn/started, after validation, rather than on every click.
  async function setSearchEnabled(sessionId, enabled) {
    const state = stateFor(sessionId);
    state.searchRevision = (state.searchRevision ?? 0) + 1;
    state.searchEnabled = enabled === true;
    state.searchDirty = true;
    pushProjection(state, { kind: "search-state", enabled: state.searchEnabled });
    return state.searchEnabled;
  }
  function reasoningEffort(sessionId) {
    const state = stateFor(sessionId);
    return normalizeReasoningEffort(state.reasoningEffort ?? state.config?.reasoningEffort);
  }
  function setReasoningEffort(sessionId, value) {
    const state = stateFor(sessionId);
    state.reasoningEffort = normalizeReasoningEffort(value);
    state.reasoningDirty = true;
    pushProjection(state, { kind: "reasoning-effort", value: state.reasoningEffort });
    return state.reasoningEffort;
  }
  function nextSearchRoute(sessionId) {
    const state = stateFor(sessionId);
    return searchRoute(searchEnabled(sessionId), normalizeSearchSettings(getSettings()?.quickAsk?.webSearch), { ...state.config, providerSearchMode: (state.config?.configurationVersion ? state.config.providerSearchMode : providerSearchMode(state.config, getSettings()?.quickAsk)) });
  }
  function validateSearchForSend(sessionId, enabled = searchEnabled(sessionId)) {
    const state = stateFor(sessionId);
    const settings = normalizeSearchSettings(getSettings()?.quickAsk?.webSearch);
    const route = searchRoute(enabled, settings, { ...state.config, providerSearchMode: (state.config?.configurationVersion ? state.config.providerSearchMode : providerSearchMode(state.config, getSettings()?.quickAsk)) });
    const errors = {};
    if (route.kind === "invalid") errors[route.error] = true;
    if (["independent", "provider-api"].includes(route.kind) && !environment.secrets.resolve(route.secretId)?.trim()) errors.searchSecret = true;
    return { valid: Object.keys(errors).length === 0, errors, route };
  }
  // Per-session live state. Everything durable also lands in the JSONL log.
  const sessionStores = new Map();
  const publishers = new Map();

  function stateFor(sessionId) {
    let state = sessionStores.get(sessionId)?.getState().state;
    if (!state) {
      state = {
        sessionId,
        usage: createTurnUsage(),
        sessionUsage: createSessionUsage(),
        occupancyAnchor: null,
        compactedSurface: null,
        config: null,
        contextProjection: createContextProjection(),
        items: [],
        authorizedImagePaths: new Set(),
        imageToolResults: createImageToolResults(),
        toolGroups: [],
        lastResponseId: null,
        storedState: false,
        nonStreaming: false,
        turn: null,
      };
      const store = createStore(() => ({ state, projection: null }));
      store.subscribe(value => { if (value.projection) onSessionChange(sessionId, value.projection); });
      sessionStores.set(sessionId, store);
      publishers.set(sessionId, createProjectionPublisher(environment.scheduler, projection => store.setState({ state, projection })));
    }
    return state;
  }

  function runningTurns() {
    let count = 0;
    for (const store of sessionStores.values()) if (store.getState().state.preparing || store.getState().state.turn?.status === "running") count += 1;
    return count;
  }

  // Rebuild in-memory state by replaying the durable log.
  async function load(sessionId, { onParsed = null, editing = false } = {}) {
    const raw = await sessionStore.readLog(sessionId);
    const parsed = { ...raw, records: effectiveRecords(raw.records) };
    const state = stateFor(sessionId);
    if (state.editing && !editing) throw new Error("Session is being edited");
    if (parsed.missing) throw new Error(`Quick Ask session ${sessionId} does not exist`);
    if (state.activeController || state.turn?.controller) {
      if (onParsed) await onParsed(parsed);
      return { state, parsed };
    }
    if (!parsed.header || !isSupportedSession(parsed)) throw new Error("Quick Ask session is unavailable");
    // Let the view paint a recent-history window before full model replay,
    // pricing and tracked-file reconciliation. This never truncates context.
    if (onParsed) await onParsed(parsed);
    // A background run may have started while the preview yielded to paint.
    if (state.activeController || state.turn?.controller) return { state, parsed };
    state.config = { ...parsed.header?.config, protocol: parsed.header?.config?.protocol ?? "responses" };
    protocolFor(state.config);
    const draftSearch = state.searchDirty ? state.searchEnabled : undefined;
    const draftEffort = state.reasoningDirty ? state.reasoningEffort : undefined;
    state.reasoningEffort = undefined;
    state.usage = createTurnUsage();
    state.usageSamples = [];
    state.sessionUsage = createSessionUsage();
    state.searchEnabled = undefined;
    state.items = [];
    state.authorizedImagePaths = new Set();
    state.imageToolResults = createImageToolResults();
    state.contextProjection = createContextProjection();
    state.compactedSurface = null;
    state.compactedItems = [];
    state.pendingCheckpoint = null;
    state.occupancyAnchor = null;
    state.lastPrice = null;
    state.lastOccupancy = null;
    state.lastResponseId = null;
    state.turn = null;
    for (const record of parsed.records ?? []) {
      applyRecord(state, record);
    }
    state.roleDisplayProfile = legacyRoleProfile(state.config, getSettings()?.quickAsk);
    if (state.turn?.processVersion === PROCESS_VERSION) {
      const records = (parsed.records ?? []).filter(record => record.payload?.turnId === state.turn.turnId);
      state.turn.process = createTurnProcess(restoreProcess(records));
    }
    state.sessionUsage = replaySessionUsage(raw.records ?? []);
    state.restoredDraft = restoredDraft(raw.records ?? []);
    state.editableTurn = latestTurn(raw.records ?? []);
    state.toolGroups = toolHistory(parsed.records ?? []);
    if (draftSearch !== undefined) state.searchEnabled = draftSearch;
    if (draftEffort !== undefined) state.reasoningEffort = draftEffort;
    trackerFor(sessionId).restore?.(parsed.records ?? []);
    // A replay can happen after a configuration edit, without view activation.
    // Reconcile on the next send even if a modify event preceded that replay.
    for (const file of trackerFor(sessionId).trackedFiles?.() ?? []) trackerFor(sessionId).modifiedFile?.(file.path);
    // Replay must never contact a provider, even near capacity. Price only the
    // restored active generation after the tracked files have been restored.
    priceLocalRequest(state, { question: "", additions: [] });
    state.reloadRequired = false;
    return { state, parsed };
  }

  function applyRecord(state, record) {
    state.contextProjection.sourceRecord(record);
    const payload = record.payload ?? {};
    switch (record.kind) {
      case "session/configured":
        if (payload.portable) {
          const originals = [...state.items];
          const migrated = state.contextProjection.items(originals);
          state.items = portableItems(migrated, state.config.protocol, (_from, to, index) => {
            state.imageToolResults.copy(originals[index], to);
          });
          state.compactedSurface = null;
          state.compactedItems = [];
        }
        state.config = { ...payload.config };
        if (payload.portable) {
          state.nonStreaming = false;
          state.inputTokensUnsupported = false;
          state.officialUnsupported = false;
          state.overflowRecoveryDone = false;
        }
        state.requestSearch = null;
        state.requestEffort = null;
        state.occupancyAnchor = null;
        break;
      case "session/search-state":
        state.searchEnabled = payload.enabled === true;
        break;
      case "item/input":
      case "item/output":
        if (record.kind === 'item/input') rememberImages(state, payload.images);
        for (const [position, item] of (payload.items ?? (payload.item ? [payload.item] : [])).entries()) {
          if (record.kind === 'item/output' && payload.tool === true && isToolOutput(item)) {
            state.imageToolResults.remember(item, payload.imagePaths ?? payload.images);
            rememberImages(state, payload.imagePaths ?? payload.images);
          }
          // Images belong to the final question, never the Context envelope.
          const isQuestion = !payload.items || position === payload.items.length - 1;
          if (!(record.kind === 'item/input' && isQuestion && payload.images?.length && !messageText(item))) appendCanonicalItem(state, item, !isQuestion);
        }
        break;
      case "compaction/checkpoint":
        // Staged here; activation happens only when the bracket closes well.
        state.pendingCheckpoint = payload;
        break;
      case "compaction/end":
        if (payload?.ok === true && state.pendingCheckpoint) {
          applyCompactedSurface(state, state.pendingCheckpoint, {
            items: state.items.slice((state.pendingCheckpoint.range?.to ?? -1) + 1),
          });
        }
        state.pendingCheckpoint = null;
        break;
      case "turn/response-created":
        state.lastResponseId = payload.responseId ?? state.lastResponseId;
        break;
      case "turn/usage":
        recordUsage(state, [payload]);
        break;
      case "turn/started":
        state.contextProjection.beginTurn(payload.additions ?? [], payload.rendererVersion ?? 1);
        if (typeof payload.nextSearchEnabled === "boolean") state.searchEnabled = payload.nextSearchEnabled;
        if (payload.reasoningEffort) state.reasoningEffort = normalizeReasoningEffort(payload.reasoningEffort);
        state.usage = createTurnUsage();
        state.usageSamples = [];
        state.turn = {
          turnId: payload.turnId,
          processVersion: payload.processVersion,
          config: payload.config ?? { ...state.config },
          editDraft: payload.editDraft,
          question: payload.question ?? "",
          additions: payload.additions ?? [],
          imagePaths: payload.images ?? [],
          rendererVersion: payload.rendererVersion ?? 1,
          status: "running",
          text: "",
          reasoning: "",
          responseId: null,
        };
        break;
      case "turn/finished":
        if (Array.isArray(payload.usageSamples)) {
          state.usage = createTurnUsage();
          state.usageSamples = [];
          recordUsage(state, payload.usageSamples);
          if (Object.hasOwn(payload, "occupancyAnchor")) state.occupancyAnchor = payload.occupancyAnchor;
        }
        state.sessionUsage.addTurn(state.usage.totals());
        if (state.turn && state.turn.turnId === payload.turnId) {
          state.turn = {
            ...state.turn,
            status: payload.state ?? "complete",
            text: payload.text ?? state.turn.text,
            reasoning: payload.reasoning ?? state.turn.reasoning,
            error: payload.error ?? null,
          };
        }
        break;
      default:
        break;
    }
  }

  function requestInput(state, staged) {
    let turn = staged.continuation
      ? staged.continuation
      : (staged.question || staged.imagePaths?.length || staged.images?.length ? renderTurn({ mutations: staged.additions, question: staged.question, userMessage: protocolFor(state.config).userMessage, rendererVersion: staged.rendererVersion ?? RENDERER_VERSION }) : []);
    if (!staged.continuation && !staged.accepted && staged.images?.length) {
      turn[turn.length - 1] = protocolFor(state.config).imageMessage(staged.question, staged.images);
    }
    if (state.storedState && state.lastResponseId) {
      // Server state is preferred: send only the new input.
      return { input: Array.isArray(turn) ? turn : staged.toolContinuation ?? [], previousResponseId: state.lastResponseId };
    }
    // Local replay rebuilds the whole request from canonical items. A
    // compaction is an explicit prefix discontinuity: the compacted surface
    // replaces the shadowed items, and every still-tracked Context File is
    // reintroduced as a path reference.
    const surface = state.compactedSurface ? activeSurface(state) : state.items;
    // Tool continuation items have already been appended to the canonical
    // surface by runToolContinuation. Replaying them again duplicates calls.
    return { input: state.contextProjection.items(staged.continuation ? [...surface] : [...surface, ...turn]), previousResponseId: null };
  }

  function rememberImages(state, paths = []) {
    if (!Array.isArray(paths)) return;
    for (const path of paths) {
      try { for (const valid of normalizeImagePaths([path])) state.authorizedImagePaths.add(valid); } catch { /* Invalid legacy metadata grants no access. */ }
    }
  }

  // The compacted surface, in the confirmed order: references to still-tracked
  // Context Files in first-added order, then the
  // compacted checkpoint output, then the retained recent tail. Each part
  // appears exactly once.
  function activeSurface(state) {
    return [...trackedFileReferences(state), ...compactionHistory(state)];
  }

  // Active checkpoint and recent items only. Tracked file references are inserted
  // separately and shadowed raw history must not return on a second compaction.
  function compactionHistory(state) {
    if (!state.compactedSurface) return state.items;
    const checkpoint = state.compactedSurface;
    const framed = checkpoint.checkpoint?.framed ?? checkpoint.framed;
    return [
      ...(checkpoint.providerOutput ?? []),
      ...(framed ? [protocolFor(state.config).userMessage(framed)] : []),
      ...(state.compactedItems ?? []),
    ];
  }

  function appendCanonicalItem(state, item, contextInput = false) {
    state.contextProjection.add(item, contextInput);
    state.items.push(item);
    if (state.compactedSurface) state.compactedItems.push(item);
  }

  // Compaction preserves tracked paths without injecting their bodies again.
  // The retained tail stays verbatim; get-full-file can retrieve current text.
  function trackedFileReferences(state) {
    const tracked = typeof trackerFor(state.sessionId).trackedFiles === "function" ? trackerFor(state.sessionId).trackedFiles() : [];
    return tracked
      .filter((file) => typeof file.observedRawText === "string" && file.status !== "staged")
      .map(file => protocolFor(state.config).userMessage(renderContextEnvelope([
        { kind: "reference", path: file.path },
      ], { rendererVersion: RENDERER_VERSION })));

  }

  function buildBody(state, staged, projectedRequest = null) {
    staged = { ...staged, rendererVersion: RENDERER_VERSION };
    const config = state.config ?? {};
    const settings = normalizeQuickAskSettings(getSettings()?.quickAsk ?? config);
    const { input, previousResponseId } = projectedRequest ?? requestInput(state, staged);
    const body = protocolFor(state.config).buildRequestBody({
      reasoningEffort: state.requestEffort ?? reasoningEffort(state.sessionId),
      instructions: buildInstructions({ rendererVersion: staged.rendererVersion ?? RENDERER_VERSION, customSystemPrompt: config.systemPrompt ?? settings.systemPrompt }),
      input,
      tools: toolsFor(state, staged.rendererVersion ?? RENDERER_VERSION),
      toolChoice: state.requestSearch?.kind === "server" ? (state.requestSearch.toolChoice ?? "auto") : "auto",
      parallelToolCalls: true,
      serverSearch: state.requestSearch?.kind === "server" ? state.requestSearch : undefined,
      previousResponseId,
      store: state.storedState,
      model: config.model ?? settings.model,
    });
    return state.requestSearch?.native ? buildGeminiSearchBody(body) : body;
  }

  function materializeToolImages(state, items, { pendingImages = [], signal = null } = {}) {
    return state.imageToolResults.materialize(items, { source: environment.images,
      allowlist: state.authorizedImagePaths, protocol: protocolFor(state.config), pendingImages, signal });
  }

  async function buildModelBody(state, staged, signal = null) {
    const request = requestInput(state, staged);
    const projected = await materializeToolImages(state, request.input, {
      pendingImages: !staged.continuation && !staged.accepted ? staged.images ?? [] : [], signal,
    });
    return { body: buildBody(state, staged, { ...request, input: projected.items }), hasImages: projected.hasImages };
  }

  function resolveApiKey(state) {
    const secretId = state.config?.secretId ?? "";
    return secretId ? environment.secrets.resolve(secretId) : null;
  }

  // Validate declaratively before building a request. The first real question
  // is the connection check, so nothing here probes the endpoint.
  function validateForSend(state) {
    const config = state.config ?? {};
    const merged = normalizeQuickAskSettings({
      ...normalizeQuickAskSettings(getSettings()?.quickAsk),
      ...config,
      // A session keeps its own snapshot; only a missing field falls back.
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.secretId ? { secretId: config.secretId } : {}),
    });
    const result = validateQuickAskSettings(merged);
    if (!result.valid) return { valid: false, errors: result.errors, settings: merged };
    if (!resolveApiKey(state)) {
      return { valid: false, errors: { secretId: "secret" }, settings: merged };
    }
    return { valid: true, errors: {}, settings: merged };
  }

  // Price the complete prospective request against the configured capacity and
  // report which pending Context Files occupy the most estimated tokens.
  function priceLocalRequest(state, { question, additions, rendererVersion = RENDERER_VERSION }) {
    rendererVersion = RENDERER_VERSION;
    const settings = normalizeQuickAskSettings(state.config ?? getSettings()?.quickAsk);
    const budget = capacityBudget(settings.contextWindowTokens, { reserveTokens: RESERVE });
    const items = state.compactedSurface ? activeSurface(state) : state.items;
    const price = priceProspectiveRequest({
      instructions: buildInstructions({ rendererVersion, customSystemPrompt: state.config?.systemPrompt ?? "" }),
      tools: toolsFor(state, rendererVersion),
      items: state.contextProjection.items(items),
      additions: additions.length ? renderTurn({ mutations: additions, question: "", userMessage: protocolFor(state.config).userMessage, rendererVersion }).slice(0, -1) : [],
      question,
      reserveTokens: budget.configured ? RESERVE : 0,
    });
    // The reserve is included in price.total once. Occupancy describes input,
    // and a previous provider sample must not hide newly added local content.
    const estimatedInput = price.total - price.components.reserve;
    let occupancy = contextOccupancy({
      anchor: state.occupancyAnchor,
      prospectiveTokens: estimatedInput,
    });
    if (estimatedInput > occupancy.tokens) occupancy = { tokens: estimatedInput, exact: false, estimated: true };
    state.lastPrice = price;
    state.lastOccupancy = occupancy;
    return { settings, budget, price, occupancy, estimatedInput };
  }

  async function pricePendingRequest(state, { question, additions, rendererVersion = RENDERER_VERSION, allowCompaction = true, images = [] }) {
    const local = priceLocalRequest(state, { question, additions, rendererVersion });
    const { settings, budget, price, estimatedInput } = local;
    let { occupancy } = local;
    if (!budget.configured) return { blocked: false, needsCompaction: false, price, occupancy };

    const nearLimit = Math.max(price.total, occupancy.tokens) > budget.inputBudget * 0.8;
    let exactInput = null;
    if (nearLimit && protocolFor(state.config).inputTokens && !state.inputTokensUnsupported) {
      const exact = await requestInputTokens({
        network: environment.network,
        baseUrl: state.config?.baseUrl ?? settings.baseUrl,
        apiKey: resolveApiKey(state),
        body: (await buildModelBody(state, { question, additions, rendererVersion, images }, state.activeController?.signal)).body,
        signal: state.activeController?.signal,
      });
      if (exact.supported === true) {
        exactInput = exact.inputTokens;
        state.exactInputTokens = exactInput;
        occupancy = contextOccupancy({ anchor: { inputTokens: exactInput } });
        state.lastOccupancy = occupancy;
      } else if (exact.supported === false) {
        state.inputTokensUnsupported = true;
      }
    }
    const exceedsCapacity = (exactInput ?? estimatedInput) + RESERVE > budget.capacity;
    const pressure = exceedsCapacity || shouldCompact({ occupancyTokens: occupancy.tokens, capacityTokens: budget.capacity });
    // Give a replaceable history prefix a chance to shrink before rejecting
    // the pending question. A first oversized file has no such prefix.
    const history = compactionHistory(state);
    const range = selectCompactionRange({ items: history,
      retained: chooseRetainedTail({ items: history, capacityTokens: budget.capacity }).items });
    const needsCompaction = allowCompaction && pressure && range.balanced && range.items.length > 0;
    if (exceedsCapacity && !needsCompaction) {
      return {
        status: "capacity", blocked: true, exact: exactInput !== null,
        error: { code: "CAPACITY", message: "Context cannot fit with the answer reserve. Remove context files or use a new session with a larger context window." },
        price, occupancy, budget, contributors: largestContributors(additions, price),
      };
    }
    return { blocked: false, needsCompaction, price, occupancy, budget };
  }

  function largestContributors(additions, price) {
    return additions
      .map((mutation) => ({
        path: mutation.path,
        kind: mutation.kind,
        tokens: measureItems([mutation]),
      }))
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, 3)
      .map((entry) => ({ ...entry, estimated: true, total: price.total }));
  }

  // Compaction at a request boundary: select the older prefix, keep the recent
  // tail, prefer the official capability, and fall back to a structured
  // summary. Both paths share one durable bracket.
  // A manual request reserves the same session slot as sending, without
  // creating a user turn or reading/clearing the Composer's pending draft.
  async function compactNow(sessionId) {
    if (!isEnabled()) return { status: "disabled" };
    const state = stateFor(sessionId);
    if (state.editing || state.preparing || state.turn?.status === "running" || runningTurns() >= MAX_CONCURRENT_TURNS) return { status: "busy" };
    const validation = validateForSend(state);
    if (!validation.valid) return { status: "invalid", errors: validation.errors };
    const controller = createAbortController(environment.network);
    state.preparing = true;
    state.manualCompacting = true;
    state.requestEffort = reasoningEffort(sessionId);
    state.activeController = controller;
    state.task = (async () => {
      const result = await compactSession(state, { reason: "manual" });
      if (result.status === "committed") {
        await pricePendingRequest(state, { question: "", additions: [], allowCompaction: false });
      }
      return result;
    })();
    try { return await state.task; }
    finally {
      state.preparing = false;
      state.manualCompacting = false;
      state.activeController = null;
      pushProjection(state, { kind: "compaction-idle" });
    }
  }

  async function compactSession(state, { reason = "pressure" } = {}) {
    if (!isEnabled() || state.activeController?.signal.aborted) return { status: "aborted" };
    const budget = capacityBudget(state.config?.contextWindowTokens, { reserveTokens: RESERVE });
    const capacity = budget.configured ? budget.capacity : 0;
    // Tracked file references are reintroduced in stable first-added order
    // and are deliberately outside the retained-tail budget.
    const history = compactionHistory(state);
    const retained = chooseRetainedTail({ items: history, capacityTokens: capacity });
    const range = selectCompactionRange({ items: history, retained: retained.items });
    // Selection can move the split to preserve the newest turn. Retain exactly
    // its resulting suffix; the initial budget candidate may include the prefix.
    retained.items = history.slice(range.retainedFrom);
    // Durable ranges address the append-only canonical log across generations.
    // The checkpoint stands for its previously shadowed range; newer tail items
    // retain their canonical identities.
    range.to = Math.max(state.compactedSurface?.range?.to ?? -1,
      ...range.items.map(item => state.items.indexOf(item)));
    if (!range.balanced || range.items.length === 0) {
      return { status: "skipped", reason: "range" };
    }
    const transaction = new CompactionTransaction({ sessionStore, sessionId: state.sessionId });
    const estimatedBefore = measureItems(state.contextProjection.items(range.items));
    const mode = officialSupported(state) ? "official" : "fallback";
    await transaction.start({
      range,
      mode,
      trigger: reason,
      shadowedIds: state.items.slice(range.from, range.to + 1).map((_item, index) => `item-${index}`),
      estimatedBefore,
      provider: state.config?.baseUrl ?? null,
      model: state.config?.model ?? null,
    });
    pushProjection(state, { kind: "compaction", status: "running", reason });

    if (mode === "official") {
      const result = await requestOfficialCompaction({
        network: environment.network,
        baseUrl: state.config?.baseUrl,
        apiKey: resolveApiKey(state),
        body: { model: state.config?.model, input: (await materializeToolImages(state,
          state.contextProjection.items(range.items), { signal: state.activeController?.signal ?? state.turn?.controller?.signal })).items },
        signal: state.activeController?.signal ?? state.turn?.controller?.signal,
      });
      if (result.supported === false) {
        state.officialUnsupported = true;
        await transaction.fail({ code: "UNSUPPORTED", message: "the endpoint does not support /responses/compact" });
        return await compactSession(state, { reason });
      }
      if (result.supported !== true) {
        await transaction.fail(result.error ?? { code: "SERVER", message: "compaction request failed" });
        pushProjection(state, { kind: "compaction", status: "failed", reason });
        return { status: "failed", reason: "provider" };
      }
      // Opaque output items are preserved exactly as transport state.
      const checkpoint = { providerOutput: result.output };
      const estimatedAfter = measureItems(result.output ?? []);
      const committed = await transaction.commit({ checkpoint, estimatedAfter, usage: result.usage, providerOutput: result.output });
      if (committed.status !== "committed") {
        pushProjection(state, { kind: "compaction", status: "failed", reason: "no-shrink" });
        return committed;
      }
      if (result.usage) state.sessionUsage.addTurn(compactionUsage(result.usage));
      applyCompactedSurface(state, committed.checkpoint, retained);
      pushProjection(state, {
        kind: "compaction", status: "committed", reason, usage: result.usage,
        items: range.items.length, before: committed.checkpoint.estimatedBefore, after: committed.checkpoint.estimatedAfter,
      });
      return committed;
    }

    const summary = await requestFallbackSummary(state, range);
    if (!summary.ok) {
      await transaction.fail(summary.error ?? { code: "SERVER", message: "summarization failed" });
      pushProjection(state, { kind: "compaction", status: "failed", reason });
      return { status: "failed", reason: "summary" };
    }
    const committed = await transaction.commit({
      checkpoint: { framed: summary.framed },
      // The shrink gate compares what the checkpoint replaces: the selected
      // older prefix on one side, the framed checkpoint on the other.
      estimatedAfter: measureText(summary.framed),
      usage: summary.usage ?? null,
    });
    if (committed.status !== "committed") {
      pushProjection(state, { kind: "compaction", status: "failed", reason: "no-shrink" });
      return committed;
    }
    if (summary.usage) state.sessionUsage.addTurn(compactionUsage(summary.usage));
    applyCompactedSurface(state, committed.checkpoint, retained);
    pushProjection(state, {
      kind: "compaction", status: "committed", reason,
      items: range.items.length, before: committed.checkpoint.estimatedBefore, after: committed.checkpoint.estimatedAfter,
    });
    return committed;
  }

  function officialSupported(state) {
    if (!protocolFor(state.config).remoteCompaction || state.officialUnsupported) return false;
    const cached = state.officialCapability;
    const key = `${state.config?.baseUrl ?? ""}|${state.config?.model ?? ""}`;
    if (cached && cached.key === key) return cached.supported;
    return true;
  }

  // The fallback summary request reproduces the session's byte-stable
  // instructions, tool definition, and leading items, then appends the
  // instruction as the final user item.
  async function requestFallbackSummary(state, range) {
    const allowlist = typeof trackerFor(state.sessionId).allowlist === "function" ? trackerFor(state.sessionId).allowlist() : [];
    // An earlier fallback checkpoint in the selected range is consolidated.
    const hasEarlierCheckpoint = range.items.some((item) => messageText(item).includes("<compacted-summary>"));
    const instruction = buildSummaryInstruction({ hasEarlierCheckpoint });
    const summaryItems = [
      ...state.contextProjection.items(range.items).map(item => {
        if (!isToolOutput(item)) return item;
        const truncated = truncateOutput(item, truncateToolResult);
        state.imageToolResults.copy(item, truncated);
        return truncated;
      }),
      protocolFor(state.config).userMessage(instruction),
    ];
    const { items: input } = await materializeToolImages(state, summaryItems,
      { signal: state.activeController?.signal ?? state.turn?.controller?.signal });
    const result = await streamAttempt({
      protocol: protocolFor(state.config),
      network: environment.network,
      scheduler: environment.scheduler,
      baseUrl: state.config?.baseUrl ?? normalizeQuickAskSettings(getSettings()?.quickAsk).baseUrl,
      body: protocolFor(state.config).buildRequestBody({
        reasoningEffort: state.requestEffort ?? reasoningEffort(state.sessionId),
        instructions: buildInstructions({ rendererVersion: RENDERER_VERSION, customSystemPrompt: state.config?.systemPrompt ?? "" }),
        input,
        tools: [protocolFor(state.config).functionTool(getFullFileTool())],
        toolChoice: "none",
        parallelToolCalls: false,
        previousResponseId: null,
        store: state.storedState,
        model: state.config?.model ?? normalizeQuickAskSettings(getSettings()?.quickAsk).model,
        // The fallback summary output cap is fixed and never a setting.
        maxOutputTokens: 8192,
      }),
      apiKey: resolveApiKey(state),
      signal: state.activeController?.signal ?? state.turn?.controller?.signal,
      policy,
      nonStreaming: state.nonStreaming,
      onEvent: () => {},
    });
    if (result.status !== "completed") return { ok: false, error: result.error };
    const text = (result.text ?? "").trim();
    if (text.length === 0) return { ok: false, error: { code: "EMPTY_RESPONSE", message: "the summarizer returned no text" } };
    // The summary output cap is fixed and never exposed as a setting.
    const framed = frameSummary(text, { allowlist });
    if (measureText(framed) > 8192) return { ok: false, error: { code: "PROTOCOL", message: "the summary exceeded its output cap" } };
    return { ok: true, framed, usage: result.usage ?? null };
  }

  // The compacted surface starts from the checkpoint output plus the retained
  // recent tail; still-tracked paths are reintroduced by the renderer.
  function applyCompactedSurface(state, checkpoint, retained) {
    state.compactedSurface = checkpoint;
    // Only the retained tail lives here: the checkpoint output is already
    // carried by the surface, so including it again would duplicate it.
    state.compactedItems = [...retained.items];
    // A successful compaction is an explicit prefix discontinuity and resets
    // the exact occupancy anchor.
    state.occupancyAnchor = null;
  }

  function recordUsage(state, samples) {
    if (!Array.isArray(samples)) return;
    const attemptId = `attempt-${state.usage.attempts() + 1}`;
    for (const sample of samples) {
      sample.attemptId ??= attemptId;
      state.usage.record(sample, { attemptId: sample.attemptId });
      (state.usageSamples ??= []).push({ source: sample.source, usage: sample.usage, attemptId: sample.attemptId, ...(sample.scope ? { scope: sample.scope } : {}) });
      const inputTokens = sample.usage?.prompt_tokens ?? responsesUsageInputTokens(sample.usage);
      if (sample.scope !== 'search' && sample.usage && Number.isFinite(inputTokens) && !state.turn?.imagePaths?.length && !state.turn?.hadToolImages) {
        state.occupancyAnchor = { inputTokens };
      }
    }
    if (state.turn?.imagePaths?.length || state.turn?.hadToolImages) state.occupancyAnchor = null;
  }

  function pushProjection(state, projection) {
    publishers.get(state.sessionId)?.push(projection);
  }

  // One user turn: durable pending state, then the streamed attempt.
  async function send(sessionId, question, { signal = null, additions = null, webSearch = undefined, webSearchRevision = undefined, reasoning = undefined, rendererVersion = RENDERER_VERSION, images = [], editDraft = null } = {}) {
    const state = stateFor(sessionId);
    // All asynchronous phases resolve only their owning session's tracker.
    if (!isEnabled()) return { status: "disabled" };
    if (state.reloadRequired) return { status: "failed", accepted: false, error: { code: "SESSION_RELOAD", message: "Reload this conversation before sending." } };
    if (state.editing || state.preparing || (state.turn && state.turn.status === "running")) {
      return { status: "busy", error: normalizeError({ kind: "protocol", message: "This session already has a running turn" }) };
    }
    if (runningTurns() >= MAX_CONCURRENT_TURNS) {
      return { status: "busy", error: normalizeError({ kind: "protocol", message: "Three Quick Ask turns are already running" }) };
    }
    // Known historical versions remain readable; actual sends (including
    // retries) use the current renderer as explicitly requested by the user.
    if (!Number.isInteger(rendererVersion) || rendererVersion < 1 || rendererVersion > RENDERER_VERSION) return { status: "failed", accepted: false,
      error: { code: "RENDERER", message: `Unsupported Quick Ask renderer version: ${rendererVersion}. Update the plugin or submit a new question.` } };
    // Explicit user decision: retries also adopt current rules/position units.
    rendererVersion = RENDERER_VERSION;
    const validation = validateForSend(state);
    if (!validation.valid) return { status: "invalid", errors: validation.errors };

    const effort = normalizeReasoningEffort(reasoning ?? reasoningEffort(sessionId));
    state.requestEffort = effort;
    const searchRevision = webSearchRevision ?? state.searchRevision ?? 0;
    const searchSettings = normalizeSearchSettings(getSettings()?.quickAsk?.webSearch);
    const enabled = typeof webSearch === "boolean" ? webSearch : searchEnabled(sessionId);
    const searchValidation = validateSearchForSend(sessionId, enabled);
    if (!searchValidation.valid) return { status: "invalid", errors: searchValidation.errors };
    const selectedSearch = searchValidation.route;
    state.requestSearch = selectedSearch;
    pushProjection(state, { kind: "search-route", route: selectedSearch.kind, provider: selectedSearch.provider });

    // Reserve the session before the first read or preflight await. Every
    // network phase shares the same abort lifetime, including compaction.
    const controller = signal?.abort ? signal : createAbortController(environment.network);
    const externalSignal = signal?.abort ? null : signal;
    const abort = () => controller.abort();
    externalSignal?.addEventListener?.("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    state.preparing = true;
    state.activeController = controller;
    const prepareAndRun = async () => {
      let paths, preparedImages;
      try {
        paths = normalizeImagePaths(images);
        preparedImages = paths.length ? await environment.images.readForSend(paths) : [];
      } catch (error) {
        return { status: "failed", accepted: false, error: { code: error.code ?? "IMAGE_MISSING", path: error.path, message: error.message } };
      }
      const capturedAdditions = additions ?? (typeof trackerFor(sessionId).mutationsForSend === "function"
        ? await trackerFor(sessionId).mutationsForSend() : []);
      const selectionSources = new Map();
      for (const mutation of capturedAdditions) {
        if (mutation.kind !== 'selection' || Number.isInteger(mutation.startUnit) || selectionSources.has(mutation.path)) continue;
        try { selectionSources.set(mutation.path, await environment.vault?.readText?.(mutation.path)); }
        catch { selectionSources.set(mutation.path, null); }
      }
      const stagedAdditions = withSelectionUnits(capturedAdditions, path => selectionSources.get(path));
      if (controller.signal.aborted || !isEnabled()) return { status: "disabled" };
      const preflight = await pricePendingRequest(state, { question, additions: stagedAdditions, rendererVersion, images: preparedImages });
      if (controller.signal.aborted || !isEnabled()) return { status: "disabled" };
      if (preflight.blocked) return preflight;
      const turnId = `turn-${environment.scheduler.now?.() ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      state.usage = createTurnUsage();
      state.usageSamples = [];
      state.pendingMutations = stagedAdditions;
      const turn = { turnId, config: { ...state.config }, editDraft, processVersion: PROCESS_VERSION, process: createTurnProcess(), question, imagePaths: paths, images: preparedImages, additions: stagedAdditions, status: "running", text: "", reasoning: "", responseId: null, controller, searchSources: [], searchStatuses: [], searchSettings, searchEnabled: enabled, reasoningEffort: effort, rendererVersion };
      state.turn = turn;
      state.contextProjection.beginTurn(stagedAdditions, rendererVersion);
      state.editableTurn = await sessionStore.append(sessionId, "turn/started", { turnId, config: { ...state.config }, ...(recoverableDraft(editDraft) ? { editDraft } : {}), processVersion: PROCESS_VERSION, question, ...(paths.length ? { images: paths } : {}), additions: stagedAdditions, webSearch: enabled, searchExecution: selectedSearch.kind === 'provider-search' ? 'independent' : 'mixed', nextSearchEnabled: searchSettings.defaultEnabled ? enabled : false, reasoningEffort: effort, rendererVersion });
      // Read the current toggle here so a manual change made during preflight
      // cannot be overwritten by consuming this question's one-shot permission.
      if ((state.searchRevision ?? 0) === searchRevision) {
        if (!searchSettings.defaultEnabled && enabled) await setSearchEnabled(sessionId, false);
        state.searchDirty = false;
      }
      if (reasoningEffort(sessionId) === effort) state.reasoningDirty = false;
      pushProjection(state, { kind: "turn", status: "running", turnId });
      const parsed = await sessionStore.readLog(sessionId);
      if (!parsed.title && sessionStore.rename) {
        const title = deriveTitle(question);
        await sessionStore.rename(sessionId, title);
        pushProjection(state, { kind: "title", title });
      }
      if (preflight.needsCompaction) {
        const compaction = await compactSession(state, { reason: "pressure" });
        if (compaction.status !== "committed") {
          return await finishTurn(state, turn, "failed", { error: compaction.error ?? {
            code: "COMPACTION",
            message: "Context compaction did not complete. Retry this question.",
          } });
        }
        // Include the checkpoint, file references AND the pending question
        // and additions. Never send an oversized request after shrinking history.
        const after = await pricePendingRequest(state, { question, additions: stagedAdditions, rendererVersion, allowCompaction: false, images: preparedImages });
        if (controller.signal.aborted || !isEnabled()) return await finishTurn(state, turn, "stopped");
        if (after.blocked) return await finishTurn(state, turn, "failed", { error: after.error });
      }
      return await runAttempt(state, turn, controller.signal);
    };
    state.task = prepareAndRun();
    try {
      return await state.task;
    } finally {
      state.preparing = false;
      state.activeController = null;
      externalSignal?.removeEventListener?.("abort", abort);
      if (state.turn?.controller === controller) {
        state.turn.controller = null;
        if (state.turn.status === "running") state.turn.status = "interrupted";
      }
      if (state.turn?.status === 'interrupted') await settleToolActivities(state, state.turn, 'interrupted');
    }
  }

  async function runAttempt(state, turn, signal) {
    const sessionId = state.sessionId;
    let retryAfterNonStreaming = state.nonStreaming;
    for (;;) {
      if (!isEnabled() || signal?.aborted) return await finishTurn(state, turn, "stopped", { text: turn.text });
      let body;
      try {
        const projected = await buildModelBody(state, turn, signal);
        body = projected.body;
        if (projected.hasImages) turn.hadToolImages = true;
      }
      catch (error) { return await finishTurn(state, turn, "failed", { error: normalizeError(error) }); }
      if (signal?.aborted || !isEnabled()) return await finishTurn(state, turn, 'stopped', { text: turn.text });
      const result = await streamAttempt({
        protocol: state.requestSearch?.native ? geminiSearchWire : protocolFor(state.config),
        network: environment.network,
        scheduler: environment.scheduler,
        baseUrl: (state.config?.baseUrl ?? normalizeQuickAskSettings(getSettings()?.quickAsk).baseUrl),
        body,
        apiKey: resolveApiKey(state),
        signal,
        idleTimeoutMs,
        policy,
        nonStreaming: state.requestSearch?.native || retryAfterNonStreaming,
        onEvent: (event) => handleStreamEvent(state, turn, event),
      });

      // Some non-streaming adapters expose readable content only on completion.
      if (turn.process && !turn.attemptHadReasoning && result.reasoning) {
        turn.process.append("reasoning", result.reasoning); turn.reasoning += result.reasoning;
      }
      if (turn.process && !turn.attemptHadText && result.text) {
        turn.process.append("text", result.text); turn.text += result.text;
      }
      turn.process?.boundary();
      saveProcess(state, turn, true);
      turn.attemptHadReasoning = false; turn.attemptHadText = false;

      if (result.output) {
        turn.searchSources = normalizeSources([...turn.searchSources, ...responseSources(result.output)]);
        turn.searchSuggestions = [...new Set([...(turn.searchSuggestions ?? []), ...responseSuggestions(result.output)])];
        const queries = result.output.filter(isResponsesWebSearchCall).flatMap(item => item.action?.queries ?? (item.action?.query ? [item.action.query] : []));
        turn.serverSearchQueries = [...new Set([...(turn.serverSearchQueries ?? []), ...queries].filter(query => typeof query === 'string'))];
      }

      // The endpoint demonstrably needed the non-streaming transport; remember
      // it for the rest of the plugin lifecycle.
      if (result.nonStreaming && !state.requestSearch?.native) {
        state.nonStreaming = true;
        retryAfterNonStreaming = true;
      }
      if (result.status === "aborted") {
        return await finishTurn(state, turn, "stopped", { text: result.text || turn.text, error: result.error, usage: result.usageSamples, reasoning: turn.reasoning || result.reasoning || "", output: result.output });
      }
      // Without a configured capacity, a provider-reported context-window
      // overflow is the only pressure signal. Switch this turn to the
      // non-streaming transport so the transport's pre-event retry budget
      // carries the unchanged request once more; a repeated overflow leaves
      // the question retryable rather than looping.
      if (result.error?.code === "CONTEXT_OVERFLOW" && !result.nonStreaming && !state.overflowTransportTried) {
        state.overflowTransportTried = true;
        retryAfterNonStreaming = true;
        continue;
      }
      if (result.status === "completed" || result.status === "incomplete") {
        if (result.status === "completed" && Array.isArray(result.functionCalls) && result.functionCalls.length > 0) {
          const continued = await runToolContinuation(state, turn, result, signal, retryAfterNonStreaming);
          if (continued) return continued;
        }
        return await finishTurn(state, turn, result.status === "completed" ? "complete" : "incomplete", {
          text: result.text ?? turn.text,
          reasoning: turn.reasoning || result.reasoning || "",
          output: result.output,
          usage: result.usageSamples,
        });
      }

      const error = result.error ?? normalizeError({ kind: "transport", message: "attempt failed" });
      // An explicit protocol result is the only capability evidence: the
      // endpoint rejected the stored Response or refused to honor server-side
      // state. The session durably switches to local replay and continues
      // without a new session; auth, limits, timeouts, and network failures are
      // never capability evidence.
      if (state.storedState && !result.accepted && !state.storedStateSwitched && isResponsesStateUnsupported(error)) {
        state.storedStateSwitched = true;
        applyStateFallback(state.sessionId);
        pushProjection(state, { kind: "state-mode", mode: "local-replay" });
        return await runAttempt(state, turn, signal);
      }
      // Without a configured capacity, a provider-reported context-window
      // overflow is the only signal: compact once, then retry the unchanged
      // request exactly once. A second overflow keeps the question retryable.
      const capacityConfigured = capacityBudget(
        state.config?.contextWindowTokens ?? normalizeQuickAskSettings(getSettings()?.quickAsk).contextWindowTokens,
      ).configured;
      if (error.code === "CONTEXT_OVERFLOW" && !capacityConfigured && !state.overflowRecoveryDone) {
        state.overflowRecoveryDone = true;
        const compaction = await compactSession(state, { reason: "overflow" });
        if (compaction.status === "committed") {
          return await runAttempt(state, turn, signal);
        }
        return await finishTurn(state, turn, "failed", { text: turn.text, error, retryable: true });
      }
      if (!result.accepted) {
        // Never accepted by the endpoint: the prior observed/transmitted state
        // stands and the turn stays explicitly retryable.
        return await finishTurn(state, turn, "failed", { text: turn.text, error, retryable: true });
      }
      // An accepted attempt that did not finish keeps its partial output and
      // never resubmits, so Context is not accepted twice.
      return await finishTurn(state, turn, "failed", { text: result.text || turn.text, error, retryable: true, usage: result.usageSamples, reasoning: turn.reasoning || result.reasoning || "", output: result.output });
    }
  }

  // Execute the requested read-only calls, append their canonical items, and
  // continue the same turn. Tool calls, outputs, and the refreshed baselines
  // are append-only additions; nothing earlier is rewritten.
  async function runToolContinuation(state, turn, result, signal, nonStreaming) {
    if ((!turn.question && !turn.imagePaths?.length) || !isEnabled()) return null;
    await acceptQueue;
    const ownToolLoop = createToolLoop({ executor: toolExecutor, tracker: trackerFor(state.sessionId), config: { ...state.config, rendererVersion: turn.rendererVersion ?? RENDERER_VERSION } });
    const question = turn.toolQuestion ?? (turn.toolQuestion = ownToolLoop.beginQuestion({
      allowlist: typeof trackerFor(state.sessionId).allowlist === "function" ? trackerFor(state.sessionId).allowlist() : [],
      imageAllowlist: [...state.authorizedImagePaths],
    }));
    // The transport reports completed calls on the attempt result; each one
    // carries its raw argument JSON so the canonical item stays byte-faithful.
    const calls = (Array.isArray(result.functionCalls) ? result.functionCalls : [])
      .filter((call) => protocolFor(state.config).answersEveryToolCall || TOOL_NAMES.includes(call?.name))
      .map((call) => ({
        id: call.id ?? null,
        callId: call.callId ?? null,
        name: call.name,
        arguments: parseToolArguments(call.arguments),
        rawArguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
      }));
    if (calls.length === 0) return null;
    const batchId = `local-${turn.toolRounds ?? 0}`;
    const activity = (call, index) => ({ turnId: turn.turnId, batchId,
      callId: call.callId ?? `${batchId}-${index}`, name: call.name, arguments: toolParameters(call.arguments),
      ...(call.name === 'web_search' ? { provider: state.requestSearch?.provider } : {}) });
    const { items, results } = await ownToolLoop.runBatch(calls, question, {
      onCallQueued: (call, index) => TOOL_NAMES.includes(call.name) ? recordToolActivity(state, { ...activity(call, index), status: 'queued' }) : undefined,
      onCallStart: (call, index) => TOOL_NAMES.includes(call.name) ? recordToolActivity(state, { ...activity(call, index), status: 'running' }) : undefined,
      onCallEnd: (call, index, value) => TOOL_NAMES.includes(call.name) ? recordToolActivity(state, { ...activity(call, index),
        status: value.ok ? 'complete' : signal?.aborted ? 'cancelled' : 'failed', summary: toolSummary(call.name, value) }) : undefined,
      normalizePath: (path) => environment.vault.normalizePath(path),
      fitsInContext: (path) => getContextBudget(path, state.sessionId) !== false,
      signal,
      search: turn.searchEnabled && state.requestSearch?.kind !== "off" ? async query => {
        let route = state.requestSearch;
        pushProjection(state, { kind: "search-status", status: "running", provider: route.provider });
        let result;
        if (route.kind === 'provider-search') {
          const child = await runProviderSearch(query, { environment, config: state.config, route, apiKey: resolveApiKey(state),
            signal, policy, idleTimeoutMs });
          const { usageSamples = [], ...evidence } = child;
          result = evidence;
          const samples = usageSamples.map(sample => ({ ...sample, scope: 'search' }));
          recordUsage(state, samples);
          for (const sample of samples) await sessionStore.append(state.sessionId, 'turn/usage', sample);
        } else result = await searchClient.search(query, route, { signal, config: state.config });
        turn.searchSources = normalizeSources([...turn.searchSources, ...(result.sources ?? [])]);
        const status = { status: result.ok ? "complete" : "failed", provider: route.provider, code: result.code ?? null };
        turn.searchStatuses.push(status);
        await sessionStore.append(state.sessionId, "search/result", { turnId: turn.turnId, query, ...status, sources: result.sources ?? [] });
        pushProjection(state, { kind: "search-status", ...status });
        return result;
      } : null,
    });
    const providerOutput = Array.isArray(result.output) ? result.output : [];
    const imageReferences = new Map(calls.map((call, index) => [call.callId, results[index]?.imagePaths]));
    const providerCallIds = new Set(providerOutput.filter(isResponsesFunctionCall).map(item => item.call_id));
    const canonical = [...providerOutput, ...items.filter(item => !isResponsesFunctionCall(item) || !providerCallIds.has(item.call_id))];
    for (const item of canonical) {
      const images = isToolOutput(item) ? imageReferences.get(toolOutputId(item)) : null;
      if (images?.length) {
        state.imageToolResults.remember(item, images);
        rememberImages(state, images);
      }
      appendCanonicalItem(state, item);
      await sessionStore.append(state.sessionId, "item/output", { item, tool: true, ...(images?.length ? { imagePaths: images } : {}) });
      pushProjection(state, { kind: "tool", item, turnId: turn.turnId });
    }
    recordUsage(state, result.usageSamples);
    for (const status of question.statuses) {
      pushProjection(state, { kind: "tool-status", turnId: turn.turnId, status });
    }
    if (signal?.aborted) return await finishTurn(state, turn, "stopped", { text: turn.text });
    // The continuation request carries only the new tool items while server
    // state is supported, and the rebuilt history otherwise.
    turn.toolContinuation = items;
    turn.toolRounds = (turn.toolRounds ?? 0) + 1;
    turn.continuation = true;
    return await runAttempt(state, turn, signal);
  }

  function saveProcess(state, turn, final = false) {
    const steps = turn.process?.drain(final) ?? [];
    if (!steps.length) return;
    state.toolDisplayQueue = (state.toolDisplayQueue ?? Promise.resolve()).then(async () => {
      await acceptQueue;
      await sessionStore.append(state.sessionId, 'turn/process', { turnId: turn.turnId, version: PROCESS_VERSION, steps });
    }).catch(() => { console.warn('Quick Ask could not save process presentation metadata.'); });
  }

  function processProjection(turn) {
    return turn.process ? { process: turn.process.steps, processVersion: PROCESS_VERSION } : {};
  }

  // Display metadata cannot change tool output, permission or model replay.
  function recordToolActivity(state, activity) {
    const turn = state.turn;
    if (turn?.process && activity.turnId === turn.turnId) {
      turn.process.tool(`${activity.turnId}:${activity.batchId}`, activity.callId);
      saveProcess(state, turn);
    }
    const updated = updateToolGroups(state.toolGroups ?? [], activity);
    state.toolGroups = updated.groups;
    pushProjection(state, { kind: 'tool-activity', group: updated.group, turnId: turn?.turnId, ...processProjection(turn ?? {}) });
    state.toolDisplayQueue = (state.toolDisplayQueue ?? Promise.resolve()).then(async () => {
      await acceptQueue;
      await sessionStore.append(state.sessionId, ['queued', 'running'].includes(activity.status) ? 'turn/tool-started' : 'turn/tool-finished', activity);
    }).catch(() => { console.warn('Quick Ask could not save tool presentation metadata.'); });
    return state.toolDisplayQueue;
  }

  async function settleToolActivities(state, turn, status) {
    for (const group of state.toolGroups ?? []) {
      if (group.turnId !== turn.turnId) continue;
      for (const call of group.calls) if (['queued', 'running'].includes(call.status)) {
        await recordToolActivity(state, { ...call, turnId: turn.turnId,
          batchId: group.id.slice(`${turn.turnId}:`.length), status });
      }
    }
  }

  function handleStreamEvent(state, turn, event) {
    if (!event || typeof event !== "object") return;
    switch (event.type) {
      case "search-progress":
        if (!turn.serverSearchStarted) {
          turn.serverSearchStarted = true;
          void recordToolActivity(state, { turnId: turn.turnId, batchId: 'server', callId: 'server-search',
            name: 'web_search', server: true, provider: state.requestSearch?.provider, arguments: {}, status: 'running' });
        }
        pushProjection(state, { kind: "search-status", status: "running", provider: state.requestSearch?.provider });
        break;
      case "created":
        turn.responseId = event.responseId ?? turn.responseId;
        // `response.created` is the acceptance checkpoint: it is what moves
        // staged Context into canonical Context and starts tracking.
        void acceptAccepted(state, turn);
        break;
      case "text-delta":
        turn.attemptHadText = true;
        if (turn.process?.append("text", event.delta ?? "")) saveProcess(state, turn);
        turn.text += event.delta ?? "";
        pushProjection(state, { kind: "text", turnId: turn.turnId, text: turn.text, ...processProjection(turn) });
        break;
      case "reasoning-summary-delta":
      case "reasoning-text-delta":
        turn.attemptHadReasoning = true;
        if (turn.process?.append("reasoning", event.delta ?? "")) saveProcess(state, turn);
        turn.reasoning += event.delta ?? "";
        pushProjection(state, { kind: "reasoning", turnId: turn.turnId, text: turn.reasoning, ...processProjection(turn) });
        break;
      default:
        pushProjection(state, { kind: "stream", turnId: turn.turnId, event });
        break;
    }
  }

  let acceptQueue = Promise.resolve();
  function acceptAccepted(state, turn) {
    if (turn.accepted) return acceptQueue;
    turn.accepted = true;
    // The response id is the durable transport handle the next request chains
    // from while the endpoint supports server-side state.
    if (turn.responseId) state.lastResponseId = turn.responseId;
    acceptQueue = acceptQueue.then(async () => {
      await sessionStore.append(state.sessionId, "turn/response-created", {
        turnId: turn.turnId, responseId: turn.responseId ?? null, stored: state.storedState,
      });
      // The endpoint accepted this turn, so the exact mutations it carried
      // become canonical Context and tracking begins.
      trackerFor(state.sessionId).acceptTurn(state.pendingMutations ?? undefined);
      await sessionStore.append(state.sessionId, "turn/accepted", { turnId: turn.turnId });
      // Accepted input precedes every assistant output, including after a
      // restart. Persist the original request exactly once at its checkpoint.
      const rendered = renderTurn({ mutations: turn.additions, question: turn.question, userMessage: protocolFor(state.config).userMessage, rendererVersion: turn.rendererVersion ?? RENDERER_VERSION });
      for (const item of rendered) {
        const isQuestion = item === rendered[rendered.length - 1];
        if (!isQuestion || turn.question || !turn.imagePaths?.length) appendCanonicalItem(state, item);
      }
      await sessionStore.append(state.sessionId, "item/input", { items: rendered,
        ...(turn.imagePaths?.length ? { images: turn.imagePaths } : {}) });
      rememberImages(state, turn.imagePaths);
      pushProjection(state, { kind: "accepted", turnId: turn.turnId });
    }).catch(() => {});
    return acceptQueue;
  }

  async function finishTurn(state, turn, status, { text = "", reasoning = turn.reasoning ?? "", error = null, output = null, usage = null } = {}) {
    await acceptQueue;
    const hint = mixedSearchErrorHint(error, state.requestSearch);
    if (hint) error = { ...error, hint };
    if (turn.serverSearchStarted || output?.some(isResponsesWebSearchCall)) {
      const searchStatus = { status: status === "complete" ? "complete" : "failed", provider: state.requestSearch?.provider, code: status === "complete" ? null : status };
      turn.searchStatuses ??= []; turn.searchStatuses.push(searchStatus);
      pushProjection(state, { kind: "search-status", ...searchStatus });
      const queries = turn.serverSearchQueries ?? [];
      const nativeCalls = (output ?? []).filter(isResponsesWebSearchCall);
      const searchState = nativeCalls.some(call => call.status === 'failed') ? 'failed'
        : ((nativeCalls.length && nativeCalls.every(call => call.status === 'completed')) || status === 'complete') ? 'complete'
          : status === 'stopped' ? 'cancelled' : 'interrupted';
      await recordToolActivity(state, { turnId: turn.turnId, batchId: 'server', callId: 'server-search',
        name: 'web_search', server: true, provider: state.requestSearch?.provider,
        arguments: queries.length ? { query: queries.join('\n') } : {},
        status: searchState,
        summary: { sources: sourceSummary(turn.searchSources ?? []) } });
    }
    await settleToolActivities(state, turn, status === 'stopped' ? 'cancelled' : 'interrupted');
    saveProcess(state, turn, true);
    await state.toolDisplayQueue;
    const canonical = Array.isArray(output) && output.length > 0 ? output : text.length > 0 || reasoning.length > 0
      ? [protocolFor(state.config).assistantMessage(text)]
      : [];
    if (protocolFor(state.config).answersEveryToolCall) {
      // Keep every native call in the log, with an explicit non-execution result
      // if the model did not finish a usable tool batch. This also keeps the
      // next local replay valid after a length/content-filter termination.
      const unfinishedCalls = canonical.flatMap(callsFromItem);
      canonical.push(...protocolFor(state.config).toolContinuationItems({
        calls: unfinishedCalls,
        outputs: unfinishedCalls.map(() => "Tool call not executed because the response did not complete a tool request."),
      }));
    }
    if (canonical.length > 0) {
      for (const item of canonical) {
        appendCanonicalItem(state, item);
        await sessionStore.append(state.sessionId, "item/output", { item });
        pushProjection(state, { kind: "output", item, turnId: turn.turnId });
      }
    }
    if (Array.isArray(usage)) {
      recordUsage(state, usage);
    }
    const turnTotals = state.usage.totals();
    state.sessionUsage.addTurn(turnTotals);
    pushProjection(state, { kind: "usage", turnId: turn.turnId, turn: turnTotals, session: state.sessionUsage.total() });
    if (!turn.accepted) trackerFor(state.sessionId).rejectTurn();
    await sessionStore.append(state.sessionId, "turn/finished", {
      turnId: turn.turnId,
      config: turn.config ?? state.config,
      state: status,
      usageSamples: state.usageSamples ?? [],
      occupancyAnchor: state.occupancyAnchor,
      text,
      reasoning,
      error: error ? { code: error.code, message: error.message, status: error.status ?? null, ...(error.hint ? { hint: error.hint } : {}) } : null,
      sources: turn.searchSources ?? [], searchSuggestions: turn.searchSuggestions ?? [], searchStatuses: turn.searchStatuses ?? [], displayText: citedAnswer(text, output ?? []),
    });
    turn.status = status;
    turn.text = text;
    turn.reasoning = reasoning;
    turn.error = error;
    turn.controller = null;
    turn.images = [];
    pushProjection(state, { kind: "turn", status, turnId: turn.turnId, answerText: text, error, ...processProjection(turn) });
    return { status, text, reasoning, error, ...processProjection(turn), turnId: turn.turnId, sources: turn.searchSources ?? [], searchSuggestions: turn.searchSuggestions ?? [], searchStatuses: turn.searchStatuses ?? [], displayText: citedAnswer(text, output ?? []), accepted: turn.accepted === true, responseId: turn.responseId, retryable: Boolean(error) };
  }

  // Stop aborts only the owning session's current turn and commits whatever
  // partial answer arrived as a stopped response.
  async function stop(sessionId) {
    const state = sessionStores.get(sessionId)?.getState().state;
    if (!state?.activeController && state?.turn?.status !== "running") return false;
    state.activeController?.abort?.();
    state.turn?.controller?.abort?.();
    return true;
  }

  // Restart recovery. A pending turn with a recoverable stored Response is
  // retrieved; everything else becomes interrupted and requires explicit retry.
  async function recover(sessionId, { retrieve = null } = {}) {
    const { state, parsed } = await load(sessionId);
    if (state.activeController || state.turn?.controller) return { status: "running" };
    // A compaction bracket that never closed means the transaction died. Its
    // replacement body is discarded, the bracket is closed with an interrupted
    // marker, and the interrupted compaction is never re-run automatically.
    const compacted = await closeInterruptedCompaction(sessionId, parsed.records ?? []);
    const pending = parsed.records?.findLast?.((record) => record.kind === "turn/started");
    const finished = (parsed.records ?? []).some((record) =>
      record.kind === "turn/finished" && record.payload?.turnId === pending?.payload?.turnId);
    if (!pending || finished) {
      if (!compacted.interrupted) return { status: "clean" };
      // The pending turn survived a crash during compaction. Its question and
      // Context additions are still staged and explicitly retryable, and the
      // compaction is never re-run automatically.
      trackerFor(state.sessionId).rejectTurn();
      pushProjection(state, { kind: "compaction", status: "interrupted", reason: "replay" });
      return { status: "interrupted", compactionInterrupted: true, retryable: true };
    }
    const responseRecord = (parsed.records ?? []).find((record) =>
      record.kind === "turn/response-created" && record.payload?.turnId === pending.payload.turnId)?.payload;
    const responseId = responseRecord?.responseId ?? null;
    // Older releases stored Responses remotely. Recovery of those historical
    // runs remains possible, independently of how new requests carry history.
    if (protocolFor(state.config).storedResponses && responseRecord?.stored !== false && responseId && typeof retrieve === "function") {
      const recovered = await retrieve(responseId);
      if (recovered?.status === "completed") {
        return await finishTurn(state, state.turn, "complete", { text: recovered.text ?? "", output: recovered.output });
      }
      if (recovered?.status === "in_progress") {
        return { status: "resumable", responseId };
      }
    }
    // No recoverable remote state: mark interrupted and offer explicit retry.
    await sessionStore.append(sessionId, "turn/finished", {
      turnId: pending.payload.turnId,
      state: "interrupted",
      text: "",
      error: { code: "INTERRUPTED", message: "The turn was interrupted before it finished" },
    });
    trackerFor(state.sessionId).rejectTurn();
    state.turn = { ...state.turn, status: "interrupted" };
    pushProjection(state, { kind: "turn", status: "interrupted", turnId: pending.payload.turnId });
    return { status: "interrupted" };
  }

  // Replay-time repair for a durable compaction bracket: an unmatched start is
  // closed once with an interrupted marker so no later replay can read it as a
  // completed replacement.
  async function closeInterruptedCompaction(sessionId, records) {
    const replay = replayCompactionSurface(records);
    if (!replay.interrupted) return { interrupted: false };
    for (const interruption of replay.interruptions) {
      if (interruption.endSeq !== null) continue;
      await sessionStore.append(sessionId, "compaction/end", {
        ok: false,
        interrupted: true,
        error: { code: "INTERRUPTED", message: "the compaction transaction was interrupted" },
        range: null,
      });
    }
    return { interrupted: true };
  }

  function snapshot(sessionId) {
    const state = sessionStores.get(sessionId)?.getState().state;
    if (!state) return null;
    return {
      config: state.config ?? null,
      roleDisplayProfile: state.roleDisplayProfile ?? null,
      editableTurn: state.editableTurn ?? null,
      restoredDraft: state.restoredDraft ?? null,
      turnConfig: state.turn?.config ?? state.config,
      status: state.preparing ? "running" : state.turn?.status ?? "idle",
      text: state.turn?.text ?? "",
      reasoning: state.turn?.reasoning ?? "",
      turnId: state.turn?.turnId,
      ...(state.turn ? processProjection(state.turn) : {}),
      error: state.turn?.error ?? null,
      responseId: state.turn?.responseId ?? null,
      storedState: state.storedState,
      nonStreaming: state.nonStreaming,
      items: [...state.items],
      toolGroups: [...(state.toolGroups ?? [])],
      // Occupancy is recomputed at read time: the latest provider anchor is
      // exact, and before the first anchor the local estimate stands in.
      occupancy: contextOccupancy({
        anchor: state.occupancyAnchor,
        prospectiveTokens: Math.max(0, (state.lastPrice?.total ?? 0) - (state.lastPrice?.components.reserve ?? 0)),
      }),
      price: state.lastPrice ?? null,
      turnUsage: state.usage.totals(),
      sessionUsage: state.sessionUsage.total(),
      compaction: { active: Boolean(state.compactedSurface), running: Boolean(state.manualCompacting) },
    };
  }

  function canEdit(sessionId) {
    const state = stateFor(sessionId);
    return isEnabled() && Boolean(state.config) && !state.reloadRequired && !state.editing && !state.preparing &&
      !state.activeController && !state.manualCompacting && state.turn?.status !== "running";
  }

  async function editSession(sessionId, operation) {
    if (!canEdit(sessionId)) return { status: "busy" };
    const state = stateFor(sessionId);
    state.editing = true;
    let committed = false;
    try {
      const { parsed } = await load(sessionId, { editing: true });
      if (!isSupportedSession(parsed) || parsed.running) throw new Error("Session unavailable");
      const action = operation(parsed, state);
      await sessionStore.commitEdit(sessionId, action.kind, action.payload, { nextSeq: parsed.nextSeq });
      committed = true;
      await load(sessionId, { editing: true });
      pushProjection(state, { kind: "session-edited", action: action.kind });
      return { status: "committed", draft: action.payload.draft ?? null };
    } catch (error) {
      if (committed) state.reloadRequired = true;
      return { status: "failed", error: { code: committed ? "SESSION_RELOAD" : error.message === "HISTORY_INCOMPATIBLE" ? "HISTORY_INCOMPATIBLE" : "SESSION_EDIT" } };
    } finally { state.editing = false; }
  }

  async function configure(sessionId, patch) {
    return editSession(sessionId, (_parsed, state) => {
      const config = { ...state.config, ...patch, configurationVersion: (state.config.configurationVersion ?? 0) + 1 };
      if (config.protocol !== state.config.protocol) throw new Error("HISTORY_INCOMPATIBLE");
      const portable = changedConnection(state.config, config);
      if (portable) portableItems(state.contextProjection.items(state.items), config.protocol);
      const validation = validateQuickAskSettings(normalizeQuickAskSettings(config));
      if (Object.hasOwn(patch, "model") && (!validation.valid || !environment.secrets.resolve(config.secretId))) throw new Error("Invalid connection");
      return { kind: "session/configured", payload: { config, portable } };
    });
  }

  async function withdraw(sessionId, { hasDraft = false } = {}) {
    if (hasDraft) return { status: "draft" };
    return editSession(sessionId, parsed => {
      const turn = latestTurn(parsed.records);
      if (!turn || !recoverableDraft(turn.payload?.editDraft)) throw new Error("Original draft unavailable");
      return { kind: "session/withdrawn", payload: { turnId: turn.payload.turnId, draft: turn.payload.editDraft } };
    });
  }

  // Permanently switch this session from server-side chaining to local replay.
  function applyStateFallback(sessionId) {
    const state = stateFor(sessionId);
    state.storedState = false;
    state.lastResponseId = null;
  }

  return {
    canEdit, configure, withdraw,
    refreshToolConcurrency: () => toolExecutor.refreshConcurrency?.(),
    suspend() {
      for (const store of sessionStores.values()) {
        const state = store.getState().state;
        state.activeController?.abort?.();
        state.turn?.controller?.abort?.();
      }
    },
    forget(sessionId) { publishers.get(sessionId)?.dispose(); publishers.delete(sessionId); sessionStores.delete(sessionId); },
    async waitForTurn(sessionId) { await sessionStores.get(sessionId)?.getState().state.task; },
    subscribe(sessionId, listener) { stateFor(sessionId); return sessionStores.get(sessionId).subscribe(listener); },
    load,
    send,
    stop,
    recover,
    snapshot,
    closeInterruptedCompaction,
    compactSession,
    compactNow,
    pricePendingRequest,
    applyStateFallback,
    isStateUnsupported: isResponsesStateUnsupported,
    runningTurns,
    stateFor,
    validateForSend,
    reasoningEffort, setReasoningEffort,
    searchEnabled, setSearchEnabled, nextSearchRoute, validateSearchForSend,
    searchRevision: sessionId => stateFor(sessionId).searchRevision ?? 0,
    MAX_CONCURRENT_TURNS,
    STREAM_EVENT_KINDS,
  };
}

module.exports = {
  createConversation,
  MAX_CONCURRENT_TURNS,
  ANSWER_RESERVE_TOKENS,
};
