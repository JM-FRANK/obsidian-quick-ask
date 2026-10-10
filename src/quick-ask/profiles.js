const { DEFAULT_ROLE_INSTRUCTIONS } = require('./prompt-renderer');
const { t } = require('./i18n');

const DEFAULT_PROFILE_ID = 'default';
const STUDY_PROFILE_ID = 'study-quiz';
const STUDY_ROLE_INSTRUCTIONS = '你是 Obsidian Quick Ask 中的学习出题助手。根据用户提供的学习笔记，结合你的知识出题，检验知识掌握、理解和应用能力。以笔记为主要依据，超出笔记范围的题目标注为拓展题；发现明显错误时指出，不将其作为标准答案。\n\n遵循用户指定的题量、题型和难度；未指定时出 3 道由浅入深的题，先不给答案。用户作答后，准确评判并简要解释，针对薄弱点继续练习。\n\n除非用户明确要求，不显示行号相关信息。';

// The legacy systemPrompt remains the active request value. Profiles are a
// settings catalog only; session snapshots and renderer semantics stay intact.
function normalizeProfiles(saved = {}) {
  const profiles = [];
  const seen = new Set();
  for (const profile of Array.isArray(saved.systemProfiles) ? saved.systemProfiles : []) {
    if (!profile || typeof profile.id !== 'string' || !profile.id || seen.has(profile.id)) continue;
    if (![DEFAULT_PROFILE_ID, STUDY_PROFILE_ID].includes(profile.id) && (typeof profile.name !== 'string' || !profile.name.trim())) continue;
    seen.add(profile.id);
    profiles.push({ id: profile.id, name: typeof profile.name === 'string' && profile.name.trim() ? profile.name : null,
      prompt: typeof profile.prompt === 'string' ? profile.prompt : '', showDefaultRole: profile.showDefaultRole === true });
  }
  if (!seen.has(DEFAULT_PROFILE_ID)) profiles.unshift({ id: DEFAULT_PROFILE_ID, name: null,
    prompt: typeof saved.systemPrompt === 'string' ? saved.systemPrompt : '',
    showDefaultRole: !Object.hasOwn(saved, 'systemPrompt') });
  // Upgrade once, preserving every existing role and the current selection.
  // The marker survives saves/exports, so explicitly deleting the added role
  // does not cause it to reappear on every subsequent load.
  const initialProfilesVersion = Number.isInteger(saved.initialProfilesVersion) && saved.initialProfilesVersion > 0
    ? saved.initialProfilesVersion : 0;
  if (initialProfilesVersion < 1) {
    let study = profiles.find(profile => profile.id === STUDY_PROFILE_ID);
    if (!study) {
      study = { id: STUDY_PROFILE_ID, name: null, prompt: STUDY_ROLE_INSTRUCTIONS, showDefaultRole: false };
      profiles.push(study);
    }
    if (study.name === null) {
      const occupied = new Set(profiles.filter(profile => profile !== study).flatMap(profile =>
        ['zh-CN', 'en'].map(language => profileName(profile, language).toLocaleLowerCase())));
      const chinese = t('zh-CN', 'profiles.studyQuiz');
      const english = t('en', 'profiles.studyQuiz');
      if (occupied.has(chinese.toLocaleLowerCase()) || occupied.has(english.toLocaleLowerCase())) {
        const base = occupied.has(chinese.toLocaleLowerCase()) ? `${chinese}-默认` : `${english}-Default`;
        let name = base, n = 1;
        while (occupied.has(name.toLocaleLowerCase())) {
          name = base === `${chinese}-默认` ? `${base}（${n++}）` : `${base} (${n++})`;
        }
        study.name = name;
      }
    }
  }
  const activeSystemProfileId = profiles.some(profile => profile.id === saved.activeSystemProfileId)
    ? saved.activeSystemProfileId : DEFAULT_PROFILE_ID;
  // Compatibility boundary: the persisted legacy field is authoritative on
  // load/import. A mismatch means an older writer edited it, so clear display
  // prefill explicitly. Ordinary profile actions operate on this normalized
  // catalog and publish the selected prompt back to the legacy field once.
  const current = profiles.find(profile => profile.id === activeSystemProfileId);
  if (typeof saved.systemPrompt === 'string' && saved.systemPrompt !== current.prompt) {
    current.prompt = saved.systemPrompt;
    current.showDefaultRole = false;
  }
  return { systemProfiles: profiles, activeSystemProfileId, initialProfilesVersion: Math.max(1, initialProfilesVersion) };
}

function activeProfile(settings) {
  const catalog = normalizeProfiles(settings);
  return catalog.systemProfiles.find(profile => profile.id === catalog.activeSystemProfileId);
}
function profileName(profile, settings) {
  return profile.name ?? t(settings, profile.id === STUDY_PROFILE_ID ? 'profiles.studyQuiz' : 'profiles.default');
}
function profilePromptText(profile) { return profile.showDefaultRole && !profile.prompt ? DEFAULT_ROLE_INSTRUCTIONS : profile.prompt; }

// Actions run against the latest settings inside the host writer. Editing the
// visible default is explicit custom text; Reset restores the empty sentinel.
function applyProfileAction(settings, action, languageSettings) {
  const catalog = normalizeProfiles(settings);
  const profiles = catalog.systemProfiles;
  const selected = profiles.find(profile => profile.id === action.id);
  if (action.type === 'add' || action.type === 'rename') {
    const name = typeof action.name === 'string' ? action.name.trim() : '';
    if (!name || profiles.some(profile => profile.id !== (action.type === 'rename' ? action.id : null)
      && profileName(profile, languageSettings).toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('profiles.invalidName');
    if (action.type === 'add') {
      if (!action.id || profiles.some(profile => profile.id === action.id)) throw new Error('profiles.invalidName');
      profiles.push({ id: action.id, name, prompt: '', showDefaultRole: true });
      catalog.activeSystemProfileId = action.id;
    } else {
      if (!selected) throw new Error('profiles.missing');
      selected.name = name;
    }
  } else {
    if (!selected) throw new Error('profiles.missing');
    if (action.type === 'select') catalog.activeSystemProfileId = action.id;
    else if (action.type === 'delete') {
      if (action.id === DEFAULT_PROFILE_ID) throw new Error('profiles.keepDefault');
      profiles.splice(profiles.indexOf(selected), 1);
      if (catalog.activeSystemProfileId === action.id) catalog.activeSystemProfileId = DEFAULT_PROFILE_ID;
    } else if (action.type === 'prompt') {
      selected.prompt = String(action.prompt ?? ''); selected.showDefaultRole = false;
    } else if (action.type === 'reset') {
      selected.prompt = action.id === STUDY_PROFILE_ID ? STUDY_ROLE_INSTRUCTIONS : '';
      selected.showDefaultRole = action.id !== STUDY_PROFILE_ID;
    } else throw new Error('profiles.missing');
  }
  return { ...catalog, systemPrompt: profiles.find(profile => profile.id === catalog.activeSystemProfileId).prompt };
}

// Shared settings/command action path, serialized for both host writers.
function createProfileManager({ getSettings, write, changed, notice }) {
  let pending = Promise.resolve();
  let revision = 0;
  const listeners = new Map();
  const publish = () => {
    changed();
    for (const [element, listener] of listeners) {
      if (element.isConnected) {
        listener.connected = true;
        listener.callback();
      } else if (listener.connected) listeners.delete(element);
      // Settings may register while their page is still being constructed.
      // Keep unmounted subscriptions until they connect or the manager disposes.
    }
  };
  return {
    watch(element, callback) {
      for (const [previous, listener] of listeners) {
        if (listener.connected && !previous.isConnected) listeners.delete(previous);
      }
      listeners.set(element, { callback, connected: element.isConnected === true });
    },
    dispose() { listeners.clear(); },
    run(action) {
      const ownRevision = ++revision;
      const operation = pending.then(async () => {
        const before = activeProfile(getSettings().quickAsk).id;
        // Validate now for localized errors; the writer also applies to its
        // latest state, avoiding a stale whole-settings replacement.
        applyProfileAction(getSettings().quickAsk, action, getSettings());
        await write({ profileAction: { ...action, language: getSettings().language } });
        if (ownRevision === revision) publish();
        if (before !== activeProfile(getSettings().quickAsk).id) notice('profiles.newSessionsOnly');
      });
      pending = operation.catch(error => {
        if (ownRevision === revision) publish();
        notice(error.message.startsWith('profiles.') ? error.message : 'profiles.saveFailed');
      });
      return pending;
    },
  };
}
module.exports = { DEFAULT_PROFILE_ID, STUDY_PROFILE_ID, STUDY_ROLE_INSTRUCTIONS, normalizeProfiles, activeProfile, profileName, profilePromptText, applyProfileAction, createProfileManager };
