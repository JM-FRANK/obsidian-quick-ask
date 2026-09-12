#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const assets = ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];
function validateRelease(root) {
  const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const manifest = read('manifest.json'), pkg = read('package.json'), lock = read('package-lock.json');
  const versions = read('versions.json'), provenance = read('upstream.json');
  if (provenance.preview || !/^[a-f0-9]{40}$/.test(provenance.upstreamCommit)) throw new Error('A release needs a fixed upstream commit, not a worktree preview');
  if (provenance.schemaVersion !== 1 || !provenance.files || digest(JSON.stringify(provenance.files)) !== provenance.sourceTreeSha256) throw new Error('Invalid source provenance');
  for (const [name, expected] of Object.entries(provenance.files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('Unsafe provenance path');
    if (digest(fs.readFileSync(path.join(root, name))) !== expected) throw new Error(`Downstream edit: ${name}`);
  }
  if (!versionPattern.test(manifest.version) || !versionPattern.test(manifest.minAppVersion)) throw new Error('Obsidian requires numeric x.y.z versions');
  if ([pkg.version, lock.version, lock.packages[''].version].some(value => value !== manifest.version)) throw new Error('Package, lock and manifest versions differ');
  if (versions[manifest.version] !== manifest.minAppVersion) throw new Error('versions.json does not match the manifest');
  if (manifest.id !== 'quick-ask' || manifest.name !== 'Quick Ask' || manifest.author !== 'FRANK-SMITH' || manifest.isDesktopOnly !== true) throw new Error('Unexpected plugin identity or platform metadata');
  if (typeof manifest.description !== 'string' || manifest.description.length > 250 || !manifest.description.endsWith('.')) throw new Error('Description must end with a period and contain at most 250 characters');
  if (pkg.license !== 'Apache-2.0' || !fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Apache License')) throw new Error('Quick Ask must include its Apache-2.0 license');
  for (const name of [...assets, 'README.md', 'CHANGELOG.md', 'docs/community-submission.md', 'docs/compatibility.md']) {
    if (!fs.statSync(path.join(root, name)).isFile()) throw new Error(`Missing release file ${name}`);
  }
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const heading = `## ${manifest.version} `;
  const start = changelog.indexOf(heading);
  if (start < 0) throw new Error('Add this version to CHANGELOG.md before release');
  const end = changelog.indexOf('\n## ', start + heading.length);
  return { manifest, provenance, notes: changelog.slice(start, end < 0 ? undefined : end).trim() };
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const { manifest, provenance, notes } = validateRelease(root);
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim()) throw new Error('Commit the synchronized snapshot and build before creating a release');
  execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'inherit' });
  if (process.argv.includes('--check')) process.exit(0);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const gh = args => execFileSync('gh', args, { cwd: root, encoding: 'utf8' });
  // Query failure must abort rather than be mistaken for an absent release.
  const releases = gh(['api', '--paginate', 'repos/{owner}/{repo}/releases', '--jq', '.[] | {tag_name,draft} | @json'])
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const existing = releases.find(release => release.tag_name === manifest.version);
  if (existing && !existing.draft) throw new Error('This version is already published; bump upstream version rather than overwrite it');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-ask-release-'));
  try {
    const notesPath = path.join(temp, 'release-notes.md');
    const sumsPath = path.join(temp, 'SHA256SUMS');
    const attested = process.env.QUICK_ASK_ATTESTED === 'true';
    fs.writeFileSync(notesPath, `${notes}\n\nGenerated from Scholar Workbench commit ${provenance.upstreamCommit}.\nSource tree SHA-256: ${provenance.sourceTreeSha256}.\n\n${attested ? 'Installation assets have GitHub build provenance attestations.' : 'Preparation draft: build provenance attestations have not been generated. Run the public-repository release workflow before community submission.'}\n`);
    fs.writeFileSync(sumsPath, assets.map(name => `${digest(fs.readFileSync(path.join(root, name)))}  ${name}`).join('\n') + '\n');
    if (existing) {
      gh(['release', 'edit', manifest.version, '--draft', '--target', revision, '--title', `Quick Ask ${manifest.version}`, '--notes-file', notesPath]);
      gh(['release', 'upload', manifest.version, '--clobber', ...assets, sumsPath]);
    } else {
      gh(['release', 'create', manifest.version, '--draft', '--target', revision, '--title', `Quick Ask ${manifest.version}`, '--notes-file', notesPath, ...assets, sumsPath]);
    }
    console.log(gh(['release', 'view', manifest.version, '--json', 'url', '--jq', '.url']).trim());
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
module.exports = { validateRelease };
