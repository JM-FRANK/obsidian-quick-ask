const { activeProvider, selectedModel } = require('./provider-profiles');
const { contextWindowControlTokens, validContextWindowControl, quickAskControlValue } = require('./settings-controls');
const { baseUrlError, normalizeBaseUrl } = require('./settings');
const { t } = require('./i18n');

function providerSettings(host, SecretComponent) {
  const manager = host.quickAskIntegration?.providers;
  const values = () => host.current().quickAsk;
  const profile = () => activeProvider(values());
  const tr = (key, args) => t(host.settings, key, args);
  const name = item => item.name ?? tr('providers.default');
  let syncing = false;
  const run = action => syncing ? Promise.resolve(false) : manager?.run(action);
  function watch(setting, callback) {
    const refresh = () => {
      syncing = true;
      try { callback(); } finally { syncing = false; }
    };
    refresh(); manager?.watch(setting.settingEl, refresh);
  }
  const connectionItems = [
    { name: tr('providers.current'), desc: tr('providers.newSessionsOnly'), render: setting => {
      let dropdown, remove;
      setting.addDropdown(input => {
        dropdown = input;
        input.onChange(id => { void run({ type: 'select', id }); });
      });
      setting.addExtraButton(button => {
        remove = button;
        button.setIcon('trash-2').setTooltip(tr('providers.delete')).onClick(async () => {
          const current = profile();
          if (await host.quickAskIntegration.environment.ui.confirm(tr('providers.deleteConfirm', { name: name(current) }))) await run({ type: 'delete', id: current.id });
        });
      });
      watch(setting, () => {
        dropdown.selectEl.empty();
        for (const item of values().providerProfiles) dropdown.addOption(item.id, name(item));
        dropdown.setValue(profile().id);
        remove.setDisabled(values().providerProfiles.length < 2);
      });
    } },
    { name: tr('providers.name'), desc: tr('providers.nameHelp'), render: setting => {
      let input, showing;
      setting.addText(control => { input = control; });
      setting.addButton(button => button.setButtonText(tr('profiles.rename')).onClick(() => { void run({ type: 'rename', id: profile().id, name: input.getValue() }); }));
      setting.addButton(button => button.setButtonText(tr('profiles.add')).onClick(() => { void run({ type: 'add', id: `provider-${globalThis.crypto.randomUUID()}`, name: input.getValue() }); }));
      watch(setting, () => {
        const current = profile(), signature = JSON.stringify([current.id, current.name]);
        if (showing !== signature) input.setValue(name(current));
        showing = signature;
      });
    } },
    { name: tr('settings.quickAsk.baseUrl.name'), desc: tr('providers.connectionHelp'), render: setting => {
      let input, showingId;
      setting.addText(control => {
        input = control;
        control.setPlaceholder(tr('settings.quickAsk.baseUrl.example')).onChange(baseUrl => {
          if (syncing) return;
          setting.setErrorMessage(baseUrlError(normalizeBaseUrl(baseUrl)) ? tr('settings.quickAsk.validation.baseUrl') : '');
        });
        // Commit the address when editing finishes, so a pause while typing a
        // different hostname cannot send the saved key to a partial hostname.
        control.inputEl.addEventListener('blur', () => {
          const baseUrl = normalizeBaseUrl(control.getValue());
          if (baseUrl !== profile().baseUrl) void run({ type: 'connection', id: profile().id, baseUrl });
        });
      });
      watch(setting, () => {
        const current = profile();
        const editing = showingId === current.id && input.inputEl.ownerDocument?.activeElement === input.inputEl;
        if (!editing && input.getValue() !== current.baseUrl) input.setValue(current.baseUrl);
        showingId = current.id;
        setting.setErrorMessage(baseUrlError(normalizeBaseUrl(input.getValue())) ? tr('settings.quickAsk.validation.baseUrl') : '');
      });
    } },
    { name: tr('settings.quickAsk.secret.name'), desc: tr('settings.quickAsk.secret.desc'), render: setting => {
      const input = new SecretComponent(host.app, setting.controlEl);
      input.onChange(secretId => { void run({ type: 'connection', id: profile().id, secretId: secretId ?? '' }); });
      watch(setting, () => {
        input.setValue(profile().secretId);
        setting.setErrorMessage(profile().secretId ? '' : tr('settings.quickAsk.validation.required'));
      });
    } },
  ];
  const modelItems = [
    { name: tr('providers.models'), desc: tr('providers.discoveryHelp'), render: setting => {
      let dropdown, refresh;
      setting.addDropdown(control => {
        dropdown = control;
        control.onChange(modelId => { void run({ type: 'model-select', id: profile().id, modelId }); });
      });
      setting.addButton(button => {
        refresh = button;
        button.setButtonText(tr('providers.refresh')).onClick(() => { void manager?.refresh(); });
      });
      watch(setting, () => {
        const current = profile();
        dropdown.selectEl.empty();
        for (const model of current.models) dropdown.addOption(model.id, model.id || tr('providers.chooseModel'));
        dropdown.setValue(current.selectedModelId);
        const status = manager?.status(current.id) ?? 'providers.discoveryHelp';
        setting.setDesc(tr(status));
        refresh.setDisabled(status === 'providers.discovering');
      });
    } },
    { name: tr('providers.manualModel'), desc: tr('providers.manualHelp'), render: setting => {
      let input, remove;
      setting.addText(control => { input = control; });
      setting.addButton(button => button.setButtonText(tr('providers.useModel')).onClick(() => {
        void run({ type: 'model-add', id: profile().id, modelId: input.getValue() });
      }));
      setting.addExtraButton(button => {
        remove = button;
        button.setIcon('trash-2').setTooltip(tr('providers.removeModel')).onClick(() => { void run({ type: 'model-delete', id: profile().id, modelId: profile().selectedModelId }); });
      });
      let showing;
      watch(setting, () => {
        const current = profile(), signature = JSON.stringify([current.id, current.selectedModelId]);
        if (showing !== signature) input.setValue(current.selectedModelId);
        showing = signature;
        remove.setDisabled(!current.selectedModelId);
      });
    } },
    { name: tr('settings.quickAsk.protocol.name'), desc: tr('providers.modelSettings'), render: setting => {
      let input;
      setting.addDropdown(control => {
        input = control;
        control.addOption('responses', 'Responses').addOption('chat-completions', 'Chat Completions');
        control.onChange(protocol => { void run({ type: 'model-edit', id: profile().id, modelId: profile().selectedModelId, patch: { protocol } }); });
      });
      watch(setting, () => input.setValue(selectedModel(profile()).protocol));
    } },
    { name: tr('settings.quickAsk.contextWindow.name'), desc: `${tr('providers.modelSettings')} ${tr('settings.quickAsk.contextWindow.desc')}`, render: setting => {
      let input;
      setting.addText(control => {
        input = control;
        control.inputEl.setAttribute('aria-label', `${tr('settings.quickAsk.contextWindow.name')} (K)`);
        control.onChange(value => {
          if (syncing) return;
          const valid = validContextWindowControl(value);
          setting.setErrorMessage(valid ? '' : tr('settings.quickAsk.validation.contextWindow'));
          if (valid) void run({ type: 'model-edit', id: profile().id, modelId: profile().selectedModelId, patch: { contextWindowTokens: contextWindowControlTokens(value) } });
        });
      });
      setting.controlEl.createSpan({ text: 'K' });
      watch(setting, () => {
        const tokens = selectedModel(profile()).contextWindowTokens;
        const text = quickAskControlValue({ quickAsk: { contextWindowTokens: tokens } }, 'quickAsk.contextWindowTokens');
        if (input.getValue() !== text) input.setValue(text);
        setting.setErrorMessage(validContextWindowControl(text) ? '' : tr('settings.quickAsk.validation.contextWindow'));
      });
    } },
  ];
  return [
    { type: 'group', heading: tr('providers.connectionGroup'), items: connectionItems },
    { type: 'group', heading: tr('providers.modelGroup'), items: modelItems },
  ];
}

module.exports = { providerSettings };
