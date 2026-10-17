// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const QUICK_ASK = path.join(ROOT, 'src', 'quick-ask');
const FORBIDDEN = ['transport.js', 'search-client.js', 'web-search.js'];

// Inspect the same resolver and entry used by scripts/quick-ask-runtime.cjs.
// Building in memory does not evaluate the bundle or create an EditorView.
function forbiddenDependencies(entry) {
  const { metafile } = esbuild.buildSync({
    absWorkingDir: ROOT,
    ...entry,
    bundle: true,
    write: false,
    metafile: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
  });
  const inputs = new Set(Object.keys(metafile.inputs).map(input => path.resolve(ROOT, input)));
  return FORBIDDEN.filter(name => inputs.has(path.join(QUICK_ASK, name)));
}

test('the Composer bundle excludes transport and search dependencies', () => {
  assert.deepEqual(forbiddenDependencies({
    entryPoints: [path.join(QUICK_ASK, 'composer-view.js')],
  }), []);
});

test('the dependency guard detects parent-relative requires and ES imports', () => {
  assert.deepEqual(forbiddenDependencies({
    stdin: {
      contents: 'require("../quick-ask/transport"); import "./web-search.js"; require("./search-client");',
      resolveDir: QUICK_ASK,
      sourcefile: 'dependency-regression-fixture.js',
    },
  }), FORBIDDEN);
});

// Execute only the shipped pure dependency factories, never the Composer/DOM.
function runtimeDependencies() {
  const vm = require('node:vm');
  const runtime = require('../scripts/quick-ask-runtime.cjs')(ROOT);
  const factories = vm.runInNewContext(`({${runtime.quickAskDependencies}})`, { TextEncoder, TextDecoder });
  const dependencies = {};
  for (const [name, factory] of Object.entries(factories)) {
    const module = { exports: {} };
    factory(module, module.exports, id => { throw new Error(`Unexpected dependency external: ${id}`); });
    dependencies[name] = module.exports;
  }
  return { runtime, dependencies };
}

test('shipped dependency facades expose only the consumed APIs and stay within the size budget', () => {
  const { runtime, dependencies } = runtimeDependencies();
  const expected = { 'diff': ['createTwoFilesPatch'], 'eventsource-parser': ['createParser'],
    'zustand/vanilla': ['createStore'], 'tokenx': ['estimateTokenCount'] };
  assert.deepEqual(Object.keys(dependencies).sort(), Object.keys(expected).sort());
  for (const [name, exports] of Object.entries(expected)) assert.deepEqual(Object.keys(dependencies[name]), exports);
  assert.ok(Buffer.byteLength(runtime.quickAskDependencies) < 30000, 'unused package APIs must not return');
  assert.ok(Buffer.byteLength(runtime.composerModule) < 650000, 'generated editor formatting must not inflate the installation');
});

test('shipped diff and token functions match the pinned source APIs exactly', () => {
  const { dependencies } = runtimeDependencies();
  const diff = require('diff').createTwoFilesPatch;
  const estimate = require('tokenx').estimateTokenCount;
  for (const [before, after] of [
    ['', 'first\n'], ['same\n', 'same\n'], ['one\ntwo\n', 'one\nthree\n'],
    ['no newline', 'changed'], ['中文\r\n😀\r\n', '中文\r\n更改 😀\r\n'],
    ['line\n'.repeat(200), 'prefix\n' + 'line\n'.repeat(200)],
  ]) assert.equal(dependencies.diff.createTwoFilesPatch('a.md', 'b.md', before, after, undefined, undefined, { context: 3 }),
    diff('a.md', 'b.md', before, after, undefined, undefined, { context: 3 }));
  for (const text of ['', 'Hello world', '中文日本語 😀', '<context_selection>\n1 | exact text\n</context_selection>',
    'const value = "test";\n'.repeat(1000)]) assert.equal(dependencies.tokenx.estimateTokenCount(text), estimate(text));
});

test('shipped SSE parsing and state subscriptions retain source behavior', () => {
  const { dependencies } = runtimeDependencies();
  function parse(createParser) {
    const events = [];
    const parser = createParser({ onEvent: event => events.push(event), onRetry: retry => events.push({ retry }),
      onError: error => events.push({ type: error.type, field: error.field, message: error.message }) });
    for (const chunk of ['event: answer\r\n', 'data: fir', 'st\r\ndata: second\r\n\r\n',
      'retry: 1200\n\n', 'invalid: field\n\n', 'data: [DONE]\n\n']) parser.feed(chunk);
    return JSON.parse(JSON.stringify(events));
  }
  assert.deepEqual(parse(dependencies['eventsource-parser'].createParser), parse(require('eventsource-parser').createParser));
  function changes(createStore) {
    const store = createStore(() => ({ count: 0 }));
    const seen = [];
    const stop = store.subscribe((state, previous) => seen.push([state.count, previous.count]));
    store.setState({ count: 1 }); store.setState(state => ({ count: state.count + 1 }));
    stop(); store.setState({ count: 3 });
    return { seen, final: store.getState().count };
  }
  assert.deepEqual(changes(dependencies['zustand/vanilla'].createStore), changes(require('zustand/vanilla').createStore));
});
