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
