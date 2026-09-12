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
          {
            name: t(host.settings, "settings.quickAsk.systemPrompt.name"),
            desc: t(host.settings, "settings.quickAsk.systemPrompt.desc"),
            control: { type: "textarea", key: "quickAsk.systemPrompt" },
          },
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


module.exports = { quickAskPage };
