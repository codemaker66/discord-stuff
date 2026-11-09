# DopasPurifierSetup.exe

A small native Windows app (Tauri v2) that installs **Vencord with Dopa's Discord Purifier built in**
into a friend's Discord desktop app, and can repair or uninstall it. It never needs admin: everything it
touches lives in the user's own profile.

```
desktop/installer/
├─ package.json          @tauri-apps/cli (exact pin), playwright, the scripts below
├─ preview.mjs           screenshots every mock scenario of the UI (1x and 2x) into screens/
├─ scripts/build-exe.mjs builds the release exe and copies it to dist-exe/
├─ scripts/make-icon.py  the 1024px app icon (rounded tile on a transparent canvas)
├─ ui/                   the window: static HTML/CSS/JS, no bundler
│  ├─ index.html  styles.css  app.js
│  ├─ mock-tauri.js      stand-in backend for a plain browser (?scenario=...)
│  └─ fonts/ img/
└─ src-tauri/
   ├─ src/core/          the installer itself, no Tauri types (cargo test drives it)
   ├─ src/lib.rs         Tauri glue: commands, events, log file, window
   ├─ tests/core.rs      sandboxed tests, including a real run of Vencord's CLI
   └─ tauri.conf.json  manifest.xml (asInvoker)  capabilities/  icons/
```

## Build

```sh
cd desktop/installer
npm ci
npm run build:exe        # -> dist-exe/DopasPurifierSetup.exe (about 6.6 MB)
```

`build:exe` runs `npx tauri build --no-bundle` (no MSI/NSIS) and copies the exe from
`$CARGO_TARGET_DIR/release` (or `src-tauri/target/release`) to `dist-exe/`, printing its size and SHA-256.
Needs Rust (stable, MSVC) and Node 22. On this PC set `CARGO_TARGET_DIR=E:/claude/cargo-target/dopa-installer`.

## Test

```sh
cargo test --manifest-path src-tauri/Cargo.toml   # or: npm run test:rust
npm run preview                                    # needs Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH)
```

`cargo test` never touches a real install. Every test builds a fake Discord tree in a sandbox under
`CARGO_TARGET_TMPDIR`. `full_sandbox_install_with_real_cli` downloads the pinned Vencord CLI once (network
needed the first time), installs into a fake Stable, skips a fake PTB that already points at the shared Vencord
folder and a fake Canary with a developer's own build, repairs, uninstalls, and checks that every real
Discord process that was running is still running.

### Test hooks (environment variables)

| Variable | Effect |
|---|---|
| `DOPA_SANDBOX=<dir>` | %LOCALAPPDATA% becomes `<dir>\Local`, %APPDATA% becomes `<dir>\Roaming`. Closing and starting Discord become logged no-ops. The Vencord CLI is reached through a junction (see below), so it cannot kill a real Discord either. The title bar shows a SANDBOX badge. |
| `DOPA_LOCAL_BUILD=<dir>` | Take the Vencord files, `SHA256SUMS.txt` and `build.json` from this folder instead of the latest GitHub release (still checksum-verified). `src-tauri/tests/fixtures/build` is a tiny one. |
| `DOPA_SANDBOX_RUNNING=stable,ptb` | In a sandbox, which branches count as running (exercises close/restart). |

Running the real exe against a sandbox:

```powershell
$env:DOPA_SANDBOX = 'E:\some\sandbox'          # holds Local\Discord\app-1.0.9999\resources\app.asar
$env:DOPA_LOCAL_BUILD = "$PWD\src-tauri\tests\fixtures\build"
.\dist-exe\DopasPurifierSetup.exe
```

Its log is `<LOCALAPPDATA>\DopasPurifier\logs\setup-<yyyymmdd-hhmmss>.log`. Adding
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` lets Playwright drive the real window
with `chromium.connectOverCDP('http://127.0.0.1:9333')`.

## What an install does

| Step id | What happens |
|---|---|
| `close` | `taskkill /F /IM <exe> /T` for each selected branch that is running, then waits until it is gone. Remembers which were running. |
| `fetch-installer` | `VencordInstallerCli.exe` v1.4.2 from Vencord/Installer's release, cached in `%LOCALAPPDATA%\DopasPurifier\cache`, checked against the pinned size and SHA-256 (`15268aba…53ef5`). A mismatch is deleted and refused. |
| `fetch-build` | The latest release of `codemaker66/discord-stuff`: `SHA256SUMS.txt`, `build.json` and every asset starting with `patcher.js`, `preload.js`, `renderer.js` or `renderer.css`. Each must be listed in the sums and match, and the hash ending the release title must be `build.json`'s `hash` and appear quoted (`"<hash>"`) in `patcher.js`, or friends' Vencord would update in a loop; anything else refuses the install before anything is changed. |
| `place` | The files, `package.json` (`{}`) and `build.json` (the release's plus `"by": "dopas-purifier"` and `"installedAt"`) are written to `%APPDATA%\Vencord\dist.dopa-new`, then swapped in with two renames: a `dist` that is not ours becomes `%APPDATA%\Vencord\dist-backup-<yyyymmdd-hhmmss>`, our own previous build goes to `dist.dopa-old` and is deleted after. If anything fails, the old `dist` is put back and the staging folder removed, so `dist` is exactly as it was and no backup exists. Renames retry for about 1.5 s (antivirus). A run cut short (power loss) is cleaned up by the next one. Vencord's settings (`%APPDATA%\Vencord\settings`) are never touched. |
| `patch:<branch>` | Skipped when the install already loads `%APPDATA%\Vencord\dist\patcher.js` (unless Repair forces it), and for a developer's own Vencord unless the UI passes the branch in `replaceCustom`. Otherwise runs `VencordInstallerCli -install -location <install dir>` with `VENCORD_USER_DATA_DIR=%APPDATA%\Vencord` and `VENCORD_DEV_INSTALL=1`, streams its output to the log, and re-reads the stub to verify. |
| `start` | `<install dir>\Update.exe --processStart <exe>` for the branches that were running, or Stable (else the first one) when none was. |

On a failure the step turns `error`, the friend sees one friendly sentence, the full log is kept for
"Copy log", and the branches that were closed are started again.

**Uninstall** closes Discord, gets the CLI, then per installed branch either runs `-install` *without*
`VENCORD_DEV_INSTALL` (`vencord:<branch>`, "Keep Vencord": the CLI downloads official Vencord's latest
files into the same dist folder, then `build.json` is removed in the `tidy` step), or `-uninstall`
(`unpatch:<branch>`, "Remove everything"), after which the `restore` step deletes our dist and puts the
newest `dist-backup-*` back, as long as no other Discord still uses it. Then `start`.

### What the Vencord CLI source says (v1.4.2)

Read from `Vencord/Installer` at tag v1.4.2 (`cli.go`, `patcher.go`, `github_downloader.go`,
`find_discord_windows.go`, `util.go`, `app_asar.go`):

- `-install` on an already patched install (one with `_app.asar`) unpatches first and patches again, so it is
  the flag for every case. `-repair` always downloads official Vencord (it ignores `VENCORD_DEV_INSTALL`), so it
  is never used here.
- With `VENCORD_DEV_INSTALL=1` the CLI never contacts GitHub and does not write `dist\package.json`.
  Without it, `-install` downloads official Vencord whenever the first line of `patcher.js`
  (`// Vencord <hash>`) differs from the latest release.
- `-location <dir>` accepts any folder with an `app-*\resources` folder. The branch is guessed from the folder
  name's suffix (`canary`, `development`, `ptb`, otherwise stable), and before patching the CLI kills the first
  process named after that branch (`Discord.exe` for stable) **wherever it runs from**. In a sandbox the
  installer therefore passes a junction `<sandbox>\cli-view\<branch>\DiscordDevelopment`: "development" maps to
  no process name, so the CLI kills nothing.
- The stub it writes is an asar with `index.js` = `require("<VENCORD_USER_DATA_DIR>\\dist\\patcher.js")`
  and a fixed `package.json`; this PC's real stubs are 196 bytes. `core::asar::build_stub` reproduces it byte
  for byte (tested against the real stub's bytes).

## Backend API (for the UI)

The UI uses the globals Tauri injects (`withGlobalTauri`): `window.__TAURI__.core.invoke`,
`window.__TAURI__.event.listen` and `window.__TAURI__.window.getCurrentWindow()` (for minimise, close and
the `data-tauri-drag-region` title bar). Argument names are camelCase.

### Commands

| Command | Arguments | Resolves to | Rejects with |
|---|---|---|---|
| `app_info` | none | `{ version, sandbox: string\|null, logPath: string\|null }` | |
| `detect` | none | `Detection` | string |
| `install` | `{ branches: Branch[], replaceCustom?: Branch[], force?: boolean }` | `Summary` | `Failure` |
| `uninstall` | `{ branches: Branch[], keepVencord: boolean }` | `Summary` | `Failure` |
| `open_url` | `{ url }`: only `https://github.com/codemaker66/discord-stuff…`, `https://codemaker66.github.io/discord-stuff…`, `https://discord.com/download` | `null` | string |
| `launch_discord` | `{ branch }` | `null` | string |

`Branch` is `"stable" | "ptb" | "canary"`. `force: true` is Repair/Update (re-patches installs that are already
ours). Only one install or uninstall runs at a time (a second gets `Failure.code = "running"`).

```ts
type Detection = {
  installs: InstallInfo[];            // Stable, PTB, Canary order; [] when Discord isn't installed
  vencordDir: string;                 // %APPDATA%\Vencord
  installedBuild: BuildJson | null;   // our build.json when installed
  latest: { title: string; tag: string | null; hash: string | null; url: string | null;
            source: "github" | "local"; build: BuildJson | null } | null;
  network: "ok" | "offline" | "no-release" | "local";
  backups: string[];                  // %APPDATA%\Vencord\dist-backup-*, newest first
  sandbox: boolean;
  installerVersion: string;
};
type InstallInfo = {
  branch: Branch; label: string;      // "Discord" | "Discord PTB" | "Discord Canary"
  exe: string; dir: string; appDir: string; version: string;   // version "1.0.9267"
  running: boolean;
  state: "clean" | "ours" | "vencord" | "custom" | "unknown";
  patcher: string | null;             // what the app.asar stub requires
  originalAsar: boolean;              // resources\_app.asar exists
};
type BuildJson = { purifier: string; vencord: string; hash: string; builtAt: string;
                   by?: "dopas-purifier"; installedAt?: string };
type Summary = {
  action: "install" | "uninstall";
  branches: { branch: Branch; label: string;
              result: "patched" | "already" | "kept-custom" | "vencord" | "restored"; detail: string }[];
  started: Branch[];
  backup: string | null;              // where a foreign dist was moved (install)
  restored: string | null;            // which backup came back (uninstall)
  build: BuildJson | null;            // what was written (install)
  log: string;
};
type Failure = {
  code: "offline" | "no-release" | "checksum" | "cli" | "busy" | "no-discord" | "io" | "invalid" | "running" | "internal";
  message: string;                    // one friendly sentence
  detail: string;                     // the technical reason
  step: string | null;                // the step that failed
  log: string;                        // the whole log, for "Copy log"
};
```

States: `clean` is Discord's own app.asar with no `_app.asar`; `ours` is a stub requiring
`%APPDATA%\Vencord\dist\patcher.js` with our `build.json`; `vencord` is that stub without it (official
Vencord); `custom` is a stub requiring any other `patcher.js` (a developer's own Vencord, like this PC's Stable and
PTB); `unknown` is anything else (a stub requiring something odd, or an `_app.asar` beside a non-stub).

### Events

| Event | Payload | When |
|---|---|---|
| `plan` | `{ id, label }[]` | once, at the start of an install or uninstall: the steps in order |
| `progress` | `{ step, state: "active" \| "done" \| "skipped" \| "error", detail, pct }` | every step change; `pct` is overall progress 0–100 and never goes back |
| `log` | `{ line }` | every log line, including the CLI's own output |

Install step ids: `close`, `fetch-installer`, `fetch-build`, `place`, `patch:<branch>`…, `start`.
Uninstall: `close`, `fetch-installer`, `vencord:<branch>`… + `tidy` (keep Vencord) or `unpatch:<branch>`… +
`restore` (remove), then `start`.

### UI hooks the preview relies on

`#app[data-screen]` is one of `loading`, `welcome`, `installing`, `done`, `already`, `uninstalled`,
`no-discord`, `error`. Buttons are `[data-action="…"]`: `install`, `repair`, `show-uninstall`,
`uninstall-keep`, `uninstall-remove`, `show-welcome`, `toggle-log`, `open-discord`, `close-app`,
`download-discord`, `recheck`, `retry`, `copy-log`, `back`, `minimize`, `close`. Steps render as
`.step[data-step][data-state]`. Links are `[data-href]` (opened through `open_url`). Keep these when
restyling, or update `preview.mjs` with them.

### Mock and preview

`ui/mock-tauri.js` replaces `window.__TAURI__` when the page is not inside Tauri. Open
`ui/index.html?scenario=<name>` from any static server (add `&speed=4` to hurry it):
`fresh`, `installing`, `done`, `already`, `error-offline`, `error-checksum`, `error-cli`, `no-discord`,
`uninstalling`, `uninstalled`. `node preview.mjs [names…]` serves `ui/`, clicks through each scenario
and writes `screens/<name>@1x.png` and `@2x.png` at 960×600 (plus `uninstall-choice`). It fails when a page
logs an error or a scenario never reaches its screen.

## Files on the friend's PC

- `%APPDATA%\Vencord\dist\`: the Vencord build with the Purifier (shared by every Discord branch that runs Vencord).
- `%APPDATA%\Vencord\dist-backup-*\`: an earlier, not-ours dist, when there was one.
- `%LOCALAPPDATA%\Discord*\app-*\resources\app.asar`: the CLI's ~200-byte stub; Discord's own archive moves to `_app.asar`.
- `%LOCALAPPDATA%\DopasPurifier\`: `cache\` (the CLI and staged builds), `logs\` (the newest ten), `webview\` (WebView2's profile for this window).

## Notes

- The exe is not code-signed, so SmartScreen may warn on first run ("More info" → "Run anyway").
- It needs the WebView2 runtime, which ships with Windows 11 and current Windows 10.
- Window: 960×600, no native frame (custom title bar), shadow, not resizable, centred; strict CSP
  (`default-src 'self'`, no inline script or style, IPC only); `freezePrototype` on.
- `productName` uses a typographic apostrophe (Dopa’s): tauri-winres escapes `'` as `\'`, which `rc.exe`
  keeps literally, so the exe's Properties showed `Dopa\'s`.
- The CLI picks the `app-*` folder with the greatest *name*; the installer picks the greatest *version*. They
  differ only if Discord keeps two versions across a digit boundary (`app-1.0.9999` and `app-1.0.10000`);
  the post-patch check would then report a failure instead of claiming success.
