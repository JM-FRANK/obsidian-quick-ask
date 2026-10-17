// Connection profiles are separate from system-prompt profiles. This module is
// pure data; credentials are represented exclusively by SecretStorage names.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
const DEFAULT_PROVIDER_ID = 'default';
const CONNECTION_FIELDS = ['baseUrl', 'secretId', 'protocol', 'model', 'contextWindowTokens'];
const cleanUrl = value => typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
const capacity = value => value == null || value === '' ? null : Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

function modelConfig(model = {}, fallback = {}) {
  return {
    id: typeof model.id === 'string' ? model.id.trim() : '',
    protocol: typeof model.protocol === 'string' ? model.protocol : fallback.protocol ?? 'responses',
    contextWindowTokens: Object.hasOwn(model, 'contextWindowTokens') ? capacity(model.contextWindowTokens)
      : Object.hasOwn(fallback, 'contextWindowTokens') ? capacity(fallback.contextWindowTokens) : DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

function normalizeProviderProfiles(saved = {}, legacy = saved) {
  const providerProfiles = [];
  const seen = new Set();
  for (const source of Array.isArray(saved.providerProfiles) ? saved.providerProfiles : []) {
    if (!source || typeof source.id !== 'string' || !source.id || seen.has(source.id)) continue;
    seen.add(source.id);
    const models = [], modelIds = new Set();
    for (const input of Array.isArray(source.models) ? source.models : []) {
      if (!input || typeof input.id !== 'string') continue;
      const model = modelConfig(input);
      if (modelIds.has(model.id)) continue;
      modelIds.add(model.id); models.push(model);
    }
    if (!models.length) models.push(modelConfig());
    providerProfiles.push({ id: source.id, name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : null,
      baseUrl: cleanUrl(source.baseUrl), secretId: typeof source.secretId === 'string' ? source.secretId : '', models,
      selectedModelId: models.some(model => model.id === source.selectedModelId) ? source.selectedModelId : models[0].id });
  }
  if (!providerProfiles.length) {
    const model = modelConfig({ id: legacy.model ?? '', protocol: legacy.protocol ?? 'responses',
      contextWindowTokens: Object.hasOwn(legacy, 'contextWindowTokens') ? legacy.contextWindowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS });
    providerProfiles.push({ id: DEFAULT_PROVIDER_ID, name: null, baseUrl: cleanUrl(legacy.baseUrl), secretId: typeof legacy.secretId === 'string' ? legacy.secretId : '', models: [model], selectedModelId: model.id });
  }
  const activeProviderProfileId = providerProfiles.some(profile => profile.id === saved.activeProviderProfileId)
    ? saved.activeProviderProfileId : providerProfiles[0].id;
  return { providerProfiles, activeProviderProfileId };
}

function activeProvider(saved) {
  const catalog = normalizeProviderProfiles(saved);
  return catalog.providerProfiles.find(profile => profile.id === catalog.activeProviderProfileId);
}
function selectedModel(profile) { return profile.models.find(model => model.id === profile.selectedModelId); }
function providerValues(catalog) {
  const profile = activeProvider(catalog), model = selectedModel(profile);
  return { ...catalog, baseUrl: profile.baseUrl, secretId: profile.secretId, model: model.id,
    protocol: model.protocol, contextWindowTokens: model.contextWindowTokens };
}

function applyProviderAction(saved, action) {
  const catalog = normalizeProviderProfiles(saved);
  const profiles = catalog.providerProfiles;
  const profile = profiles.find(item => item.id === action.id);
  if (action.type === 'add' || action.type === 'rename') {
    const name = String(action.name ?? '').trim();
    if (!name || profiles.some(item => item.id !== (action.type === 'rename' ? action.id : null)
      && (item.name ? [item.name] : ['Default connection', '默认连接']).some(label => label.toLocaleLowerCase() === name.toLocaleLowerCase()))) throw new Error('providers.invalidName');
    if (action.type === 'add') {
      if (!action.id || profile) throw new Error('providers.missing');
      profiles.push({ id: action.id, name, baseUrl: '', secretId: '', models: [modelConfig()], selectedModelId: '' });
      catalog.activeProviderProfileId = action.id;
    } else {
      if (!profile) throw new Error('providers.missing');
      profile.name = name;
    }
  } else {
    if (!profile) throw new Error('providers.missing');
    if (action.type === 'select') catalog.activeProviderProfileId = profile.id;
    else if (action.type === 'delete') {
      if (profiles.length === 1) throw new Error('providers.lastProfile');
      profiles.splice(profiles.indexOf(profile), 1);
      if (catalog.activeProviderProfileId === profile.id) catalog.activeProviderProfileId = profiles[0].id;
    } else if (action.type === 'connection') {
      if (Object.hasOwn(action, 'baseUrl')) profile.baseUrl = cleanUrl(action.baseUrl);
      if (Object.hasOwn(action, 'secretId')) profile.secretId = String(action.secretId ?? '');
    } else if (action.type === 'model-select') {
      if (!profile.models.some(model => model.id === action.modelId)) throw new Error('providers.modelMissing');
      profile.selectedModelId = action.modelId;
    } else if (action.type === 'model-add') {
      const id = String(action.modelId ?? '').trim();
      if (!id) throw new Error('providers.modelMissing');
      if (!profile.models.some(model => model.id === id)) profile.models.push(modelConfig({ id }, selectedModel(profile)));
      profile.selectedModelId = id;
    } else if (action.type === 'model-edit') {
      const model = profile.models.find(item => item.id === action.modelId);
      if (!model) throw new Error('providers.modelMissing');
      Object.assign(model, modelConfig({ ...model, ...action.patch, id: model.id }));
    } else if (action.type === 'model-delete') {
      profile.models = profile.models.filter(model => model.id !== action.modelId);
      if (!profile.models.length) profile.models.push(modelConfig());
      if (!profile.models.some(model => model.id === profile.selectedModelId)) profile.selectedModelId = profile.models[0].id;
    } else if (action.type === 'discovered') {
      // A late response cannot populate a profile whose connection changed.
      if (profile.baseUrl !== action.baseUrl || profile.secretId !== action.secretId) return providerValues(catalog);
      for (const model of action.models) {
        if (!profile.models.some(item => item.id === model.id)) profile.models.push(modelConfig(model));
      }
    } else throw new Error('providers.missing');
  }
  return providerValues(catalog);
}

function providerPatch(saved, patch) {
  if (patch.providerAction) return applyProviderAction(saved, patch.providerAction);
  if (Object.hasOwn(patch, 'providerProfiles') || Object.hasOwn(patch, 'activeProviderProfileId')) {
    return providerValues(normalizeProviderProfiles({ ...saved, ...patch }));
  }
  let catalog = normalizeProviderProfiles(saved);
  const profile = activeProvider(catalog);
  if (Object.hasOwn(patch, 'baseUrl') || Object.hasOwn(patch, 'secretId')) catalog = applyProviderAction(catalog, { type: 'connection', id: profile.id,
    ...Object.fromEntries(['baseUrl', 'secretId'].filter(key => Object.hasOwn(patch, key)).map(key => [key, saved[key]])) });
  if (Object.hasOwn(patch, 'model')) {
    if (saved.model) catalog = applyProviderAction(catalog, { type: 'model-add', id: profile.id, modelId: saved.model });
    else {
      const current = catalog.providerProfiles.find(item => item.id === profile.id);
      if (!current.models.some(model => model.id === '')) current.models.push(modelConfig({ id: '' }, selectedModel(current)));
      current.selectedModelId = '';
    }
  }
  const modelPatch = Object.fromEntries(['protocol', 'contextWindowTokens'].filter(key => Object.hasOwn(patch, key)).map(key => [key, saved[key]]));
  if (Object.keys(modelPatch).length) catalog = applyProviderAction(catalog, { type: 'model-edit', id: profile.id, modelId: activeProvider(catalog).selectedModelId, patch: modelPatch });
  return providerValues(catalog);
}

module.exports = { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_PROVIDER_ID, CONNECTION_FIELDS, normalizeProviderProfiles, activeProvider, selectedModel, providerValues, applyProviderAction, providerPatch };
