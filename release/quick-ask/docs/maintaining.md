# Maintainer workflow

Quick Ask is maintained in Scholar Workbench. The standalone repository is a generated distribution: its feature source, settings UI, translations, styles, release metadata, documentation and workflows are synchronized from an upstream commit.

## Update and synchronize

In the main Scholar Workbench checkout, update the feature and release notes. To update all version files together:

```sh
npm run version:quick-ask -- 1.0.3
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

Review, commit and push the synchronized source, metadata and provenance. Generated `main.js`, `styles.css` and `THIRD_PARTY_NOTICES.md` remain ignored local outputs; retain root `manifest.json` as release metadata. Managed-file drift is rejected; removed managed files are removed during synchronization. `upstream.json` records the source SHA and checksums. No application session data is exported by the source synchronizer.

For GitHub-based synchronization, configure `UPSTREAM_REPOSITORY` and read credentials if the upstream is private. Run **Pull Quick Ask from upstream** with a full commit SHA; it verifies the generated tree before creating a PR. Until the upstream has a remote repository, use local synchronization. A PR generated with GITHUB_TOKEN may not trigger another workflow, so the sync job performs its own tests.

## Preview releases

Use tags such as `1.1.0-beta.1`, `1.1.0-beta.2`, then `1.1.0-rc.1` before the stable `1.1.0`. The [Obsidian manifest](https://docs.obsidian.md/Reference/Manifest) keeps numeric version `1.1.0`; Git tags and GitHub's pre-release flag distinguish candidates.

Prepare preview metadata on an upstream release branch and synchronize it to downstream `preview/1.1.0`. Keep downstream `main` at the last stable manifest version: the community installer looks for the numeric tag matching that file, so a preview branch must not advertise an unpublished stable version on `main`.

Dispatch **Prepare Quick Ask release** on that preview branch with `release_tag=1.1.0-beta.1` and `prerelease=true`. The workflow validates/builds/tests/attests the exact snapshot, then prepares a draft with the pre-release flag and `latest=false`. After reviewing its three installation assets and checksums, publish that draft while retaining both flags. Published candidates are never overwritten; use the next candidate tag. Local preparation supports `npm run release:draft -- --tag 1.1.0-beta.1 --prerelease`, but still requires the public workflow for attestations.

## Prepare a release

Build locally, commit the synchronized source snapshot, then run `npm run release:check`. Use the **Prepare Quick Ask release** workflow to rebuild, test and attest the exact installation files before uploading them to a draft Release. A local `npm run release:draft` is useful for preparation, but it does not generate a GitHub attestation and its draft is explicitly marked accordingly.

Private repository runs also create preparation drafts without attestations on ordinary GitHub plans. After making the repository public, rerun the workflow to generate attestations and refresh the same unpublished draft. Published releases are never overwritten by this tool. `upstream.json` and the SHA-256 values embedded in release notes support traceability, but do not replace GitHub's signed artifact attestation.

See [Community submission](community-submission.md) for the final manual acceptance, public release and directory registration steps.


## Obsidian review recommendations

Release uploads contain only `main.js`, `manifest.json` and `styles.css`. Keep
`LICENSE` and `NOTICE` in the repository and generate `THIRD_PARTY_NOTICES.md` locally;
the builder includes their text in `main.js`. Checksums are included in release
notes instead of a separate `SHA256SUMS` attachment. This preserves notices for
Obsidian installations while avoiding unsupported download files.

For an already published release, do not run the draft-creation workflow to fix
an attachment recommendation. After review, remove only its extra attachments;
keep the existing tag, supported installation files and their attestations.
Vault enumeration and clipboard access are disclosed, user-driven capabilities,
not removed or concealed to bypass behavior detection.
