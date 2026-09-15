# Maintainer workflow

Quick Ask is maintained in Scholar Workbench. The standalone repository is a generated distribution: its feature source, settings UI, translations, styles, release metadata, documentation and workflows are synchronized from an upstream commit.

## Update and synchronize

In the main Scholar Workbench checkout, update the feature and release notes. To update all version files together:

```sh
npm run version:quick-ask -- 1.0.2
```

This updates the independent manifest, package metadata, lockfile and version compatibility map, preserving older entries. Add that version's notes to `release/quick-ask/CHANGELOG.md`, test and commit upstream. Do not bump the downstream package directly or reuse a published version.

In the independent checkout:

```sh
npm run sync -- --source /path/to/obsidian-scholar-workbench --ref FULL_COMMIT_SHA
npm ci
npm run build
npm test
npm run check
```

Review, commit and push the synchronized source plus build outputs, including `THIRD_PARTY_NOTICES.md`. Managed-file drift is rejected; removed managed files are removed during synchronization. `upstream.json` records the source SHA and checksums. No application session data is exported by the source synchronizer.

For GitHub-based synchronization, configure `UPSTREAM_REPOSITORY` and read credentials if the upstream is private. Run **Pull Quick Ask from upstream** with a full commit SHA; it verifies the generated tree before creating a PR. Until the upstream has a remote repository, use local synchronization. A PR generated with GITHUB_TOKEN may not trigger another workflow, so the sync job performs its own tests.

## Prepare a release

Commit the synchronized outputs, then run `npm run release:check`. Use the **Prepare Quick Ask release** workflow to rebuild, test and attest the exact installation files before uploading them to a draft Release. A local `npm run release:draft` is useful for preparation, but it does not generate a GitHub attestation and its draft is explicitly marked accordingly.

Private repository runs also create preparation drafts without attestations on ordinary GitHub plans. After making the repository public, rerun the workflow to generate attestations and refresh the same unpublished draft. Published releases are never overwritten by this tool. `upstream.json` and SHA256SUMS support traceability, but do not replace GitHub's signed artifact attestation.

See [Community submission](community-submission.md) for the final manual acceptance, public release and directory registration steps.
