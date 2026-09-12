const { redactQuickAskSettings } = require("./settings");

// The opt-in Preserved Copy and the explicit data actions. The preserved copy
// mirrors recoverable session data into a Vault folder as plaintext, so the
// settings UI must say so. It never contains an API secret value, and a backup
// failure never fails or rolls back the live session.

const BACKUP_DIRECTORY = "quick-ask-backup";
const SESSIONS_SEGMENT = "sessions";

function backupPaths(directory) {
  const root = String(directory ?? "").replace(/^\/+|\/+$/g, "");
  const base = root ? `${root}/${BACKUP_DIRECTORY}` : BACKUP_DIRECTORY;
  return { base, index: `${base}/index.json`, sessions: `${base}/${SESSIONS_SEGMENT}` };
}

function createPreservedCopy({ pluginData, vault, getSettings, now = () => new Date().toISOString() }) {
  const state = { enabled: false, directory: "", lastSuccessAt: null, lastError: null };

  function settings() {
    const values = getSettings?.() ?? {};
    const preserved = values.preservedCopy ?? {};
    state.enabled = preserved.enabled === true;
    state.directory = preserved.directory ?? "";
    return state;
  }

  function isEnabled() {
    settings();
    return state.enabled && state.directory.length > 0;
  }

  // Copying never blocks or rolls back the live session: a failure is recorded
  // and reported in settings instead.
  async function syncSession({ id, header, records, index }) {
    if (!isEnabled()) return { status: "disabled" };
    const paths = backupPaths(state.directory);
    try {
      await vault.writeText(`${paths.sessions}/${id}.jsonl`, serializeLog(header, records));
      if (index) await vault.writeText(paths.index, `${JSON.stringify(sanitizeIndex(index))}\n`);
      state.lastSuccessAt = now();
      state.lastError = null;
      return { status: "synced", at: state.lastSuccessAt };
    } catch (error) {
      state.lastError = error?.message ?? String(error);
      return { status: "failed", error: state.lastError };
    }
  }

  function status() {
    settings();
    return {
      enabled: state.enabled,
      directory: state.directory,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      unsynchronized: state.lastSuccessAt === null,
    };
  }

  return { isEnabled, syncSession, status, backupPaths: () => backupPaths(state.directory) };
}

// The preserved copy is an append-only mirror of the local log: the header keeps
// its immutable configuration snapshot, but only the redacted settings cross the
// boundary, so a secret value can never be written there.
function serializeLog(header, records) {
  const sanitizedHeader = {
    ...header,
    config: header?.config ? redactQuickAskSettings(header.config) : header?.config,
  };
  const lines = [JSON.stringify(sanitizedHeader)];
  for (const record of records ?? []) lines.push(JSON.stringify(record));
  return `${lines.join("\n")}\n`;
}

function sanitizeIndex(index) {
  return {
    kind: "quick-ask-index",
    activeSessionId: index?.activeSessionId ?? null,
    sessions: (index?.sessions ?? []).map((session) => ({
      id: session.id,
      title: session.title,
      created: session.created,
      lastActivity: session.lastActivity,
      order: session.order,
    })),
  };
}

// Import adds valid sessions that are missing locally without changing their
// ids. A collision keeps both: the imported session gets a new id and its title
// gains the import suffix. Sessions are never merged or overwritten.
function planImport({ localIds = [], backupSessions = [], suffix = "（导入）" } = {}) {
  const local = new Set(localIds);
  const planned = [];
  const used = new Set(localIds);
  for (const session of backupSessions) {
    if (!session || typeof session.id !== "string" || session.id.length === 0) continue;
    // `sourceId` is the id inside the backup, so an import can find its body
    // even after a collision renames the session it creates.
    if (!local.has(session.id) && !used.has(session.id)) {
      used.add(session.id);
      planned.push({ id: session.id, sourceId: session.id, title: session.title ?? "", collision: false });
      continue;
    }
    let number = 1;
    while (used.has(`${session.id}-import-${number}`)) number += 1;
    const newId = `${session.id}-import-${number}`;
    used.add(newId);
    planned.push({ id: newId, sourceId: session.id, title: `${session.title ?? ""}${suffix}`, collision: true });
  }
  return planned;
}

// Export is a whole-Quick-Ask snapshot for portability; it carries secret
// references only.
function buildExport({ settings, index, sessions = [] } = {}) {
  return {
    kind: "quick-ask-export",
    exportedAt: new Date().toISOString(),
    settings: redactQuickAskSettings(settings),
    index: sanitizeIndex(index),
    sessions: sessions.map((session) => ({
      id: session.id,
      header: {
        ...session.header,
        config: session.header?.config ? redactQuickAskSettings(session.header.config) : session.header?.config,
      },
      records: session.records ?? [],
    })),
  };
}

function parseExport(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!parsed || typeof parsed !== "object" || parsed.kind !== "quick-ask-export") {
    return { ok: false, reason: "not-an-export" };
  }
  if (!Array.isArray(parsed.sessions)) return { ok: false, reason: "missing-sessions" };
  return { ok: true, export: parsed };
}

// Clearing Quick Ask data removes only the stored secret-ID reference. The
// referenced Obsidian Secret is shared and is never deleted.
async function clearQuickAskData({ pluginData, sessionsDirectory, indexPath }) {
  const removed = [];
  let listed = { files: [] };
  try {
    listed = await pluginData.dataAdapter.list(sessionsDirectory);
  } catch {
    listed = { files: [] };
  }
  for (const path of listed.files ?? []) {
    try {
      await pluginData.dataAdapter.remove(path);
      removed.push(path);
    } catch {
      // A file that cannot be removed is simply not reported as removed.
    }
  }
  if (indexPath) {
    try {
      await pluginData.dataAdapter.remove(indexPath);
      removed.push(indexPath);
    } catch {
      // The index is a derived cache; a failed removal is not fatal.
    }
  }
  return {
    removed,
    // The caller keeps the stored secret reference unless the user also clears
    // the setting; no Obsidian Secret is ever deleted here.
    secretsDeleted: 0,
  };
}

module.exports = {
  BACKUP_DIRECTORY,
  SESSIONS_SEGMENT,
  backupPaths,
  createPreservedCopy,
  serializeLog,
  sanitizeIndex,
  planImport,
  buildExport,
  parseExport,
  clearQuickAskData,
};
