// Dopa's Discord Purifier Setup: the window's logic.
// Talks to the Rust backend through window.__TAURI__ (withGlobalTauri); see ../README.md
// for every command and event. In a plain browser, mock-tauri.js stands in for it.
// Motion: screens and sheets move by transform and opacity (Web Animations), the ring's beads light
// one at a time, and everything but the fades goes away under prefers-reduced-motion.
'use strict';

(() => {
  const T = window.__TAURI__;
  const invoke = (cmd, args) => T.core.invoke(cmd, args);
  const listen = (event, cb) => T.event.listen(event, cb);
  const currentWindow = () => T.window.getCurrentWindow();

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const params = new URLSearchParams(location.search);
  const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const motionOK = () => !reducedQuery.matches;

  const EASE_OUT = 'cubic-bezier(.22, 1, .36, 1)';
  const EASE_IN_OUT = 'cubic-bezier(.65, 0, .35, 1)';
  const SPRING = 'linear(0, .041, .14, .269, .408, .542, .662, .766, .85, .915, .963, .997, 1.019, 1.032, 1.037, 1.038, 1.036, 1.032, 1.026, 1.021, 1.016, 1.012, 1.008, 1.005, 1.003, 1.001, 1, 1)';
  const SOUND_KEY = 'dopa-setup-sound';

  const state = {
    detection: null,
    busy: false,
    lastOp: null,
    failure: null,
    logLines: [],
    selected: new Set(),
    summary: null,
    plan: [],
  };

  const STATE_LABEL = {
    clean: 'Ready',
    ours: 'Already purified',
    vencord: 'Has Vencord',
    custom: 'Custom Vencord',
    unknown: 'Modified',
  };

  const ERROR_TITLE = {
    offline: 'You’re offline~',
    'no-release': 'Not out yet~',
    checksum: 'A download didn’t check out',
    cli: 'Vencord’s installer hit a snag',
    busy: 'Discord is still open',
    io: 'Couldn’t write a file',
    invalid: 'Nothing to do',
    running: 'Already on it~',
    internal: 'Something went wrong',
  };
  // What to try next, for each failure. Plain steps, nothing scary.
  const ERROR_TIPS = {
    offline: ['Check your Wi-Fi or cable, then press Try again.'],
    'no-release': ['The Discord app version is on its way. Check back soon~'],
    checksum: ['GitHub may still be publishing the files. Wait a minute, then press Try again.'],
    cli: ['Quit Discord from the system tray (right-click its icon, then Quit Discord) and press Try again.', 'Still stuck? Copy the log and send it to whoever shared this with you.'],
    busy: ['Right-click Discord in the system tray, pick Quit Discord, then press Try again.'],
    io: ['Quit Discord from the system tray, then press Try again.', 'Still stuck? Restarting your PC frees files that are in use.'],
    invalid: ['Go back, pick at least one Discord, then try again.'],
    running: ['Wait for the one that’s running to finish~'],
    internal: ['Press Try again. If it happens again, copy the log and send it to whoever shared this with you.'],
  };
  const ERROR_ICON = {
    offline: 'i-wifi-off',
    'no-release': 'i-clock',
    checksum: 'i-shield',
    cli: 'i-wrench',
    busy: 'i-window',
    io: 'i-file',
    invalid: 'i-info',
    running: 'i-clock',
    internal: 'i-alert',
  };

  // What each step is doing, in a sentence, under the big step name.
  const STEP_NOTE = {
    close: 'Discord closes while it’s patched, then reopens by itself.',
    'fetch-installer': 'Vencord’s official installer, checked against its fingerprint.',
    'fetch-build': 'The Purifier build from GitHub. Every file is checked before anything changes.',
    place: 'Into your Vencord folder. Anything already there is backed up first; your settings stay.',
    patch: 'Vencord’s installer points Discord at the new files.',
    start: 'Opening Discord again~',
    vencord: 'Official Vencord goes back in. Your Vencord settings stay.',
    unpatch: 'Putting Discord’s own files back.',
    tidy: 'Clearing out the Purifier’s bits. Vencord stays.',
    restore: 'Clearing out the Purifier’s files.',
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

  const SVGNS = 'http://www.w3.org/2000/svg';
  function icon(id, cls = '') {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', `ico ${cls}`.trim());
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVGNS, 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  }

  function anim(node, frames, opts) {
    if (!node || !node.animate) return null;
    return node.animate(frames, opts);
  }

  // A small seeded random, so the motes sit in the same places on every launch.
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function setBusy(busy) {
    state.busy = busy;
    const close = $('[data-action="close"]');
    close.disabled = busy;
    close.title = busy ? 'Please wait until it finishes' : 'Close';
  }

  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    const fresh = t.hidden;
    t.hidden = false;
    if (fresh && motionOK()) anim(t, [{ opacity: 0, transform: 'translate(-50%, 10px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 320, easing: EASE_OUT });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      const hide = () => { t.hidden = true; };
      if (!motionOK()) return hide();
      const a = anim(t, [{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%, 6px)' }], { duration: 200, easing: 'ease-in' });
      if (a) a.finished.then(hide, hide); else hide();
    }, 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = el('textarea', { readonly: true, class: 'sr' });
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

  // Typographic apostrophes in the backend's sentences and Discord's labels.
  const typo = (text) => String(text ?? '').replace(/(\w)'(\w)/g, '$1’$2');

  function joinAnd(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  // "Dopa's Discord Purifier 4.2.0 for the Discord app · Vencord v1.14.1 · 94f9601"
  function latestInfo(d) {
    const l = d?.latest;
    if (!l) return null;
    if (l.build?.purifier) return { purifier: l.build.purifier, vencord: l.build.vencord || null };
    const m = /Purifier\s+(\S+)\s+for the Discord app\s+·\s+Vencord\s+(\S+)/.exec(l.title || '');
    return m ? { purifier: m[1], vencord: m[2] } : null;
  }

  const isForeign = (i) => i.state === 'custom' || i.state === 'unknown';
  const oursBranches = () => (state.detection?.installs || []).filter((i) => i.state === 'ours').map((i) => i.branch);
  const installFor = (branch) => (state.detection?.installs || []).find((i) => i.branch === branch);

  // ---------------------------------------------------------------- sound

  // Tiny synthesised cues (no files): quiet by default, off with the speaker in the title bar.
  const sfx = (() => {
    let ctx = null;
    let out = null;
    let on = true;
    try {
      on = localStorage.getItem(SOUND_KEY) !== 'off';
    } catch {
      /* no storage: sounds stay on for this run */
    }
    function audio() {
      if (!on) return null;
      try {
        if (!ctx) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          ctx = new AC();
          out = ctx.createGain();
          out.gain.value = 0.12;
          const soft = ctx.createBiquadFilter();
          soft.type = 'lowpass';
          soft.frequency.value = 5200;
          out.connect(soft).connect(ctx.destination);
        }
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
      } catch {
        return null;
      }
    }
    function note(freq, { at = 0, dur = 0.25, type = 'sine', vol = 0.3, attack = 0.005, to = 0 } = {}) {
      const c = audio();
      if (!c) return;
      const t = c.currentTime + 0.01 + at;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    const PENTA = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51, 1567.98];
    return {
      get on() { return on; },
      toggle() {
        on = !on;
        try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* not remembered */ }
        return on;
      },
      tick() { note(1760, { dur: 0.05, type: 'triangle', vol: 0.18 }); },
      select(checked) { note(checked ? 880 : 700, { dur: 0.12, vol: 0.26, to: checked ? 1320 : 520 }); },
      open() { note(587.33, { dur: 0.2, vol: 0.18, to: 880 }); },
      start() {
        note(392, { dur: 0.25, vol: 0.28 });
        note(587.33, { at: 0.09, dur: 0.35, vol: 0.28 });
      },
      step(i) {
        const f = PENTA[Math.min(Math.max(i, 0), PENTA.length - 1)];
        note(f, { dur: 0.4, vol: 0.22 });
        note(f * 2, { dur: 0.22, vol: 0.05, type: 'triangle' });
      },
      success() {
        [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => note(f, { at: i * 0.075, dur: 0.8, vol: 0.24 }));
        [2093, 2637.02, 3135.96].forEach((f, i) => note(f, { at: 0.34 + i * 0.06, dur: 0.4, vol: 0.05, type: 'triangle' }));
      },
      error() {
        note(392, { dur: 0.3, vol: 0.28, type: 'triangle' });
        note(311.13, { at: 0.15, dur: 0.5, vol: 0.28, type: 'triangle' });
      },
    };
  })();

  function paintSoundButton() {
    const b = $('#sound-btn');
    b.setAttribute('aria-pressed', String(sfx.on));
    b.title = sfx.on ? 'Sounds on' : 'Sounds off';
  }

  // ---------------------------------------------------------------- backdrop motes

  function seedMotes() {
    const box = $('#motes');
    const rnd = seeded(0xd0fa);
    for (let i = 0; i < 20; i++) {
      const star = i % 5 === 2;
      const m = el('i', { class: star ? 'mote mote-star' : 'mote' });
      const dur = 10 + rnd() * 12;
      m.style.setProperty('--x', `${(rnd() * 100).toFixed(1)}%`);
      m.style.setProperty('--y', `${(18 + rnd() * 84).toFixed(1)}%`);
      m.style.setProperty('--s', `${(star ? 7 + rnd() * 4 : 1.5 + rnd() * 2.2).toFixed(1)}px`);
      m.style.setProperty('--dur', `${dur.toFixed(1)}s`);
      m.style.setProperty('--delay', `${(-rnd() * dur).toFixed(1)}s`);
      m.style.setProperty('--dx', `${((rnd() - 0.5) * 70).toFixed(0)}px`);
      m.style.setProperty('--dy', `${(-70 - rnd() * 130).toFixed(0)}px`);
      m.style.setProperty('--o', (0.22 + rnd() * 0.5).toFixed(2));
      if (star) m.append(icon('i-sparkle'));
      // Keep the band under the wordmark and mood clear, so a mote never sits on a word.
      const x = parseFloat(m.style.getPropertyValue('--x'));
      const y = parseFloat(m.style.getPropertyValue('--y'));
      if (x > 8 && x < 36 && y > 52) m.style.setProperty('--x', `${(x < 22 ? x - 9 : x + 9).toFixed(1)}%`);
      box.append(m);
    }
  }

  // ---------------------------------------------------------------- the ring

  // The panel's 270° arc, open at the bottom, cut into 54 beads. Lit beads are a dash pattern
  // rebuilt only when the count changes; the head bead and the crimson failure notch are one dash each.
  const ring = (() => {
    const R = 104;
    const C = 2 * Math.PI * R;
    const LEN = C * 0.75;
    const N = 54;
    const GAP = 3.3;
    const BEAD = (LEN - (N - 1) * GAP) / N;
    const PITCH = BEAD + GAP;
    const fill = $('#r-fill');
    const head = $('#r-head');
    const fail = $('#r-fail');
    const pct = $('#ring-pct');
    const dash = (k) => {
      if (k <= 0) return `0 ${C.toFixed(2)}`;
      const parts = [];
      for (let i = 0; i < k; i++) parts.push(BEAD.toFixed(3), (i === k - 1 ? C - (k * PITCH - GAP) : GAP).toFixed(3));
      return parts.join(' ');
    };
    $('#r-track').setAttribute('stroke-dasharray', dash(N));
    const one = `${BEAD.toFixed(3)} ${(C - BEAD).toFixed(3)}`;
    head.setAttribute('stroke-dasharray', one);
    fail.setAttribute('stroke-dasharray', one);

    let shown = 0;
    let lit = -1;
    let raf = 0;
    let target = 0;
    let resolveRun = null;
    const easeOut = (t) => 1 - (1 - t) ** 3;

    // The number in the middle has its own tween, from what it shows to the true target, so a ring
    // still draining from a full welcome never drags it (it reads 0 at the start of a run, then climbs).
    let num = 0;
    function draw(frac, n) {
      shown = Math.max(0, Math.min(1, frac));
      const k = Math.round(shown * N);
      if (k !== lit) {
        lit = k;
        fill.setAttribute('stroke-dasharray', dash(k));
        head.setAttribute('stroke-dashoffset', String((-(Math.max(k, 1) - 1) * PITCH).toFixed(3)));
        head.classList.toggle('on', k > 0 && k < N);
      }
      num = n;
      pct.textContent = String(Math.round(num * 100));
    }
    function stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      delete app.dataset.tween;
      if (resolveRun) {
        const r = resolveRun;
        resolveRun = null;
        r();
      }
    }
    function animateTo(to, { duration, easing = easeOut } = {}) {
      stop();
      target = Math.max(0, Math.min(1, to));
      const from = shown;
      const nFrom = num;
      const dur = duration ?? 260 + 720 * Math.abs(target - from);
      if (!motionOK() || dur <= 0 || (from === target && nFrom === target)) {
        draw(target, target);
        return Promise.resolve();
      }
      const t0 = performance.now();
      app.dataset.tween = '1'; // the preview waits for the ring to settle
      return new Promise((resolve) => {
        resolveRun = resolve;
        const tick = (now) => {
          const t = Math.min(1, (now - t0) / dur);
          const e = easing(t);
          draw(from + (target - from) * e, nFrom + (target - nFrom) * e);
          if (t < 1) raf = requestAnimationFrame(tick);
          else stop();
        };
        raf = requestAnimationFrame(tick);
      });
    }
    return {
      animateTo,
      finish() { stop(); draw(target, target); },
      markFail() {
        fail.setAttribute('stroke-dashoffset', String((-(Math.max(lit, 1) - 1) * PITCH).toFixed(3)));
        fail.classList.add('on');
      },
      clearFail() { fail.classList.remove('on'); },
      resetCount() { num = 0; pct.textContent = '0'; },
      get value() { return shown; },
    };
  })();

  // ---------------------------------------------------------------- the stage

  // mode: loading | idle | progress | error | empty; badge: '' | ok | bad | calm.
  function stage({ mode, badge = '', mood, caption = '' }) {
    if (mode) app.dataset.ring = mode;
    app.dataset.badge = badge;
    $('#ring-caption').textContent = caption;
    if (mood != null) setMood(mood);
  }

  function setMood(text) {
    const m = $('#mood');
    if (m.textContent === text) return;
    if (!motionOK() || !screensLive) {
      m.textContent = text;
      return;
    }
    const out = anim(m, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
    const swap = () => {
      m.textContent = text;
      if (out) out.cancel();
      anim(m, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE_OUT });
    };
    if (out) out.finished.then(swap, swap); else swap();
  }

  function replayShine(delay = 0) {
    if (!motionOK()) return [];
    const shine = $('.wm-shine');
    const text = $('.wm-shine-text');
    const wordW = $('.wm-word').offsetWidth;
    const winW = shine.offsetWidth;
    const opts = { duration: 680, delay, easing: EASE_IN_OUT };
    return [
      anim(shine, [{ opacity: 1, transform: `translateX(${-winW}px)` }, { opacity: 1, transform: `translateX(${wordW}px)` }], opts),
      anim(text, [{ transform: `translateX(${winW}px)` }, { transform: `translateX(${-wordW}px)` }], opts),
    ];
  }

  // The finish: a ring of light, a burst from the rim, Dopa pops, the wordmark catches the light.
  function celebrate() {
    sfx.success();
    if (!motionOK()) return;
    const box = $('#burst');
    const rnd = Math.random;
    const cx = 136;
    const cy = 136;
    const rim = 112;
    const colors = ['#ff7aa9', '#ffa0c2', '#ffe3ed', '#ffc4d8', '#f2568f', '#ffe6a8'];
    for (let i = 0; i < 46; i++) {
      const a = ((135 + rnd() * 270) * Math.PI) / 180;
      const kind = i % 6 === 0 ? 'star' : i % 9 === 4 ? 'heart' : i % 3 === 1 ? 'chip' : 'dot';
      const p = el('i', { class: `spark spark-${kind}` });
      if (kind === 'star') p.append(icon('i-sparkle'));
      if (kind === 'heart') p.append(icon('i-heart'));
      const size = kind === 'dot' ? 3 + rnd() * 4 : kind === 'chip' ? 3 + rnd() * 2.5 : 10 + rnd() * 8;
      p.style.setProperty('--s', `${size.toFixed(1)}px`);
      p.style.setProperty('--c', colors[i % colors.length]);
      p.style.setProperty('left', `${(cx + Math.cos(a) * rim).toFixed(1)}px`);
      p.style.setProperty('top', `${(cy + Math.sin(a) * rim).toFixed(1)}px`);
      box.append(p);
      const power = 40 + rnd() * 100;
      const vx = Math.cos(a) * power;
      const vy = Math.sin(a) * power - 30;
      const spin = (rnd() - 0.5) * 600;
      const frames = [];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        const e = 1 - (1 - t) ** 2.2;
        frames.push({
          transform: `translate(${(vx * e).toFixed(1)}px, ${(vy * e + 80 * t * t).toFixed(1)}px) rotate(${(spin * t).toFixed(0)}deg) scale(${(1 - t * 0.35).toFixed(2)})`,
          opacity: t < 0.12 ? t / 0.12 : t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35,
        });
      }
      const done = () => p.remove();
      anim(p, frames, { duration: 1300 + rnd() * 900, delay: rnd() * 140, easing: 'linear', fill: 'backwards' }).finished.then(done, done);
    }
    const wave = el('i', { class: 'wave' });
    box.append(wave);
    const gone = () => wave.remove();
    anim(wave, [{ opacity: 0.95, transform: 'translate(-50%, -50%) scale(.86)' }, { opacity: 0, transform: 'translate(-50%, -50%) scale(1.42)' }], { duration: 950, easing: EASE_OUT }).finished.then(gone, gone);
    anim($('.halo'), [{ opacity: 1, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(1.16)', offset: 0.3 }, { opacity: 0.85, transform: 'scale(1)' }], { duration: 1200, easing: EASE_OUT });
    anim($('#avatar'), [{ transform: 'scale(.84)' }, { transform: 'scale(1)' }], { duration: 760, easing: SPRING });
    replayShine(260);
  }

  // ---------------------------------------------------------------- screens

  let current = $('.screen[data-screen="loading"]');
  let introDone = false;
  // Screens animate their changes once the intro has brought the panel in (or right away without one).
  let screensLive = false;

  function entrance(section, { base = 70, step = 45, duration = 520 } = {}) {
    const kids = [...section.children].filter((k) => !k.hidden && !k.classList.contains('sr'));
    if (!motionOK()) {
      anim(section, [{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
      return;
    }
    kids.forEach((k, i) => {
      anim(k, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], {
        duration, delay: base + i * step, easing: EASE_OUT, fill: 'backwards',
      });
    });
  }

  function show(screen) {
    const next = $(`.screen[data-screen="${screen}"]`);
    const prev = current !== next ? current : null;
    closeSheets(false);
    app.dataset.screen = screen;
    current = next;
    if (!screensLive) return; // the intro brings the first screen in
    if (prev && motionOK()) {
      prev.classList.add('is-leaving');
      const a = anim(prev, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-8px)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' });
      const clear = () => {
        prev.classList.remove('is-leaving');
        if (a) a.cancel();
      };
      if (a) a.finished.then(clear, clear); else clear();
    }
    if (prev) entrance(next);
    focusHeading(next);
  }

  function focusHeading(section) {
    const h = section.querySelector('h2');
    if (!h) return;
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- sheets

  let openSheet = null;
  let sheetOpener = null;

  function showSheet(sheet, opener) {
    if (openSheet === sheet) return;
    closeSheets(false);
    sheet.hidden = false;
    openSheet = sheet;
    sheetOpener = opener || null;
    current.inert = true;
    if (opener) opener.setAttribute('aria-expanded', 'true');
    sfx.open();
    if (motionOK()) {
      anim(sheet, [{ opacity: 0, transform: 'translateY(18px) scale(.985)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT });
      const kids = [...sheet.querySelectorAll('.sheet-head, .about li, .choice, .sheet-foot')];
      kids.forEach((k, i) => anim(k, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 60 + i * 40, easing: EASE_OUT, fill: 'backwards' }));
    }
    const h = sheet.querySelector('h3');
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }

  function closeSheets(animate = true) {
    if (!openSheet) return;
    const sheet = openSheet;
    const opener = sheetOpener;
    openSheet = null;
    sheetOpener = null;
    current.inert = false;
    if (opener) opener.setAttribute('aria-expanded', 'false');
    const hide = () => { sheet.hidden = true; };
    if (animate && motionOK()) {
      const a = anim(sheet, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(12px) scale(.99)' }], { duration: 190, easing: 'ease-in' });
      if (a) a.finished.then(hide, hide); else hide();
    } else {
      hide();
    }
    if (animate && opener) opener.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- intro

  // Dopa and the wordmark appear in the middle of the window, the light sweeps the wordmark, then the
  // stage glides home and the panel slides in. 1.4 s; any key or click skips it.
  let introAnims = [];
  let introTimer = 0;

  function finishIntro() {
    if (introDone) return;
    clearTimeout(introTimer);
    introDone = true;
    screensLive = true;
    app.dataset.intro = 'done';
    removeEventListener('keydown', skipIntro, true);
    removeEventListener('pointerdown', skipIntro, true);
  }

  function skipIntro(e) {
    if (introDone) return;
    if (e.type === 'keydown') e.preventDefault();
    for (const a of introAnims) {
      try { a.finish(); } catch { /* already gone */ }
    }
    for (const a of current.getAnimations({ subtree: true })) {
      try { a.finish(); } catch { /* already gone */ }
    }
    finishIntro();
    focusHeading(current);
  }

  function playIntro() {
    if (!motionOK() || params.get('intro') === '0') {
      introDone = true;
      screensLive = true;
      app.dataset.intro = 'done';
      entrance(current, { base: 0, step: 30, duration: 360 });
      return;
    }
    app.dataset.intro = 'playing';
    addEventListener('keydown', skipIntro, true);
    addEventListener('pointerdown', skipIntro, true);
    const stageEl = $('.stage');
    const r = stageEl.getBoundingClientRect();
    const dx = Math.round(innerWidth / 2 - (r.left + r.width / 2));
    const dy = 18;
    const A = (node, frames, opts) => {
      const a = anim(node, frames, { easing: EASE_OUT, fill: 'backwards', ...opts });
      if (a) introAnims.push(a);
      return a;
    };
    A(stageEl, [{ transform: `translate(${dx}px, ${dy}px) scale(1.05)` }, { transform: 'none' }], { delay: 820, duration: 520, easing: EASE_IN_OUT });
    A($('.halo'), [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 900 });
    A($('.avatar'), [{ opacity: 0, transform: 'scale(.78)' }, { opacity: 1, transform: 'none' }], { delay: 40, duration: 700, easing: SPRING });
    A($('.ring'), [{ opacity: 0, transform: 'rotate(-60deg) scale(.9)' }, { opacity: 1, transform: 'none' }], { delay: 90, duration: 800 });
    A($('.wm-eyebrow'), [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { delay: 300, duration: 520 });
    A($('.wm-wrap'), [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { delay: 360, duration: 560 });
    A($('#mood'), [{ opacity: 0 }, { opacity: 1 }], { delay: 600, duration: 420 });
    A($('.stage-foot'), [{ opacity: 0 }, { opacity: 1 }], { delay: 960, duration: 420 });
    A($('#panel'), [{ opacity: 0, transform: 'translateX(32px)' }, { opacity: 1, transform: 'none' }], { delay: 860, duration: 540 });
    for (const a of replayShine(560)) if (a) introAnims.push(a);
    A($('.sweep'), [{ opacity: 0 }, { opacity: 1 }], { delay: 420, duration: 400 });
    A($('.orbit'), [{ opacity: 0 }, { opacity: 1 }], { delay: 220, duration: 900 });
    introTimer = setTimeout(() => {
      screensLive = true;
      entrance(current, { base: 40, step: 30, duration: 400 });
    }, 880);
    Promise.all(introAnims.map((a) => a.finished)).then(finishIntro, finishIntro);
  }

  // ---------------------------------------------------------------- detect

  async function runDetect() {
    ring.clearFail();
    ring.animateTo(0, { duration: 300 });
    stage({ mode: 'loading', mood: 'looking for Discord~' });
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
    ring.clearFail();
    if (!d.installs.length) {
      stage({ mode: 'empty', badge: 'calm', mood: 'no Discord here yet~' });
      ring.animateTo(0, { duration: 500 });
      return show('no-discord');
    }
    if (d.installs.some((i) => i.state === 'ours')) {
      renderAlready(d);
      return show('already');
    }
    renderWelcome(d);
    show('welcome');
  }

  // ---------------------------------------------------------------- welcome

  function warnText(i, checked) {
    if (i.state === 'custom') {
      return checked
        ? 'Will switch to the Purifier build. Your own build’s files stay where they are.'
        : `Runs your own Vencord build (${i.patcher || 'another folder'}). Left alone unless you tick it.`;
    }
    return checked
      ? 'Its changed app.asar will be replaced with the Purifier build.'
      : 'Something else changed its app.asar. Left alone unless you tick it.';
  }

  function renderWelcome(d) {
    $('[data-action="show-already"]').hidden = true; // shown only when coming from the installed screen
    stage({ mode: 'idle', mood: 'awaiting orders, princess~' });
    ring.animateTo(1, { duration: 760 });
    const list = $('#installs');
    list.replaceChildren();
    state.selected = new Set(d.installs.filter((i) => !isForeign(i)).map((i) => i.branch));
    for (const i of d.installs) {
      const checked = state.selected.has(i.branch);
      const box = el('input', { type: 'checkbox', class: 'install-box', 'aria-describedby': `meta-${i.branch}` });
      box.checked = checked;
      const bits = [`Version ${i.version}`];
      if (i.running) bits.push('open now, will restart');
      const row = el('label', { class: `install${checked ? ' selected' : ''}`, 'data-branch': i.branch, 'data-state': i.state },
        box,
        el('span', { class: 'check-ui', 'aria-hidden': 'true' }, icon('i-check')),
        el('span', { class: 'tile', 'aria-hidden': 'true' }, icon('i-app')),
        el('span', { class: 'install-text' },
          el('span', { class: 'install-name' }, i.label),
          el('span', { class: 'install-meta', id: `meta-${i.branch}` }, bits.join(' · '))),
        el('span', { class: `badge ${i.state}` }, STATE_LABEL[i.state] || i.state));
      let warn = null;
      if (isForeign(i)) {
        warn = el('span', { class: 'install-warn', id: `warn-${i.branch}` }, warnText(i, checked));
        box.setAttribute('aria-describedby', `meta-${i.branch} warn-${i.branch}`);
        row.append(warn);
      }
      box.addEventListener('change', () => {
        if (box.checked) state.selected.add(i.branch);
        else state.selected.delete(i.branch);
        row.classList.toggle('selected', box.checked);
        if (warn) warn.textContent = warnText(i, box.checked);
        sfx.select(box.checked);
        updateInstallButton();
      });
      list.append(el('li', {}, row));
    }

    const pill = $('#latest-pill');
    const latest = latestInfo(d);
    pill.hidden = !latest;
    if (latest) pill.textContent = latest.vencord ? `v${latest.purifier} · Vencord ${latest.vencord}` : `v${latest.purifier}`;

    const note = $('#net-note');
    note.hidden = true;
    note.classList.remove('is-info');
    if (d.network === 'offline') {
      note.textContent = 'Can’t reach GitHub right now. The install downloads the Purifier, so check your connection first~';
      note.hidden = false;
    } else if (d.network === 'no-release') {
      note.textContent = 'The Discord app version isn’t out yet, so there’s nothing to install. Check back soon~';
      note.hidden = false;
    } else if (d.network === 'local') {
      note.textContent = 'Using a local build (test mode).';
      note.classList.add('is-info');
      note.hidden = false;
    }
    updateInstallButton();
  }

  function updateInstallButton() {
    const btn = $('#install-btn');
    const hint = $('#install-hint');
    const picked = [...state.selected].map(installFor).filter(Boolean);
    const noRelease = state.detection?.network === 'no-release';
    btn.disabled = picked.length === 0 || noRelease;
    hint.textContent = picked.length || noRelease ? '' : 'Pick at least one Discord~';
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
    const where = d.installs.filter((i) => i.state === 'ours').map((i) => i.label);
    const facts = $('#installed-facts');
    facts.replaceChildren();
    const add = (k, v, wide) => {
      if (v) facts.append(el('div', { class: wide ? 'wide' : null }, el('dt', {}, k), el('dd', {}, v)));
    };
    // Vencord updates itself by replacing patcher.js and the rest, never our build.json, so the
    // hash on patcher.js's first line (installedHash) is the build that runs. Once it has moved on,
    // build.json's versions are old: the latest release's title names them when that is what runs.
    const same = (x, y) => Boolean(x && y && String(x).toLowerCase() === String(y).toLowerCase());
    const installedHash = d.installedHash || b.hash || null;
    const latestHash = d.latest?.hash;
    const latest = latestInfo(d);
    const running = !b.hash || same(installedHash, b.hash) ? b : same(installedHash, latestHash) && latest ? latest : {};
    add('Purifier', running.purifier ? `v${running.purifier}` : null);
    add('Vencord', running.vencord || null);
    add('Build', installedHash);
    add('Installed', b.installedAt ? formatDate(b.installedAt) : null);
    $('#already-lead').textContent = where.length ? `Running in ${joinAnd(where)}.` : 'The Purifier is in your Discord.';

    const outdated = Boolean(latestHash && installedHash && !same(latestHash, installedHash));
    const note = $('#update-note');
    note.hidden = !outdated;
    if (outdated) {
      $('#update-title').textContent = latest ? `Update ready: v${latest.purifier}` : 'An update is ready';
      $('#update-sub').textContent = [running.purifier ? `You have v${running.purifier}` : null, latest?.vencord ? `brings Vencord ${latest.vencord}` : null].filter(Boolean).join(' · ');
    }
    const repair = $('#repair-btn');
    repair.dataset.mode = outdated ? 'update' : 'repair';
    $('#repair-label').textContent = outdated ? 'Update' : 'Repair';
    stage({ mode: 'idle', badge: 'ok', mood: outdated ? 'a new build is out~ ♡' : 'all comfy in your Discord ♡' });
    ring.animateTo(1, { duration: 760 });
  }

  // ---------------------------------------------------------------- running an operation

  function renderPlan(steps) {
    state.plan = steps;
    const list = $('#steps');
    list.replaceChildren();
    steps.forEach((s, i) => {
      const row = el('li', { class: 'step', 'data-step': s.id, 'data-state': 'pending' },
        el('span', { class: 'step-node', 'aria-hidden': 'true' }, icon('i-check', 'i-ok'), icon('i-dash', 'i-skip'), icon('i-bang', 'i-bad')),
        el('span', { class: 'step-text' }, el('span', { class: 'step-label' }, typo(s.label)), el('span', { class: 'step-detail' })));
      list.append(row);
      if (motionOK()) anim(row, [{ opacity: 0, transform: 'translateX(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 120 + i * 40, easing: EASE_OUT, fill: 'backwards' });
    });
  }

  // The big step name and its note crossfade together; updates that arrive mid-fade wait, and the
  // newest one wins, so the heading never trails the timeline.
  let runStepNext = null;
  let runStepFading = false;
  function setRunStep(text, note) {
    const h = $('#run-step');
    const n = $('#run-detail');
    if (!runStepFading && h.textContent === text && n.textContent === note) return;
    if (!motionOK() || app.dataset.screen !== 'installing') {
      h.textContent = text;
      n.textContent = note;
      runStepNext = null;
      return;
    }
    runStepNext = { text, note };
    if (runStepFading) return;
    runStepFading = true;
    const fadeOut = [{ opacity: 1 }, { opacity: 0, transform: 'translateY(-6px)' }];
    const outs = [h, n].map((node) => anim(node, fadeOut, { duration: 120, easing: 'ease-in', fill: 'forwards' }));
    const swap = () => {
      runStepFading = false;
      if (runStepNext) {
        h.textContent = runStepNext.text;
        n.textContent = runStepNext.note;
      }
      runStepNext = null;
      outs.forEach((a) => a && a.cancel());
      anim(h, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: EASE_OUT });
      anim(n, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 360, delay: 40, easing: EASE_OUT, fill: 'backwards' });
    };
    if (outs[0]) outs[0].finished.then(swap, swap); else swap();
  }

  function onProgress(p) {
    const idx = state.plan.findIndex((s) => s.id === p.step);
    const row = document.querySelector(`.step[data-step="${CSS.escape(p.step)}"]`);
    const was = row?.dataset.state;
    if (row) {
      row.dataset.state = p.state;
      const withDetail = p.state === 'skipped' || p.state === 'error';
      row.querySelector('.step-detail').textContent = withDetail ? typo(p.detail) : '';
      row.title = typo(p.detail);
      if (was !== p.state && (p.state === 'done' || p.state === 'error') && motionOK()) {
        anim(row.querySelector('.step-node'), [{ transform: 'scale(.55)' }, { transform: 'scale(1)' }], { duration: 520, easing: SPRING });
      }
    }
    if (p.state === 'active') {
      setRunStep(typo(p.detail || state.plan[idx]?.label || ''), STEP_NOTE[p.step.split(':')[0]] || '');
      if (was !== 'active') $('#run-live').textContent = typo(p.detail || state.plan[idx]?.label || '');
    }
    if (idx >= 0) $('#ring-caption').textContent = `Step ${idx + 1} of ${state.plan.length}`;
    if (was !== p.state && p.state === 'done') sfx.step(idx);
    ring.animateTo((Number(p.pct) || 0) / 100);
  }

  function onLog(line) {
    state.logLines.push(line);
    const log = $('#log');
    log.append(document.createTextNode(`${line}\n`));
    if (!log.hidden) log.scrollTop = log.scrollHeight;
  }

  const RUN_MOOD = {
    Installing: 'moving in~ don’t look',
    Repairing: 'fixing myself up~',
    Updating: 'trying on the new build~',
    Uninstalling: 'packing my things~',
  };

  async function run(cmd, args, title) {
    state.lastOp = { cmd, args, title };
    state.failure = null;
    state.logLines = [];
    state.plan = [];
    $('#run-title').textContent = title;
    $('#steps').replaceChildren();
    $('#log').textContent = '';
    $('#log').hidden = true;
    $('#steps').hidden = false;
    const toggle = $('[data-action="toggle-log"]');
    toggle.textContent = 'Show details';
    toggle.setAttribute('aria-expanded', 'false');
    runStepNext = null;
    $('#run-step').textContent = 'Getting ready…';
    $('#run-detail').textContent = cmd === 'install' ? 'Discord closes for a moment and reopens by itself~' : 'Discord closes for a moment and reopens by itself.';
    $('#ring-label').textContent = title === 'Switching to official Vencord' ? 'Switching' : title;
    ring.clearFail();
    stage({ mode: 'progress', mood: RUN_MOOD[title] || 'switching things over~', caption: '' });
    ring.resetCount(); // first, so the drain below leaves the number at 0
    ring.animateTo(0, { duration: 320 });
    show('installing');
    setBusy(true);
    sfx.start();
    try {
      const summary = await invoke(cmd, args);
      state.summary = summary;
      await ring.animateTo(1, { duration: 360 });
      setBusy(false);
      if (cmd === 'install') renderDone(summary);
      else renderUninstalled(summary, Boolean(args.keepVencord));
    } catch (f) {
      ring.finish();
      setBusy(false);
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
    restored: 'Discord’s own files are back',
  };

  function summaryList(target, s) {
    const list = $(target);
    list.replaceChildren();
    const row = (iconId, info, ...text) => el('li', {}, el('span', { class: `s-ico${info ? ' s-info' : ''}`, 'aria-hidden': 'true' }, icon(iconId)), el('span', {}, ...text));
    for (const r of s.branches) {
      const kept = r.result === 'kept-custom';
      list.append(row(kept ? 'i-dash' : 'i-check', kept, el('b', {}, typo(r.label)), ` · ${typo(RESULT_TEXT[r.result] || r.detail)}`));
    }
    if (s.backup) list.append(row('i-info', true, 'Your old Vencord files are saved in ', el('b', {}, s.backup)));
    if (s.restored) list.append(row('i-undo', true, 'Your previous Vencord files are back'));
  }

  function renderDone(s) {
    summaryList('#done-summary', s);
    $('#done-lead').textContent = s.started.length
      ? 'Discord is reopening with the Purifier inside.'
      : 'Open Discord and the Purifier is waiting inside.';
    stage({ mode: 'idle', badge: 'ok', mood: 'all set, princess ♡', caption: '' });
    show('done');
    setTimeout(celebrate, motionOK() ? 160 : 0);
  }

  function renderUninstalled(s, keep) {
    summaryList('#uninstalled-summary', s);
    $('#uninstalled-title').textContent = keep ? 'Back to official Vencord' : 'All removed~';
    $('#uninstalled-lead').textContent = keep
      ? 'Discord keeps Vencord and your Vencord settings. The Purifier is gone.'
      : 'Discord is back to how it ships.';
    stage({ mode: 'empty', mood: 'see you around, princess ♡', caption: '' });
    setTimeout(() => ring.animateTo(0, { duration: 1100 }), 250);
    show('uninstalled');
  }

  const OP_STOPPED = { Installing: 'Install stopped', Repairing: 'Repair stopped', Updating: 'Update stopped', Uninstalling: 'Uninstall stopped' };

  function showError(f) {
    state.failure = f;
    if (f.code === 'no-discord') {
      stage({ mode: 'empty', badge: 'calm', mood: 'no Discord here yet~', caption: '' });
      ring.animateTo(0, { duration: 500 });
      return show('no-discord');
    }
    $('#error-title').textContent = ERROR_TITLE[f.code] || ERROR_TITLE.internal;
    $('#error-message').textContent = typo(f.message);
    const tips = ERROR_TIPS[f.code] || ERROR_TIPS.internal;
    $('#error-tips').replaceChildren(...tips.map((t) => el('li', {}, icon('i-chevron'), el('span', {}, t))));
    $('#error-detail').textContent = f.detail || '';
    const op = state.lastOp?.title;
    $('#error-eyebrow').textContent = OP_STOPPED[op] || (op ? 'Uninstall stopped' : 'Stopped');
    $('#error-ico').replaceChildren(icon(ERROR_ICON[f.code] || 'i-alert'));
    $('#copy-log-btn').hidden = !(f.log || state.logLines.length);
    const hadRun = app.dataset.ring === 'progress';
    if (hadRun) ring.markFail();
    stage({ mode: hadRun ? 'error' : 'idle', badge: 'bad', mood: 'something fought back~', caption: '' });
    sfx.error();
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
    close: () => (state.busy ? toast('Hang on until it finishes~') : currentWindow().close()),
    'close-app': () => (state.busy ? toast('Hang on until it finishes~') : currentWindow().close()),
    'toggle-sound': () => {
      sfx.toggle();
      paintSoundButton();
      sfx.tick();
    },
    install: startInstall,
    repair: () => {
      const branches = oursBranches();
      const updating = $('#repair-btn').dataset.mode === 'update';
      run('install', { branches, replaceCustom: [], force: true }, updating ? 'Updating' : 'Repairing');
    },
    'show-about': (btn) => showSheet($('#about-sheet'), btn),
    'hide-about': () => closeSheets(true),
    'show-uninstall': (btn) => showSheet($('#uninstall-box'), btn),
    'hide-uninstall': () => closeSheets(true),
    'uninstall-keep': () => run('uninstall', { branches: oursBranches(), keepVencord: true }, 'Switching to official Vencord'),
    'uninstall-remove': () => run('uninstall', { branches: oursBranches(), keepVencord: false }, 'Uninstalling'),
    'show-welcome': () => {
      renderWelcome(state.detection);
      $('[data-action="show-already"]').hidden = false;
      show('welcome');
    },
    'show-already': () => {
      renderAlready(state.detection);
      show('already');
    },
    'toggle-log': (btn) => {
      const log = $('#log');
      const steps = $('#steps');
      const opening = log.hidden;
      log.hidden = !opening;
      steps.hidden = opening;
      btn.setAttribute('aria-expanded', String(opening));
      btn.textContent = opening ? 'Hide details' : 'Show details';
      const shown = opening ? log : steps;
      if (motionOK()) anim(shown, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE_OUT });
      log.scrollTop = log.scrollHeight;
    },
    'open-discord': () => {
      invoke('launch_discord', { branch: launchTarget() })
        .then(() => toast('Starting Discord~'))
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
      toast((await copyText(text)) ? 'Log copied~' : "Couldn't copy the log");
    },
  };

  const QUIET_ACTIONS = new Set(['install', 'repair', 'uninstall-keep', 'uninstall-remove', 'show-about', 'show-uninstall', 'toggle-sound', 'retry']);

  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-href]');
    if (link) {
      e.preventDefault();
      sfx.tick();
      openUrl(link.dataset.href);
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const fn = actions[btn.dataset.action];
    if (fn) {
      e.preventDefault();
      if (!QUIET_ACTIONS.has(btn.dataset.action)) sfx.tick();
      fn(btn);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openSheet) {
      e.preventDefault();
      closeSheets(true);
    }
  });

  // No browser context menu, except where text is meant to be selected.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.log, .error-detail')) e.preventDefault();
  });

  // ---------------------------------------------------------------- start

  (async () => {
    seedMotes();
    paintSoundButton();
    const ready = document.fonts ? document.fonts.ready.catch(() => {}) : Promise.resolve();
    try {
      await Promise.all([
        listen('plan', (e) => renderPlan(e.payload)),
        listen('progress', (e) => onProgress(e.payload)),
        listen('log', (e) => onLog(e.payload.line)),
        // Alt+F4 or the taskbar's "Close window" while working: the backend keeps the window open.
        listen('close-blocked', () => toast('Hang on until it finishes~')),
      ]);
    } catch (e) {
      console.error('event wiring failed', e);
    }
    invoke('app_info')
      .then((info) => {
        $('#foot-version').textContent = `Setup ${info.version}`;
        if (info.sandbox) {
          const badge = $('#sandbox-badge');
          badge.hidden = false;
          badge.title = info.sandbox;
        }
      })
      .catch((e) => console.error('app_info failed', e));
    runDetect();
    await ready;
    playIntro();
  })();
})();
