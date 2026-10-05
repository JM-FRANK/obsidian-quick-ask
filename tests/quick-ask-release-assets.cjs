// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

for (const existing of [true, false]) {
test(`release CLI ${existing ? 'refreshes a draft' : 'prepares a draft'} with only installation files and checksum notes`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-ask-asset-policy-'));
  const script = require.resolve('../scripts/quick-ask-release.cjs');
  const version = '1.0.4';
  const digest = data => createHash('sha256').update(data).digest('hex');
  const files = {
    'manifest.json': JSON.stringify({ id: 'quick-ask', name: 'Quick Ask', author: 'FRANK-SMITH', description: 'Ask AI.', version, minAppVersion: '1.13.7', isDesktopOnly: true }),
    'package.json': JSON.stringify({ version, license: 'Apache-2.0' }),
    'package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'versions.json': JSON.stringify({ [version]: '1.13.7' }),
    'upstream.json': JSON.stringify({ schemaVersion: 1, preview: false, upstreamCommit: 'a'.repeat(40), files: {}, sourceTreeSha256: digest('{}') }),
    'main.js': '// license included\nmodule.exports = {};', 'styles.css': '.fixture {}',
    'LICENSE': 'Apache License', 'NOTICE': 'Copyright fixture', 'THIRD_PARTY_NOTICES.md': 'Dependency licenses',
    'README.md': 'Readme', 'CHANGELOG.md': `## ${version} — Updates\n\n- Fixture.`,
    'docs/community-submission.md': 'Submission', 'docs/compatibility.md': 'Compatibility',
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  const calls = [];
  let notes;
  const module = { exports: {} };
  const localRequire = name => {
    if (name === 'node:child_process') return { execFileSync(command, args) {
      calls.push({ command, args });
      if (command === 'git') return args[0] === 'status' ? '' : 'b'.repeat(40);
      if (command === 'npm') return '';
      if (command !== 'gh') throw Error('Unexpected command');
      if (args[0] === 'api') return existing ? JSON.stringify({ tag_name: version, draft: true }) : '';
      if (args[1] === 'edit' || args[1] === 'create') notes = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
      return '';
    } };
    return require(name);
  };
  localRequire.main = module;
  try {
    vm.runInNewContext(fs.readFileSync(script, 'utf8'), { require: localRequire, module, exports: module.exports,
      __dirname: path.join(root, 'scripts'), process: { argv: ['node', script], env: {} }, console: { log() {} } }, { filename: script });
    const command = calls.find(call => call.command === 'gh' && call.args[1] === (existing ? 'upload' : 'create')).args;
    const uploaded = Array.from(command.slice(existing ? 4 : command.indexOf('--notes-file') + 2), name => path.basename(name));
    assert.deepEqual(uploaded, ['main.js', 'manifest.json', 'styles.css']);
    for (const name of uploaded) assert.ok(notes.includes(`${digest(files[name])}  ${name}`));
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) assert.equal(fs.existsSync(path.join(root, name)), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

}
