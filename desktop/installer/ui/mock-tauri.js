// A stand-in for window.__TAURI__ so the installer UI runs in a plain browser.
// Pick a scripted backend with ?scenario=<name> (and ?speed=<n> to run it n times faster):
//   fresh            Stable (open) is clean, Canary runs a developer's own Vencord
//   many             Stable (open) is clean, PTB has official Vencord, Canary's app.asar was changed by something else
//   loading          detection never finishes, so "Looking for Discord" stays up
//   installing       like fresh; an install stops halfway, so the progress screen stays up
//   done             like fresh; an install finishes
//   already          the Purifier is installed in Stable and PTB, and a newer build is out
//   up-to-date       like already, with no newer build
//   uninstalling     like already; an uninstall stops halfway
//   uninstalled      like already; an uninstall finishes
//   no-release       there's no desktop release yet, so the welcome can't install
//   no-discord       no Discord on this PC
//   error-offline    GitHub can't be reached; an install fails at its first download
//   error-checksum   an install fails because a download didn't match SHA256SUMS
//   error-cli        an install fails inside Vencord's installer
//   error-busy       an install can't close Discord
//   error-io         an install can't write a file
//   error-no-release the release vanishes between detection and install
//   error-internal   the installer itself fails
//   error-detect     detection itself fails
// Inside the real app (Tauri injects __TAURI_INTERNALS__ first) this file does nothing.
(() => {
  'use strict';
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return;

  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'fresh';
  const speed = Math.max(0.1, Number(params.get('speed')) || 1);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed));
  const never = () => new Promise(() => {});

  const listeners = new Map();
  const emit = (event, payload) => (listeners.get(event) || []).forEach((cb) => cb({ event, id: 0, payload }));

  const LOCAL = 'C:\\Users\\friend\\AppData\\Local';
  const ROAMING = 'C:\\Users\\friend\\AppData\\Roaming';
  const OUR_PATCHER = `${ROAMING}\\Vencord\\dist\\patcher.js`;
  const LATEST = {
    title: "Dopa's Discord Purifier 4.2.0 for the Discord app · Vencord v1.14.1 · 94f9601",
    tag: 'desktop-v4.2.0-94f9601',
    hash: '94f9601',
    url: 'https://github.com/codemaker66/discord-stuff/releases/tag/desktop-v4.2.0-94f9601',
    source: 'github',
    build: null,
  };
  const INSTALLED = {
    purifier: scenario === 'up-to-date' ? '4.2.0' : '4.1.0',
    vencord: scenario === 'up-to-date' ? 'v1.14.1' : 'v1.14.0',
    hash: scenario === 'up-to-date' ? '94f9601' : '6298341',
    builtAt: '2026-10-30T18:02:11.000Z',
    by: 'dopas-purifier',
    installedAt: '2026-11-02T20:14:05+01:00',
  };

  const install = (branch, label, version, state, extra = {}) => ({
    branch,
    label,
    exe: `${label.replace(/ /g, '')}.exe`,
    dir: `${LOCAL}\\${label.replace(/ /g, '')}`,
    appDir: `${LOCAL}\\${label.replace(/ /g, '')}\\app-${version}`,
    version,
    running: false,
    state,
    patcher: state === 'clean' ? null : OUR_PATCHER,
    originalAsar: state !== 'clean',
    ...extra,
  });

  const freshInstalls = () => [
    install('stable', 'Discord', '1.0.9267', 'clean', { running: true }),
    install('canary', 'Discord Canary', '1.0.1314', 'custom', { patcher: 'D:\\dev\\Vencord\\dist\\patcher.js' }),
  ];
  const manyInstalls = () => [
    install('stable', 'Discord', '1.0.9267', 'clean', { running: true }),
    install('ptb', 'Discord PTB', '1.0.1231', 'vencord'),
    install('canary', 'Discord Canary', '1.0.1314', 'unknown', { patcher: null }),
  ];
  const ourInstalls = () => [
    install('stable', 'Discord', '1.0.9267', 'ours', { running: true }),
    install('ptb', 'Discord PTB', '1.0.1231', 'ours'),
  ];

  const isAlready = ['already', 'up-to-date', 'uninstalling', 'uninstalled'].includes(scenario);
  const noRelease = scenario === 'no-release';
  const detection = {
    installs: scenario === 'no-discord' ? [] : isAlready ? ourInstalls() : scenario === 'many' ? manyInstalls() : freshInstalls(),
    vencordDir: `${ROAMING}\\Vencord`,
    installedBuild: isAlready ? INSTALLED : null,
    latest: scenario === 'error-offline' || noRelease ? null : LATEST,
    network: scenario === 'error-offline' ? 'offline' : noRelease ? 'no-release' : 'ok',
    backups: [],
    sandbox: false,
    installerVersion: '1.0.0',
  };

  // Messages as the Rust side words them (src-tauri/src/core).
  const failures = {
    'error-offline': {
      at: 'fetch-installer',
      code: 'offline',
      message: "Couldn't reach GitHub. Check your internet connection and try again.",
      detail: 'network unavailable: dns error: No such host is known. (os error 11001)',
    },
    'error-checksum': {
      at: 'fetch-build',
      code: 'checksum',
      message: "renderer.js didn't match its fingerprint, so nothing was installed. Try again in a minute.",
      detail: 'renderer.js: SHA256SUMS says 3f9c…a1, download is 77b0…e4',
    },
    'error-cli': {
      at: 'patch:stable',
      code: 'cli',
      message: "Vencord's installer couldn't update Discord. It undoes its own half-finished changes; copy the log if you want help.",
      detail: 'VencordInstallerCli exited with 1: ERROR rename …\\app.asar …\\_app.asar: Access is denied.',
    },
    'error-busy': {
      at: 'close',
      code: 'busy',
      message: "Couldn't close Discord. Quit it from the system tray and try again.",
      detail: 'taskkill /F /IM Discord.exe /T: Access is denied. (exit 1)',
    },
    'error-io': {
      at: 'place',
      code: 'io',
      message: "Windows wouldn't let the installer write a file. Close Discord and try again.",
      detail: `write ${ROAMING}\\Vencord\\dist\\renderer.js: The process cannot access the file because it is being used by another process. (os error 32)`,
    },
    'error-no-release': {
      at: 'fetch-build',
      code: 'no-release',
      message: "There's no Discord app release to install yet. Check back soon!",
      detail: 'codemaker66/discord-stuff has no published release',
    },
    'error-internal': {
      at: 'patch:stable',
      code: 'internal',
      message: 'Something went wrong inside the installer.',
      detail: 'thread panicked at src/core/ops.rs: called `Option::unwrap()` on a `None` value',
    },
  };

  const log = (line) => emit('log', { line });

  // steps: [id, label, weight, doneDetail ('~' = skipped), lines, doing, partials]
  async function runSteps(steps, { stopAt, failAt, failure } = {}) {
    emit('plan', steps.map(([id, label]) => ({ id, label })));
    const total = steps.reduce((n, s) => n + s[2], 0);
    let before = 0;
    for (const [id, label, weight, detail, lines, doing, partials] of steps) {
      const pct = (f) => Math.round(((before + weight * f) / total) * 1000) / 10;
      emit('progress', { step: id, state: 'active', detail: doing || label, pct: pct(0) });
      for (const l of lines || []) {
        await sleep(90);
        log(l);
      }
      for (const f of partials || []) {
        await sleep(160);
        emit('progress', { step: id, state: 'active', detail: f[1], pct: pct(f[0]) });
      }
      if (id === failAt) {
        await sleep(300);
        emit('progress', { step: id, state: 'error', detail: failure.message, pct: pct(0.3) });
        log(`FAILED at ${id}: ${failure.detail}`);
        throw { code: failure.code, message: failure.message, detail: failure.detail, step: id, log: '(mock log)' };
      }
      if (id === stopAt) {
        emit('progress', { step: id, state: 'active', detail: doing || label, pct: pct(0.45) });
        return never();
      }
      await sleep(280);
      const skipped = typeof detail === 'string' && detail.startsWith('~');
      emit('progress', { step: id, state: skipped ? 'skipped' : 'done', detail: skipped ? detail.slice(1) : detail, pct: pct(1) });
      before += weight;
    }
  }

  async function doInstall(args) {
    const branches = args.branches || [];
    const steps = [
      ['close', 'Close Discord', 4, 'Closed Discord', ['Closing Discord (Discord.exe)'], 'Closing Discord'],
      ['fetch-installer', "Get Vencord's installer", 16, 'Vencord Installer v1.4.2, verified', ['Downloading Vencord installer v1.4.2', 'Verified VencordInstallerCli.exe'],
        "Getting Vencord's official installer", [[0.35, "Downloading Vencord's installer"], [0.8, "Downloading Vencord's installer"]]],
      ['fetch-build', 'Download the Purifier build', 24, '9 files verified', ['Latest release: ' + LATEST.title, 'Verified patcher.js', 'Verified renderer.js'],
        'Downloading the Purifier build', [[0.5, 'Downloading the Purifier build']]],
      ['place', 'Put the files in place', 8, 'Files in place', [`Placed 11 files in ${ROAMING}\\Vencord\\dist`], 'Putting the files in place'],
      ...branches.map((b) => {
        const i = detection.installs.find((x) => x.branch === b) || { label: b };
        return [`patch:${b}`, `Patch ${i.label}`, 40 / Math.max(1, branches.length), args.force || i.state !== 'ours' ? `${i.label} patched` : '~Already set up',
          [`> VencordInstallerCli -install -location "${i.dir}"  (VENCORD_DEV_INSTALL=1)`, `  INFO  Patching ${i.dir}...`, `  INFO  Successfully patched ${i.dir}`], `Patching ${i.label}`];
      }),
      ['start', 'Start Discord', 8, 'Started Discord', ['Starting Discord'], 'Starting Discord'],
    ];
    const f = failures[scenario];
    await runSteps(steps, {
      stopAt: scenario === 'installing' ? `patch:${branches[0]}` : null,
      failAt: f && f.at,
      failure: f,
    });
    return {
      action: 'install',
      branches: branches.map((b) => {
        const i = detection.installs.find((x) => x.branch === b) || { label: b };
        return { branch: b, label: i.label, result: 'patched', detail: 'Patched' };
      }),
      started: ['stable'],
      backup: null,
      restored: null,
      build: { ...INSTALLED, purifier: '4.2.0', vencord: 'v1.14.1', hash: '94f9601' },
      log: '(mock log)',
    };
  }

  async function doUninstall(args) {
    const branches = args.branches || [];
    const keep = Boolean(args.keepVencord);
    const steps = [
      ['close', 'Close Discord', 6, 'Closed Discord', ['Closing Discord (Discord.exe)'], 'Closing Discord'],
      ['fetch-installer', "Get Vencord's installer", 20, 'Vencord Installer v1.4.2, verified', ['Vencord installer v1.4.2 already downloaded and verified'], "Getting Vencord's official installer"],
      ...branches.map((b) => {
        const i = detection.installs.find((x) => x.branch === b) || { label: b };
        return keep
          ? [`vencord:${b}`, `Switch ${i.label} to official Vencord`, 50 / branches.length, `${i.label} runs official Vencord`, [`> VencordInstallerCli -install -location "${i.dir}"`], `Installing official Vencord into ${i.label}`]
          : [`unpatch:${b}`, `Restore ${i.label}`, 50 / branches.length, `${i.label} is back to normal`, [`> VencordInstallerCli -uninstall -location "${i.dir}"`, `  INFO  Successfully unpatched ${i.dir}`], `Restoring ${i.label}`];
      }),
      keep ? ['tidy', 'Tidy up', 14, 'Vencord stays, the Purifier is gone', [], 'Tidying up'] : ['restore', 'Remove the Purifier files', 14, 'Removed', [`Removed ${ROAMING}\\Vencord\\dist`], 'Removing the Purifier files'],
      ['start', 'Start Discord', 10, 'Started Discord', ['Starting Discord'], 'Starting Discord'],
    ];
    await runSteps(steps, { stopAt: scenario === 'uninstalling' ? `${keep ? 'vencord' : 'unpatch'}:${branches[0]}` : null });
    return {
      action: 'uninstall',
      branches: branches.map((b) => {
        const i = detection.installs.find((x) => x.branch === b) || { label: b };
        return { branch: b, label: i.label, result: keep ? 'vencord' : 'restored', detail: '' };
      }),
      started: ['stable'],
      backup: null,
      restored: null,
      build: null,
      log: '(mock log)',
    };
  }

  const commands = {
    app_info: async () => ({ version: '1.0.0', sandbox: null, logPath: null }),
    detect: async () => {
      if (scenario === 'loading') return never();
      await sleep(450);
      if (scenario === 'error-detect') throw 'reading C:\\Users\\friend\\AppData\\Local: Access is denied. (os error 5)';
      return JSON.parse(JSON.stringify(detection));
    },
    install: doInstall,
    uninstall: doUninstall,
    open_url: async ({ url }) => console.info('[mock] open_url', url),
    launch_discord: async ({ branch }) => console.info('[mock] launch_discord', branch),
  };

  async function invoke(cmd, args = {}) {
    const fn = commands[cmd];
    if (!fn) throw new Error(`[mock] unknown command ${cmd}`);
    return fn(args);
  }

  async function listen(event, cb) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
    return () => listeners.set(event, listeners.get(event).filter((x) => x !== cb));
  }

  const fakeWindow = {
    minimize: async () => console.info('[mock] minimize'),
    close: async () => console.info('[mock] close'),
    startDragging: async () => {},
  };

  window.__TAURI__ = {
    core: { invoke },
    event: { listen },
    window: { getCurrentWindow: () => fakeWindow },
  };
  window.__TAURI_MOCK__ = { scenario, speed };
})();
