# The desktop release

Friends get one file, **DopasPurifierSetup.exe**, from this stable link:

https://github.com/codemaker66/discord-stuff/releases/latest/download/DopasPurifierSetup.exe

The installer puts Vencord into their Discord app, with the purifier built in as a Vencord
userplugin, and the purifier switches itself on. After that, their Vencord updates itself from this
repository's releases, the same way official Vencord updates from Vendicated's.

| File | What it does |
| --- | --- |
| `vencord.json` | The pin: the exact Vencord commit we build, and the pinned official Vencord installer CLI (v1.4.2, by URL, size and sha256). |
| `build-vencord.mjs` | Builds Vencord at the pin with `dist/vencord/dopasPurifier/` inside. `--follow` checks and moves the pin. |
| `release.mjs` | Publishes one GitHub release with everything in it. |
| `release-order.mjs` | Tells `release.mjs` whether a commit may become the latest release (never one the latest already contains). Tested by `node --test desktop/release-order.test.mjs`. |
| `RELEASE_NOTES.md` | The release notes template (`{{VERSION}}`, `{{VENCORD}}`, `{{HASH}}`, `{{DATE}}`). |
| `installer/` | The installer app (Tauri v2), built to `installer/dist-exe/DopasPurifierSetup.exe`. |
| `../.github/workflows/desktop.yml` | Runs all of the above on GitHub Actions. |

## What a release holds

- Tag `desktop-v<version>-<hash>`, for example `desktop-v4.2.0-1a2b3c4`.
- Title `Dopa's Discord Purifier <version> for the Discord app · Vencord <label> · <hash>`.
- `patcher.js`, `preload.js`, `renderer.js` and `renderer.css`, with their `.map` and `.LEGAL.txt`
  files. This is Vencord's standalone build with the purifier inside.
- `DopasPurifierSetup.exe`, the installer.
- `build.json`: `{"purifier": "4.2.0", "vencord": "v1.15.16", "hash": "1a2b3c4", "builtAt": "<ISO time>"}`.
- `SHA256SUMS.txt`, with one `<sha256>  <name>` line for every other file. Check them with `sha256sum -c SHA256SUMS.txt`.

`<version>` is `package.json`'s version. `<hash>` is the first 7 characters of the commit
being released from this repository. `<label>` comes from `vencord.json`.

## How CI releases

`.github/workflows/desktop.yml` starts in three ways:

- **A push to main** that touches `src/**`, `tools/build.mjs`, `dist/vencord/**`, `desktop/**`
  or `package.json` releases that commit.
- **Every day at 05:23 UTC**, the `sync` job checks whether official Vencord users got a new build.
  If they did, it moves the pin, commits `Follow Vencord to <label>` as github-actions[bot],
  pushes to main and releases that commit in the same run. A push made with the workflow token
  starts no new run, which is why the same run carries on. It also releases main when main has
  changes no release carries yet: the hash ending the latest release's name is not main's, and
  main differs from that commit in the paths a push releases for. That catches a push whose run
  GitHub dropped (a waiting run is cancelled when a newer one queues behind it) or that failed.
  If none of that applies, the run stops there.
- **By hand** (Actions → desktop → Run workflow), which runs the same sync. Tick *force* to
  release main even when Vencord has not moved.

After `sync`, two jobs run side by side. `vencord` (Ubuntu) checks that `dist/` matches `src/`,
then runs `build-vencord.mjs`. `installer` (Windows) runs `npm ci && npm run build:exe` in
`desktop/installer`. When both succeed, `release` runs `release.mjs`. The concurrency group
`desktop-release` keeps two runs from releasing at once, and `release.mjs` never releases a
commit that the latest desktop release already contains (it says so and exits 0). Without that,
a push that waited behind a daily sync would be released after the sync's newer "Follow Vencord"
commit and take every friend back to the older build.

## Releasing by hand

You need Node 22, git and the GitHub CLI signed in (`gh auth status`). The installer also needs
Rust stable (MSVC) and WebView2. Run these from the repository root:

```sh
npm run build && npm run check          # dist/ must match src/, the plugin especially
git push                                # the release commit must be on GitHub (see below)
hash=$(git rev-parse HEAD | cut -c1-7)
node desktop/build-vencord.mjs --hash $hash --remote codemaker66/discord-stuff \
  --work E:/claude/vencord-build/vencord --out desktop/out --pnpm-dirs E:/claude/vencord-build/pnpm
(cd desktop/installer && npm ci && npm run build:exe)
node desktop/release.mjs --out desktop/out --exe desktop/installer/dist-exe/DopasPurifierSetup.exe --dry-run
node desktop/release.mjs --out desktop/out --exe desktop/installer/dist-exe/DopasPurifierSetup.exe
```

- `--work` is a folder the script owns. It is reset to the pin on every build, and reused when
  it is already there, so a second build takes about 15 seconds. The script refuses a folder it
  did not make, so it can never touch your own Vencord checkout. On other machines,
  `--work desktop/work` works too, and git ignores it, like `desktop/out`.
- `--pnpm-dirs` keeps pnpm's store, cache and state off C:. pnpm 12 still writes one empty lock
  file to `%LOCALAPPDATA%\pnpm-store-operation-locks`, because it asks Windows for that folder
  directly.
- pnpm is always the version in Vencord's `packageManager` (12.15.0 at v1.15.16), run with
  `npx --yes pnpm@<version>`. Plain `pnpm` or corepack on this PC cannot start pnpm 12.
- `--dry-run` prints the `gh release create` command, the checksums and the rendered notes.
  It also lists what a real run would refuse: a missing installer, an unpushed commit or an
  existing tag. Nothing is written or uploaded.
- `release.mjs` refuses a build whose `patcher.js` does not carry this repository and the
  build's hash, and an existing tag. It releases nothing when the latest desktop release already
  contains the commit (compared on GitHub, so a shallow clone is fine), and refuses when it
  cannot find out. It checks afterwards that `releases/latest` is the new release.

## The pin and the daily sync

`vencord.json` pins Vencord to a full commit SHA, and pins it to **what official Vencord users
run**, which is not always the newest tag. Official Vencord updates from
`Vendicated/Vencord`'s latest release, the "DevBuild", which Vencord rebuilds on every push to
its main that touches the source. That release's name ends with the commit it was built from
(`DevBuild 383409e`). So the rule, here and in CI, is:

1. Read the name of `Vendicated/Vencord`'s latest release. Its last word is the commit hash.
2. Resolve that hash to a full SHA. That SHA is the pin.
3. For the label, take the `package.json` version at that commit: `v1.15.16` when the commit is
   that version's tag, or `v1.15.16+abc1234` when it is later.

Check or move the pin yourself:

```sh
node desktop/build-vencord.mjs --follow           # shows the pin and what official users get
node desktop/build-vencord.mjs --follow --write   # moves the pin there
```

On 9 Nov 2026, DevBuild and tag v1.15.16 were the same commit,
`383409e6a6ec9008ee8a7496500f1e75f17824d1`. That commit is the pin, labelled `v1.15.16`.

Because friends' builds follow official Vencord's own cadence, when a Discord update breaks
Vencord, friends get the fix within a day of official users: at the next 05:23 UTC run, or sooner
with *Run workflow*.

## Why the hash must end the release name

A friend's Vencord was built with `VENCORD_REMOTE=codemaker66/discord-stuff` and
`VENCORD_HASH=<hash>`. Its updater (`src/main/updater/http.ts` in Vencord) does three things:

- It reads `https://api.github.com/repos/codemaker66/discord-stuff/releases/latest` and takes
  **the last space-separated word of the release name** as that release's build hash. If that
  word differs from its own `VENCORD_HASH`, an update is available.
- It downloads every asset whose name starts with `patcher.js`, `preload.js`, `renderer.js` or
  `renderer.css` into its `dist` folder.
- It shows a changelog from `/compare/<its hash>...HEAD` on this repository.

So:

- The last word of the title must be exactly the hash the files were built with. If it is
  anything else, every friend sees an update forever, even right after updating.
- The commit must be on GitHub, or the changelog call fails. `release.mjs` checks this.
- Every desktop release must be the latest release (`--latest`), and no other release in this
  repository may take that spot.
- No other asset may have a name that starts with those four prefixes.

The 7-character sha in the tag and the title is the same one passed to `--hash`.

## Licence (GPL-3.0)

Vencord is licensed GPL-3.0-or-later. A desktop release distributes a **modified Vencord**:
official Vencord with the purifier added as a userplugin, built with this repository as its
update source. As the GPL requires, its complete corresponding source is public:

- Vencord's source at the pinned commit, `Vendicated/Vencord@<ref>` in `vencord.json`.
- This repository at the released commit. The plugin's source is `src/` (`main.js`,
  `engine.js`, `ui.js`, `styles.css`, wrapped by `src/vencord.js`). `tools/build.mjs`
  generates `dist/vencord/dopasPurifier/index.js` from it, and `desktop/build-vencord.mjs`
  holds the build steps and settings.

The plugin is distributed inside Vencord as part of that combined work, under the GPL-3.0-or-later.
Every release's notes end with links to both source trees at the exact commits, and the
`.LEGAL.txt` files from Vencord's build ship as release assets. The official installer CLI
(Vencord/Installer v1.4.2, GPL-3.0) is pinned in `vencord.json`. If a release ever ships that exe
itself, its source is Vencord/Installer at v1.4.2.
