const { baseUrlError } = require('./settings');
const { activeProvider, applyProviderAction } = require('./provider-profiles');

async function discoverModels({ profile, apiKey, network, signal }) {
  if (baseUrlError(profile.baseUrl) || !apiKey?.trim()) throw new Error('providers.discoveryConfig');
  const response = await network.request({ url: `${profile.baseUrl}/models`, method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }, signal });
  if (response.status < 200 || response.status >= 300) throw new Error('providers.discoveryFailed');
  let body;
  try { body = typeof response.json === 'function' ? await response.json() : response.json; }
  catch { throw new Error('providers.discoveryInvalid'); }
  if (!Array.isArray(body?.data)) throw new Error('providers.discoveryInvalid');
  const ids = new Set(), models = [];
  for (const item of body.data) {
    if (typeof item?.id !== 'string' || !item.id.trim() || ids.has(item.id.trim())) continue;
    const id = item.id.trim(); ids.add(id);
    const model = { id };
    // Only explicit metadata is used. A model ID never proves protocol support.
    if (Number.isSafeInteger(item.context_window) && item.context_window > 16384) model.contextWindowTokens = item.context_window;
    models.push(model);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function createProviderManager({ getSettings, write, network, secrets, scheduler, notice }) {
  let pending = Promise.resolve(), disposed = false, edits = 0;
  const revisions = new Map();
  const listeners = new Map(), jobs = new Map(), statuses = new Map();
  const values = () => getSettings().quickAsk;
  const publish = () => {
    if (disposed || edits) return;
    for (const [element, listener] of listeners) {
      if (element.isConnected) { listener.connected = true; listener.callback(); }
      else if (listener.connected) listeners.delete(element);
    }
  };
  function cancel(id) {
    const job = jobs.get(id);
    if (job) {
      scheduler.cancelDelay(job.timer);
      scheduler.cancelDelay(job.timeout);
      job.controller?.abort();
      jobs.delete(id);
    }
    statuses.delete(id);
  }
  function enqueue(operation) {
    const result = pending.then(() => disposed ? false : operation());
    pending = result.catch(() => {});
    return result;
  }
  async function refresh(id) {
    await pending;
    if (disposed) return;
    id ??= activeProvider(values()).id;
    cancel(id);
    const profile = values().providerProfiles.find(item => item.id === id);
    if (!profile) return;
    const job = { controller: network.AbortController ? new network.AbortController() : null };
    jobs.set(id, job);
    statuses.set(id, 'providers.discovering'); publish();
    // A disabled feature or a service that never replies must not leave the
    // setting in a permanent loading state. No retry or endpoint probing.
    job.timeout = scheduler.delay(20000, () => {
      if (jobs.get(id) !== job) return;
      cancel(id); statuses.set(id, 'providers.discoveryFailed'); publish();
    });
    try {
      const models = await discoverModels({ profile, apiKey: secrets.resolve(profile.secretId), network, signal: job.controller?.signal });
      if (disposed || jobs.get(id) !== job) return;
      await enqueue(async () => {
        if (jobs.get(id) !== job) return;
        const current = values().providerProfiles.find(item => item.id === id);
        if (!current || current.baseUrl !== profile.baseUrl || current.secretId !== profile.secretId) return;
        try { await write({ providerAction: { type: 'discovered', id, baseUrl: profile.baseUrl, secretId: profile.secretId, models } }); }
        catch { throw new Error('providers.saveFailed'); }
        if (jobs.get(id) === job) statuses.set(id, models.length ? 'providers.discovered' : 'providers.discoveryEmpty');
      });
    } catch (error) {
      if (!disposed && jobs.get(id) === job) statuses.set(id, error.message?.startsWith('providers.') ? error.message : 'providers.discoveryFailed');
    } finally {
      if (jobs.get(id) === job) {
        scheduler.cancelDelay(job.timeout); jobs.delete(id); publish();
      }
    }
  }
  function schedule(id) {
    cancel(id);
    const profile = values().providerProfiles.find(item => item.id === id);
    if (!profile || baseUrlError(profile.baseUrl) || !secrets.resolve(profile.secretId)?.trim()) return;
    const job = {};
    job.timer = scheduler.delay(600, () => { if (!disposed && jobs.get(id) === job) void refresh(id); });
    jobs.set(id, job);
  }
  return {
    watch(element, callback) {
      for (const [previous, listener] of listeners) if (listener.connected && !previous.isConnected) listeners.delete(previous);
      listeners.set(element, { callback, connected: element.isConnected === true });
    },
    status: id => statuses.get(id) ?? 'providers.discoveryHelp',
    refresh,
    run(action) {
      const connectionEdit = action.type === 'connection' || action.type === 'delete';
      const revision = (revisions.get(action.id) ?? 0) + 1;
      if (connectionEdit) { revisions.set(action.id, revision); cancel(action.id); }
      edits++;
      return enqueue(async () => {
        applyProviderAction(values(), action);
        await write({ providerAction: action });
        if (action.type === 'connection' && revisions.get(action.id) === revision) schedule(action.id);
        return true;
      }).catch(error => {
        notice(error.message?.startsWith('providers.') ? error.message : 'providers.saveFailed'); return false;
      }).finally(() => { edits--; publish(); });
    },
    dispose() {
      disposed = true;
      for (const id of jobs.keys()) cancel(id);
      listeners.clear();
    },
  };
}

module.exports = { discoverModels, createProviderManager };
