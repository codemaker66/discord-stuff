// Dopa's Discord Purifier Setup: the window's logic.
// Talks to the Rust backend through window.__TAURI__ (withGlobalTauri); see ../README.md
// for every command and event. In a plain browser, mock-tauri.js stands in for it.
'use strict';

(() => {
  const T = window.__TAURI__;
  const invoke = (cmd, args) => T.core.invoke(cmd, args);
  const listen = (event, cb) => T.event.listen(event, cb);
  const currentWindow = () => T.window.getCurrentWindow();

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');

  const state = {
    detection: null,
    busy: false,
    lastOp: null,
    failure: null,
    logLines: [],
    selected: new Set(),
    summary: null,
  };

  const STATE_LABEL = {
    clean: 'Ready',
    ours: 'Purifier installed',
    vencord: 'Vencord',
    custom: 'Your own Vencord',
    unknown: 'Modified',
  };

  const ERROR_TITLE = {
    offline: "You're offline",
    'no-release': 'Not out yet',
    checksum: "A download didn't check out",
    cli: "Vencord's installer hit a snag",
    busy: 'Discord is still open',
    io: "Couldn't write a file",
    invalid: 'Nothing to do',
    running: 'Already working',
    internal: 'Something went wrong',
  };

  // ---------------------------------------------------------------- helpers

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  function show(screen) {
    app.dataset.screen = screen;
    const heading = document.querySelector(`.screen[data-screen="${screen}"] h2`);
    if (heading) heading.setAttribute('tabindex', '-1');
  }

  function setBusy(busy) {
    state.busy = busy;
    $('[data-action="close"]').disabled = busy;
    $('[data-action="close"]').title = busy ? 'Please wait until it finishes' : 'Close';
  }

  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = el('textarea', { readonly: true });
      area.value = text;
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    }
  }

  function openUrl(url) {
    invoke('open_url', { url }).catch((e) => toast(String(e)));
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const isForeign = (i) => i.state === 'custom' || i.state === 'unknown';
  const oursBranches = () => (state.detection?.installs || []).filter((i) => i.state === 'ours').map((i) => i.branch);
  const installFor = (branch) => (state.detection?.installs || []).find((i) => i.branch === branch);

  // ---------------------------------------------------------------- detect

  async function runDetect() {
    show('loading');
    try {
      const d = await invoke('detect');
      state.detection = d;
      route(d);
    } catch (e) {
      showError({ code: 'internal', message: "Couldn't look for Discord.", detail: String(e), log: '' });
    }
  }

  function route(d) {
    if (!d.installs.length) return show('no-discord');
    if (d.installs.some((i) => i.state === 'ours')) {
      renderAlready(d);
      return show('already');
    }
    renderWelcome(d);
    show('welcome');
  }

  // ---------------------------------------------------------------- welcome

  function renderWelcome(d) {
    const list = $('#installs');
    list.replaceChildren();
    state.selected = new Set(d.installs.filter((i) => !isForeign(i)).map((i) => i.branch));
    for (const i of d.installs) {
      const checked = state.selected.has(i.branch);
      const box = el('input', { type: 'checkbox', 'aria-label': i.label });
      box.checked = checked;
      const meta = `Version ${i.version}${i.running ? ' · open now, will restart' : ''}`;
      const row = el(
        'label',
        { class: `install${checked ? ' selected' : ''}`, 'data-branch': i.branch, 'data-state': i.state },
        box,
        el('div', {}, el('div', { class: 'install-name' }, i.label), el('div', { class: 'install-meta' }, meta)),
        el('span', { class: `badge ${i.state}` }, STATE_LABEL[i.state] || i.state),
      );
      if (isForeign(i)) {
        const what = i.patcher ? `a Vencord build from ${i.patcher}` : 'a modified app.asar';
        row.append(el('div', { class: 'install-warn' }, `Runs ${what}. Tick it to replace that with the Purifier build.`));
      }
      box.addEventListener('change', () => {
        if (box.checked) state.selected.add(i.branch);
        else state.selected.delete(i.branch);
        row.classList.toggle('selected', box.checked);
        updateInstallButton();
      });
      list.append(el('li', {}, row));
    }

    const note = $('#net-note');
    note.hidden = true;
    if (d.network === 'offline') {
      note.textContent = "Can't reach GitHub right now. The install downloads the Purifier, so check your connection first.";
      note.hidden = false;
    } else if (d.network === 'no-release') {
      note.textContent = "There's no Discord app release to install yet.";
      note.hidden = false;
    }
    updateInstallButton();
  }

  function updateInstallButton() {
    const btn = $('#install-btn');
    const hint = $('#install-hint');
    const picked = [...state.selected].map(installFor).filter(Boolean);
    btn.disabled = picked.length === 0;
    if (!picked.length) hint.textContent = 'Pick at least one Discord.';
    else if (picked.some((i) => i.running)) hint.textContent = 'Discord will close for a moment and reopen.';
    else hint.textContent = '';
  }

  function startInstall() {
    const branches = [...state.selected];
    if (!branches.length) return;
    const replaceCustom = branches.filter((b) => isForeign(installFor(b) || {}));
    run('install', { branches, replaceCustom, force: false }, 'Installing');
  }

  // ---------------------------------------------------------------- already installed

  function renderAlready(d) {
    const b = d.installedBuild || {};
    const facts = $('#installed-facts');
    facts.replaceChildren();
    const add = (k, v) => { if (v) facts.append(el('dt', {}, k), el('dd', {}, v)); };
    add('Purifier', b.purifier ? `v${b.purifier}` : null);
    add('Vencord', b.vencord || null);
    add('Build', b.hash || null);
    add('Installed', b.installedAt ? formatDate(b.installedAt) : null);
    add('In', d.installs.filter((i) => i.state === 'ours').map((i) => i.label).join(', '));

    const latestHash = d.latest?.hash;
    const outdated = Boolean(latestHash && b.hash && latestHash.toLowerCase() !== String(b.hash).toLowerCase());
    const note = $('#update-note');
    note.hidden = !outdated;
    if (outdated) note.textContent = `A newer build is out: ${d.latest.title}`;
    $('#repair-btn').textContent = outdated ? 'Update' : 'Repair';
    $('#uninstall-box').hidden = true;
    $('[data-action="show-uninstall"]').setAttribute('aria-expanded', 'false');
  }

  // ---------------------------------------------------------------- running an operation

  function setPct(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    $('#progress-bar').style.setProperty('--pct', String(p));
    $('#run-pct').textContent = `${Math.round(p)}%`;
  }

  function renderPlan(steps) {
    const list = $('#steps');
    list.replaceChildren();
    for (const s of steps) {
      list.append(
        el('li', { class: 'step', 'data-step': s.id, 'data-state': 'pending' },
          el('span', { class: 'step-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'step-label' }, s.label, el('span', { class: 'step-detail' }))),
      );
    }
  }

  function onProgress(p) {
    const row = document.querySelector(`.step[data-step="${CSS.escape(p.step)}"]`);
    if (row) {
      row.dataset.state = p.state;
      row.querySelector('.step-detail').textContent = p.detail || '';
    }
    if (p.detail) $('#run-detail').textContent = p.detail;
    setPct(p.pct);
  }

  function onLog(line) {
    state.logLines.push(line);
    const log = $('#log');
    log.append(document.createTextNode(`${line}\n`));
    log.scrollTop = log.scrollHeight;
  }

  async function run(cmd, args, title) {
    state.lastOp = { cmd, args, title };
    state.failure = null;
    state.logLines = [];
    $('#run-title').textContent = title;
    $('#steps').replaceChildren();
    $('#log').textContent = '';
    $('#run-detail').textContent = 'Starting…';
    setPct(0);
    app.classList.remove('failed');
    show('installing');
    setBusy(true);
    try {
      const summary = await invoke(cmd, args);
      state.summary = summary;
      setBusy(false);
      if (cmd === 'install') renderDone(summary);
      else renderUninstalled(summary, Boolean(args.keepVencord));
    } catch (f) {
      setBusy(false);
      app.classList.add('failed');
      showError(normaliseFailure(f));
    }
  }

  function normaliseFailure(f) {
    if (f && typeof f === 'object' && f.code) return { detail: '', log: '', ...f };
    return { code: 'internal', message: 'Something went wrong inside the installer.', detail: String(f), log: '' };
  }

  const RESULT_TEXT = {
    patched: 'Purifier installed',
    already: 'Already set up',
    'kept-custom': 'Kept your own Vencord',
    vencord: 'Back on official Vencord',
    restored: "Discord's own files are back",
  };

  function summaryList(target, s) {
    const list = $(target);
    list.replaceChildren();
    for (const r of s.branches) {
      list.append(el('li', {}, el('b', {}, r.label), RESULT_TEXT[r.result] || r.detail));
    }
    if (s.backup) list.append(el('li', {}, el('b', {}, 'Old Vencord files'), `Saved to ${s.backup}`));
    if (s.restored) list.append(el('li', {}, el('b', {}, 'Vencord files'), 'Your previous files are back'));
  }

  function renderDone(s) {
    summaryList('#done-summary', s);
    $('#done-lead').textContent = s.started.length
      ? 'Discord is reopening with the Purifier inside. Open any chat and press Purify.'
      : 'Open Discord, then open any chat and press Purify.';
    show('done');
  }

  function renderUninstalled(s, keep) {
    summaryList('#uninstalled-summary', s);
    $('#uninstalled-title').textContent = keep ? 'Back to official Vencord' : 'Removed';
    $('#uninstalled-lead').textContent = keep
      ? 'Discord keeps Vencord and your Vencord settings. The Purifier is gone.'
      : 'Discord is back to how it ships.';
    show('uninstalled');
  }

  function showError(f) {
    state.failure = f;
    if (f.code === 'no-discord') return show('no-discord');
    $('#error-title').textContent = ERROR_TITLE[f.code] || ERROR_TITLE.internal;
    $('#error-message').textContent = f.message || '';
    $('#error-detail').textContent = f.detail || '';
    $('#copy-log-btn').hidden = !(f.log || state.logLines.length);
    show('error');
  }

  function launchTarget() {
    const s = state.summary;
    if (s?.started?.length) return s.started[0];
    const patched = s?.branches?.find((r) => r.result !== 'kept-custom');
    if (patched) return patched.branch;
    return state.detection?.installs?.[0]?.branch || 'stable';
  }

  // ---------------------------------------------------------------- actions

  const actions = {
    minimize: () => currentWindow().minimize(),
    close: () => (state.busy ? toast('Hang on until it finishes.') : currentWindow().close()),
    'close-app': () => (state.busy ? toast('Hang on until it finishes.') : currentWindow().close()),
    install: startInstall,
    repair: () => {
      const branches = oursBranches();
      const updating = $('#repair-btn').textContent === 'Update';
      run('install', { branches, replaceCustom: [], force: true }, updating ? 'Updating' : 'Repairing');
    },
    'show-uninstall': (btn) => {
      const box = $('#uninstall-box');
      box.hidden = !box.hidden;
      btn.setAttribute('aria-expanded', String(!box.hidden));
    },
    'uninstall-keep': () => run('uninstall', { branches: oursBranches(), keepVencord: true }, 'Switching to official Vencord'),
    'uninstall-remove': () => run('uninstall', { branches: oursBranches(), keepVencord: false }, 'Uninstalling'),
    'show-welcome': () => {
      renderWelcome(state.detection);
      show('welcome');
    },
    'toggle-log': (btn) => {
      const log = $('#log');
      log.hidden = !log.hidden;
      btn.setAttribute('aria-expanded', String(!log.hidden));
      btn.textContent = log.hidden ? 'Show details' : 'Hide details';
      log.scrollTop = log.scrollHeight;
    },
    'open-discord': () => {
      invoke('launch_discord', { branch: launchTarget() })
        .then(() => toast('Starting Discord…'))
        .catch((e) => toast(String(e)));
    },
    'download-discord': () => openUrl('https://discord.com/download'),
    recheck: runDetect,
    retry: () => {
      const op = state.lastOp;
      if (op && state.failure && state.failure.code !== 'invalid') run(op.cmd, op.args, op.title);
      else runDetect();
    },
    back: runDetect,
    'copy-log': async () => {
      const f = state.failure || {};
      const text = [f.message, f.detail, '', f.log || state.logLines.join('\n')].filter((x) => x != null).join('\n');
      toast((await copyText(text)) ? 'Log copied' : "Couldn't copy the log");
    },
  };

  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-href]');
    if (link) {
      e.preventDefault();
      openUrl(link.dataset.href);
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const fn = actions[btn.dataset.action];
    if (fn) {
      e.preventDefault();
      fn(btn);
    }
  });

  // No browser context menu, except where text is meant to be selected.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.log, .error-detail')) e.preventDefault();
  });

  // ---------------------------------------------------------------- start

  (async () => {
    try {
      await Promise.all([
        listen('plan', (e) => renderPlan(e.payload)),
        listen('progress', (e) => onProgress(e.payload)),
        listen('log', (e) => onLog(e.payload.line)),
      ]);
    } catch (e) {
      console.error('event wiring failed', e);
    }
    try {
      const info = await invoke('app_info');
      $('#foot-version').textContent = `Setup ${info.version}`;
      if (info.sandbox) {
        const badge = $('#sandbox-badge');
        badge.hidden = false;
        badge.title = info.sandbox;
      }
    } catch (e) {
      console.error('app_info failed', e);
    }
    runDetect();
  })();
})();
