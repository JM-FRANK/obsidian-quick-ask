// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ANSWER_RESERVE_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_CALL_LIMIT,
  defaultQuickAskSettings,
  normalizeQuickAskSettings,
  normalizeCallLimit,
  normalizeBaseUrl,
  baseUrlError,
  validateQuickAskSettings,
  sessionConfigSnapshot,
  redactQuickAskSettings,
  normalizeDisplaySettings,
  quickAskDisplayPage,
  BUBBLE_COLOR_DEFAULTS,
} = require('../src/quick-ask/settings');

test('display settings validate independently from frozen session configuration', () => {
  const display = normalizeDisplaySettings({ fontSize: 18, lineHeight: 1.7, paragraphSpacing: 0, showReasoning: false });
  assert.equal(display.fontSize, 18);
  assert.equal(display.lineHeight, 1.7);
  assert.equal(display.paragraphSpacing, 0);
  assert.equal(display.showReasoning, false);
  assert.equal(normalizeDisplaySettings({ fontSize: 300, lineHeight: NaN }).fontSize, 14);
  assert.equal(normalizeDisplaySettings({ lineHeight: NaN }).lineHeight, 1.5);
  assert.equal(sessionConfigSnapshot({ display }).display, undefined);
  assert.equal(quickAskDisplayPage({}).items.length, 9);
  assert.equal(redactQuickAskSettings({ display }).display.fontSize, 18);
});

test('bubble colors normalize hex values while theme defaults remain the default mode', () => {
  assert.equal(normalizeDisplaySettings().customBubbleColors, false);
  const custom = normalizeDisplaySettings({ customBubbleColors: true, userBubbleColor: ' #ABC ', assistantBubbleColor: '#12ABef' });
  assert.equal(custom.userBubbleColor, '#aabbcc');
  assert.equal(custom.assistantBubbleColor, '#12abef');
  assert.equal(normalizeDisplaySettings({ userBubbleColor: 'url(example)' }).userBubbleColor, BUBBLE_COLOR_DEFAULTS.userBubbleColor);
  const off = normalizeDisplaySettings({ ...custom, customBubbleColors: false });
  assert.equal(off.userBubbleColor, custom.userBubbleColor);
  assert.equal(sessionConfigSnapshot({ display: custom }).display, undefined);
  assert.deepEqual(redactQuickAskSettings({ display: custom }).display, custom);
});

test('bubble tint rows use the public native color control and follow the custom-color toggle', () => {
  const settings = { quickAsk: { display: { customBubbleColors: false } } };
  const colors = quickAskDisplayPage(settings).items.filter(item => item.control.type === 'color');
  assert.equal(colors.length, 2);
  assert.equal(colors[0].control.disabled(), true);
  settings.quickAsk.display.customBubbleColors = true;
  assert.equal(colors[0].control.disabled(), false);
  assert.equal(colors[1].control.disabled(), false);
});


test('network sends stay off until the user asks a question, so the feature defaults to on', () => {
  const defaults = defaultQuickAskSettings();
  assert.equal(defaults.enable, true);
  assert.equal(defaults.baseUrl, '');
  assert.equal(defaults.secretId, '');
  assert.equal(defaults.model, '');
  assert.equal(defaults.systemPrompt, '');
  assert.equal(defaults.callLimit, DEFAULT_CALL_LIMIT);
  assert.equal(defaults.preservedCopy.enabled, false);
});

test('a new installation starts with the 256K context capacity and the fixed answer reserve is not a setting', () => {
  const defaults = defaultQuickAskSettings();
  assert.equal(defaults.contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS);
  assert.equal(ANSWER_RESERVE_TOKENS, 16384);
  assert.equal(Object.hasOwn(defaults, 'answerReserveTokens'), false);
  assert.equal(normalizeQuickAskSettings({}).contextWindowTokens, DEFAULT_CONTEXT_WINDOW_TOKENS);
});

test('Base URL normalization strips trailing slashes, trims, and never appends /v1', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1');
  assert.equal(normalizeBaseUrl('  https://api.deepseek.com//  '), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('https://api.openai.com'), 'https://api.openai.com');
  assert.equal(normalizeBaseUrl(undefined), '');
  assert.equal(normalizeBaseUrl(42), '');
});

test('only http and https roots are accepted, and the /responses suffix is refused inline', () => {
  assert.equal(baseUrlError('https://api.openai.com/v1'), null);
  assert.equal(baseUrlError('http://127.0.0.1:11434'), null);
  assert.equal(baseUrlError('ftp://example.com'), 'baseUrlScheme');
  assert.equal(baseUrlError('api.openai.com/v1'), 'baseUrlScheme');
  assert.equal(baseUrlError(''), 'baseUrlMissing');
  assert.equal(baseUrlError('https://api.openai.com/v1/responses'), 'baseUrlResponses');
  assert.equal(baseUrlError('https://api.openai.com/v1/responses/'), 'baseUrlResponses');
});

test('the full-file call limit normalizes stored integers from 1 to 10 and falls back to 3', () => {
  assert.equal(normalizeCallLimit(1), 1);
  assert.equal(normalizeCallLimit(10), 10);
  assert.equal(normalizeCallLimit(0), 3);
  assert.equal(normalizeCallLimit(11), 3);
  assert.equal(normalizeCallLimit(2.5), 3);
  assert.equal(normalizeCallLimit('4'), 3);
  assert.equal(normalizeCallLimit(undefined), 3);
});

test('clearing the context capacity disables proactive compaction instead of restoring the default', () => {
  assert.equal(normalizeQuickAskSettings({ contextWindowTokens: '' }).contextWindowTokens, null);
  assert.equal(normalizeQuickAskSettings({ contextWindowTokens: null }).contextWindowTokens, null);
  assert.equal(normalizeQuickAskSettings({ contextWindowTokens: 0 }).contextWindowTokens, null);
  assert.equal(normalizeQuickAskSettings({ contextWindowTokens: 131072 }).contextWindowTokens, 131072);
  assert.equal(normalizeQuickAskSettings({ contextWindowTokens: 'abc' }).contextWindowTokens, null);
});

test('declarative validation reports each missing item inline and claims no capability', () => {
  const empty = validateQuickAskSettings({});
  assert.equal(empty.valid, false);
  assert.deepEqual(Object.keys(empty.errors).sort(), ['baseUrl', 'model', 'secretId']);

  const complete = validateQuickAskSettings({
    baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', secretId: 'openai-key',
  });
  assert.equal(complete.valid, true);
  assert.deepEqual(complete.errors, {});
});

test('a capacity at or below the fixed answer reserve is an inline error treated as no capacity', () => {
  const base = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', secretId: 'key' };
  for (const value of [16384, 8192, 1]) {
    const result = validateQuickAskSettings({ ...base, contextWindowTokens: value });
    assert.equal(result.valid, false);
    assert.equal(result.errors.contextWindowTokens, 'contextWindowReserve');
  }
  assert.equal(validateQuickAskSettings({ ...base, contextWindowTokens: 16385 }).valid, true);
  assert.equal(validateQuickAskSettings({ ...base, contextWindowTokens: '' }).valid, true);
});

test('a session snapshots endpoint, model, credential reference, prompt, and capacity once', () => {
  const settings = {
    baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat', secretId: 'deepseek-key',
    systemPrompt: 'Be terse.', contextWindowTokens: 131072, callLimit: 5, language: 'zh-CN',
  };
  const snapshot = sessionConfigSnapshot(settings, { createdAt: '2026-09-12T00:00:00.000Z' });
  assert.deepEqual(snapshot, {
    protocol: 'responses',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    secretId: 'deepseek-key',
    systemPrompt: 'Be terse.',
    contextWindowTokens: 131072,
    callLimit: 5,
    language: 'zh-CN',
    createdAt: '2026-09-12T00:00:00.000Z',
  });
  assert.equal(sessionConfigSnapshot({}).callLimit, DEFAULT_CALL_LIMIT);
  assert.equal(sessionConfigSnapshot({}).language, 'en');
});

test('settings that leave the machine carry the secret reference only, never a value', () => {
  const redacted = redactQuickAskSettings({
    secretId: 'openai-key',
    baseUrl: 'https://api.openai.com/v1',
    secretValue: 'sk-live-secret-value',
  });
  assert.equal(redacted.secretId, 'openai-key');
  // The redaction is an allowlist: a value field on the input cannot survive it.
  for (const forbidden of ['secretValue', 'apiKey', 'key', 'value', 'token']) {
    assert.equal(Object.hasOwn(redacted, forbidden), false, `${forbidden} must not be exported`);
  }
  assert.equal(JSON.stringify(redacted).includes('sk-live-secret-value'), false);
  assert.deepEqual(Object.keys(redacted).sort(), [
    'baseUrl', 'callLimit', 'contextWindowTokens', 'display', 'enable', 'model', 'preservedCopy', 'protocol', 'secretId', 'systemPrompt', 'webSearch',
  ]);
});

test('search preferences patch independently and export only named secrets',()=>{
 const {applyQuickAskPatch}=require('../src/quick-ask/settings');
 const {quickAskControlPatch,quickAskControlValue}=require('../src/quick-ask/settings-controls');
 const target=normalizeQuickAskSettings({webSearch:{provider:'exa',secretId:'search-reference',defaultEnabled:true,apiKey:'PRIVATE_KEY'}});
 applyQuickAskPatch(target,quickAskControlPatch('quickAsk.webSearch.defaultEnabled',false));
 assert.equal(quickAskControlValue({quickAsk:target},'quickAsk.webSearch.defaultEnabled'),false);
 assert.equal(target.webSearch.provider,'exa');assert.equal(target.webSearch.secretId,'search-reference');
 assert.equal(JSON.stringify(redactQuickAskSettings(target)).includes('PRIVATE_KEY'),false);
});


test('search method defaults to DuckDuckGo and keeps provider secret references separate',()=>{
 const {applyQuickAskPatch}=require('../src/quick-ask/settings');
 const settings=normalizeQuickAskSettings({webSearch:{provider:'exa',secretId:'exa-ref'}});
 assert.equal(normalizeQuickAskSettings({}).webSearch.provider,'duckduckgo');
 applyQuickAskPatch(settings,{webSearch:{provider:'parallel'}});
 assert.equal(settings.webSearch.secretId,'');
 applyQuickAskPatch(settings,{webSearch:{secretId:'parallel-ref'}});
 applyQuickAskPatch(settings,{webSearch:{provider:'exa'}});
 assert.equal(settings.webSearch.secretId,'exa-ref');
 assert.equal(settings.webSearch.secretIds.parallel,'parallel-ref');
});

test('search settings expose only the selected method configuration',()=>{
 const {searchSettingsPage}=require('../src/quick-ask/settings-ui');
 const make=provider=>{const data={language:'en',quickAsk:normalizeQuickAskSettings({webSearch:{provider}})};return searchSettingsPage({settings:data,current:()=>data},class {});};
 assert.equal(make('duckduckgo').items.some(i=>i.render),false);
 assert.equal(make('server').items.some(i=>i.render),false);
 const exa=make('exa');assert.equal(exa.items.filter(i=>i.render).length,2);
 assert.ok(exa.items.some(i=>i.name==='Exa API Key'));
 assert.equal(exa.items.some(i=>i.name==='Parallel API Key'),false);
});
