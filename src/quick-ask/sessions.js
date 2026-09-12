const { sessionConfigSnapshot } = require("./settings");

// Durable Quick Ask session storage: one append-only JSONL log per session plus
// a derived navigation index. The layout is ADR 0010; the tolerant replay and
// seq contract follow the useful subset of pi-agent's session files.
//
// The store receives a pluginData capability slice and a scheduler slice, so it
// never touches the Obsidian API and never reads a global.

const CURRENT_SCHEMA_VERSION = 1;
const INDEX_KIND = "quick-ask-index";
const SESSIONS_DIRECTORY = "quick-ask/sessions";
const INDEX_PATH = "quick-ask/index.json";
const SESSIONS_PATH = "quick-ask/sessions";
const MAX_TITLE_LENGTH = 120;

// Record kinds this version knows how to replay. An unknown kind is skipped so
// a later version can add records without damaging an older reader.
const KNOWN_RECORD_KINDS = new Set([
  "context/file-added",
  "context/file-updated",
  "context/file-diff",
  "context/file-renamed",
  "context/file-deleted",
  "context/file-removed",
  "context/selection-added",
  "context/selection-removed",
  "context/file-reference",
  "context/tool-baseline",
  "item/input",
  "item/output",
  "turn/started",
  "turn/response-created",
  "turn/accepted",
  "turn/tool-started",
  "turn/tool-finished",
  "turn/finished",
  "turn/usage",
  "compaction/start",
  "compaction/checkpoint",
  "compaction/end",
  "session/renamed",
]);

function join(directory, name) {
  return directory ? `${directory}/${name}` : name;
}

function normalizeTitle(title) {
  if (typeof title !== "string") return "";
  const trimmed = title.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_TITLE_LENGTH ? trimmed.slice(0, MAX_TITLE_LENGTH) : trimmed;
}

// Derive the initial title locally from the first ten characters of the first
// line. No model call is involved.
function deriveTitle(question) {
  if (typeof question !== "string") return "";
  const firstLine = question.split(/\r?\n/, 1)[0].trim();
  return firstLine.slice(0, 10);
}

function createIdGenerator({ now, random }) {
  let counter = 0;
  return () => {
    counter += 1;
    const time = now().toString(36);
    const noise = Math.floor(random() * 0x1000000).toString(36).padStart(5, "0");
    return `${time}-${noise}-${counter.toString(36)}`;
  };
}

class QuickAskSessionStore {
  constructor({ pluginData, scheduler, onError = () => {}, onCommitted = null } = {}) {
    this.pluginData = pluginData;
    this.scheduler = scheduler;
    this.onError = onError;
    // Called after each durable local commit, so the optional preserved copy
    // mirrors only what the live session already persisted.
    this.onCommitted = onCommitted;
    this.directory = join(pluginData?.pluginDirectory ?? "", "quick-ask");
    this.sessionsDirectory = join(this.directory, "sessions");
    this.indexPath = join(this.directory, "index.json");
    this.tails = new Map();
    this.index = null;
    this._newId = createIdGenerator({
      now: () => scheduler?.now?.() ?? Date.now(),
      random: () => Math.random(),
    });
  }

  // The one place a session's plugin-directory path is built.
  adapterPathFor(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Quick Ask session ID");
    return join(this.sessionsDirectory, `${id}.jsonl`);
  }

  async directoryExists(path) {
    try {
      return await this.pluginData.dataAdapter.exists(path);
    } catch {
      return false;
    }
  }

  // Serialize every write for one session so concurrent commits retain order.
  enqueue(id, work) {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const attempt = previous.then(work);
    this.tails.set(id, attempt.catch(() => {}));
    return attempt;
  }

  async ensureDirectories() {
    for (const path of [this.directory, this.sessionsDirectory]) {
      if (!(await this.directoryExists(path))) {
        try {
          await this.pluginData.dataAdapter.mkdir(path);
        } catch (error) {
          // A concurrent creator is not a failure.
          if (!(await this.directoryExists(path))) throw error;
        }
      }
    }
  }

  async loadIndex() {
    if (this.index) return this.index;
    return (await this.init()).index;
  }

  // Read the index once per store instance. A missing or invalid cache is
  // rebuilt immediately; rebuilding twice in one instance is never necessary.
  async ensureIndex() {
    if (this.index) return this.index;
    const cached = await this.readIndex();
    if (cached) {
      this.index = cached;
      return cached;
    }
    return await this.rebuildIndex();
  }

  async readIndex() {
    if (!(await this.directoryExists(this.indexPath))) return null;
    let raw;
    try {
      raw = await this.pluginData.dataAdapter.read(this.indexPath);
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || parsed.kind !== INDEX_KIND) return null;
    if (!Array.isArray(parsed.sessions)) return null;
    const sessions = [];
    const seen = new Set();
    for (const entry of parsed.sessions) {
      if (!entry || typeof entry.id !== "string" || entry.id.length === 0) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      sessions.push({
        id: entry.id,
        title: normalizeTitle(entry.title),
        created: typeof entry.created === "string" ? entry.created : null,
        lastActivity: typeof entry.lastActivity === "string" ? entry.lastActivity : null,
        running: entry.running === true,
        unread: entry.unread === true,
        order: Number.isInteger(entry.order) ? entry.order : sessions.length,
      });
    }
    return {
      kind: INDEX_KIND,
      activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
      sessions,
      resetNotice: false,
    };
  }

  async writeIndex(index) {
    await this.ensureDirectories();
    const payload = {
      kind: INDEX_KIND,
      activeSessionId: index.activeSessionId ?? null,
      sessions: index.sessions.map((entry, position) => ({
        id: entry.id,
        title: entry.title,
        created: entry.created,
        lastActivity: entry.lastActivity,
        running: entry.running === true,
        unread: entry.unread === true,
        order: Number.isInteger(entry.order) ? entry.order : position,
      })),
    };
    await this.pluginData.dataAdapter.write(this.indexPath, `${JSON.stringify(payload)}\n`);
    this.index = index;
  }

  // The index is a derived navigation cache. When it is missing or invalid it
  // is rebuilt only from the dedicated sessions directory, never by scanning
  // the Vault. Display order and the active choice may reset; no conversation
  // content can be lost because it never lived here.
  async rebuildIndex() {
    const sessions = [];
    let listed = { files: [] };
    try {
      listed = await this.pluginData.dataAdapter.list(this.sessionsDirectory);
    } catch {
      listed = { files: [] };
    }
    for (const path of listed.files ?? []) {
      if (!String(path).endsWith(".jsonl")) continue;
      const id = String(path).slice(String(path).lastIndexOf("/") + 1, -".jsonl".length);
      const summary = await this.readSummary(id);
      if (!summary) continue;
      sessions.push(summary);
    }
    const ordered = orderSessions(sessions);
    const index = {
      kind: INDEX_KIND,
      activeSessionId: ordered.length > 0 ? ordered[0].id : null,
      sessions: ordered,
      resetNotice: ordered.length > 0,
    };
    await this.writeIndex(index);
    return index;
  }

  // Startup entry point. Only the index is touched; session bodies load on
  // demand through readLog().
  async init() {
    const before = this.index;
    const index = await this.ensureIndex();
    return { index, reset: before === null && index.resetNotice === true };
  }

  // Read just enough of a session log to describe it in the index.
  async readSummary(id) {
    const parsed = await this.readLog(id);
    if (!parsed.header || parsed.header.sessionId !== id) return null;
    return {
      id,
      title: normalizeTitle(parsed.title),
      created: parsed.header.createdAt ?? null,
      lastActivity: parsed.lastActivity ?? parsed.header.createdAt ?? null,
      running: parsed.running,
      unread: false,
      order: 0,
    };
  }

  // Tolerant replay. A torn tail is truncated and the valid prefix preserved;
  // invalid data anywhere earlier marks the session damaged and leaves the
  // original file available for explicit deletion or preserved-copy recovery.
  async readLog(id) {
    const path = this.adapterPathFor(id);
    if (!(await this.directoryExists(path))) return { missing: true };
    let raw;
    try {
      raw = await this.pluginData.dataAdapter.read(path);
    } catch {
      return { damaged: true, reason: "unreadable" };
    }
    return parseLog(raw);
  }

  async listSessions() {
    const index = await this.ensureIndex();
    return orderSessions(index.sessions);
  }

  async ensureActiveSession(config) {
    return this.enqueue("active-session", async () => {
      const index = await this.ensureIndex();
      const active = index.sessions.find(session => session.id === index.activeSessionId) ?? index.sessions[0];
      if (active) {
        if (index.activeSessionId !== active.id) await this.setActive(active.id);
        return active.id;
      }
      return (await this.createSession({ config })).id;
    });
  }

  async createSession({ config, title, createdAt, id: requestedId } = {}) {
    await this.ensureDirectories();
    const now = this.scheduler?.now?.() ?? Date.now();
    const created = createdAt ?? new Date(now).toISOString();
    // A restored session (an import) supplies its own id; a new one generates.
    const id = typeof requestedId === "string" && requestedId.length > 0 ? requestedId : this._newId();
    const header = {
      kind: "header",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      sessionId: id,
      createdAt: created,
      title: normalizeTitle(title),
      config: config ?? sessionConfigSnapshot({}, { createdAt: created }),
    };
    // Recover the derived index before the new log exists, preserving older
    // sessions without adding the new session twice during a rebuild.
    const index = await this.ensureIndex();
    await this.enqueue(id, async () => {
      if (await this.pluginData.dataAdapter.exists(this.adapterPathFor(id))) throw new Error("Quick Ask session already exists");
      await this.pluginData.dataAdapter.write(this.adapterPathFor(id), `${JSON.stringify(header)}\n`);
    });
    index.sessions.push({
      id,
      title: normalizeTitle(title),
      created,
      lastActivity: created,
      running: false,
      unread: false,
      order: index.sessions.length,
    });
    index.activeSessionId = id;
    await this.writeIndex(index);
    await this.notifyCommitted(id);
    return { id, header };
  }

  // Append one durable record with the next consecutive seq.
  async append(id, kind, payload, { at } = {}) {
    const timestamp = at ?? new Date(this.scheduler?.now?.() ?? Date.now()).toISOString();
    return this.enqueue(id, async () => {
      const parsed = await this.readLog(id);
      if (parsed.missing) throw new Error(`Quick Ask session ${id} does not exist`);
      if (parsed.damaged) throw new Error(`Quick Ask session ${id} is damaged and cannot be appended to`);
      if (parsed.version > CURRENT_SCHEMA_VERSION) {
        throw new Error(`Quick Ask session ${id} was created by a newer Scholar Workbench`);
      }
      if (parsed.version !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`Quick Ask session ${id} has an unsupported format version`);
      }
      if (parsed.tornTail) {
        await this.pluginData.dataAdapter.write(this.adapterPathFor(id), parsed.validText);
      }
      const record = { seq: parsed.nextSeq, at: timestamp, kind, payload: payload ?? {} };
      await this.pluginData.dataAdapter.append(this.adapterPathFor(id), `${JSON.stringify(record)}\n`);
      await this.touch(id, { at: timestamp, kind, payload });
      await this.notifyCommitted(id);
      return record;
    });
  }

  // Best-effort post-commit notification. A mirror failure never fails or rolls
  // back the live session.
  async notifyCommitted(id) {
    if (typeof this.onCommitted !== "function") return;
    try {
      await this.onCommitted(id, this);
    } catch (error) {
      this.onError(error);
    }
  }

  async touch(id, { at, kind }) {
    const index = await this.ensureIndex();
    const entry = index.sessions.find((session) => session.id === id);
    if (!entry) return;
    entry.lastActivity = at;
    if (kind === "session/renamed") entry.title = normalizeTitle(entry.title);
    await this.writeIndex(index);
  }

  async rename(id, title) {
    const normalized = normalizeTitle(title);
    const record = await this.append(id, "session/renamed", { title: normalized });
    const index = await this.ensureIndex();
    const entry = index.sessions.find((session) => session.id === id);
    if (entry) entry.title = normalized;
    await this.writeIndex(index);
    return record;
  }

  async delete(id) {
    return this.enqueue(id, async () => {
      const current = await this.ensureIndex();
      await this.pluginData.dataAdapter.remove(this.adapterPathFor(id));
      const index = { ...current, sessions: current.sessions.filter(session => session.id !== id) };
      if (index.activeSessionId === id) index.activeSessionId = index.sessions[0]?.id ?? null;
      await this.writeIndex(index);
      await this.notifyCommitted(id);
    });
  }

  async importSession({ id, header, records, title }) {
    const importedHeader = { ...header, sessionId: id };
    const lines = [importedHeader, ...records];
    let text = lines.map(line => JSON.stringify(line)).join("\n") + "\n";
    const parsed = parseLog(text);
    if (parsed.damaged || parsed.version !== CURRENT_SCHEMA_VERSION) throw new Error("Invalid or unsupported Quick Ask session");
    if (title !== parsed.title) {
      text += JSON.stringify({ seq: parsed.nextSeq, at: new Date(this.scheduler?.now?.() ?? Date.now()).toISOString(), kind: "session/renamed", payload: { title } }) + "\n";
    }
    const index = await this.ensureIndex();
    await this.ensureDirectories();
    await this.enqueue(id, async () => {
      if (await this.pluginData.dataAdapter.exists(this.adapterPathFor(id))) throw new Error("Quick Ask session already exists");
      await this.pluginData.dataAdapter.write(this.adapterPathFor(id), text);
    });
    const summary = await this.readSummary(id);
    await this.writeIndex({ ...index, sessions: [...index.sessions, summary] });
    await this.notifyCommitted(id);
    return id;
  }

  async setActive(id) {
    const index = await this.ensureIndex();
    if (id !== null && !index.sessions.some((session) => session.id === id)) return null;
    index.activeSessionId = id;
    await this.writeIndex(index);
    return index;
  }

  async setProjection(id, projection) {
    const index = await this.ensureIndex();
    const entry = index.sessions.find((session) => session.id === id);
    if (!entry) return;
    if (typeof projection.running === "boolean") entry.running = projection.running;
    if (typeof projection.unread === "boolean") entry.unread = projection.unread;
    await this.writeIndex(index);
  }
}

// Ordering for the session list, stated branch by branch so the sign of each
// rule is visible: most recent durable activity first, then the earlier
// creation time, then session ID.
function compareSessions(a, b) {
  const aActivity = String(a.lastActivity ?? "");
  const bActivity = String(b.lastActivity ?? "");
  // Descending activity: whoever was active more recently comes first.
  if (aActivity !== bActivity) return aActivity > bActivity ? -1 : 1;
  const aCreated = String(a.created ?? "");
  const bCreated = String(b.created ?? "");
  // Ascending creation: the earlier session comes first.
  if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
  const aId = String(a.id);
  const bId = String(b.id);
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

// Order a session list without depending on the engine's sort implementation.
// The list is small, and a selection sort states the ordering rule directly:
// repeatedly take the session that must come first among the remaining ones.
function orderSessions(sessions) {
  const remaining = [...sessions];
  const ordered = [];
  while (remaining.length > 0) {
    let best = 0;
    for (let index = 1; index < remaining.length; index++) {
      if (compareSessions(remaining[index], remaining[best]) < 0) best = index;
    }
    ordered.push(remaining.splice(best, 1)[0]);
  }
  return ordered;
}

// Parse one session log. Only a malformed structure, a missing, duplicate, or
// out-of-order seq, or unreadable JSON makes a session damaged.
function parseLog(raw) {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  const complete = lines.slice(0, -1);
  const tail = lines[lines.length - 1];
  let header = null;
  let title = "";
  let lastActivity = null;
  let running = false;
  let nextSeq = 0;
  const records = [];

  for (let position = 0; position < complete.length; position++) {
    const line = complete[position];
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { damaged: true, reason: "invalid-json" };
    }
    if (!parsed || typeof parsed !== "object") return { damaged: true, reason: "invalid-record" };
    if (position === 0 || parsed.kind === "header") {
      if (header || typeof parsed.sessionId !== "string") return { damaged: true, reason: "invalid-header" };
      const version = parsed.schemaVersion === undefined ? 1 : parsed.schemaVersion;
      if (!Number.isInteger(version) || version < 1) return { damaged: true, reason: "invalid-header" };
      header = { ...parsed, schemaVersion: version };
      title = normalizeTitle(header.title);
      lastActivity = header.createdAt ?? null;
      continue;
    }
    if (!Number.isInteger(parsed.seq) || parsed.seq !== nextSeq) {
      return { damaged: true, reason: "seq" };
    }
    nextSeq += 1;
    if (typeof parsed.at === "string") lastActivity = parsed.at;
    if (parsed.kind === "session/renamed" && typeof parsed.payload?.title === "string") {
      title = parsed.payload.title;
    }
    if (parsed.kind === "turn/started") {
      running = true;
    }
    if (parsed.kind === "turn/finished") {
      running = false;
    }
    if (KNOWN_RECORD_KINDS.has(parsed.kind) || typeof parsed.kind === "string") records.push(parsed);
  }

  if (!header) {
    // A single torn line is a torn tail, not a damaged session: the caller may
    // finish writing the header later through an explicit create.
    if (tail.length > 0 && complete.length === 0) {
      return { damaged: true, reason: "missing-header" };
    }
    return { damaged: true, reason: "missing-header" };
  }

  return {
    header,
    version: header.schemaVersion,
    title,
    lastActivity,
    running,
    records,
    nextSeq,
    tornTail: tail.length > 0,
    validText: tail.length > 0 ? `${complete.join("\n")}\n` : text,
  };
}

module.exports = {
  QuickAskSessionStore,
  CURRENT_SCHEMA_VERSION,
  INDEX_PATH,
  SESSIONS_PATH,
  SESSIONS_DIRECTORY,
  KNOWN_RECORD_KINDS,
  deriveTitle,
  normalizeTitle,
  parseLog,
  compareSessions,
  orderSessions,
};
