const { normalizeSearchSettings } = require("./web-search");
const { DEFAULT_LANGUAGE, LANGUAGES, t } = require("./i18n");
const DISPLAY_FIELDS = {
  fontSize: { default: 14, min: 12, max: 24, step: 1 },
  lineHeight: { default: 1.5, min: 1.2, max: 2, step: 0.1 },
  paragraphSpacing: { default: 0.65, min: 0, max: 2, step: 0.05 },
  messageSpacing: { default: 12, min: 4, max: 32, step: 1 },
};
const BUBBLE_COLOR_DEFAULTS = { userBubbleColor: "#086ddd", assistantBubbleColor: "#39c5bb" };

function normalizeBubbleColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return "#" + [...hex.slice(1)].map(char => char + char).join("");
  return fallback;
}

function normalizeDisplaySettings(saved = {}) {
  const result = {};
  for (const [key, rule] of Object.entries(DISPLAY_FIELDS)) {
    const value = saved?.[key];
    result[key] = typeof value === "number" && Number.isFinite(value) && value >= rule.min && value <= rule.max ? value : rule.default;
  }
  for (const key of ["showReasoning", "showUsage"]) result[key] = typeof saved?.[key] === "boolean" ? saved[key] : true;
  result.customBubbleColors = saved?.customBubbleColors === true;
  for (const [key, fallback] of Object.entries(BUBBLE_COLOR_DEFAULTS)) result[key] = normalizeBubbleColor(saved?.[key], fallback);
  return result;
}

function quickAskDisplayPage(settings) {
  const colorsDisabled = () => {
    const current = typeof settings?.values === "function" ? settings.values() : settings;
    return !normalizeDisplaySettings(current?.quickAsk?.display).customBubbleColors;
  };
  return {
    type: "page", name: t(settings, "display.title"), desc: t(settings, "display.description"),
    items: [
      ...Object.entries(DISPLAY_FIELDS).map(([key, rule]) => ({
        name: t(settings, `display.${key}`),
        control: { type: "number", key: `quickAsk.display.${key}`, min: rule.min, max: rule.max, step: rule.step,
          validate: value => Number.isFinite(value) && value >= rule.min && value <= rule.max ? undefined : t(settings, "display.range", rule) },
      })),
      ...["showReasoning", "showUsage"].map(key => ({ name: t(settings, `display.${key}`), control: { type: "toggle", key: `quickAsk.display.${key}` } })),
      { name: t(settings, "display.customBubbleColors"), desc: t(settings, "display.customBubbleColorsDescription"),
        control: { type: "toggle", key: "quickAsk.display.customBubbleColors" } },
      ...Object.keys(BUBBLE_COLOR_DEFAULTS).map(key => ({
        name: t(settings, `display.${key}`), desc: t(settings, "display.bubbleColorDescription"),
        control: { type: "color", key: `quickAsk.display.${key}`, disabled: colorsDisabled },
      })),
    ],
  };
}

// Quick Ask owns its settings shape, defaults, and validation. The Scholar
// Workbench host stores these values in its own data.json through the shared
// serialized writer; nothing here reaches for the Obsidian API.

// The fixed answer reserve, in tokens. It follows pi-agent's reserveTokens
// default and is deliberately not a setting.
const ANSWER_RESERVE_TOKENS = 16384;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 262144;
const DEFAULT_CALL_LIMIT = 3;
const MIN_CALL_LIMIT = 1;
const MAX_CALL_LIMIT = 10;
const DEFAULT_PRESERVED_COPY_DIRECTORY = "quick-ask-preserved";

function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") end--;
  return end === value.length ? value : value.slice(0, end);
}

function defaultQuickAskSettings() {
  return {
    enable: true,
    display: normalizeDisplaySettings(),
    webSearch: normalizeSearchSettings(),
    protocol: "responses",
    baseUrl: "",
    secretId: "",
    model: "",
    systemPrompt: "",
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    callLimit: DEFAULT_CALL_LIMIT,
    preservedCopy: { enabled: false, directory: DEFAULT_PRESERVED_COPY_DIRECTORY },
  };
}

function normalizeCallLimit(value) {
  return Number.isInteger(value) && value >= MIN_CALL_LIMIT && value <= MAX_CALL_LIMIT
    ? value
    : DEFAULT_CALL_LIMIT;
}

function normalizeContextWindowTokens(value) {
  if (value === null || value === "" || value === undefined) return null;
  const tokens = typeof value === "number" ? value : Number(value);
  return Number.isInteger(tokens) && tokens > 0 ? tokens : null;
}

function normalizeBaseUrl(value) {
  return typeof value === "string" ? stripTrailingSlashes(value.trim()) : "";
}

// Save-time normalization accepts partial user input: a cleared field must
// stay cleared rather than being rewritten to a valid-looking default.
function normalizeQuickAskSettings(saved) {
  const defaults = defaultQuickAskSettings();
  if (saved == null || typeof saved !== "object") return defaults;
  const values = {
    enable: typeof saved.enable === "boolean" ? saved.enable : defaults.enable,
    display: normalizeDisplaySettings(saved.display),
    webSearch: normalizeSearchSettings(saved.webSearch),
    protocol: typeof saved.protocol === "string" ? saved.protocol : defaults.protocol,
    baseUrl: normalizeBaseUrl(saved.baseUrl),
    secretId: typeof saved.secretId === "string" ? saved.secretId : defaults.secretId,
    model: typeof saved.model === "string" ? saved.model.trim() : defaults.model,
    systemPrompt: typeof saved.systemPrompt === "string" ? saved.systemPrompt : defaults.systemPrompt,
    contextWindowTokens: Object.hasOwn(saved, "contextWindowTokens")
      ? normalizeContextWindowTokens(saved.contextWindowTokens)
      : defaults.contextWindowTokens,
    callLimit: normalizeCallLimit(saved.callLimit),
    preservedCopy: {
      enabled: typeof saved.preservedCopy?.enabled === "boolean" ? saved.preservedCopy.enabled : defaults.preservedCopy.enabled,
      directory: typeof saved.preservedCopy?.directory === "string"
        ? stripTrailingSlashes(saved.preservedCopy.directory.trim())
        : defaults.preservedCopy.directory,
    },
  };
  return values;
}

// Deliberately dependency-free: the plugin bundle runs in a host context that
// does not guarantee a URL constructor, and this only needs to reject a wrong
// scheme and the /responses suffix.
const ABSOLUTE_URL = /^(https?):\/\/([^\s/?#]+)([^\s?#]*)$/i;

function baseUrlError(baseUrl) {
  if (baseUrl.length === 0) return "baseUrlMissing";
  const match = ABSOLUTE_URL.exec(baseUrl);
  if (!match) return "baseUrlScheme";
  const scheme = match[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "baseUrlScheme";
  const path = match[3] ?? "";
  if (/\/(?:responses|chat\/completions)\/?$/i.test(path)) return "baseUrlResponses";
  return null;
}

// Declarative validation runs before a request is built. It never probes the
// endpoint and never spends a billed request: a missing item is reported
// inline, and the first real question is the actual connection check.
function validateQuickAskSettings(settings) {
  const values = normalizeQuickAskSettings(settings);
  const errors = {};
  if (!["responses", "chat-completions"].includes(values.protocol)) errors.protocol = "protocol";
  const urlError = baseUrlError(values.baseUrl);
  if (urlError) errors.baseUrl = urlError;
  if (values.model.length === 0) errors.model = "model";
  if (values.secretId.length === 0) errors.secretId = "secret";
  if (values.contextWindowTokens != null && values.contextWindowTokens <= ANSWER_RESERVE_TOKENS) {
    errors.contextWindowTokens = "contextWindowReserve";
  }
  return { valid: Object.keys(errors).length === 0, errors, values };
}

// The immutable per-session configuration snapshot. Later setting changes
// affect new sessions only.
function sessionConfigSnapshot(settings, { createdAt } = {}) {
  const values = normalizeQuickAskSettings(settings);
  return {
    protocol: values.protocol,
    baseUrl: values.baseUrl,
    model: values.model,
    secretId: values.secretId,
    systemPrompt: values.systemPrompt,
    contextWindowTokens: values.contextWindowTokens,
    callLimit: values.callLimit,
    language: LANGUAGES.includes(settings?.language) ? settings.language : DEFAULT_LANGUAGE,
    createdAt: createdAt ?? null,
  };
}

// Settings that leave this machine never carry a secret value: only the
// SecretStorage reference name is stored. The redaction is an allowlist, so a
// future field cannot leak into an export by default.
function redactQuickAskSettings(settings) {
  const values = normalizeQuickAskSettings(settings);
  return {
    enable: values.enable,
    display: { ...values.display },
    webSearch: { ...values.webSearch },
    protocol: values.protocol,
    baseUrl: values.baseUrl,
    model: values.model,
    systemPrompt: values.systemPrompt,
    contextWindowTokens: values.contextWindowTokens,
    callLimit: values.callLimit,
    preservedCopy: { ...values.preservedCopy },
    // The SecretStorage reference name is deliberately kept: the copy must stay
    // usable after an import, and a reference is not a credential. The value it
    // names is what never leaves SecretStorage.
    secretId: values.secretId,
  };
}

module.exports = {
  BUBBLE_COLOR_DEFAULTS,
  normalizeBubbleColor,
  DISPLAY_FIELDS,
  normalizeDisplaySettings,
  quickAskDisplayPage,
  ANSWER_RESERVE_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_CALL_LIMIT,
  MIN_CALL_LIMIT,
  MAX_CALL_LIMIT,
  DEFAULT_PRESERVED_COPY_DIRECTORY,
  defaultQuickAskSettings,
  normalizeQuickAskSettings,
  normalizeCallLimit,
  normalizeContextWindowTokens,
  normalizeBaseUrl,
  baseUrlError,
  validateQuickAskSettings,
  sessionConfigSnapshot,
  redactQuickAskSettings,
};

function applyQuickAskPatch(target, patch) {
  if (!patch || typeof patch !== "object") return 0;
  const search = { ...target.webSearch, ...patch.webSearch, secretIds: { ...target.webSearch?.secretIds, ...patch.webSearch?.secretIds } };
  if (Object.hasOwn(patch.webSearch ?? {}, "secretId")) search.secretIds[search.provider] = patch.webSearch.secretId;
  if (Object.hasOwn(patch.webSearch ?? {}, "provider") && patch.webSearch.provider !== target.webSearch?.provider) search.secretId = search.secretIds[patch.webSearch.provider] ?? "";
  const normalized = normalizeQuickAskSettings({ ...target, ...patch, webSearch: search, display: { ...target.display, ...patch.display }, preservedCopy: { ...target.preservedCopy, ...(patch.preservedCopy ?? {}) } });
  let applied = 0;
  for (const field of ["enable", "protocol", "baseUrl", "secretId", "model", "systemPrompt", "contextWindowTokens", "callLimit"]) {
    if (Object.hasOwn(patch, field) && target[field] !== normalized[field]) {
      target[field] = normalized[field];
      applied += 1;
    }
  }
  if (patch.preservedCopy && typeof patch.preservedCopy === "object") {
    for (const field of ["enabled", "directory"]) {
      if (Object.hasOwn(patch.preservedCopy, field) && target.preservedCopy[field] !== normalized.preservedCopy[field]) {
        target.preservedCopy[field] = normalized.preservedCopy[field];
        applied += 1;
      }
    }
  }
  if (patch.webSearch && typeof patch.webSearch === "object" && JSON.stringify(target.webSearch) !== JSON.stringify(normalized.webSearch)) {
    target.webSearch = normalized.webSearch; applied++;
  }
  if (patch.display && typeof patch.display === "object") {
    for (const field of Object.keys(normalized.display)) {
      if (Object.hasOwn(patch.display, field) && target.display[field] !== normalized.display[field]) {
        target.display[field] = normalized.display[field];
        applied += 1;
      }
    }
  }
  return applied;
}


module.exports.applyQuickAskPatch = applyQuickAskPatch;
