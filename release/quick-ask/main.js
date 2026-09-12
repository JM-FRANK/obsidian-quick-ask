const { Plugin, PluginSettingTab, SecretComponent, Notice, editorInfoField } = require('obsidian');
const { createQuickAsk } = require('../../src/quick-ask/index');
const { quickAskPage } = require('../../src/quick-ask/settings-ui');
const { quickAskControlValue, quickAskControlPatch } = require('../../src/quick-ask/settings-controls');
const { QuickAskSettings } = require('./settings-store');

class QuickAskSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.settings = plugin.settings;
    this.quickAskIntegration = plugin.quickAsk;
  }
  current() { return this.settings.values(); }
  getControlValue(key) {
    return key === 'language' ? this.current().language : quickAskControlValue(this.current(), key);
  }
  async setControlValue(key, value) {
    const patch = key === 'language' ? { language: value } : { quickAsk: quickAskControlPatch(key, value) };
    await this.settings.update(patch);
    if (key === 'quickAsk.enable') this.quickAskIntegration.syncEnabled();
    if (key.startsWith('quickAsk.display.') || key === 'language') this.quickAskIntegration.refreshAppearance();
    this.update();
  }
  getSettingDefinitions() {
    const chinese = this.current().language === 'zh-CN';
    return [{
      name: chinese ? '界面语言' : 'Interface language',
      control: { type: 'dropdown', key: 'language', options: { en: 'English', 'zh-CN': '简体中文' } },
    }, {
      name: chinese ? '从 Scholar Workbench 切换' : 'Switching from Scholar Workbench',
      desc: chinese
        ? '建议关闭 Scholar Workbench 内置的快速提问。两者独立保存会话；可使用数据导出／导入迁移会话，并重新选择 API 密钥和模型。'
        : 'Disable Quick Ask inside Scholar Workbench when switching. History is stored separately; use Export/Import to transfer sessions and select your API secret and model again.',
    }, ...quickAskPage(this, SecretComponent).items];
  }
}

module.exports = class QuickAskPlugin extends Plugin {
  async onload() {
    this.settings = new QuickAskSettings(await this.loadData(), data => this.saveData(data));
    this.quickAsk = createQuickAsk({
      plugin: this,
      getSettings: () => this.settings.values(),
      loadEditorModules: () => ({ EditorView: require.desktop('@codemirror/view').EditorView, editorInfoField }),
    });
    this.quickAsk.sync();
    const tab = new QuickAskSettingsTab(this.app, this);
    this.addSettingTab(tab);
    void this.quickAsk.refreshStorageSummary().then(() => tab.update()).catch(error => {
      console.error('Quick Ask: storage summary failed', error);
      new Notice(this.settings.values().language === 'zh-CN' ? '快速提问：无法读取会话存储信息。' : 'Quick Ask: could not read session storage information.');
    });
  }
};
