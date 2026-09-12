# Quick Ask

An independent desktop Obsidian plugin by **FRANK-SMITH** for asking AI about explicitly selected Markdown text and files. It includes local conversation history, streaming responses, context tracking, display settings, and session export/import. Opening the sidebar alone sends no note content.

Requires Obsidian **1.13.7+**. Configure a Responses-compatible Base URL, model and an Obsidian named secret in settings. Use the ribbon button or **Quick Ask: Open Quick Ask** command to open the sidebar. API keys remain in Obsidian's secret storage.

## Installation and switching

Install `main.js`, `manifest.json`, and `styles.css` into your Vault's `.obsidian/plugins/quick-ask/` directory and enable Quick Ask. Community directory publication is a separate release step.

If you already use Scholar Workbench, disable its built-in Quick Ask when switching. The two releases have separate view identities and plugin data directories. Export sessions from Scholar Workbench's Quick Ask settings and import them in this plugin's settings. Existing source sessions are retained. Select the API secret and configure the new plugin's model and endpoint; exporting sessions does not transfer secret values. If retained plaintext backup copies are enabled, select separate backup directories for the two installations.

## One upstream, two distributions

This is a generated distribution of Quick Ask from the Scholar Workbench repository. **Make source changes upstream**, including changes to this README, build scripts, settings UI and release workflows. There is no separately maintained Quick Ask implementation here.

`upstream.json` records the exact upstream commit and SHA-256 hashes of the synchronized files. Preview exports are marked and cannot be released. The independent plugin version is maintained upstream in `release/quick-ask/manifest.json`, `package.json` and `versions.json`.

## Build and verify

Use Node.js 22 and npm:

```sh
npm ci
npm run build
npm test
npm run check
```

This checkout builds without the Scholar Workbench checkout and without its Zotero, Pandoc or PDF dependencies. Tests are pure core checks; real UI testing is performed manually.

## Pull updates from a local upstream checkout

Start from a clean downstream checkout and use a committed upstream revision:

```sh
npm run sync -- --source /path/to/obsidian-scholar-workbench --ref FULL_COMMIT_SHA
npm ci
npm run build
npm test
npm run check
```

Review the diff, commit it and push. The synchronizer refuses to overwrite edits to managed downstream files. Removed upstream files are removed from the generated source snapshot. The existing `.git` directory and release history remain intact. Do not merge or cherry-pick the entire Scholar Workbench branch into this repository.

For GitHub pull automation, configure `UPSTREAM_REPOSITORY` to the actual `owner/repository` and, for a private upstream, `UPSTREAM_READ_TOKEN` with read access. Enable Actions' permission to create pull requests. Run **Pull Quick Ask from upstream** with a full commit SHA: it exports, tests and builds the snapshot, then opens a sync PR. Workflows created with `GITHUB_TOKEN` may not trigger another workflow; the sync job therefore performs verification itself.

## Releases

After merging the synchronized source and build, run **Prepare Quick Ask release** or:

```sh
npm run release:draft
```

The command checks provenance, source hashes, a clean working tree, version format, build consistency and a LICENSE, then creates a draft release whose tag matches `manifest.json`. Review and publish the draft when manual acceptance is complete. Sync never publishes automatically.

No project license has been selected yet. Set `release/quick-ask/LICENSE` upstream and sync it before creating a release or submitting to the community directory. Third-party code retains its own license notices in the bundled JavaScript.
