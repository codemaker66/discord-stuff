// node --test desktop/release-order.test.mjs
// releaseOrder against a fake `gh api` over a small commit graph:
//
//   O --- H --- X        H: Blake's push. X: the daily sync's "Follow Vencord" commit on top of it.
//    \
//     D                  D: a commit off to the side (diverged from H and X).
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseOrder } from './release-order.mjs';

const sha = (c) => c.repeat(40);
const [O, H, X, D] = ['0', '1', '2', '3'].map(sha);
const parents = { [O]: [], [H]: [O], [X]: [H], [D]: [O] };
const ancestors = (c) => [c, ...parents[c].flatMap(ancestors)];
const REPO = 'codemaker66/discord-stuff';
const ok = (out) => ({ ok: true, out, err: '' });
const fail = (err) => ({ ok: false, out: '', err });

// What GitHub would answer, given the latest release (null for none) and its commit.
function fakeGh(latest, { broken } = {}) {
  const calls = [];
  const api = (endpoint, jq) => {
    calls.push(endpoint);
    if (broken === endpoint.split('/')[3]) return fail('gh: Server Error (HTTP 502)');
    if (endpoint === `repos/${REPO}/releases/latest`) {
      if (!latest) return fail('gh: Not Found (HTTP 404)');
      assert.match(jq, /tag_name/);
      return ok(`${latest.tag}\t${latest.commitish ?? 'main'}`);
    }
    const tagged = endpoint.match(/^repos\/[^/]+\/[^/]+\/commits\/(.+)$/);
    if (tagged) return decodeURIComponent(tagged[1]) === latest?.tag ? ok(latest.commit) : fail('gh: No commit found (HTTP 422)');
    const cmp = endpoint.match(/\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/);
    if (cmp) {
      const [, base, head] = cmp;
      const a = ancestors(head).filter((c) => !ancestors(base).includes(c)).length;
      const b = ancestors(base).filter((c) => !ancestors(head).includes(c)).length;
      const status = a && b ? 'diverged' : a ? 'ahead' : b ? 'behind' : 'identical';
      return ok(`${status}\t${a}\t${b}`);
    }
    throw new Error(`unexpected gh api ${endpoint}`);
  };
  return { api, calls };
}

const release = (commit) => ({ tag: `desktop-v4.2.0-${commit.slice(0, 7)}`, commit });

test('the race: sync released X on top of H, so H is not released after it', () => {
  const { api } = fakeGh(release(X));
  const r = releaseOrder({ repo: REPO, target: H, api });
  assert.equal(r.release, false, JSON.stringify(r));
  assert.match(r.reason, /already contains 1111111 \(behind, 1 commit\(s\) behind it\)/);
});

test('a newer commit is released over an older one', () => {
  const r = releaseOrder({ repo: REPO, target: X, api: fakeGh(release(H)).api });
  assert.deepEqual(r, { release: true, reason: '2222222 is 1 commit(s) ahead of desktop-v4.2.0-1111111' });
});

test('the commit that is already latest is not released again', () => {
  const r = releaseOrder({ repo: REPO, target: X, api: fakeGh(release(X)).api });
  assert.equal(r.release, false);
  assert.match(r.reason, /already releases this commit/);
});

test('a diverged commit is released (main was rewritten, or the latest came from a side branch)', () => {
  assert.equal(releaseOrder({ repo: REPO, target: H, api: fakeGh(release(D)).api }).release, true);
});

test('no release yet, or a latest release that is not a desktop one: release', () => {
  assert.deepEqual(releaseOrder({ repo: REPO, target: H, api: fakeGh(null).api }), { release: true, reason: `${REPO} has no release yet` });
  const other = { tag: 'v4.2.0', commit: X };
  assert.equal(releaseOrder({ repo: REPO, target: H, api: fakeGh(other).api }).release, true);
});

test('the tag is preferred over target_commitish, which is used when the tag cannot be read', () => {
  const { api, calls } = fakeGh({ ...release(X), commitish: X });
  assert.equal(releaseOrder({ repo: REPO, target: H, api }).release, false);
  assert.ok(calls.some((c) => c.endsWith('/commits/desktop-v4.2.0-2222222')));
  const noTag = (endpoint, jq) => (endpoint.includes('/commits/') ? fail('gh: Not Found (HTTP 404)') : api(endpoint, jq));
  assert.equal(releaseOrder({ repo: REPO, target: H, api: noTag }).release, false);
});

test('when GitHub cannot be asked, the answer is an error, never a release', () => {
  for (const broken of ['releases', 'compare']) {
    const r = releaseOrder({ repo: REPO, target: H, api: fakeGh(release(X), { broken }).api });
    assert.ok(r.error && r.release === undefined, `${broken}: ${JSON.stringify(r)}`);
  }
  const branchOnly = { ...release(X), commitish: 'main' };
  const noTag = (endpoint, jq) => (endpoint.includes('/commits/') ? fail('gh: Not Found (HTTP 404)') : fakeGh(branchOnly).api(endpoint, jq));
  assert.ok(releaseOrder({ repo: REPO, target: H, api: noTag }).error);
  assert.ok(releaseOrder({ repo: REPO, target: 'abc1234', api: fakeGh(null).api }).error, 'a short sha is refused');
});
