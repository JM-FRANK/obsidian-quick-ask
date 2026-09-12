#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function exportQuickAsk({ source, ref, out, worktree = false }) {
  const git = args => execFileSync('git', ['-C', source, ...args], { maxBuffer: 32 * 1024 * 1024 });
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
  const available = new Set(git(['ls-tree', '-r', '--name-only', commit]).toString().trim().split('\n'));
  const read = name => worktree ? fs.readFileSync(path.join(source, name)) : git(['show', `${commit}:${name}`]);
  if (worktree) {
    for (const directory of ['src/quick-ask', 'release/quick-ask']) {
      const walk = folder => {
        for (const entry of fs.readdirSync(path.join(source, folder), { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue;
          const name = `${folder}/${entry.name}`;
          if (entry.isDirectory()) walk(name);
          else if (entry.isFile()) available.add(name);
        }
      };
      walk(directory);
    }
  }
  const pkg = JSON.parse(read('release/quick-ask/package.json'));
  const manifest = JSON.parse(read('release/quick-ask/manifest.json'));
  if (pkg.version !== manifest.version) throw new Error('Quick Ask package and manifest versions differ');
  const tests = pkg.scripts.test.split(/\s+/).filter(name => /^tests\/[\w-]+\.cjs$/.test(name));
  const managed = new Map();
  for (const name of [...available].sort()) {
    if (name.startsWith('src/quick-ask/') && /\.(js|css)$/.test(name) ||
        name.startsWith('release/quick-ask/') && /\.(js|cjs|json|md|yml)$/.test(name)) managed.set(name, read(name));
  }
  for (const name of ['scripts/quick-ask-runtime.cjs', 'scripts/quick-ask-export.cjs', 'scripts/quick-ask-release.cjs', ...tests]) {
    managed.set(name, read(name));
  }
  for (const name of ['package.json', 'package-lock.json', 'manifest.json', 'versions.json', 'README.md']) {
    managed.set(name, read(`release/quick-ask/${name}`));
  }
  for (const name of ['verify.yml', 'release.yml', 'sync.yml']) managed.set(`.github/workflows/${name}`, read(`release/quick-ask/workflows/${name}`));
  if (available.has('release/quick-ask/LICENSE') || worktree && fs.existsSync(path.join(source, 'release/quick-ask/LICENSE'))) {
    managed.set('LICENSE', read('release/quick-ask/LICENSE'));
  }
  managed.set('.gitignore', Buffer.from('node_modules/\ndist/\n'));
  const sourceHashes = Object.fromEntries([...managed].map(([name, bytes]) => [name, hash(bytes)]));
  const provenance = {
    schemaVersion: 1,
    upstreamCommit: commit,
    preview: worktree,
    sourceTreeSha256: hash(JSON.stringify(sourceHashes)),
    files: sourceHashes,
  };
  const destination = path.resolve(out);
  const sourceDirectory = path.resolve(source);
  if (destination === sourceDirectory || sourceDirectory.startsWith(destination + path.sep)) throw new Error('Export destination cannot contain the source repository');
  let previous = null;
  if (fs.existsSync(destination) && fs.readdirSync(destination).some(name => name !== '.git')) {
    const marker = path.join(destination, 'upstream.json');
    if (!fs.existsSync(marker)) throw new Error('Refusing to overwrite a directory without Quick Ask provenance');
    previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (previous.schemaVersion !== 1 || !previous.files) throw new Error('Unsupported provenance schema');
    for (const [name, expected] of Object.entries(previous.files)) {
      if (path.posix.isAbsolute(name) || name.split('/').some(part => part === '..' || part === '.git')) throw new Error('Unsafe managed path');
      const file = path.join(destination, name);
      if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink() || hash(fs.readFileSync(file)) !== expected) {
        throw new Error(`Downstream edit detected: ${name}. Fix upstream or restore before syncing.`);
      }
    }
    for (const name of managed.keys()) {
      if (!Object.hasOwn(previous.files, name) && fs.existsSync(path.join(destination, name))) throw new Error(`Unmanaged file would be overwritten: ${name}`);
    }
  }
  // Reject symlink parents before any writes.
  for (const name of managed.keys()) {
    let current = destination;
    for (const part of ['.', ...name.split('/')]) {
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Export cannot follow symlinks');
    }
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const name of Object.keys(previous?.files ?? {})) {
    if (!managed.has(name)) fs.unlinkSync(path.join(destination, name));
  }
  for (const [name, bytes] of managed) {
    fs.mkdirSync(path.dirname(path.join(destination, name)), { recursive: true });
    fs.writeFileSync(path.join(destination, name), bytes);
  }
  fs.writeFileSync(path.join(destination, 'upstream.json'), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
  const source = option('--source');
  const ref = option('--ref');
  const out = option('--out');
  if (!source || !ref || !out) throw new Error('Usage: --source <local upstream checkout> --ref <commit/tag> --out <directory> [--worktree (preview only)]');
  const result = exportQuickAsk({ source: path.resolve(source), ref, out, worktree: args.includes('--worktree') });
  console.log(`Exported ${result.upstreamCommit}${result.preview ? ' (uncommitted preview; cannot release)' : ''}`);
}
module.exports = { exportQuickAsk };
