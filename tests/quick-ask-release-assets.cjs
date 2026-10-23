// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

for (const prerelease of [false, true]) {
for (const existing of [true, false, 'published']) {
test(`release CLI ${prerelease ? 'preview' : 'stable'} ${existing === 'published' ? 'refuses a published release' : existing ? 'refreshes a draft' : 'prepares a draft'} with only installation files and checksum notes`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-ask-asset-policy-'));
  const script = require.resolve('../scripts/quick-ask-release.cjs');
  const version = '1.0.4';
  const tag = prerelease ? `${version}-beta.1` : version;
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
      if (args[0] === 'api') return existing ? JSON.stringify({ tag_name: tag, draft: existing !== 'published' }) : '';
      if (args[1] === 'edit' || args[1] === 'create') notes = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
      return '';
    } };
    return require(name);
  };
  localRequire.main = module;
  try {
    const run = () => vm.runInNewContext(fs.readFileSync(script, 'utf8'), { require: localRequire, module, exports: module.exports,
      __dirname: path.join(root, 'scripts'), process: {
        argv: ['node', script, ...(prerelease && !existing ? ['--tag', tag, '--prerelease'] : [])],
        env: prerelease && existing ? { QUICK_ASK_RELEASE_TAG: tag, QUICK_ASK_PRERELEASE: 'true' } : {},
      }, console: { log() {} } }, { filename: script });
    if (existing === 'published') {
      assert.throws(run, /already published/);
      assert.equal(calls.some(call => call.command === 'gh' && call.args[0] === 'release'), false);
      return;
    }
    run();
    const operation = calls.find(call => call.command === 'gh' && ['create', 'edit'].includes(call.args[1])).args;
    assert.equal(operation[2], tag);
    assert.equal(operation.includes('--prerelease'), prerelease);
    assert.equal(operation.includes('--latest=false'), prerelease);
    if (prerelease) assert.ok(notes.includes(`Preview build for testing: ${tag}`));
    const command = calls.find(call => call.command === 'gh' && call.args[1] === (existing ? 'upload' : 'create')).args;
    const uploaded = Array.from(command.slice(existing ? 4 : command.indexOf('--notes-file') + 2), name => path.basename(name));
    assert.deepEqual(uploaded, ['main.js', 'manifest.json', 'styles.css']);
    for (const name of uploaded) assert.ok(notes.includes(`${digest(files[name])}  ${name}`));
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) assert.equal(fs.existsSync(path.join(root, name)), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

}

}

test('release target validates candidate tags independently of numeric manifest versions', () => {
  const { releaseTarget } = require('../scripts/quick-ask-release.cjs');
  assert.deepEqual(releaseTarget('1.1.0'), { tag: '1.1.0', prerelease: false });
  for (const tag of ['1.1.0-alpha.1', '1.1.0-beta.1', '1.1.0-beta.2', '1.1.0-rc.1'])
    assert.deepEqual(releaseTarget('1.1.0', { tag, prerelease: true }), { tag, prerelease: true });
  for (const tag of ['1.1.0', 'v1.1.0-beta.1', '1.0.7-beta.1', '1.1.0-beta.0', '1.1.0-beta.01', '1.1.0-preview.1'])
    assert.throws(() => releaseTarget('1.1.0', { tag, prerelease: true }), /prerelease tag/);
  assert.throws(() => releaseTarget('1.1.0', { tag: '1.1.0-beta.1' }), /requires --prerelease/);
});
