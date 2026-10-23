const { providerSettings } = require("./provider-settings");
const { profileSettings } = require("./profile-settings");
const { normalizeSearchSettings } = require("./web-search");
const { t } = require("./i18n");
const { quickAskDisplayPage } = require("./settings");

function quickAskPreservedStatusDescription(host) {
  const preserved = host.quickAskIntegration?.preservedCopy?.() ?? null;
  if (!preserved?.enabled) return t(host.settings, "settings.quickAsk.preservedCopy.off");
  const plaintext = t(host.settings, "settings.quickAsk.preservedCopy.plaintext");
  if (preserved.unsynchronized) return `${plaintext} ${t(host.settings, "settings.quickAsk.preservedCopy.unsynchronized")}`;
  if (preserved.lastError) {
    return `${plaintext} ${t(host.settings, "settings.quickAsk.preservedCopy.failed", { error: preserved.lastError })}`;
  }
  return `${plaintext} ${t(host.settings, "settings.quickAsk.preservedCopy.synced", { at: preserved.lastSuccessAt ?? "" })}`;
}

function renderQuickAskDataActions(host, setting) {
  setting.addExtraButton((button) => button
    .setIcon("download")
    .setTooltip(t(host.settings, "settings.quickAsk.data.export"))
    .onClick(async () => {
      const result = await host.quickAskIntegration?.exportData?.();
      if (result?.status === "exported") await host.quickAskIntegration.writeClipboard?.(result.text);
      host.update();
    }));
  setting.addExtraButton((button) => button
    .setIcon("upload")
    .setTooltip(t(host.settings, "settings.quickAsk.data.import"))
    .onClick(async () => {
      const text = await host.quickAskIntegration?.readClipboard?.();
      if (typeof text === "string") await host.quickAskIntegration?.importData?.(text);
      host.update();
    }));
  setting.addExtraButton((button) => button
    .setIcon("trash-2")
    .setTooltip(t(host.settings, "settings.quickAsk.data.clear"))
    .onClick(async () => {
      // Clearing is destructive, so it asks first with the host's own dialog.
      const confirmed = await host.quickAskIntegration?.confirmClear?.();
      if (confirmed === false) return;
      await host.quickAskIntegration?.clearData?.();
      host.update();
    }));
}

const SEARCH_INFO = {
  firecrawl: { name: "Firecrawl", url: "https://www.firecrawl.dev/", placeholder: "fc-…" },
  exa: { name: "Exa", url: "https://dashboard.exa.ai/api-keys", placeholder: "API key" },
  parallel: { name: "Parallel", url: "https://platform.parallel.ai/", placeholder: "API key" },
  perplexity: { name: "Perplexity Search", url: "https://docs.perplexity.ai/", placeholder: "pplx-…" },
};
function searchSettingsPage(host, SecretComponent) {
  const values = normalizeSearchSettings(host.current().quickAsk?.webSearch);
  const info = SEARCH_INFO[values.provider];
  const tr = key => t(host.settings, key);
  const items = [
    { name: tr("search.provider"), desc: tr("search.manualDescription"), control: { type: "dropdown", key: "quickAsk.webSearch.provider", options: {
      duckduckgo: "DuckDuckGo", server: tr("search.serverOption"), ...Object.fromEntries(Object.entries(SEARCH_INFO).map(([id, info]) => [id, info.name])),
    } } },
    { name: tr("search.default"), desc: tr("search.defaultDescription"), control: { type: "toggle", key: "quickAsk.webSearch.defaultEnabled" } },
  ];
  if (values.provider === "duckduckgo") items.push({ name: "DuckDuckGo", desc: tr("search.duckHelp") });
  else if (values.provider === "server") items.push({ name: tr("search.serverOption"), desc: tr("search.serverHelp") });
  else if (info) {
    items.push({ name: `${info.name} API Key`, desc: tr("search.keyHelp"), render: setting => {
      setting.descEl.createEl("a", { text: tr("search.openProvider"), attr: { href: info.url, target: "_blank", rel: "noopener noreferrer" } });
      let key = "", keyInput;
      setting.addText(text => {
        keyInput = text;
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "new-password";
        text.setPlaceholder(info.placeholder).onChange(value => { key = value; });
      });
      // Raw key stays in this transient password control and goes directly to
      // public SecretStorage, never through the settings writer or a log.
      setting.addButton(button => button.setButtonText(tr("search.saveKey")).onClick(async () => {
        if (!key.trim()) { setting.setErrorMessage(tr("search.missingSecret")); return; }
        if (host.current().quickAsk.webSearch.provider !== values.provider) return;
        button.setDisabled(true);
        try {
          const id = `${host.plugin?.manifest?.id ?? "quick-ask"}-search-${values.provider}`;
          host.app.secretStorage.setSecret(id, key.trim());
          key = "";
          keyInput.setValue("");
          await host.setControlValue("quickAsk.webSearch.secretId", id);
        } catch { setting.setErrorMessage(tr("search.saveFailed")); }
        finally { button.setDisabled(false); }
      }));
    } });
    items.push({ name: tr("search.savedKey"), desc: tr("search.savedKeyHelp"), render: setting => {
      const validate = id => setting.setErrorMessage(host.app.secretStorage.getSecret(id ?? "")?.trim() ? "" : tr("search.missingSecret"));
      new SecretComponent(host.app, setting.controlEl).setValue(values.secretId).onChange(async id => {
        await host.setControlValue("quickAsk.webSearch.secretId", id ?? ""); validate(id);
      });
      validate(values.secretId);
    } });
  } else items.push({ name: tr("search.invalidProvider"), desc: tr("search.manualDescription") });
  return { type: "page", name: tr("search.title"), desc: tr("search.manualDescription"), items };
}

function quickAskPage(host, SecretComponent) {
  const tr = key => t(host.settings, key);
  const storage = host.quickAskIntegration?.storageSummary?.();
  return {
    type: "page",
    name: tr("settings.page.quickAsk.name"),
    desc: tr("settings.page.quickAsk.desc"),
    items: [
      {
        type: "group", heading: tr("settings.quickAsk.generalGroup"),
        items: [
          {
            name: tr("settings.quickAsk.enable.name"),
            desc: tr("settings.quickAsk.enable.desc"),
            control: { type: "toggle", key: "quickAsk.enable" },
          },
          {
            name: tr("settings.quickAsk.toolConcurrency.name"),
            desc: tr("settings.quickAsk.toolConcurrency.desc"),
            control: {
              type: "number", key: "quickAsk.toolConcurrency", min: 1, max: 10, step: 1,
              validate: value => Number.isInteger(value) && value >= 1 && value <= 10
                ? undefined : tr("settings.quickAsk.validation.toolConcurrency"),
            },
          },
        ],
      },
      {
        type: "page", name: tr("providers.pageTitle"), desc: tr("providers.pageDescription"),
        items: providerSettings(host, SecretComponent),
      },
      {
        type: "page", name: tr("profiles.pageTitle"), desc: tr("profiles.pageDescription"),
        items: profileSettings(host),
      },
      searchSettingsPage(host, SecretComponent),
      quickAskDisplayPage(host.settings),
      {
        type: "page", name: tr("settings.quickAsk.dataPage"), desc: tr("settings.quickAsk.dataPageDescription"),
        items: [
          {
            type: "group", heading: tr("settings.quickAsk.conversationDataGroup"),
            items: [
              { name: tr("settings.quickAsk.data.name"), desc: tr("settings.quickAsk.data.desc"),
                render: setting => renderQuickAskDataActions(host, setting) },
              { name: tr("settings.quickAsk.storage.name"), desc: storage?.text ?? "" },
            ],
          },
          {
            type: "group", heading: tr("settings.quickAsk.preservedCopy.name"),
            items: [
              { name: tr("settings.quickAsk.preservedCopy.name"), desc: tr("settings.quickAsk.preservedCopy.desc"),
                control: { type: "toggle", key: "quickAsk.preservedCopy.enabled" } },
              { name: tr("settings.quickAsk.preservedCopy.directory.name"), desc: tr("settings.quickAsk.preservedCopy.directory.desc"),
                control: { type: "text", key: "quickAsk.preservedCopy.directory" } },
              { name: tr("settings.quickAsk.preservedCopy.status.name"), desc: quickAskPreservedStatusDescription(host) },
            ],
          },
          {
            type: "group", heading: tr("settings.quickAsk.imageCacheGroup"),
            items: [{ name: tr("images.keepCache"), desc: tr("images.keepCacheHelp"),
              control: { type: "toggle", key: "quickAsk.keepCachedImages" } }],
          },
        ],
      },
    ],
  };
}

module.exports = { quickAskPage, searchSettingsPage };
