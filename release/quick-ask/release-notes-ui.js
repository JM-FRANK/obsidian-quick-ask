const { Modal, Component, MarkdownRenderer, requestUrl } = require('obsidian');
const { t } = require('../../src/quick-ask/i18n');
const { UPDATE_NOTICE, RELEASES_URL, releaseTagFor, releasePageUrl, releaseNoticePlan, fetchReleaseNotes } = require('../../src/quick-ask/release-notes');

class ReleaseNotesModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.tag = releaseTagFor(plugin.manifest.version);
    this.generation = 0;
  }
  onOpen() {
    this.opened = true;
    this.modalEl.addClass('scholar-quick-ask-release-notes');
    const settings = this.plugin.settings.values();
    this.translate = key => t(settings, key);
    this.component = new Component();
    this.component.load();
    this.titleEl.setText(t(settings, 'updates.title', { version: this.tag }));
    const message = UPDATE_NOTICE.message[settings.language] || UPDATE_NOTICE.message.en;
    if (message) {
      const intro = this.contentEl.createDiv({ cls: 'markdown-rendered' });
      void MarkdownRenderer.render(this.plugin.app, message, intro, '', this.component).catch(() => {
        if (this.opened) intro.setText(message);
      });
    }
    if (UPDATE_NOTICE.showPreview) {
      this.contentEl.createEl('h3', { text: this.translate('updates.previewTitle') });
      this.contentEl.createEl('p', { text: this.translate('updates.previewDescription') });
      this.contentEl.createEl('p', { text: this.translate('updates.previewCompatibility') });
      this.link(this.translate('updates.previewLink'), RELEASES_URL);
    }
    this.contentEl.createEl('hr');
    this.contentEl.createEl('h3', { text: this.translate('updates.releaseHeading') });
    this.link(this.translate('updates.releaseLink'), releasePageUrl(this.tag));
    this.status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    this.body = this.contentEl.createDiv({ cls: 'markdown-rendered' });
    void this.loadRelease();
  }
  link(text, href) {
    this.contentEl.createEl('a', { text, attr: { href, target: '_blank', rel: 'noopener noreferrer' } });
  }
  async loadRelease() {
    const generation = ++this.generation;
    this.releaseComponent?.unload();
    this.body.empty();
    this.status.hidden = false;
    this.status.setText(this.translate('updates.loading'));
    try {
      const markdown = await fetchReleaseNotes(this.tag, requestUrl);
      if (generation !== this.generation) return;
      this.releaseComponent = new Component();
      this.releaseComponent.load();
      if (markdown.trim()) await MarkdownRenderer.render(this.plugin.app, markdown, this.body, '', this.releaseComponent);
      else this.body.createEl('p', { text: this.translate('updates.empty') });
      if (generation === this.generation) this.status.hidden = true;
    } catch (error) {
      if (generation !== this.generation) return;
      this.releaseComponent?.unload();
      this.body.empty();
      this.status.setText(this.translate(error.status === 404 ? 'updates.notPublished' : 'updates.failed'));
    }
  }
  onClose() {
    this.opened = false;
    this.generation++;
    this.component?.unload();
    this.releaseComponent?.unload();
    this.contentEl.empty();
  }
}

function registerReleaseNotes(plugin) {
  let active = true;
  let modal = null;
  const open = () => {
    if (!active) return;
    modal?.close();
    modal = new ReleaseNotesModal(plugin);
    modal.open();
  };
  plugin.register(() => { active = false; modal?.close(); modal = null; });
  plugin.addCommand({ id: 'show-release-notes', name: t(plugin.settings.values(), 'updates.command'), callback: open });
  plugin.app.workspace.onLayoutReady(() => {
    if (!active) return;
    const tag = releaseTagFor(plugin.manifest.version);
    const plan = releaseNoticePlan(tag, plugin.settings.values().lastSeenReleaseNotesVersion);
    if (plan.show) open();
    if (plan.remember) void plugin.settings.update({ lastSeenReleaseNotesVersion: tag })
      .catch(error => console.error('Quick Ask: could not save the release-notes version', error));
  });
}

module.exports = { registerReleaseNotes };
