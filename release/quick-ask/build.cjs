const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const { quickAskDependencies, composerModule, bundledPackageDirectories } = require('../../scripts/quick-ask-runtime.cjs')(root);
const projectLicense = fs.readFileSync(path.join(__dirname, "LICENSE"), "utf8");
const projectNotice = fs.readFileSync(path.join(__dirname, "NOTICE"), "utf8");
const notices = require("./build-notices.cjs")(bundledPackageDirectories);
const check = process.argv.includes('--check');
const outIndex = process.argv.indexOf('--out');
const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(root, 'dist/quick-ask');
const names = fs.readdirSync(path.join(root, 'src/quick-ask')).filter(name => name.endsWith('.js') && name !== 'composer-view.js')
  .sort().map(name => `src/quick-ask/${name}`);
names.push('release/quick-ask/settings-store.js', 'release/quick-ask/main.js');
const factories = names.map(name => {
  const source = fs.readFileSync(path.join(root, name), 'utf8');
  // Resolve every static local import at build time, leaving host externals
  // and the composer's separate bundled CodeMirror graph intact.
  const mapped = source.replace(/require\((['"])(\.[^'"]+)\1\)/g, (_match, _quote, id) => {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), id)).replace(/\.js$/, '');
    return `require(${JSON.stringify(resolved)})`;
  });
  return `${JSON.stringify(name.slice(0, -3))}: function(module, exports, require) {\n${mapped}\n}`;
}).join(',\n');
const main = (projectNotice + "\n" + projectLicense + "\n" + notices).split("\n").map(line => ("// " + line).trimEnd()).join("\n") + "\n" + `// Generated from the Scholar Workbench Quick Ask sources.\nmodule.exports = (() => {\n` +
`const factories = {${factories},\n${composerModule.replace('"./quick-ask/composer-view"', '"src/quick-ask/composer-view"')},\n${quickAskDependencies}};\n` +
`const cache = Object.create(null);\nfunction load(id) {\n` +
`if (id === 'obsidian' || id.startsWith('@codemirror/')) return require(id);\n` +
`if (!Object.hasOwn(factories, id)) throw new Error('Unknown Quick Ask module: ' + id);\n` +
`if (!cache[id]) { const m = cache[id] = { exports: {} }; factories[id](m, m.exports, load); }\nreturn cache[id].exports;\n}\n` +
`load.desktop = id => require(id);\nload.desktopFallback = id => Object.hasOwn(factories, id) ? load(id) : require(id);\n` +
`return load('release/quick-ask/main');\n})();\n`;
new vm.Script(main);
const files = {
  'main.js': main,
  'THIRD_PARTY_NOTICES.md': notices,
  'styles.css': fs.readFileSync(path.join(root, 'src/quick-ask/styles.css'), 'utf8'),
  'manifest.json': fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'),
};
if (!check) fs.mkdirSync(out, { recursive: true });
for (const [name, contents] of Object.entries(files)) {
  const target = path.join(out, name);
  if (check) {
    if (fs.readFileSync(target, 'utf8') !== contents) throw new Error(`${name} is stale`);
  } else fs.writeFileSync(target, contents);
}
console.log(check ? 'Quick Ask bundle matches source.' : `Built Quick Ask in ${out}`);
