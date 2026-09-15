const { profileSettings } = require("./profile-settings");
const { normalizeSearchSettings } = require("./web-search");
const { t } = require("./i18n");
const { quickAskDisplayPage, baseUrlError, normalizeBaseUrl } = require("./settings");

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
  const values = host.current().quickAsk;
  const quickAsk = host.quickAskIntegration;
  const storage = quickAsk?.storageSummary?.();
  return {
    type: "page",
    name: t(host.settings, "settings.page.quickAsk.name"),
    desc: t(host.settings, "settings.page.quickAsk.desc"),
    items: [
      quickAskDisplayPage(host.settings),
      searchSettingsPage(host, SecretComponent),
      {
        type: "group",
        heading: t(host.settings, "settings.group.quickAsk"),
        items: [
          {
            name: t(host.settings, "settings.quickAsk.enable.name"),
            desc: t(host.settings, "settings.quickAsk.enable.desc"),
            control: { type: "toggle", key: "quickAsk.enable" },
          },
          {
            name: t(host.settings, "settings.quickAsk.protocol.name"),
            desc: t(host.settings, "settings.quickAsk.protocol.desc"),
            control: { type: "dropdown", key: "quickAsk.protocol", options: { responses: "Responses", "chat-completions": "Chat Completions" } },
          },
          {
            name: t(host.settings, "settings.quickAsk.baseUrl.name"),
            desc: t(host.settings, "settings.quickAsk.baseUrl.desc"),
            control: {
              type: "text", key: "quickAsk.baseUrl",
              placeholder: t(host.settings, "settings.quickAsk.baseUrl.example"),
              validate: (value) => {
                const error = baseUrlError(normalizeBaseUrl(value));
                return error ? t(host.settings, error === "baseUrlMissing" ? "settings.quickAsk.validation.required" : "settings.quickAsk.validation.baseUrl") : undefined;
              },
            },
          },
          {
            name: t(host.settings, "settings.quickAsk.secret.name"),
            desc: t(host.settings, "settings.quickAsk.secret.desc"),
            render: setting => {
              const validate = id => setting.setErrorMessage(id ? "" : t(host.settings, "settings.quickAsk.validation.required"));
              new SecretComponent(host.app, setting.controlEl).setValue(values.secretId).onChange(async id => {
                await host.setControlValue("quickAsk.secretId", id ?? "");
                validate(id);
              });
              validate(values.secretId);
            },
          },
          {
            name: t(host.settings, "settings.quickAsk.model.name"),
            desc: t(host.settings, "settings.quickAsk.model.desc"),
            control: { type: "text", key: "quickAsk.model", validate: value => String(value).trim() ? undefined : t(host.settings, "settings.quickAsk.validation.required") },
          },
          ...profileSettings(host),
          {
            name: t(host.settings, "settings.quickAsk.contextWindow.name"),
            desc: t(host.settings, "settings.quickAsk.contextWindow.desc"),
            control: {
              type: "text", key: "quickAsk.contextWindowTokens",
              validate: (value) => {
                if (value === "") return undefined;
                const tokens = Number(value);
                if (!Number.isInteger(tokens) || tokens <= 0) return t(host.settings, "settings.quickAsk.validation.contextWindow");
                return tokens > 16384 ? undefined : t(host.settings, "settings.quickAsk.validation.contextWindow");
              },
            },
          },
          {
            name: t(host.settings, "settings.quickAsk.callLimit.name"),
            desc: t(host.settings, "settings.quickAsk.callLimit.desc"),
            control: {
              type: "number", key: "quickAsk.callLimit", min: 1, max: 10, step: 1,
              validate: (value) => (Number.isInteger(value) && value >= 1 && value <= 10
                ? undefined : t(host.settings, "settings.quickAsk.validation.callLimit")),
            },
          },
        ],
      },
      {
        type: "group",
        heading: t(host.settings, "settings.quickAsk.preservedCopy.name"),
        items: [
          {
            name: t(host.settings, "settings.quickAsk.preservedCopy.name"),
            desc: t(host.settings, "settings.quickAsk.preservedCopy.desc"),
            control: { type: "toggle", key: "quickAsk.preservedCopy.enabled" },
          },
          {
            name: t(host.settings, "settings.quickAsk.preservedCopy.directory.name"),
            desc: t(host.settings, "settings.quickAsk.preservedCopy.directory.desc"),
            control: { type: "text", key: "quickAsk.preservedCopy.directory" },
          },
          {
            name: t(host.settings, "settings.quickAsk.preservedCopy.status.name"),
            desc: quickAskPreservedStatusDescription(host),
          },
          {
            name: t(host.settings, "settings.quickAsk.data.name"),
            desc: t(host.settings, "settings.quickAsk.data.desc"),
            render: (setting) => renderQuickAskDataActions(host, setting),
          },
        ],
      },
      {
        type: "group",
        heading: t(host.settings, "settings.quickAsk.storage.name"),
        items: [{ name: t(host.settings, "settings.quickAsk.storage.name"), desc: storage?.text ?? "" }],
      },
    ],
  };
}


module.exports = { quickAskPage, searchSettingsPage };
