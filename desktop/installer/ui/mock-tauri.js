// A stand-in for window.__TAURI__ so the installer UI runs in a plain browser.
// Pick a scripted backend with ?scenario=<name> (and ?speed=<n> to run it n times faster):
//   fresh          Stable (open) is clean, Canary runs a developer's own Vencord
//   installing     like fresh; an install stops halfway, so the progress screen stays up
//   done           like fresh; an install finishes
//   already        the Purifier is installed in Stable and PTB, and a newer build is out
//   uninstalling   like already; an uninstall stops halfway
//   uninstalled    like already; an uninstall finishes
//   error-offline  GitHub can't be reached; an install fails at its first download
//   error-checksum an install fails because a download didn't match SHA256SUMS
//   error-cli      an install fails inside Vencord's installer
//   no-discord     no Discord on this PC
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
    purifier: '4.1.0',
    vencord: 'v1.14.0',
    hash: '6298341',
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
  const ourInstalls = () => [
    install('stable', 'Discord', '1.0.9267', 'ours', { running: true }),
    install('ptb', 'Discord PTB', '1.0.1231', 'ours'),
  ];

  const isAlready = ['already', 'uninstalling', 'uninstalled'].includes(scenario);
  const detection = {
    installs: scenario === 'no-discord' ? [] : isAlready ? ourInstalls() : freshInstalls(),
    vencordDir: `${ROAMING}\\Vencord`,
    installedBuild: isAlready ? INSTALLED : null,
    latest: scenario === 'error-offline' ? null : LATEST,
    network: scenario === 'error-offline' ? 'offline' : 'ok',
    backups: [],
    sandbox: false,
    installerVersion: '1.0.0',
  };

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
      message: "The download of renderer.js didn't match its fingerprint, so nothing was installed. Try again in a minute.",
      detail: 'renderer.js: SHA256SUMS says 3f9c…a1, download is 77b0…e4',
    },
    'error-cli': {
      at: 'patch:stable',
      code: 'cli',
      message: "Vencord's installer couldn't update Discord. It undoes its own half-finished changes; copy the log if you want help.",
      detail: 'VencordInstallerCli exited with 1: ERROR rename …\\app.asar …\\_app.asar: Access is denied.',
    },
  };

  const log = (line) => emit('log', { line });

  async function runSteps(steps, { stopAt, failAt, failure } = {}) {
    emit('plan', steps.map(([id, label]) => ({ id, label })));
    const total = steps.reduce((n, s) => n + s[2], 0);
    let before = 0;
    for (const [id, label, weight, detail, lines] of steps) {
      const pct = (f) => Math.round(((before + weight * f) / total) * 1000) / 10;
      emit('progress', { step: id, state: 'active', detail: `${label}…`, pct: pct(0) });
      for (const l of lines || []) {
        await sleep(90);
        log(l);
      }
      if (id === failAt) {
        await sleep(300);
        emit('progress', { step: id, state: 'error', detail: failure.message, pct: pct(0.3) });
        log(`FAILED at ${id}: ${failure.detail}`);
        throw { code: failure.code, message: failure.message, detail: failure.detail, step: id, log: '(mock log)' };
      }
      if (id === stopAt) {
        emit('progress', { step: id, state: 'active', detail: `${label}…`, pct: pct(0.45) });
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
      ['close', 'Close Discord', 4, 'Closed Discord', ['Closing Discord (Discord.exe)']],
      ['fetch-installer', 'Get Vencord\'s installer', 16, 'Vencord Installer v1.4.2, verified', ['Downloading Vencord installer v1.4.2', 'Verified VencordInstallerCli.exe']],
      ['fetch-build', 'Download the Purifier build', 24, '9 files verified', ['Latest release: ' + LATEST.title, 'Verified patcher.js', 'Verified renderer.js']],
      ['place', 'Put the files in place', 8, 'Files in place', [`Placed 11 files in ${ROAMING}\\Vencord\\dist`]],
      ...branches.map((b) => {
        const i = detection.installs.find((x) => x.branch === b) || { label: b };
        return [`patch:${b}`, `Patch ${i.label}`, 40 / Math.max(1, branches.length), args.force || i.state !== 'ours' ? `${i.label} patched` : '~Already set up',
          [`> VencordInstallerCli -install -location "${i.dir}"  (VENCORD_DEV_INSTALL=1)`, `  INFO  Patching ${i.dir}...`, `  INFO  Successfully patched ${i.dir}`]];
      }),
      ['start', 'Start Discord', 8, 'Started Discord', ['Starting Discord']],
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
      ['close', 'Close Discord', 6, 'Closed Discord', ['Closing Discord (Discord.exe)']],
      ['fetch-installer', 'Get Vencord\'s installer', 20, 'Vencord Installer v1.4.2, verified', ['Vencord installer v1.4.2 already downloaded and verified']],
      ...branches.map((b) => {
        const i = detection.installs.find((x) => x.branch === b) || { label: b };
        return keep
          ? [`vencord:${b}`, `Switch ${i.label} to official Vencord`, 50 / branches.length, `${i.label} runs official Vencord`, [`> VencordInstallerCli -install -location "${i.dir}"`]]
          : [`unpatch:${b}`, `Restore ${i.label}`, 50 / branches.length, `${i.label} is back to normal`, [`> VencordInstallerCli -uninstall -location "${i.dir}"`, `  INFO  Successfully unpatched ${i.dir}`]];
      }),
      keep ? ['tidy', 'Tidy up', 14, 'Vencord stays, the Purifier is gone', []] : ['restore', 'Remove the Purifier files', 14, 'Removed', [`Removed ${ROAMING}\\Vencord\\dist`]],
      ['start', 'Start Discord', 10, 'Started Discord', ['Starting Discord']],
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
      await sleep(450);
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
