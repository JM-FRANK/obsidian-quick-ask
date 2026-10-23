#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Obsidian installs these three files. License notices remain in the source
// repository and are embedded in main.js; checksums belong in release notes.
const assets = ['main.js', 'manifest.json', 'styles.css'];
// Git tags identify preview builds; Obsidian's manifest remains numeric x.y.z.
function releaseTarget(version, { tag = version, prerelease = false } = {}) {
  if (prerelease) {
    const prefix = `${version}-`;
    if (typeof tag !== 'string' || !tag.startsWith(prefix) || !/^(alpha|beta|rc)\.[1-9]\d*$/.test(tag.slice(prefix.length)))
      throw new Error('A prerelease tag must match the manifest version plus -alpha.N, -beta.N or -rc.N (N >= 1)');
  } else if (tag !== version) throw new Error('A custom preview tag requires --prerelease');
  return { tag, prerelease };
}
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
  for (const name of [...assets, 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'CHANGELOG.md', 'docs/community-submission.md', 'docs/compatibility.md']) {
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
  const tagIndex = process.argv.indexOf('--tag');
  if (tagIndex >= 0 && !process.argv[tagIndex + 1]) throw new Error('--tag requires a value');
  const target = releaseTarget(manifest.version, {
    tag: tagIndex >= 0 ? process.argv[tagIndex + 1] : process.env.QUICK_ASK_RELEASE_TAG || manifest.version,
    prerelease: process.argv.includes('--prerelease') || process.env.QUICK_ASK_PRERELEASE === 'true',
  });
  const tag = target.tag;
  const releaseFlags = target.prerelease ? ['--prerelease', '--latest=false'] : [];
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim()) throw new Error('Commit the synchronized source snapshot before creating a release');
  execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'inherit' });
  if (process.argv.includes('--check')) process.exit(0);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const gh = args => execFileSync('gh', args, { cwd: root, encoding: 'utf8' });
  // Query failure must abort rather than be mistaken for an absent release.
  const releases = gh(['api', '--paginate', 'repos/{owner}/{repo}/releases', '--jq', '.[] | {tag_name,draft} | @json'])
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const existing = releases.find(release => release.tag_name === tag);
  if (existing && !existing.draft) throw new Error('This tag is already published; use the next preview tag or bump upstream version rather than overwrite it');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-ask-release-'));
  try {
    const notesPath = path.join(temp, 'release-notes.md');
    const attested = process.env.QUICK_ASK_ATTESTED === 'true';
    const sums = assets.map(name => `${digest(fs.readFileSync(path.join(root, name)))}  ${name}`).join('\n');
    fs.writeFileSync(notesPath, `${target.prerelease ? `> Preview build for testing: ${tag}. The plugin manifest uses ${manifest.version}; this is not a stable release.\n\n` : ''}${notes}\n\nGenerated from Scholar Workbench commit ${provenance.upstreamCommit}.\nSource tree SHA-256: ${provenance.sourceTreeSha256}.\n\nInstallation file SHA-256:\n\n\`\`\`text\n${sums}\n\`\`\`\n\n${attested ? 'Installation assets have GitHub build provenance attestations.' : 'Preparation draft: build provenance attestations have not been generated. Run the public-repository release workflow before community submission.'}\n`);
    if (existing) {
      gh(['release', 'edit', tag, '--draft', '--target', revision, '--title', `Quick Ask ${tag}`, ...releaseFlags, '--notes-file', notesPath]);
      gh(['release', 'upload', tag, '--clobber', ...assets]);
    } else {
      gh(['release', 'create', tag, '--draft', '--target', revision, '--title', `Quick Ask ${tag}`, ...releaseFlags, '--notes-file', notesPath, ...assets]);
    }
    console.log(gh(['release', 'view', tag, '--json', 'url', '--jq', '.url']).trim());
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
module.exports = { validateRelease, releaseTarget };
