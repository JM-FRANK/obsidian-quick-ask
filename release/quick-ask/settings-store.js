const { normalizeQuickAskSettings, applyQuickAskPatch } = require('../../src/quick-ask/settings');
const { DEFAULT_LANGUAGE, LANGUAGES } = require('../../src/quick-ask/i18n');

class QuickAskSettings {
  constructor(saved, save) {
    this.state = {
      language: LANGUAGES.includes(saved?.language) ? saved.language : DEFAULT_LANGUAGE,
      quickAsk: normalizeQuickAskSettings(saved?.quickAsk),
    };
    this.save = save;
    this.pending = Promise.resolve();
  }
  values() { return { language: this.state.language, quickAsk: normalizeQuickAskSettings(this.state.quickAsk) }; }
  update(patch) {
    // Serialize mutation as well as persistence so a failed write cannot roll
    // back a later successful edit.
    const operation = this.pending.then(async () => {
      const next = this.values();
      if (LANGUAGES.includes(patch.language)) next.language = patch.language;
      applyQuickAskPatch(next.quickAsk, patch.quickAsk);
      await this.save(next);
      this.state = next;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}
module.exports = { QuickAskSettings };
