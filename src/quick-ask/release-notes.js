// Filled by the standalone builder so preview tags need not match the numeric
// Obsidian manifest version. Source helpers fall back to the manifest version.
const RELEASE_TAG = null;
const RELEASES_URL = 'https://github.com/JM-FRANK/obsidian-quick-ask/releases';
// Optional short Markdown notice, independent of the detailed GitHub release.
const UPDATE_NOTICE = { message: { en: '', 'zh-CN': '' }, showPreview: true };

function versionParts(version) {
  const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/.exec(version);
  return match ? [...match.slice(1, 4).map(Number), { alpha: 0, beta: 1, rc: 2 }[match[4]] ?? 3, Number(match[5] ?? 0)] : null;
}

function releaseTagFor(version, tag = RELEASE_TAG) {
  const selected = tag || version;
  if (!versionParts(selected) || selected.split('-', 1)[0] !== version) throw new Error('Release tag must match the manifest version');
  return selected;
}

function releasePageUrl(tag) { return `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`; }

function releaseNoticePlan(currentVersion, lastSeenVersion) {
  const current = versionParts(currentVersion), previous = versionParts(lastSeenVersion);
  if (!current) return { remember: false, show: false };
  if (!previous) return { remember: true, show: false };
  for (let index = 0; index < current.length; index++) {
    if (current[index] !== previous[index]) {
      const upgrade = current[index] > previous[index];
      return { remember: upgrade, show: upgrade };
    }
  }
  return { remember: false, show: false };
}

async function fetchReleaseNotes(tag, request) {
  const response = await request({
    url: `https://api.github.com/repos/JM-FRANK/obsidian-quick-ask/releases/tags/${encodeURIComponent(tag)}`,
    headers: { Accept: 'application/vnd.github+json' }, throw: false,
  });
  if (response.status !== 200) throw Object.assign(new Error('Could not load release notes'), { status: response.status });
  const release = response.json;
  if (release.tag_name !== tag || release.draft || (release.body !== null && typeof release.body !== 'string')) throw new Error('Invalid release response');
  return release.body ?? '';
}

module.exports = { UPDATE_NOTICE, RELEASES_URL, releaseTagFor, releasePageUrl, releaseNoticePlan, fetchReleaseNotes };
