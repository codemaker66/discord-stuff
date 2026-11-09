// Whether a commit may become the latest desktop release. Used by release.mjs, tested by
// release-order.test.mjs (node --test desktop/release-order.test.mjs).
//
// A friend's Vencord follows releases/latest, so releasing an older commit on top of a newer one
// takes every friend back to it, and the next daily sync sees nothing to do. Queued runs make that
// happen: while a daily sync holds the desktop-release concurrency group, a push of H waits; the
// sync then pushes a new Vencord pin X on top of H and releases X; then H's run releases H last.
// So a commit that the latest desktop release already contains (an ancestor of it, or the same
// commit) is not released.
//
//   releaseOrder({ repo, target, api }) -> { release: true|false, reason } or { error }
//
// `target` is the full sha to release. `api(endpoint, jq)` runs `gh api <endpoint> --jq <jq>` and
// returns { ok, out, err } (release.mjs's capture()).

const SHA = /^[0-9a-f]{40}$/;
const notFound = (r) => /HTTP 404/.test(`${r.err}\n${r.out}`);

export function releaseOrder({ repo, target, api }) {
  if (!SHA.test(target ?? '')) return { error: `"${target}" is not a full commit sha` };
  const latest = api(`repos/${repo}/releases/latest`, '[.tag_name, .target_commitish] | @tsv');
  if (!latest.ok) {
    if (notFound(latest)) return { release: true, reason: `${repo} has no release yet` };
    return { error: `could not read the latest release of ${repo} (${latest.err || latest.out})` };
  }
  const [tag, commitish = ''] = latest.out.split('\t');
  if (!tag.startsWith('desktop-v')) return { release: true, reason: `the latest release, ${tag}, is not a desktop release` };

  // The tag is what the release points at; target_commitish is only a sha when --target was one.
  const tagged = api(`repos/${repo}/commits/${encodeURIComponent(tag)}`, '.sha');
  const commit = tagged.ok && SHA.test(tagged.out) ? tagged.out : SHA.test(commitish) ? commitish : '';
  if (!commit) return { error: `could not tell which commit ${tag} was released from (${tagged.err || tagged.out})` };
  if (commit === target) return { release: false, reason: `${tag} already releases this commit` };

  // compare/<base>...<head> says how head stands against base.
  const cmp = api(`repos/${repo}/compare/${commit}...${target}`, '[.status, .ahead_by, .behind_by] | @tsv');
  if (!cmp.ok) return { error: `could not compare ${target.slice(0, 7)} with ${tag} (${cmp.err || cmp.out})` };
  const [status, ahead, behind] = cmp.out.split('\t');
  switch (status) {
    case 'ahead':
      return { release: true, reason: `${target.slice(0, 7)} is ${ahead} commit(s) ahead of ${tag}` };
    case 'diverged':
      return { release: true, reason: `${target.slice(0, 7)} and ${tag} have diverged (${ahead} ahead, ${behind} behind); releasing the newer push` };
    case 'behind':
    case 'identical':
      return { release: false, reason: `${tag} already contains ${target.slice(0, 7)} (${status}${behind && behind !== '0' ? `, ${behind} commit(s) behind it` : ''})` };
    default:
      return { error: `GitHub compared ${target.slice(0, 7)} with ${tag} as "${status}"` };
  }
}
