#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const provenance = JSON.parse(fs.readFileSync(path.join(root, 'upstream.json')));
if (provenance.preview || !/^[a-f0-9]{40}$/.test(provenance.upstreamCommit)) throw new Error('A release needs a fixed upstream commit, not a worktree preview');
if (!fs.existsSync(path.join(root, 'LICENSE'))) throw new Error('Choose a license in upstream release/quick-ask/LICENSE and sync it before publishing');
if (execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim()) throw new Error('Commit the synchronized snapshot and build before creating a release');
for (const [name, expected] of Object.entries(provenance.files)) {
  if (createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex') !== expected) throw new Error(`Downstream edit: ${name}`);
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Obsidian requires a numeric x.y.z version');
execFileSync('npm', ['run', 'check'], { cwd: root, stdio: 'inherit' });
if (process.argv.includes('--check')) process.exit(0);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
const notes = `Generated from Scholar Workbench commit ${provenance.upstreamCommit}.\nSource tree SHA-256: ${provenance.sourceTreeSha256}.\n`;
// A draft is deliberate: sync and public release are separate operations.
execFileSync('gh', ['release', 'create', manifest.version, '--draft', '--target', revision,
  '--title', `Quick Ask ${manifest.version}`, '--notes', notes,
  'main.js', 'manifest.json', 'styles.css'], { cwd: root, stdio: 'inherit' });
