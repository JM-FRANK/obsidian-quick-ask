// A single policy for placeholder, existing-session and busy states. Titles
// are labels only; an actionable session always has an ID in the real index.
function sessionNavigation({ sessions = [], activeSessionId = null, busy = false, hasHistory = false, hasDraft = false, unavailable = false } = {}) {
  const active = sessions.find(session => session.id === activeSessionId) ?? null;
  return {
    kind: busy ? "busy" : active ? "session" : "none",
    active,
    canSelect: !busy && sessions.length > 0,
    canManage: !busy && active !== null,
    canCreate: !busy && (!active || unavailable || hasHistory || hasDraft),
  };
}

// All navigation mutations share one promise tail. A failed action releases
// the queue, and its error reaches the caller instead of becoming a dead click.
function createSessionActionQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    get busy() { return pending > 0; },
    run(work) {
      pending += 1;
      const action = tail.then(work).finally(() => { pending -= 1; });
      tail = action.catch(() => {});
      return action;
    },
  };
}

function adoptUnassignedDraft(drafts, sessionId, draft) {
  if (!drafts.has(sessionId)) drafts.set(sessionId, draft);
  drafts.delete(null);
}

function sessionMenuEntries(sessions, activeId, actions) {
  return sessions.map(session => ({
    ...session, current: session.id === activeId,
    open: () => actions.select(session.id),
    rename: () => actions.rename(session.id),
    remove: () => actions.remove(session.id),
  }));
}

module.exports = { sessionNavigation, createSessionActionQueue, adoptUnassignedDraft, sessionMenuEntries };
