const { activeProfile, normalizeProfiles, profileName, profilePromptText, DEFAULT_PROFILE_ID } = require('./profiles');
const { t } = require('./i18n');

function profileSettings(host) {
  const manager = host.quickAskIntegration?.profiles;
  const settings = () => host.current();
  const tr = key => t(host.settings, key);
  let syncing = false;
  const syncControls = update => {
    const previous = syncing;
    syncing = true;
    try { update(); } finally { syncing = previous; }
  };
  const run = action => { if (!syncing) return manager?.run(action); };
  return [
    { name: tr('profiles.current'), desc: tr('profiles.newSessionsOnly'), render: setting => {
      let dropdown, remove;
      setting.addDropdown(control => {
        dropdown = control;
        control.onChange(id => { void run({ type: 'select', id }); });
      });
      setting.addExtraButton(button => (remove = button).setIcon('trash-2').setTooltip(tr('profiles.delete')).onClick(async () => {
        const profile = activeProfile(settings().quickAsk);
        if (profile.id === DEFAULT_PROFILE_ID) return;
        if (await host.quickAskIntegration.environment.ui.confirm(t(host.settings, 'profiles.deleteConfirm', { name: profileName(profile, settings()) }))) {
          await run({ type: 'delete', id: profile.id });
        }
      }));
      const refresh = () => syncControls(() => {
        const catalog = normalizeProfiles(settings().quickAsk);
        dropdown.selectEl.empty();
        for (const profile of catalog.systemProfiles) dropdown.addOption(profile.id, profileName(profile, settings()));
        dropdown.setValue(catalog.activeSystemProfileId);
        remove.setDisabled(catalog.activeSystemProfileId === DEFAULT_PROFILE_ID);
      });
      refresh(); manager?.watch(setting.settingEl, refresh);
    } },
    { name: tr('profiles.name'), desc: tr('profiles.nameHelp'), render: setting => {
      let input, showingId, showingName;
      setting.addText(control => { input = control; control.setPlaceholder(tr('profiles.name')); });
      setting.addButton(button => button.setButtonText(tr('profiles.rename')).onClick(() => {
        void run({ type: 'rename', id: activeProfile(settings().quickAsk).id, name: input.getValue() });
      }));
      setting.addButton(button => button.setButtonText(tr('profiles.add')).onClick(() => {
        // Names are validated independently of IDs and never silently replaced.
        const id = `profile-${globalThis.crypto.randomUUID()}`;
        void run({ type: 'add', id, name: input.getValue() });
      }));
      const refresh = () => syncControls(() => {
        const profile = activeProfile(settings().quickAsk);
        const name = profileName(profile, settings());
        if (showingId !== profile.id || showingName !== name) input.setValue(name);
        showingId = profile.id; showingName = name;
      });
      refresh(); manager?.watch(setting.settingEl, refresh);
    } },
    { name: tr('settings.quickAsk.systemPrompt.name'), desc: tr('settings.quickAsk.systemPrompt.desc'), render: setting => {
      let input;
      setting.addTextArea(control => {
        input = control;
        control.inputEl.rows = 6;
        control.inputEl.addClass('scholar-quick-ask-profile-prompt');
        control.onChange(prompt => { void run({ type: 'prompt', id: activeProfile(settings().quickAsk).id, prompt }); });
      });
      setting.addExtraButton(button => button.setIcon('rotate-ccw').setTooltip(tr('profiles.restore')).onClick(() => {
        void run({ type: 'reset', id: activeProfile(settings().quickAsk).id });
      }));
      const refresh = () => syncControls(() => {
        const text = profilePromptText(activeProfile(settings().quickAsk));
        if (input.getValue() !== text) input.setValue(text);
      });
      refresh(); manager?.watch(setting.settingEl, refresh);
    } },
  ];
}
module.exports = { profileSettings };
