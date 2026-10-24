  // ── Lifecycle ───────────────────────────────────────────
  // Everything that touches the page outside our shadow root is registered here,
  // so the BetterDiscord plugin's stop() leaves Discord exactly as it found it.

  const disposers = [];

  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    disposers.push(() => target.removeEventListener(type, fn, options));
  }

  function every(ms, fn) {
    const id = setInterval(fn, ms);
    disposers.push(() => clearInterval(id));
  }

  const shortVersion = VERSION.split('.').slice(0, 2).join('.');

  // ── DOM helpers ─────────────────────────────────────────
  // Everything Discord hands us (names, message text) goes in as text nodes —
  // never through innerHTML.

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key === 'style') el.style.cssText = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false || child === '') continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, value);
    for (const child of children.flat()) if (child) el.append(child);
    return el;
  }

  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.round((seconds % 3600) / 60);
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
  }

  const estimateSeconds = (n) => (n * (TIMING.deleteDelayMs + 250)) / 1000;
  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ── Preferences (survive reloads) ───────────────────────

  // Every Discord tab shares these. A tab writes back only the keys it changed, and shields
  // are read, changed and written in one go, so no tab can erase another tab's settings.
  const PREFS_KEY = 'dopa-purifier:prefs';
  const prefs = { x: null, y: null, open: true, muted: false, tab: 'current', welcomed: false };
  const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 500) : []);

  function withStorage(fn) {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.body.appendChild(frame);
    try { return fn(frame.contentWindow.localStorage); } catch { return null; } finally { frame.remove(); }
  }

  function readStored(ls) {
    try {
      const saved = JSON.parse(ls.getItem(PREFS_KEY));
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
  }

  function loadPrefs() {
    const saved = withStorage(readStored);
    if (!saved) return;
    if (Number.isFinite(saved.x)) prefs.x = saved.x;
    if (Number.isFinite(saved.y)) prefs.y = saved.y;
    if (typeof saved.open === 'boolean') prefs.open = saved.open;
    if (typeof saved.muted === 'boolean') prefs.muted = saved.muted;
    if (saved.tab === 'current' || saved.tab === 'batch') prefs.tab = saved.tab;
    if (typeof saved.welcomed === 'boolean') prefs.welcomed = saved.welcomed;
  }

  let prefsTimer = 0;
  const dirtyPrefs = new Set();

  function writePrefs() {
    const keys = [...dirtyPrefs];
    dirtyPrefs.clear();
    withStorage((ls) => {
      const stored = readStored(ls);
      for (const key of keys) stored[key] = prefs[key];
      ls.setItem(PREFS_KEY, JSON.stringify(stored));
    });
  }

  function savePrefs(...keys) {
    for (const key of keys) dirtyPrefs.add(key);
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => { prefsTimer = 0; writePrefs(); }, 250);
  }

  function flushPrefs() {
    if (!prefsTimer) return;
    clearTimeout(prefsTimer);
    prefsTimer = 0;
    writePrefs();
  }

  // Pull in shields set in any tab. Returns whether anything changed.
  function syncProtection() {
    const saved = withStorage(readStored);
    if (!saved) return false; // storage blocked: keep this tab's own shields
    const ids = stringList(saved.protectedIds);
    const released = stringList(saved.released);
    const same = (set, list) => set.size === list.length && list.every((x) => set.has(x));
    if (same(protection.ids, ids) && same(protection.released, released)) return false;
    protection.ids = new Set(ids);
    protection.released = new Set(released);
    return true;
  }

  function storeProtection() {
    withStorage((ls) => {
      const stored = readStored(ls);
      stored.protectedIds = [...protection.ids];
      stored.released = [...protection.released];
      ls.setItem(PREFS_KEY, JSON.stringify(stored));
    });
  }

  // ── Sound ───────────────────────────────────────────────

  const sound = { ctx: null, buffer: null, loading: null };

  async function playDeleteSound() {
    if (prefs.muted) return;
    try {
      if (!sound.ctx) sound.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (sound.ctx.state === 'suspended') await sound.ctx.resume();
      if (!sound.buffer) {
        // Decode from the embedded base64 directly: fetch() on a data: URL
        // would trip Discord's connect-src CSP.
        if (!sound.loading) {
          const bin = atob(DELETE_SOUND.slice(DELETE_SOUND.indexOf(',') + 1));
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          sound.loading = sound.ctx.decodeAudioData(bytes.buffer);
        }
        sound.buffer = await sound.loading;
      }
      const source = sound.ctx.createBufferSource();
      const gain = sound.ctx.createGain();
      gain.gain.value = 0.6;
      source.buffer = sound.buffer;
      source.connect(gain).connect(sound.ctx.destination);
      source.start(0);
    } catch (err) {
      console.debug('[Dopa Purifier] sound unavailable:', err);
    }
  }

  // ── Springs ─────────────────────────────────────────────
  // Semi-implicit Euler springs driving the panel's wobble layer, a separate
  // element from anything a CSS animation touches so the two never fight.

  class Spring {
    constructor(stiffness, damping, rest) {
      this.k = stiffness;
      this.c = damping;
      this.rest = rest;
      this.value = rest;
      this.velocity = 0;
      this.target = rest;
    }
    step(dt) {
      const accel = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += accel * dt;
      this.value += this.velocity * dt;
      return Math.abs(this.velocity) > 0.001 || Math.abs(this.value - this.target) > 0.001;
    }
    settle() { this.value = this.target; this.velocity = 0; }
  }


  // ── UI state ────────────────────────────────────────────

  const state = {
    tab: 'current',
    route: null,          // { guildId, channelId } from the URL
    target: null,         // described route target
    targetError: null,
    scanning: false,
    runTargets: [],
    batchRows: new Map(), // key → row
    selected: new Set(),  // row keys
    guildsLoaded: false,
    dmsLoaded: false,
    filter: '',
  };

  let root = null;  // shadow root
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => Array.from(root.querySelectorAll(sel));

  // ── Icons (inline SVG, stroke = currentColor) ───────────

  const ICONS = {
    minimize: 'M5 12h14',
    close: 'M6 6l12 12M18 6L6 18',
    sound: 'M4 9v6h4l5 4V5L8 9H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
    muted: 'M4 9v6h4l5 4V5L8 9H4zM17 9l5 6M22 9l-5 6',
    scan: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
    pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
    play: 'M8 5.5l10.5 6.5L8 18.5z',
    stop: 'M7 7h10v10H7z',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    chevron: 'M9 6l6 6-6 6',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
    sparkle: 'M12 3l1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8z',
    shield: 'M12 2.6l7.6 3.1v5.9c0 4.9-3.2 8.4-7.6 10.1-4.4-1.7-7.6-5.2-7.6-10.1V5.7z',
    crown: 'M3.2 8.2l4.6 3.9L12 5l4.2 7.1 4.6-3.9-1.9 10.4H5.1z',
    drop: 'M12 3.2c3 4.4 6.2 7.5 6.2 11a6.2 6.2 0 0 1-12.4 0c0-3.5 3.2-6.6 6.2-11z',
    megaphone: 'M3 11l18-5v12L3 14zM11.6 16.8a3 3 0 1 1-5.8-1.6',
    share: 'M12 15V3M7.5 7.5L12 3l4.5 4.5M5 12v7h14v-7',
    forum: 'M4 5h16v10H9l-5 4z',
    dagger: 'M12 1.8l2.1 3.4v9.4H9.9V5.2zM6.8 14.6h10.4v2.2H6.8zM10.9 16.8h2.2v3.4h-2.2zM12 20a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z',
  };

  const FILLED = new Set(['pause', 'play', 'stop', 'shield', 'crown', 'drop', 'heart', 'dagger']);
  function icon(name, extra = '') {
    const cls = `ico${FILLED.has(name) ? ' ico-fill' : ''}${extra ? ` ${extra}` : ''}`;
    return svg('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      svg('path', { d: ICONS[name] }));
  }

  // ── Build ───────────────────────────────────────────────

  // The kill ring: a 270° arc in a 200×200 box. With a known total of up to 90
  // messages it is cut into one notch per message; failures keep their place as
  // crimson notches that stand proud of the arc. Bigger totals use a continuous
  // arc with failure ticks that never shrink below a few degrees. Everything is
  // drawn with dash patterns (no masks or filters by id), so it renders the same
  // in any browser's shadow DOM; the gradient reference carries a colour fallback.
  const G = { cx: 100, cy: 100, r: 84, sweep: 0.75, maxBeads: 90, minTick: 4 };
  G.c = 2 * Math.PI * G.r;
  G.len = G.c * G.sweep;
  const ARC = { cx: G.cx, cy: G.cy, r: G.r, transform: 'rotate(135 100 100)', fill: 'none' };
  const ROSE_STROKE = 'url(#dp-g-rose) #ff7aa9';

  function buildGauge() {
    return h('div', { class: 'gauge', 'aria-hidden': 'true' },
      svg('svg', { class: 'dial', viewBox: '0 0 200 200' },
        svg('defs', {},
          svg('linearGradient', { id: 'dp-g-rose', gradientUnits: 'userSpaceOnUse', x1: '30', y1: '170', x2: '170', y2: '40' },
            svg('stop', { offset: '0', class: 'g-stop-a' }),
            svg('stop', { offset: '1', class: 'g-stop-b' })),
          svg('radialGradient', { id: 'dp-g-dial' },
            svg('stop', { offset: '0', class: 'g-dial-a' }),
            svg('stop', { offset: '1', class: 'g-dial-b' }))),
        svg('circle', { cx: '100', cy: '100', r: '74', class: 'g-dial', fill: 'url(#dp-g-dial) none' }),
        svg('circle', { ...ARC, class: 'g-track' }),
        svg('g', { class: 'g-glow' },
          svg('circle', { ...ARC, class: 'g-ok', stroke: ROSE_STROKE }),
          svg('circle', { ...ARC, class: 'g-head' })),
        svg('circle', { ...ARC, class: 'g-fail' }),
        svg('g', { class: 'g-comet' },
          svg('circle', { ...ARC, stroke: ROSE_STROKE, 'stroke-linecap': 'round', 'stroke-dasharray': `${(G.len * 0.16).toFixed(2)} ${G.c.toFixed(2)}` }))),
      h('div', { class: 'blood' }),
      h('div', { class: 'sticker', 'data-role': 'sticker', hidden: true }),
      h('div', { class: 'gauge-pct', 'data-role': 'pct' }));
  }

  function buildHero() {
    return h('div', { class: 'hero' },
      h('div', { class: 'burst', 'data-role': 'burst', 'aria-hidden': 'true' }),
      buildGauge(),
      h('div', { class: 'hero-core' },
        h('div', { class: 'count', 'data-role': 'count', text: '0' }),
        h('div', { class: 'count-label', text: 'messages purged' }),
        h('div', { class: 'hero-sub', 'data-role': 'hero-sub' })),
      h('div', { class: 'readout', 'data-role': 'readout' },
        h('div', { class: 'readout-line', 'data-role': 'readout-line', text: '' }),
        h('div', { class: 'stats', 'data-role': 'stats', hidden: true },
          h('div', { class: 'stat stat-fail', 'data-role': 'stat-fail' }, h('i', { class: 'stat-dot' }), h('b', { text: '0' }), h('span', { text: ' failed' })),
          h('div', { class: 'stat', 'data-role': 'stat-eta' }, h('b', { text: '—' })),
          h('div', { class: 'stat', 'data-role': 'stat-rate' }, h('b', { text: '—' })))));
  }

  // Notches in processing order for the current (or last) run.
  const ring = { done: 0, fails: [], drawn: '' };

  // Paint exactly the given [start, length] ranges along the arc. The pattern
  // starts on the first dash and is shifted into place with a dash offset, so no
  // zero-length dash exists to leave a round-cap dot behind.
  function paint(el, ranges) {
    el.setAttribute('visibility', ranges.length ? 'visible' : 'hidden');
    if (!ranges.length) return;
    const parts = [];
    ranges.forEach(([from, length], i) => {
      const next = ranges[i + 1];
      parts.push(length.toFixed(2), (next ? next[0] - from - length : G.c).toFixed(2));
    });
    el.setAttribute('stroke-dasharray', parts.join(' '));
    el.setAttribute('stroke-dashoffset', (-ranges[0][0]).toFixed(2));
  }

  function drawRing({ total, done: doneRaw, fails, spinning }) {
    const key = `${total}|${doneRaw}|${fails.length}|${spinning}`;
    if (key === ring.drawn) return;
    ring.drawn = key;
    const dial = $('.dial');
    dial.classList.toggle('is-spinning', spinning);
    const beads = total > 0 && total <= G.maxBeads;
    dial.classList.toggle('is-beaded', beads);
    const step = total ? G.len / total : G.len;
    const done = Math.min(doneRaw, total || 0);
    const failSet = new Set(fails.filter((k) => k < done));
    const track = $('.g-track');
    const ok = $('.g-ok');
    const head = $('.g-head');
    const fail = $('.g-fail');

    if (beads) {
      const gap = clamp(step * 0.22, 1.8, 3.2);
      const dash = Math.max(0.6, step - gap);
      const bead = (i) => [i * step + gap / 2, dash];
      const all = Array.from({ length: total }, (_, i) => i);
      paint(track, all.map(bead));
      paint(ok, all.filter((i) => i < done && !failSet.has(i)).map(bead));
      paint(fail, [...failSet].sort((a, b) => a - b).map(bead));
      const headOn = done > 0 && done < total && !failSet.has(done - 1);
      paint(head, headOn ? [bead(done - 1)] : []);
      return;
    }

    paint(track, [[0, G.len]]);
    paint(head, []);
    // Rose runs between failures, so crimson ticks never sit inside the rose bloom.
    const runs = [];
    let at = 0;
    for (const k of [...failSet].sort((a, b) => a - b)) {
      if (k > at) runs.push([at * step, (k - at) * step]);
      at = k + 1;
    }
    if (done > at) runs.push([at * step, (done - at) * step]);
    paint(ok, total ? runs : []);
    // Neighbouring failures merge into one tick; every tick is at least minTick long.
    const ticks = [];
    for (const k of [...failSet].sort((a, b) => a - b)) {
      const len = Math.max(step, G.minTick);
      const from = clamp(k * step + step / 2 - len / 2, 0, G.len - len);
      const last = ticks[ticks.length - 1];
      if (last && from <= last[0] + last[1] + 1) last[1] = Math.max(last[1], from + len - last[0]);
      else ticks.push([from, len]);
    }
    paint(fail, ticks);
  }

  // Where the ring's leading edge is, in gauge-local pixels — blood drips from there.
  function ringHead(total) {
    const gauge = $('.gauge');
    const size = gauge.clientWidth || 196;
    const frac = total ? clamp((ring.done - 0.5) / total, 0, 1) : 0.5;
    const a = ((135 + 270 * frac) * Math.PI) / 180;
    const k = size / 200;
    return { x: (G.cx + G.r * Math.cos(a)) * k, y: (G.cy + G.r * Math.sin(a)) * k, angle: a };
  }

  function buildCurrentView() {
    return h('div', { class: 'view', 'data-view': 'current', role: 'tabpanel', 'aria-label': 'Current channel' },
      h('div', { class: 'target', 'data-role': 'target' },
        h('div', { class: 'target-ico', 'data-role': 'target-ico', 'aria-hidden': 'true', text: '#' }),
        h('div', { class: 'target-text' },
          h('div', { class: 'eyebrow', 'data-role': 'eyebrow' }, h('i', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { 'data-role': 'eyebrow-text', text: 'Current channel' })),
          h('div', { class: 'target-line' },
            h('span', { class: 'target-name', 'data-role': 'target-name', text: 'detecting…' }),
            h('span', { class: 'target-context', 'data-role': 'target-context' })),
          h('div', { class: 'target-viewing', 'data-role': 'target-viewing', hidden: true }),
          h('div', { class: 'target-note', 'data-role': 'target-note', hidden: true })),
        h('span', { class: 'target-tools', 'data-role': 'target-tools' })));
  }

  function buildBatchView() {
    const dmHead = h('div', { class: 'section-head' },
      h('div', { class: 'section-title', text: 'Direct messages' }),
      h('div', { class: 'section-tools' },
        h('button', { class: 'chip', 'data-act': 'dm-all', text: 'All' }),
        h('button', { class: 'chip', 'data-act': 'dm-none', text: 'None' }),
        h('button', { class: 'chip icon-only', 'data-act': 'dm-refresh', 'aria-label': 'Refresh DMs', title: 'Refresh' }, icon('refresh'))));
    const serverHead = h('div', { class: 'section-head' },
      h('div', { class: 'section-title', text: 'Servers' }),
      h('div', { class: 'section-tools' },
        h('button', { class: 'chip icon-only', 'data-act': 'server-refresh', 'aria-label': 'Refresh servers', title: 'Refresh' }, icon('refresh'))));
    return h('div', { class: 'view', 'data-view': 'batch', role: 'tabpanel', 'aria-label': 'Batch' },
      h('div', { class: 'hint' }, h('span', { class: 'hint-ico', text: '💡' }),
        h('span', { text: 'Tip: Scan people first to see message counts and get accurate progress tracking!' })),
      h('input', { class: 'filter', type: 'search', 'data-role': 'filter', placeholder: 'Filter people & channels…', 'aria-label': 'Filter', spellcheck: 'false', autocomplete: 'off' }),
      dmHead,
      h('div', { class: 'list', 'data-role': 'dm-list' }, h('div', { class: 'list-empty', text: 'Loading DMs & friends… 💬' })),
      serverHead,
      h('div', { class: 'list', 'data-role': 'server-list' }, h('div', { class: 'list-empty', text: 'Loading servers… 🏰' })));
  }

  function buildPanel() {
    return h('section', { class: 'panel', 'aria-label': "Dopa's Purifier" },
      h('header', { class: 'head', 'data-role': 'drag' },
        h('button', { class: 'avatar', 'data-act': 'poke', 'aria-label': 'Poke Dopa', title: 'boop~' },
          h('img', { src: EMOTE_IMG, alt: '', draggable: 'false' })),
        h('div', { class: 'titles' },
          h('div', { class: 'title' }, h('span', { text: "Dopa's Purifier" }), h('span', { class: 'ver', text: `v${shortVersion}` })),
          h('div', { class: 'mood', 'data-role': 'mood', text: 'awaiting orders, princess~' })),
        h('div', { class: 'head-tools' },
          h('button', { class: 'icon-btn', 'data-act': 'share', 'aria-label': 'Share with a friend', title: 'Share with a friend ♡' }, icon('share')),
          h('button', { class: 'icon-btn', 'data-act': 'mute', 'aria-label': 'Mute sound', title: 'Sound' }, icon('sound')),
          h('button', { class: 'icon-btn', 'data-act': 'minimize', 'aria-label': 'Minimise', title: 'Minimise' }, icon('minimize')))),
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Mode' },
        h('span', { class: 'tab-pill', 'aria-hidden': 'true' }),
        h('button', { class: 'tab', role: 'tab', 'data-tab': 'current', text: 'Current channel' }),
        h('button', { class: 'tab', role: 'tab', 'data-tab': 'batch' }, h('span', { text: 'Batch' }), h('span', { class: 'tab-badge', 'data-role': 'tab-badge', hidden: true }))),
      h('div', { class: 'welcome', 'data-role': 'welcome', hidden: true, role: 'dialog', 'aria-label': 'Welcome' },
        h('div', { class: 'welcome-card' },
          h('div', { class: 'welcome-emote' }, h('img', { src: EMOTE_IMG, alt: '' })),
          h('div', { class: 'welcome-title', text: 'Hi princess~ ♡' }),
          h('div', { class: 'welcome-lead', text: 'Three steps and your messages are gone:' }),
          h('ol', { class: 'welcome-steps' },
            h('li', {}, h('span', {}, h('b', { text: 'Open a chat' }), ' — any DM, group or server channel')),
            h('li', {}, h('span', {}, h('b', { text: 'Scan' }), ' to count your messages there')),
            h('li', {}, h('span', {}, h('b', { text: 'Hold Purify' }), ' and watch the ring fill up'))),
          h('div', { class: 'welcome-note' },
            icon('shield'),
            h('span', { text: 'Only your own messages, nothing leaves Discord, and anyone you shield is immune.' })),
          h('div', { class: 'welcome-actions' },
            h('button', { class: 'btn btn-purge', 'data-act': 'welcome-ok', text: 'Got it ♡' }),
            h('button', { class: 'btn btn-quiet', 'data-act': 'welcome-batch', text: 'Purge many chats' })))),
      h('div', { class: 'body', 'data-role': 'body' },
        buildHero(),
        buildCurrentView(),
        buildBatchView()),
      h('footer', { class: 'foot' },
        h('div', { class: 'actions', 'data-role': 'idle-actions' },
          h('button', { class: 'btn btn-quiet', 'data-act': 'scan' }, icon('scan'), h('span', { 'data-role': 'scan-label', text: 'Scan' })),
          h('button', { class: 'btn btn-purge', 'data-act': 'purify' }, h('span', { 'data-role': 'purify-label', text: 'Purify' }), h('span', { class: 'btn-count', 'data-role': 'purify-count', hidden: true }))),
        h('div', { class: 'actions', 'data-role': 'run-actions', hidden: true },
          h('button', { class: 'btn btn-quiet', 'data-act': 'pause' }, icon('pause'), h('span', { text: 'Pause' })),
          h('button', { class: 'btn btn-purge', 'data-act': 'resume', hidden: true }, icon('play'), h('span', { text: 'Resume' })),
          h('button', { class: 'btn btn-stop', 'data-act': 'stop' }, icon('stop'), h('span', { text: 'Stop' }))),
        h('div', { class: 'status-row' },
          h('div', { class: 'status', 'data-role': 'status', role: 'status', 'aria-live': 'polite', dataset: { tone: 'info' } },
            h('span', { class: 'status-dot', 'aria-hidden': 'true' }),
            h('span', { 'data-role': 'status-text', text: 'Ready to purify~ ✨' })),
          h('button', { class: 'logs-btn', 'data-act': 'logs', 'aria-pressed': 'false' }, icon('heart'), h('span', { 'data-role': 'logs-label', text: 'Logs' })))));
  }

  function buildTerminal() {
    return h('section', { class: 'term', 'aria-label': 'Purifier log', hidden: true },
      h('header', { class: 'term-head', 'data-role': 'term-drag' },
        h('span', { class: 'term-title', text: 'DOPA-OS ♡ PURIFIER MAINFRAME' }),
        h('button', { class: 'icon-btn', 'data-act': 'copy-log', 'aria-label': 'Copy log', title: 'Copy log' }, icon('copy')),
        h('button', { class: 'icon-btn', 'data-act': 'close-log', 'aria-label': 'Close log', title: 'Close' }, icon('close'))),
      h('div', { class: 'term-screen' }, h('div', { class: 'term-body', 'data-role': 'term-body', role: 'log', 'aria-live': 'off' })),
      h('footer', { class: 'term-foot', 'aria-hidden': 'true' },
        h('span', {}, 'PURGED ', h('b', { 'data-role': 'tf-purged', text: '000' })),
        h('span', { class: 'tf-fail' }, 'FAILED ', h('b', { 'data-role': 'tf-failed', text: '000' })),
        h('span', { 'data-role': 'tf-rate', text: '' }),
        h('span', { class: 'tf-eta' }, 'ETA ', h('b', { 'data-role': 'tf-eta', text: '--:--' }))));
  }

  function buildModal() {
    return h('div', { class: 'modal-layer', hidden: true },
      h('div', { class: 'modal', role: 'alertdialog', tabindex: '-1', 'aria-modal': 'true', 'aria-labelledby': 'dp-modal-title', 'aria-describedby': 'dp-modal-text' },
        h('div', { class: 'modal-emote' }, h('img', { src: EMOTE_IMG, alt: '' })),
        h('div', { class: 'modal-title', id: 'dp-modal-title', 'data-role': 'modal-title' }),
        h('div', { class: 'modal-text', id: 'dp-modal-text', 'data-role': 'modal-text' }),
        h('div', { class: 'modal-buttons' },
          h('button', { class: 'btn btn-quiet', 'data-act': 'cancel', text: 'Nevermind~' }),
          h('button', { class: 'btn btn-purge btn-hold', 'data-act': 'confirm' },
            h('span', { class: 'hold-fill', 'aria-hidden': 'true' }),
            h('span', { class: 'hold-label', 'data-role': 'confirm-label', text: '✨ Do it! ✨' }))),
        h('div', { class: 'modal-hint' }, 'Hold to purify · ', h('kbd', { text: 'Esc' }), ' keeps you safe')));
  }

  function mount() {
    const host = h('div', { id: 'dopa-purifier-host' });
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483600;';
    root = host.attachShadow({ mode: 'open' });
    root.append(
      h('style', { text: CSS }),
      h('div', { class: 'layer', 'data-role': 'layer' },
        h('div', { class: 'shell', 'data-role': 'shell' }, h('div', { class: 'wobble', 'data-role': 'wobble' }, buildPanel())),
        buildTerminal(),
        h('button', { class: 'orb', 'data-act': 'restore', 'aria-label': "Open Dopa's Purifier", hidden: true },
          svg('svg', { class: 'orb-ring', viewBox: '0 0 48 48', 'aria-hidden': 'true' },
            svg('circle', { class: 'orb-track', cx: '24', cy: '24', r: '22' }),
            svg('circle', { class: 'orb-fill', cx: '24', cy: '24', r: '22', 'stroke-dasharray': `0 ${2 * Math.PI * 22}` })),
          h('img', { src: EMOTE_IMG, alt: '', draggable: 'false' }),
          h('span', { class: 'orb-badge', 'data-role': 'orb-badge', hidden: true })),
        buildModal(),
        h('div', { class: 'fx', 'aria-hidden': 'true' })));
    // Keep Discord's global hotkeys (type-to-focus-composer, Esc, etc.) out of our UI.
    for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    document.body.appendChild(host);
    return host;
  }

  // ── Status, meter, gauge ────────────────────────────────

  // Per-kill updates are quiet (aria-live off) so screen readers aren't read every deletion.
  function setStatus(text, tone = 'info', { quiet = false } = {}) {
    const el = $('[data-role="status"]');
    el.setAttribute('aria-live', quiet ? 'off' : 'polite');
    $('[data-role="status-text"]').textContent = text;
    el.title = text; // the line truncates; hover shows all of it
    el.dataset.tone = tone;
  }

  function setMood(text) {
    $('[data-role="mood"]').textContent = text;
  }

  let shownCount = 0;
  let lastSnapshot = null;
  let lastEnd = null; // { key, text, tone } summary of the last finished run, shown until the context changes

  function renderProgress(p) {
    lastSnapshot = p;
    renderHero();
  }

  const contextKey = () => (state.tab === 'current' ? `c:${state.target ? state.target.channelId : ''}` : 'batch');

  // Idle preview for whatever the tab points at: the scan verdict and its notch count.
  function previewFor() {
    if (state.tab === 'current') {
      const t = state.target;
      if (!t) return { total: 0, text: state.targetError === 'none' ? 'open a DM or channel to purify it~' : '', tone: 'quiet' };
      if (t.protected) return { total: 0, text: 'Protected forever~ nothing here can be purged 🛡', tone: 'immune' };
      const n = counts.get(t.channelId);
      if (n === undefined) return { total: 0, text: 'scan first for an honest ETA~', tone: 'quiet' };
      if (isPartialCount(t.channelId)) {
        return n
          ? { total: n, text: `${plural(n, 'message')} found so far · Discord is still indexing older ones`, tone: 'ready' }
          : { total: 0, text: 'Discord is still indexing this chat~ purify anyway, or scan again later 📚', tone: 'quiet' };
      }
      return n
        ? { total: n, text: `${plural(n, 'message')} found · ~${formatDuration(estimateSeconds(n))} to purge`, tone: 'ready' }
        : { total: 0, text: 'All clear! No messages to purge here~ ✨', tone: 'clear' };
    }
    const rows = selectedRows();
    if (!rows.length) return { total: 0, text: 'pick some chats to purify~', tone: 'quiet' };
    const scanned = rows.filter((r) => r.channelId && counts.has(r.channelId));
    const total = scanned.reduce((sum, r) => sum + counts.get(r.channelId), 0);
    // A friend without a DM can't be scanned (that would open one); the run counts them.
    const later = rows.filter((r) => r.needsDM && r.status !== 'error').length;
    const unscanned = rows.length - scanned.length - later - rows.filter((r) => r.status === 'error').length;
    const text = [
      `${plural(rows.length, 'chat')} selected`, scanned.length ? `${total.toLocaleString()} found` : '',
      unscanned ? `${unscanned} need a scan` : '', later ? `${plural(later, 'friend')} at purge` : '',
    ].filter(Boolean).join(' · ');
    return { total, text, tone: total ? 'ready' : 'quiet' };
  }

  function renderHero() {
    const p = lastSnapshot || progressSnapshot();
    const mode = run.active ? 'run' : (lastEnd && lastEnd.key === contextKey() ? 'done' : 'preview');
    const processedNow = p.deleted + p.failed + (p.gone || 0);
    const idle = mode === 'preview' ? previewFor() : null;
    const layer = $('[data-role="layer"]');
    layer.dataset.hero = mode;
    // While some chats are still uncounted the total is a floor, not a promise.
    const known = p.total > 0 && !p.partial;
    const ringTotal = mode === 'done' && p.partial ? processedNow : p.total;

    const shown = mode === 'preview' ? 0 : p.deleted;
    const countEl = $('[data-role="count"]');
    if (shown !== shownCount) {
      shownCount = shown;
      countEl.textContent = shown.toLocaleString();
    }
    countEl.classList.toggle('is-zero', shown === 0);

    if (mode === 'preview') drawRing({ total: idle.total, done: 0, fails: [], spinning: false });
    else drawRing({ total: mode === 'run' && !known ? 0 : ringTotal, done: ring.done, fails: ring.fails, spinning: mode === 'run' && !known });

    // "18 of 40" counts processed messages (purged + failed), matching the ring.
    const pct = $('[data-role="pct"]');
    pct.textContent = mode === 'preview'
      ? (idle.total ? `0 of ${idle.total.toLocaleString()}` : '')
      : known ? `${Math.min(processedNow, p.total).toLocaleString()} of ${p.total.toLocaleString()}`
        : p.total ? `${processedNow.toLocaleString()} of ${p.total.toLocaleString()}+` : '';
    pct.classList.toggle('is-full', mode === 'done' && processedNow >= ringTotal && ringTotal > 0);

    const readout = $('[data-role="readout"]');
    const line = $('[data-role="readout-line"]');
    const stats = $('[data-role="stats"]');
    stats.hidden = mode !== 'run';
    line.hidden = mode === 'run';
    if (mode === 'run') {
      const fail = $('[data-role="stat-fail"]');
      fail.querySelector('b').textContent = p.failed.toLocaleString();
      fail.classList.toggle('has-fails', p.failed > 0);
      $('[data-role="stat-eta"] b').textContent = known && processedNow >= p.total ? 'double-checking…'
        : p.etaSeconds != null ? `~${formatDuration(p.etaSeconds)} left` : (known ? 'estimating…' : '—');
      $('[data-role="stat-rate"] b').textContent = p.rate ? `${p.rate.toFixed(1)}/s` : '—';
      readout.dataset.tone = run.paused ? 'paused' : 'live';
    } else if (mode === 'done') {
      line.textContent = lastEnd.text;
      readout.dataset.tone = lastEnd.tone;
    } else {
      line.textContent = idle.text;
      readout.dataset.tone = idle.tone;
    }

    const sub = $('[data-role="hero-sub"]');
    if (mode === 'run') sub.textContent = p.total ? `${processedNow.toLocaleString()} of ${p.total.toLocaleString()}${known ? '' : '+'}${p.failed ? ` · ${p.failed} failed` : ''}` : 'counting as we go~';
    else sub.textContent = mode === 'done' ? lastEnd.text : idle.text;
    sub.title = sub.textContent; // the Batch strip truncates; hover shows all of it

    // Minimised through the finish line: the orb keeps the full ring and count until reopened.
    const orbC = 2 * Math.PI * 22;
    const orbFrac = run.active ? (known ? Math.min(1, processedNow / p.total) : 0)
      : state.orbDone ? (state.orbDone.clean ? 1 : (p.total ? Math.min(1, processedNow / p.total) : 0)) : 0;
    $('.orb-fill').setAttribute('stroke-dasharray', `${(orbC * orbFrac).toFixed(2)} ${orbC.toFixed(2)}`);
    $('.orb-fill').setAttribute('visibility', orbFrac > 0 ? 'visible' : 'hidden');
    const badge = $('[data-role="orb-badge"]');
    badge.textContent = p.deleted.toLocaleString();
    badge.hidden = !(run.active || state.orbDone) || !p.deleted;
    $('.orb').dataset.live = run.active ? 'true' : state.orbDone ? (state.orbDone.clean ? 'done' : 'trouble') : 'false';

    let mood = 'awaiting orders, princess~';
    if (mode === 'run') mood = run.stopping ? 'wrapping up~' : run.paused ? 'paused~ take your time' : "purging… don't look~";
    else if (mode === 'done') mood = lastEnd.error ? 'oh no… something broke' : lastEnd.stopped ? 'stopped~ the rest can wait' : lastEnd.problems ? 'some chats fought back~' : lastEnd.failed ? 'mostly clean, princess ♡' : 'all clean, princess ♡';
    else if (state.tab === 'batch') mood = "who's first, princess~?";
    else if (state.target && state.target.protected) mood = 'this one is protected~';
    setMood(mood);

    const sticker = $('[data-role="sticker"]');
    const stickerText = mode === 'done' && state.tab === 'current' && lastEnd.sticker ? lastEnd.sticker : '';
    if (stickerText !== sticker.textContent || sticker.hidden === !!stickerText) {
      sticker.textContent = stickerText;
      sticker.hidden = !stickerText;
      if (stickerText && !reducedMotion()) {
        sticker.animate([
          { transform: 'rotate(-28deg) scale(0)', opacity: 0 },
          { transform: 'rotate(14deg) scale(1.15)', opacity: 1, offset: 0.6 },
          { transform: 'rotate(9deg) scale(1)' },
        ], { duration: 520, delay: 380, easing: 'cubic-bezier(.2,.9,.3,1.2)', fill: 'backwards' });
      }
    }

    $('[data-role="tf-purged"]').textContent = String(p.deleted).padStart(3, '0');
    $('[data-role="tf-failed"]').textContent = String(p.failed).padStart(3, '0');
    $('.tf-fail').classList.toggle('has-fails', p.failed > 0);
    $('[data-role="tf-rate"]').textContent = run.active && p.rate ? `${p.rate.toFixed(1)}/s` : '';
    $('[data-role="tf-eta"]').textContent = run.active && p.etaSeconds != null ? clockTime(p.etaSeconds) : '--:--';
  }

  function clockTime(seconds) {
    const t = Math.max(0, Math.round(seconds));
    const two = (n) => String(n).padStart(2, '0');
    return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}` : `${two(Math.floor(t / 60))}:${two(t % 60)}`;
  }

  // ── Current channel ─────────────────────────────────────

  let describeSeq = 0;
  async function refreshRoute({ keepScan = false } = {}) {
    const route = routeTarget();
    const key = route ? route.channelId : '';
    if (state.route && route && state.route.channelId === key) return;
    if (!state.route && !route && state.target === null && state.targetError === 'none') return;
    if (state.scanning && state.scanKind === 'current' && !keepScan) cancelScan();
    state.route = route;
    state.target = null;
    state.targetError = route ? null : 'none';
    const seq = ++describeSeq;
    renderCurrent();
    if (!route) { if (!run.active) setStatus('Open a chat to purify~', 'info'); return; }
    try {
      const target = await describeRoute(route);
      if (seq !== describeSeq) return; // user moved on while we were asking
      state.target = target;
      if (target.protected && !run.active) setStatus(`${target.name} is immune~`, 'immune');
    } catch (err) {
      if (seq !== describeSeq) return;
      state.target = { channelId: route.channelId, guildId: route.guildId, kind: route.guildId ? 'guild' : 'dm', name: route.channelId, context: '', protected: false };
      state.targetError = err.message;
      setStatus(`Couldn't read this channel: ${err.message} 😿`, 'error');
    }
    renderCurrent();
  }

  function renderCurrent() {
    const runningHere = run.active && state.runMode === 'current';
    const shown = runningHere ? state.runTargets[0] : state.target;
    const card = $('[data-role="target"]');
    card.dataset.state = runningHere ? (run.paused ? 'paused' : 'live') : (shown && shown.protected ? 'immune' : 'idle');
    const purified = !runningHere && lastEnd && lastEnd.key === contextKey() && !lastEnd.stopped && !lastEnd.error && !lastEnd.problems && state.tab === 'current';
    if (purified) card.dataset.state = 'purified';
    const eyebrow = $('[data-role="eyebrow-text"]');
    if (runningHere) eyebrow.replaceChildren(...(run.paused ? ['Paused · resumes in place'] : [icon('dagger', 'ico-dagger ico-dagger-r'), 'Purging']));
    else if (shown && shown.protected) eyebrow.replaceChildren(icon('crown', 'ico-crown'), 'Immune');
    else if (purified) eyebrow.replaceChildren(icon('check'), lastEnd.failed ? 'Mostly purified' : 'Purified');
    else eyebrow.replaceChildren(shown && !shown.guildId ? (shown.kind === 'group' ? 'Group DM' : 'Direct message') : 'Current channel');
    if (purified && lastEnd.failed) card.dataset.state = 'partial';
    const ico = $('[data-role="target-ico"]');
    if (shown && shown.protected) ico.replaceChildren(icon('shield'));
    else ico.textContent = !shown ? '✦' : shown.guildId ? '#' : (shown.kind === 'group' ? '👥' : '@');
    // DMs can be shielded right from the card.
    const tools = $('[data-role="target-tools"]');
    const partner = !runningHere && shown && shown.partner;
    tools.replaceChildren(...(partner ? [shieldButton(partner, { protectedNow: !!shown.protected, label: shown.name })] : []));
    const note = $('[data-role="target-note"]');
    note.hidden = !purified;
    note.textContent = purified ? (lastEnd.failed ? `${lastEnd.failed.toLocaleString()} wouldn't budge — see logs` : 'Nothing left of you here~') : '';
    const name = $('[data-role="target-name"]');
    const context = $('[data-role="target-context"]');
    if (shown) {
      name.textContent = shown.guildId ? shown.name.replace(/^#/, '') : shown.name;
      context.textContent = shown.guildId ? shown.context : '';
    } else {
      name.textContent = state.targetError === 'none' ? 'No channel open' : 'detecting…';
      context.textContent = '';
    }
    context.hidden = !context.textContent;
    const viewing = $('[data-role="target-viewing"]');
    const elsewhere = runningHere && state.target && state.target.channelId !== shown.channelId;
    viewing.hidden = !elsewhere;
    if (elsewhere) viewing.textContent = `viewing ${state.target.name}`;
    renderHero();
    renderActions();
  }

  // ── Actions ─────────────────────────────────────────────

  function selectedRows() {
    return Array.from(state.selected).map((k) => state.batchRows.get(k)).filter((r) => r && !r.protected);
  }

  function renderActions() {
    const idle = $('[data-role="idle-actions"]');
    const running = $('[data-role="run-actions"]');
    idle.hidden = run.active;
    running.hidden = !run.active;
    $('[data-act="pause"]').hidden = run.paused;
    $('[data-act="resume"]').hidden = !run.paused;
    $('[data-act="pause"]').disabled = run.stopping;
    $('[data-act="resume"]').disabled = run.stopping;
    $('[data-act="stop"]').disabled = run.stopping;
    const scan = $('[data-act="scan"]');
    const purify = $('[data-act="purify"]');
    const scanLabel = $('[data-role="scan-label"]');
    const purifyLabel = $('[data-role="purify-label"]');
    const purifyCount = $('[data-role="purify-count"]');
    const rows = selectedRows();
    const badge = $('[data-role="tab-badge"]');
    badge.textContent = String(rows.length);
    badge.hidden = !rows.length;
    if (state.tab === 'current') {
      const t = state.target;
      const usable = !!t && !t.protected && !state.targetError;
      const n = usable ? counts.get(t.channelId) : undefined;
      scan.disabled = !usable && !state.scanning;
      purify.disabled = !usable || state.scanning || (n === 0 && !isPartialCount(t.channelId));
      scanLabel.textContent = state.scanning ? 'Cancel scan' : (n !== undefined ? 'Scan again' : 'Scan');
      purifyLabel.textContent = 'Purify';
      purifyCount.textContent = n ? n.toLocaleString() : '';
      purifyCount.hidden = !n;
    } else {
      scan.disabled = !rows.length && !state.scanning;
      // Nothing left to purge in any selected chat (all scanned at 0): nothing to offer.
      const allClear = rows.length && rows.every((r) => r.channelId && counts.get(r.channelId) === 0 && !isPartialCount(r.channelId));
      purify.disabled = !rows.length || state.scanning || allClear;
      scanLabel.textContent = state.scanning ? 'Cancel scan' : 'Scan selected';
      purifyLabel.textContent = 'Purify selected';
      purifyCount.textContent = String(rows.length);
      purifyCount.hidden = !rows.length;
    }
    const busy = run.active || state.scanning;
    for (const row of state.batchRows.values()) if (row.box) row.box.disabled = busy;
    for (const act of ['dm-all', 'dm-none', 'dm-refresh', 'server-refresh']) $(`[data-act="${act}"]`).disabled = busy;
    if (root.querySelector('.guild')) syncGuildChecks();
    $('[data-role="layer"]').dataset.run = run.active ? (run.paused ? 'paused' : 'running') : 'idle';
  }

  // Scans are cancellable: the Scan button becomes Cancel, and leaving the channel cancels too.
  function beginScan(kind) {
    state.scanning = true;
    state.scanKind = kind;
    state.scanAbort = new AbortController();
    renderActions();
    return state.scanAbort.signal;
  }

  function endScan() {
    state.scanning = false;
    state.scanAbort = null;
    state.scanKind = null;
    if (state.tab === 'batch') setTimeout(loadPendingLists, 0);
  }

  function cancelScan() {
    if (state.scanAbort) state.scanAbort.abort();
  }

  async function scanCurrent() {
    const t = state.target;
    if (!t || t.protected || run.active || state.scanning) return;
    const signal = beginScan('current');
    setStatus('Counting your messages… 🔍', 'info');
    try {
      const n = await countMine(t, {
        signal,
        onWait: (w) => setStatus(waitText(w), 'warn'),
        onProgress: ({ count, scanned }) => setStatus(`Scanning… found ${count.toLocaleString()} so far (${scanned.toLocaleString()} checked) 🔍`, 'info', { quiet: true }),
      });
      counts.set(t.channelId, n);
      if (lastEnd && lastEnd.key === `c:${t.channelId}`) lastEnd = null;
      const here = state.target && state.target.channelId === t.channelId;
      const where = here ? '' : ` in ${t.name}`;
      if (isPartialCount(t.channelId)) {
        setStatus(n ? `${plural(n, 'message')} found so far${where} · Discord is still indexing older ones 📚` : `Discord is still indexing${where}~ older messages may be hiding 📚`, 'warn');
      } else {
        setStatus(n ? `${plural(n, 'message')} found${where} · ~${formatDuration(estimateSeconds(n))} to purge ✨` : `All clear${where}! No messages to purge~ ✨`, 'success');
      }
    } catch (err) {
      if (err instanceof Stopped) setStatus('Scan cancelled~', 'info');
      else setStatus(`Scan error: ${err.message} 😿`, 'error');
    } finally {
      endScan();
      renderCurrent();
    }
  }

  // Friends without an open DM are not opened just to count: that would litter
  // their DM list (and looks like spam to Discord). They are counted when purged.
  async function scanSelected() {
    const rows = selectedRows();
    if (!rows.length || run.active || state.scanning) return;
    const signal = beginScan('batch');
    let grand = 0;
    let deferred = 0;
    let indexing = 0;
    let searched = false;
    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.needsDM) { deferred++; continue; }
        // Search is Discord's tightest limit: pace it like a purge does instead of leaning on 429s.
        if (searched) await sleep(TIMING.searchDelayMs, signal);
        searched = true;
        setStatus(`Scanning ${i + 1}/${rows.length}: ${row.label}… 🔍`, 'info', { quiet: true });
        setRowState(row, 'scanning');
        try {
          const n = await countMine(row, { signal, onWait: (w) => setStatus(waitText(w), 'warn') });
          counts.set(row.channelId, n);
          grand += n;
          if (isPartialCount(row.channelId)) indexing++;
          setRowState(row, isPartialCount(row.channelId) ? 'indexing' : n ? 'ready' : 'clean');
        } catch (err) {
          if (err instanceof Stopped || err.status === 401 || err.code === 'captcha') throw err;
          setRowState(row, 'error', err.message);
        }
      }
      if (lastEnd && lastEnd.key === 'batch') lastEnd = null;
      if (!searched) setStatus(`${plural(deferred, 'friend')} counted at purge~ ♡`, 'info');
      else if (indexing) setStatus(`Scan done~ ${plural(grand, 'message')} so far · Discord is still indexing ${plural(indexing, 'chat')} 📚`, 'warn');
      else setStatus(`Scan done~ ${plural(grand, 'message')} in ${plural(rows.length - deferred, 'chat')} ✨`, 'success');
    } catch (err) {
      for (const row of rows) if (row.status === 'scanning') setRowState(row, 'idle');
      if (err instanceof Stopped) setStatus('Scan cancelled~', 'info');
      else setStatus(`Scan error: ${err.message} 😿`, 'error');
    } finally {
      endScan();
      renderHero();
      renderActions();
    }
  }

  function waitText(w) {
    if (w.kind === 'rate') return `Rate limited~ waiting ${Math.ceil(w.seconds)}s… 🦇 zzz…`;
    if (w.kind === 'index') return 'Discord is still indexing this chat~ hang on… 📚';
    if (w.kind === 'network') return `Connection hiccup~ retrying in ${Math.ceil(w.seconds)}s… 📡`;
    return `Discord is having a moment~ retrying in ${Math.ceil(w.seconds)}s…`;
  }

  // The dialog names the account doing the deleting, so a switched account can't surprise anyone.
  async function actingAs() {
    try { syncAccount(); const me = await whoAmI(); return me.username; } catch { return null; }
  }

  async function askPurgeCurrent() {
    if (!state.target || state.target.protected || run.active || modal) return;
    const who = await actingAs();
    const t = state.target; // re-read: an account switch may have reset everything meanwhile
    if (!t || t.protected || run.active || modal) return;
    const n = isPartialCount(t.channelId) ? 0 : counts.get(t.channelId);
    confirmDialog({
      title: 'Ready to purify?',
      lead: n ? ['This will delete all ', h('b', { text: n.toLocaleString() }), ' of your messages in'] : ['This will delete all your messages in'],
      pill: t,
      who,
      confirmLabel: '✨ Do it! ✨',
      onConfirm: () => beginRun([{ ...t }], 'current'),
    });
  }

  async function askPurgeSelected() {
    if (!selectedRows().length || run.active || modal) return;
    const who = await actingAs();
    const rows = selectedRows(); // re-read: an account switch clears the selection
    if (!rows.length || run.active || modal) return;
    const scanned = rows.filter((r) => r.channelId && counts.has(r.channelId));
    const known = scanned.reduce((sum, r) => sum + counts.get(r.channelId), 0);
    const blocked = rows.filter((r) => r.status === 'error').length;
    const unscanned = rows.length - scanned.length - blocked;
    const more = unscanned || scanned.some((r) => isPartialCount(r.channelId));
    confirmDialog({
      title: 'Batch purify?',
      lead: [
        'Purging ', h('b', { text: `${known.toLocaleString()}${more ? '+' : ''}` }), ` of your messages from ${plural(rows.length, 'chat').replace(' ', '\u00a0')}`,
        unscanned ? ` · ${unscanned}\u00a0not\u00a0scanned` : '', blocked ? ` · ${blocked}\u00a0no\u00a0access` : '', ':',
      ],
      list: rows.map((r) => {
        const n = r.channelId ? counts.get(r.channelId) : undefined;
        return { label: r.label, meta: r.status === 'error' ? 'no access' : n === undefined ? 'not scanned' : plural(n, 'msg') };
      }),
      who,
      confirmLabel: '✨ Purify All! ✨',
      onConfirm: () => beginRun(rows, 'batch'),
    });
  }

  async function beginRun(targets, mode) {
    if (syncProtection()) protectionStale = true; // a shield from another tab; the engine honours it per chat
    state.runTargets = targets;
    state.runMode = mode;
    state.runKey = mode === 'current' ? `c:${targets[0].channelId}` : 'batch';
    ring.done = 0;
    ring.fails = [];
    lastEnd = null;
    shownCount = -1;
    clearLog();
    playDeleteSound();
    for (const t of targets) {
      t.deleted = 0;
      t.failed = 0;
      t.gone = 0;
      t.openedByUs = false;
      if (t.row) setRowState(t, 'queued');
    }
    await startRun(targets);
  }

  // ── Batch lists ─────────────────────────────────────────

  function rowKey(row) {
    return row.channelId ? `c:${row.channelId}` : `u:${row.userId}`;
  }

  function setRowState(row, status, detail) {
    row.status = status;
    const el = row.el;
    if (!el || row.protected) return;
    el.dataset.state = status;
    const n = counts.get(row.channelId);
    const deleted = (row.deleted || 0).toLocaleString();
    const msgs = (k) => h('span', { class: 'meta-count' }, h('b', { text: k.toLocaleString() }), h('small', { text: k === 1 ? ' msg' : ' msgs' }));
    const pill = (kind, ...children) => h('span', { class: `run-pill run-pill-${kind}` }, ...children);
    const tag = el.querySelector('.row-tag');
    if (status === 'ready') tag.replaceChildren(icon('dagger', 'ico-dagger ico-dagger-l'), 'READY FOR PURGE', icon('dagger', 'ico-dagger ico-dagger-r'));
    else if (status === 'running') tag.replaceChildren(row.failed ? `purging~ · ${row.failed} failed` : 'purging~');
    else if (status === 'error') tag.replaceChildren(detail ? shortReason(detail) : 'error');
    else if (status === 'partial') tag.replaceChildren(detail || 'run again later');
    else if (status === 'indexing') tag.replaceChildren('Discord is still indexing~');
    else tag.replaceChildren();
    tag.hidden = !tag.textContent;
    let meta = null;
    if (status === 'idle') meta = row.needsDM ? h('span', { class: 'chip-need', text: 'no DM yet' }) : (n !== undefined ? (n ? msgs(n) : 'clean ✓') : null);
    else if (status === 'scanning') meta = pill('scan', h('i', { class: 'spin' }), 'scanning');
    else if (status === 'ready') meta = n ? msgs(n) : null;
    else if (status === 'indexing') meta = n ? msgs(n) : 'none yet';
    else if (status === 'clean') meta = 'no messages found';
    else if (status === 'queued') meta = pill('queued', 'queued');
    else if (status === 'running') meta = pill('live', h('i', { class: 'spin' }), n ? `${deleted}/${n.toLocaleString()}` : deleted);
    else if (status === 'done') meta = pill('done', icon('check'), row.failed ? `${deleted} · ${row.failed} failed` : deleted);
    else if (status === 'partial') meta = pill('stopped', `${deleted} · again later`);
    else if (status === 'error') meta = pill('error', '✗ skipped');
    else if (status === 'stopped') meta = pill('stopped', 'stopped');
    el.querySelector('.row-meta').replaceChildren(...(meta ? [meta] : []));
    el.title = detail || '';
  }

  function shortReason(reason) {
    if (/Missing Access/i.test(reason)) return 'no access';
    if (/Missing Permissions/i.test(reason)) return 'no permission';
    if (/indexing/i.test(reason)) return 'still indexing';
    return reason.length > 28 ? `${reason.slice(0, 27)}…` : reason;
  }

  function initials(name) {
    const words = String(name).replace(/^[@#]/, '').replace(/[^\p{L}\p{N}\s,._-]/gu, '').split(/[\s,._-]+/).filter(Boolean);
    const first = words.slice(0, 2).map((w) => [...w][0]).join('');
    return (first || '✦').toUpperCase();
  }

  function hueFor(id) {
    let x = 0;
    for (const ch of String(id)) x = (x * 31 + ch.charCodeAt(0)) % 360;
    return x;
  }

  function makeRow(row, { indent = false } = {}) {
    const key = rowKey(row);
    row.key = key;
    row.row = true;
    state.batchRows.set(key, row);
    const ava = row.kind === 'guild'
      ? h('span', { class: 'row-glyph', 'aria-hidden': 'true' }, ICONS[row.glyph] ? icon(row.glyph) : row.glyph)
      : h('span', { class: 'row-ava', 'aria-hidden': 'true', style: `--tone:${hueFor(row.userId || row.channelId) % 9}`, text: initials(row.display) });
    if (row.protected) {
      row.el = h('div', { class: 'row row-immune', dataset: { key } },
        h('span', { class: 'row-shield', 'aria-hidden': 'true' }, icon('shield')),
        h('span', { class: 'row-ava', 'aria-hidden': 'true', text: initials(row.display) }),
        h('span', { class: 'row-main' }, h('span', { class: 'row-name', text: row.display }), row.sub ? h('span', { class: 'row-sub', text: row.sub }) : null),
        h('span', { class: 'row-meta' }, h('span', { class: 'chip-crown' }, icon('crown'), 'immune')),
        row.partner ? shieldButton(row.partner, { protectedNow: true, label: row.display }) : null);
      return row.el;
    }
    const box = h('input', { type: 'checkbox', class: 'check', 'aria-label': row.label });
    box.checked = state.selected.has(key);
    box.addEventListener('change', () => {
      if (box.checked) state.selected.add(row.key); else state.selected.delete(row.key);
      row.el.classList.toggle('is-selected', box.checked);
      selectionChanged();
    });
    box.disabled = run.active || state.scanning;
    row.box = box;
    row.el = h('label', { class: `row${indent ? ' row-indent' : ''}${box.checked ? ' is-selected' : ''}`, dataset: { key } },
      box,
      h('span', { class: 'check-ui', 'aria-hidden': 'true' }, icon('check')),
      ava,
      h('span', { class: 'row-main' },
        h('span', { class: 'row-name', text: row.display }),
        row.sub ? h('span', { class: 'row-sub', text: row.sub }) : null,
        h('span', { class: 'row-tag', hidden: true })),
      h('span', { class: 'row-meta' }),
      row.partner ? shieldButton(row.partner, { protectedNow: false, label: row.display }) : null);
    setRowState(row, row.status || 'idle');
    return row.el;
  }

  // Re-key a friend row once its DM exists, so the row and its selection follow the real channel id.
  function rekeyRow(row, oldKey) {
    const key = rowKey(row);
    if (key === oldKey) return;
    if (state.batchRows.get(oldKey) === row) state.batchRows.delete(oldKey);
    state.batchRows.set(key, row);
    if (state.selected.delete(oldKey)) state.selected.add(key);
    row.key = key;
    if (row.el) row.el.dataset.key = key;
  }

  function snowflakeDesc(a, b) {
    const x = BigInt(a || 0);
    const y = BigInt(b || 0);
    return x === y ? 0 : (x > y ? -1 : 1);
  }

  async function loadDMs() {
    const list = $('[data-role="dm-list"]');
    if (run.active || state.scanning) {
      if (!state.dmsLoaded) list.replaceChildren(h('div', { class: 'list-empty', text: 'Lists load when the purge finishes~' }));
      return;
    }
    list.replaceChildren(h('div', { class: 'list-empty', text: 'Loading DMs & friends… 💬' }));
    try {
      const [channels, relationships] = await Promise.all([listDMs(), listRelationships()]);
      state.dmData = { channels, relationships };
      const counted = renderDMs();
      if (state.tab === 'batch' && !run.active) setStatus(`Loaded ${plural(counted.dms, 'DM')} + ${plural(counted.friends, 'friend')} ✨`, 'success');
    } catch (err) {
      list.replaceChildren(h('div', { class: 'list-empty', text: `Failed to load DMs 😿 ${err.message}` }));
    }
    renderActions();
  }

  // Build the DM list from the last fetch (also used to redraw after shielding someone).
  function renderDMs() {
    const list = $('[data-role="dm-list"]');
    const { channels, relationships } = state.dmData;
    for (const [key, row] of state.batchRows) if (row.kind !== 'guild') state.batchRows.delete(key);
    const dms = channels.filter((c) => c.type === 1 || c.type === 3)
      .sort((a, b) => snowflakeDesc(a.last_message_id, b.last_message_id));
    const withDM = new Set(dms.filter((c) => c.type === 1).map((c) => c.recipients && c.recipients[0] && c.recipients[0].id));
    const rows = dms.map((c) => ({
      kind: c.type === 3 ? 'group' : 'dm',
      channelId: c.id,
      guildId: null,
      name: dmTitle(c),
      display: dmTitle(c),
      sub: c.type === 3 ? 'group' : (c.recipients && c.recipients[0] ? `@${c.recipients[0].username}` : ''),
      glyph: c.type === 3 ? '👥' : '',
      partner: c.type === 1 && c.recipients ? c.recipients[0] : null,
      protected: isProtectedChannel(c),
      label: c.type === 3 ? `Group: ${dmTitle(c)}` : `DM: ${dmTitle(c)}`,
      context: c.type === 3 ? 'Group DM' : 'Direct message',
    }));
    for (const rel of relationships) {
      if (rel.type !== 1 || withDM.has(rel.id)) continue;
      const user = rel.user || {};
      const name = user.global_name || user.username || 'Unknown';
      rows.push({
        kind: 'friend', channelId: null, userId: rel.id, needsDM: true, guildId: null,
        name, display: name, sub: user.username ? `@${user.username} · friend` : 'friend', glyph: '',
        partner: user,
        protected: isProtectedUser(user),
        label: `Friend: ${name}`, context: 'Direct message',
      });
    }
    rows.sort((a, b) => Number(b.protected) - Number(a.protected));
    for (const r of rows) if (r.protected) state.selected.delete(rowKey(r));
    list.replaceChildren(...(rows.length ? rows.map((r) => makeRow(r)) : [h('div', { class: 'list-empty', text: 'No DMs or friends found~' })]));
    state.dmsLoaded = true;
    applyFilter();
    const dmRows = rows.filter((r) => r.kind !== 'friend').length;
    return { dms: dmRows, friends: rows.length - dmRows };
  }

  // ── Protection ──────────────────────────────────────────

  function immuneSummary() {
    const names = [...PROTECTED_USERNAMES].filter((n) => !protection.released.has(n));
    const extra = protection.ids.size ? ` + ${protection.ids.size} shielded` : '';
    return (names.join(', ') || 'nobody yet') + extra;
  }

  function toggleProtection(user) {
    if (!user || run.active) return;
    syncProtection(); // start from every tab's shields, not just this one's
    const shield = !isProtectedUser(user);
    setProtected(user, shield);
    storeProtection();
    const name = user.global_name || user.username;
    addLog(shield ? `shielded ${name} — they're immune now ♡` : `${name} is no longer immune`, 'info');
    setStatus(shield ? `${name} is immune now~` : `${name} can be purged again`, shield ? 'immune' : 'info');
    protectionChanged();
  }

  // Redraw everything that shows who is immune.
  function protectionChanged({ keepVerdict = false } = {}) {
    if (state.dmData) renderDMs();
    const partner = state.target && state.target.partner;
    if (partner) state.target.protected = isProtectedUser(partner);
    if (!keepVerdict && lastEnd && lastEnd.key === contextKey()) lastEnd = null;
    renderCurrent();
  }

  // Another tab shielded or released someone: take it on now, or once this tab's run ends
  // (the engine re-checks shields as it reaches each chat either way).
  let protectionStale = false;
  function onStorage(e) {
    if (e.key !== PREFS_KEY && e.key !== null) return;
    if (!syncProtection()) return;
    if (run.active) protectionStale = true;
    else protectionChanged();
  }

  function shieldButton(user, { protectedNow, label }) {
    const btn = h('button', {
      class: `shield-btn${protectedNow ? ' is-on' : ''}`,
      type: 'button',
      'aria-pressed': String(protectedNow),
      'aria-label': protectedNow ? `Stop protecting ${label}` : `Protect ${label}`,
      title: protectedNow ? 'Immune — click to allow purging again' : 'Protect — never purge this chat',
    }, icon('shield'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleProtection(user);
    });
    return btn;
  }

  async function loadServers({ refresh = false } = {}) {
    const list = $('[data-role="server-list"]');
    if (run.active || state.scanning) {
      if (!state.guildsLoaded) list.replaceChildren(h('div', { class: 'list-empty', text: 'Lists load when the purge finishes~' }));
      return;
    }
    list.replaceChildren(h('div', { class: 'list-empty', text: 'Loading servers… 🏰' }));
    try {
      const guilds = await myGuilds({ refresh });
      for (const [key, row] of state.batchRows) if (row.kind === 'guild') state.batchRows.delete(key);
      list.replaceChildren(...(guilds.length ? guilds.map(buildGuild) : [h('div', { class: 'list-empty', text: 'No servers found~' })]));
      state.guildsLoaded = true;
      applyFilter();
    } catch (err) {
      list.replaceChildren(h('div', { class: 'list-empty', text: `Failed to load servers 😿 ${err.message}` }));
    }
  }

  // A guild is a disclosure button plus a tri-state "all channels" checkbox.
  function buildGuild(guild) {
    const channelsEl = h('div', { class: 'guild-channels', hidden: true });
    const head = h('button', { class: 'guild-head', 'aria-expanded': 'false' },
      h('span', { class: 'guild-chevron', 'aria-hidden': 'true' }, icon('chevron')),
      h('span', { class: 'guild-badge', 'aria-hidden': 'true', text: initials(guild.name) }),
      h('span', { class: 'guild-name', text: guild.name }),
      h('span', { class: 'guild-meta', 'data-role': 'guild-meta' }));
    const all = h('input', { type: 'checkbox', class: 'check', 'aria-label': `All channels in ${guild.name}` });
    const allLabel = h('label', { class: 'guild-all', title: 'Select every channel' }, all, h('span', { class: 'check-ui', 'aria-hidden': 'true' }, icon('check')));
    const section = h('div', { class: 'guild', dataset: { guildId: guild.id, name: guild.name.toLowerCase() } },
      h('div', { class: 'guild-bar' }, head, allLabel), channelsEl);
    let loading = null;
    const load = () => {
      if (!loading) {
        channelsEl.replaceChildren(h('div', { class: 'list-empty', text: 'Loading channels…' }));
        loading = listTextChannels(guild.id).then((channels) => {
          const rows = channels.map((ch) => ({
            kind: 'guild', channelId: ch.id, guildId: guild.id,
            name: `#${ch.name}`, display: ch.name, glyph: ch.type === 2 || ch.type === 13 ? 'sound' : ch.type === 5 ? 'megaphone' : ch.type === 15 || ch.type === 16 ? 'forum' : '#',
            sub: ch.categoryName ? ch.categoryName.toLowerCase() : '',
            protected: false, label: `#${ch.name} (${guild.name})`, context: guild.name,
          }));
          channelsEl.replaceChildren(...(rows.length ? rows.map((r) => makeRow(r, { indent: true })) : [h('div', { class: 'list-empty', text: 'No text channels~' })]));
          head.querySelector('[data-role="guild-meta"]').textContent = plural(rows.length, 'channel');
          applyFilter();
          syncGuildChecks();
        }, (err) => {
          loading = null;
          channelsEl.replaceChildren(h('div', { class: 'list-empty', text: `Couldn't load channels 😿 ${err.message}` }));
          throw err;
        });
      }
      return loading;
    };
    const expand = (open) => {
      head.setAttribute('aria-expanded', String(open));
      channelsEl.hidden = !open;
      if (open) load().catch(() => {});
    };
    head.addEventListener('click', () => expand(head.getAttribute('aria-expanded') !== 'true'));
    all.addEventListener('change', async () => {
      const checked = all.checked;
      expand(true);
      try { await load(); } catch { all.checked = false; return; }
      for (const row of state.batchRows.values()) {
        if (row.guildId !== guild.id || !row.box || row.el.hidden) continue;
        row.box.checked = checked;
        if (checked) state.selected.add(row.key); else state.selected.delete(row.key);
        row.el.classList.toggle('is-selected', checked);
      }
      selectionChanged();
    });
    return section;
  }

  function syncGuildChecks() {
    for (const section of $$('.guild')) {
      const box = section.querySelector('.guild-all .check');
      const rows = Array.from(state.batchRows.values()).filter((r) => r.guildId === section.dataset.guildId && r.box);
      const picked = rows.filter((r) => state.selected.has(r.key)).length;
      box.checked = rows.length > 0 && picked === rows.length;
      box.indeterminate = picked > 0 && picked < rows.length;
      box.disabled = run.active || state.scanning;
      const meta = section.querySelector('[data-role="guild-meta"]');
      if (rows.length) meta.textContent = picked ? `${picked} of ${rows.length}` : plural(rows.length, 'channel');
    }
  }

  function applyFilter() {
    const q = state.filter.trim().toLowerCase();
    for (const row of state.batchRows.values()) {
      if (!row.el) continue;
      const hay = `${row.display} ${row.name} ${row.label} ${row.sub || ''}`.toLowerCase();
      row.el.hidden = !!q && !hay.includes(q);
    }
    for (const guild of $$('.guild')) {
      const nameHit = !q || guild.dataset.name.includes(q);
      const anyChannel = Array.from(guild.querySelectorAll('.row')).some((r) => !r.hidden);
      guild.hidden = !nameHit && !anyChannel;
      if (q && nameHit) for (const r of guild.querySelectorAll('.row')) r.hidden = false;
    }
  }

  function selectAllDMs(checked) {
    for (const row of state.batchRows.values()) {
      if (row.kind === 'guild' || row.protected || !row.box || row.el.hidden) continue;
      if (checked && row.needsDM) continue; // "All" means chats you already have; friends are opt-in
      row.box.checked = checked;
      if (checked) state.selected.add(row.key); else state.selected.delete(row.key);
      row.el.classList.toggle('is-selected', checked);
    }
    selectionChanged();
  }

  function selectionChanged() {
    if (lastEnd && lastEnd.key === 'batch') lastEnd = null;
    syncGuildChecks();
    renderHero();
    renderActions();
  }

  // ── Tabs ────────────────────────────────────────────────

  function switchTab(tab, { initial = false } = {}) {
    state.tab = tab;
    prefs.tab = tab;
    if (!initial) savePrefs('tab');
    const layer = $('[data-role="layer"]');
    layer.dataset.tab = tab;
    for (const t of $$('.tab')) {
      const selected = t.dataset.tab === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
    }
    for (const v of $$('.view')) v.hidden = v.dataset.view !== tab;
    if (tab === 'batch') {
      if (!state.dmsLoaded) loadDMs();
      if (!state.guildsLoaded) loadServers();
    }
    if (!initial) kick({ stretch: tab === 'batch' ? 0.025 : -0.025 });
    renderCurrent();
    layoutPanel();
  }

  // ── Confirm dialog (hold to confirm) ────────────────────

  const HOLD_MS = 850;
  let modal = null; // { onConfirm, restoreFocus, label, openedAt }
  let dialogTimer = 0;

  function targetPill(t) {
    return h('div', { class: 'pill' },
      h('span', { class: 'pill-glyph', text: t.guildId ? '#' : (t.kind === 'group' ? '👥' : '@') }),
      h('span', { class: 'pill-name', text: t.guildId ? t.name.replace(/^#/, '') : t.name }),
      t.guildId && t.context ? h('span', { class: 'pill-context', text: `· ${t.context}` }) : null);
  }

  function confirmDialog({ title, lead, pill, list, who, confirmLabel, onConfirm }) {
    if (modal) return;
    const layer = $('.modal-layer');
    $('[data-role="modal-title"]').textContent = title;
    const text = $('[data-role="modal-text"]');
    text.replaceChildren(...[
      h('p', { class: 'modal-lead' }, lead),
      pill && targetPill(pill),
      list && h('div', { class: 'modal-list' }, list.map((item) => h('div', { class: 'modal-item' },
        h('span', { class: 'modal-item-name', text: item.label }),
        h('span', { class: `modal-item-meta${item.meta === 'not scanned' ? ' is-unknown' : ''}`, text: item.meta })))),
      who && h('div', { class: 'modal-who' }, 'as ', h('b', { text: `@${who}` })),
      h('div', { class: 'modal-warn', text: "This can't be undone~ 🩸" }),
    ].filter(Boolean));
    $('[data-role="confirm-label"]').textContent = confirmLabel;
    modal = { onConfirm, restoreFocus: root.activeElement, label: confirmLabel, openedAt: performance.now() };
    clearTimeout(dialogTimer);
    layer.hidden = false;
    layer.dataset.open = 'true';
    resetHold();
    $('[data-act="cancel"]').focus();
  }

  function closeDialog(confirmed) {
    if (!modal) return;
    const { onConfirm, restoreFocus } = modal;
    modal = null;
    resetHold();
    const layer = $('.modal-layer');
    layer.dataset.open = 'false';
    const finish = () => { if (!modal) layer.hidden = true; };
    clearTimeout(dialogTimer);
    if (reducedMotion()) finish(); else dialogTimer = setTimeout(finish, 160);
    if (confirmed) onConfirm();
    else if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
  }

  const hold = { start: 0, raf: 0, active: false };

  function resetHold() {
    cancelAnimationFrame(hold.raf);
    hold.active = false;
    const btn = $('[data-act="confirm"]');
    btn.style.setProperty('--hold', '0');
    btn.classList.remove('is-holding');
    if (modal) $('[data-role="confirm-label"]').textContent = modal.label;
  }

  function beginHold() {
    if (!modal || hold.active) return;
    hold.active = true;
    hold.start = performance.now();
    const btn = $('[data-act="confirm"]');
    btn.classList.add('is-holding');
    const step = (now) => {
      if (!hold.active) return;
      const t = Math.min(1, (now - hold.start) / HOLD_MS);
      btn.style.setProperty('--hold', String(t));
      $('[data-role="confirm-label"]').textContent = t < 1 ? 'Keep holding~' : 'Purifying~';
      if (t >= 1) {
        hold.active = false;
        closeDialog(true);
        return;
      }
      hold.raf = requestAnimationFrame(step);
    };
    hold.raf = requestAnimationFrame(step);
  }

  function endHold() {
    if (!hold.active) return;
    resetHold();
    const label = $('[data-role="confirm-label"]');
    label.dataset.nudge = 'true';
    setTimeout(() => { delete label.dataset.nudge; }, 600);
  }

  function trapFocus(e) {
    if (!modal || e.key !== 'Tab') return;
    const items = [$('[data-act="cancel"]'), $('[data-act="confirm"]')];
    const i = Math.max(-1, items.indexOf(root.activeElement));
    e.preventDefault();
    items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
  }

  // ── Terminal log ────────────────────────────────────────

  const LOG_LIMIT = 800;
  const LOG_PREFIX = { success: '♡', error: '✗', warn: '⚠', info: '›', skip: '·' };

  function bannerLine(text) {
    return h('div', { class: 'line banner' }, h('span', { class: 'line-pfx', text: '>' }), h('span', { class: 'line-msg', text }));
  }

  function logBanner() {
    return [
      bannerLine('wake up, princess~'),
      bannerLine('loading heart.sys · dagger.dll'),
      bannerLine(`immune list · ${immuneSummary()} ♡`),
      bannerLine('♡ SYSTEM ONLINE ♡'),
      bannerLine('AWAITING ORDERS, PRINCESS~'),
      h('div', { class: 'line banner rule' }, h('span', { class: 'line-pfx', text: '>' }), h('span', { class: 'line-msg', text: '♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡' })),
      h('div', { class: 'line prompt', 'data-role': 'prompt' },
        h('span', { class: 'prompt-who', text: 'dopa@mainframe' }),
        h('span', { class: 'prompt-sep', text: ' ♡ ' }),
        h('span', { class: 'prompt-cmd', 'data-role': 'prompt-cmd' }),
        h('span', { class: 'cursor', 'aria-hidden': 'true' })),
    ];
  }

  function setPrompt(text) {
    const cmd = $('[data-role="prompt-cmd"]');
    if (cmd) cmd.textContent = text;
  }

  // Once a run ends, the text of messages that no longer exist leaves the page too.
  function scrubLog() {
    for (const line of $$('.term-body .line[data-scrub]')) {
      line.querySelector('.line-msg').textContent = line.dataset.scrub;
      delete line.dataset.scrub;
    }
  }

  function clearLog() {
    $('[data-role="term-body"]').replaceChildren(...logBanner());
  }

  function addLog(text, tone = 'info', { scrub } = {}) {
    const body = $('[data-role="term-body"]');
    const pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    const time = new Date().toTimeString().slice(0, 8);
    const line = h('div', { class: `line ${tone}` },
      h('span', { class: 'line-time', text: time }),
      h('span', { class: 'line-pfx', text: LOG_PREFIX[tone] || '›' }),
      h('span', { class: 'line-msg', text }));
    if (scrub) line.dataset.scrub = scrub;
    body.insertBefore(line, $('[data-role="prompt"]'));
    const lines = body.querySelectorAll('.line:not(.banner):not(.prompt)');
    if (lines.length > LOG_LIMIT) lines[0].remove();
    if (pinned) body.scrollTop = body.scrollHeight;
  }

  function preview(msg, max = 56) {
    const text = (msg.content || '').replace(/\s+/g, ' ').trim();
    if (!text) return msg.attachments && msg.attachments.length ? '[attachment]' : '[embed/sticker]';
    const chars = [...text];
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
  }

  function toggleLog(force) {
    const term = $('.term');
    const open = force != null ? force : term.hidden;
    term.hidden = !open;
    $('[data-act="logs"]').setAttribute('aria-pressed', String(open));
    $('[data-role="logs-label"]').textContent = 'Logs';
    if (open) {
      placeTerminal();
      term.dataset.boot = 'true';
      setTimeout(() => { delete term.dataset.boot; }, 700);
      const body = $('[data-role="term-body"]');
      body.scrollTop = body.scrollHeight;
    }
  }

  function placeTerminal() {
    const term = $('.term');
    if (term.hidden) return;
    const panel = $('.panel').getBoundingClientRect();
    const w = term.offsetWidth || 380;
    const hgt = term.offsetHeight || 420;
    const gap = 14;
    let left = panel.left - w - gap;
    if (left < 8) left = panel.right + gap;
    if (left + w > innerWidth - 8) left = clamp(innerWidth - w - 8, 8, innerWidth);
    const top = clamp(panel.top, 8, Math.max(8, innerHeight - hgt - 8));
    term.style.left = `${Math.round(left)}px`;
    term.style.top = `${Math.round(top)}px`;
  }

  async function copyLog() {
    const text = $$('.term-body .line').map((l) => l.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      addLog('log copied to clipboard ♡', 'info');
    } catch {
      addLog('clipboard is locked~ select the text instead', 'warn');
    }
  }

  // ── Motion: springs, blood, confetti ────────────────────

  const wob = { rot: new Spring(220, 16, 0), sx: new Spring(260, 15, 1), sy: new Spring(260, 15, 1), raf: 0, last: 0 };

  function animateWobble(now) {
    const dt = Math.min(0.032, (now - wob.last) / 1000 || 1 / 60);
    wob.last = now;
    const moving = [wob.rot.step(dt), wob.sx.step(dt), wob.sy.step(dt)].some(Boolean);
    const el = $('[data-role="wobble"]');
    if (moving) {
      el.style.transform = `rotate(${wob.rot.value.toFixed(3)}deg) scale(${wob.sx.value.toFixed(4)}, ${wob.sy.value.toFixed(4)})`;
      wob.raf = requestAnimationFrame(animateWobble);
    } else {
      wob.rot.settle(); wob.sx.settle(); wob.sy.settle();
      el.style.transform = '';
      wob.raf = 0;
    }
  }

  function kick({ spin = 0, squash = 0, stretch = 0 } = {}) {
    if (reducedMotion()) return;
    wob.rot.velocity += spin;
    wob.sx.velocity += stretch + squash;
    wob.sy.velocity += -squash - stretch * 0.6;
    if (!wob.raf) {
      wob.last = performance.now();
      wob.raf = requestAnimationFrame(animateWobble);
    }
  }

  function popCount() {
    const el = $('[data-role="count"]');
    if (reducedMotion() || !fxVisible()) return;
    el.animate([
      { transform: 'scale(1.07)', color: 'var(--rose-300)', textShadow: '0 0 22px rgba(255, 122, 169, .8)' },
      { transform: 'scale(0.99)', offset: 0.6 },
      { transform: 'none' },
    ], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  // A couple of drops fall from just outside the ring's leading edge, clear of the number.
  const fxVisible = () => !document.hidden && !$('[data-role="shell"]').hidden;

  function bleed() {
    if (reducedMotion() || !fxVisible()) return;
    const zone = $('.blood');
    while (zone.childElementCount > 9) zone.firstElementChild.remove();
    const { x, y, angle } = ringHead(lastSnapshot ? lastSnapshot.total : 0);
    const ox = Math.cos(angle) * 12;
    const oy = Math.sin(angle) * 12;
    const drops = 2 + Math.round(Math.random());
    for (let i = 0; i < drops; i++) {
      const d = h('i', { class: 'drop' });
      const size = 0.55 + Math.random() * 0.5;
      d.style.left = `${x + ox + (Math.random() - 0.5) * 6}px`;
      d.style.top = `${y + oy}px`;
      zone.append(d);
      const fall = 18 + Math.random() * 18;
      d.animate([
        { transform: `scale(${size * 0.6}, ${size * 0.9})`, opacity: 0 },
        { transform: `translate(${(ox / 12 * fall * 0.24).toFixed(1)}px, ${(oy / 12 * fall * 0.24 + fall * 0.07).toFixed(1)}px) scale(${size}, ${size * 1.2})`, opacity: 1, offset: 0.3 },
        { transform: `translate(${(ox / 12 * fall * 0.8).toFixed(1)}px, ${(oy / 12 * fall * 0.8 + fall * 0.8).toFixed(1)}px) scale(${size * 0.9}, ${size * 1.35})`, opacity: 0 },
      ], { duration: 700 + Math.random() * 400, delay: i * 70, easing: 'cubic-bezier(.5,0,.9,.6)', fill: 'backwards' })
        .finished.then(() => d.remove(), () => d.remove());
    }
  }

  // Confetti bursts outward from the ring's rim, so it frames the number instead of covering it.
  function celebrate() {
    kick({ spin: (Math.random() - 0.5) * 24, squash: 0.8 });
    if (reducedMotion() || !fxVisible()) return;
    const fx = $('[data-role="burst"]');
    const box = fx.getBoundingClientRect();
    const g = $('.gauge').getBoundingClientRect();
    const cx = g.left + g.width / 2 - box.left;
    const cy = g.top + g.height / 2 - box.top;
    const rim = g.width * 0.46;
    const colors = ['#ff7aa9', '#ffa0c2', '#ffe3ed', '#ff4a63', '#ffc4d8', '#f2568f'];
    const glyphs = ['♡', '✦', '✧', '❤'];
    for (let i = 0; i < 56; i++) {
      const glyph = i % 4 === 0;
      const color = colors[i % colors.length];
      const angle = Math.random() * Math.PI * 2;
      const p = h('i', { class: glyph ? 'confetti confetti-glyph' : 'confetti', text: glyph ? glyphs[i % glyphs.length] : '' });
      const size = glyph ? 10 + Math.random() * 7 : 4 + Math.random() * 4;
      const x0 = cx + Math.cos(angle) * rim;
      const y0 = cy + Math.sin(angle) * rim;
      p.style.cssText = `left:${x0}px;top:${y0}px;` + (glyph
        ? `color:${color};font-size:${size}px;`
        : `background:${color};width:${size}px;height:${size * (1.2 + Math.random())}px;border-radius:${Math.random() < 0.35 ? '50%' : '2px 6px'};`);
      fx.append(p);
      const power = 14 + Math.random() * 46;
      const vx = Math.cos(angle) * power;
      const vy = Math.sin(angle) * power - 24;
      const spin = (Math.random() - 0.5) * 720;
      const frames = [];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        const ease = 1 - (1 - t) ** 2;
        frames.push({
          transform: `translate(${(vx * ease).toFixed(1)}px, ${(vy * ease + 60 * t * t).toFixed(1)}px) rotate(${(spin * t).toFixed(0)}deg) scale(${(1 - t * 0.3).toFixed(2)})`,
          opacity: t < 0.2 ? t / 0.2 : (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3),
        });
      }
      p.animate(frames, { duration: 1300 + Math.random() * 800, easing: 'linear', delay: Math.random() * 140, fill: 'backwards' })
        .finished.then(() => p.remove(), () => p.remove());
    }
  }

  // ── Placement, drag, minimise ───────────────────────────

  function panelSize() {
    const panel = $('.panel');
    return { w: panel.offsetWidth, h: panel.offsetHeight };
  }

  function placeShell(x, y) {
    const shell = $('[data-role="shell"]');
    const w = panelSize().w || 360; // hidden while minimised: measure as its real width
    const nx = clamp(x, 8, Math.max(8, innerWidth - w - 8));
    const ny = clamp(y, 8, Math.max(8, innerHeight - 120));
    shell.style.left = `${Math.round(nx)}px`;
    shell.style.top = `${Math.round(ny)}px`;
    prefs.x = nx;
    prefs.y = ny;
    layoutPanel();
    return { x: nx, y: ny };
  }

  const MIN_PANEL = 400;

  // Keep the whole panel (and its footer) on screen: if it was dragged low, lift
  // it so at least MIN_PANEL pixels fit, then cap the height to what is left.
  function layoutPanel() {
    if (!root) return;
    const shell = $('[data-role="shell"]');
    let top = parseFloat(shell.style.top) || 56;
    const lifted = Math.max(8, Math.min(top, innerHeight - MIN_PANEL - 12));
    if (lifted !== top) {
      top = lifted;
      shell.style.top = `${Math.round(top)}px`;
      prefs.y = top;
    }
    $('.panel').style.maxHeight = `${Math.max(240, innerHeight - top - 12)}px`;
    placeTerminal();
    placeOrb();
  }

  function defaultPosition() {
    return { x: innerWidth - panelSize().w - 20, y: 56 };
  }

  function makeDraggable() {
    const handle = $('[data-role="drag"]');
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const shell = $('[data-role="shell"]');
      drag = { id: e.pointerId, dx: e.clientX - shell.offsetLeft, dy: e.clientY - shell.offsetTop, lastX: e.clientX, vx: 0, t: performance.now() };
      handle.setPointerCapture(e.pointerId);
      $('[data-role="layer"]').dataset.dragging = 'true';
      kick({ squash: -0.35 });
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const now = performance.now();
      const dt = Math.max(1, now - drag.t);
      drag.vx = drag.vx * 0.6 + ((e.clientX - drag.lastX) / dt) * 16 * 0.4;
      drag.lastX = e.clientX;
      drag.t = now;
      placeShell(e.clientX - drag.dx, e.clientY - drag.dy);
      if (!reducedMotion()) {
        wob.rot.target = clamp(drag.vx * 0.35, -7, 7);
        kick();
      }
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      wob.rot.target = 0;
      kick({ spin: clamp(drag.vx * 1.8, -40, 40), squash: Math.min(0.6, Math.abs(drag.vx) * 0.02) });
      drag = null;
      delete $('[data-role="layer"]').dataset.dragging;
      savePrefs('x', 'y');
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function placeOrb() {
    const orb = $('.orb');
    const shell = $('[data-role="shell"]');
    const { w } = panelSize();
    const left = (parseFloat(shell.style.left) || 0) + (w || 360) - 56;
    orb.style.left = `${Math.round(clamp(left, 8, innerWidth - 60))}px`;
    orb.style.top = `${Math.round(clamp(parseFloat(shell.style.top) || 56, 8, innerHeight - 60))}px`;
  }

  function setOpen(open, { initial = false } = {}) {
    prefs.open = open;
    if (!initial) savePrefs('open');
    const shell = $('[data-role="shell"]');
    const orb = $('.orb');
    const layer = $('[data-role="layer"]');
    if (open) {
      state.orbDone = null;
      shell.hidden = false;
      orb.hidden = true;
      layer.dataset.open = 'true';
      placeShell(parseFloat(shell.style.left) || 0, parseFloat(shell.style.top) || 0);
      if (!initial && !reducedMotion()) {
        $('.panel').animate([
          { transform: 'translate(24px, -12px) scale(0.6)', opacity: 0, transformOrigin: '90% 0' },
          { transform: 'none', opacity: 1, transformOrigin: '90% 0' },
        ], { duration: 420, easing: 'cubic-bezier(.2,1.25,.3,1)' });
        kick({ spin: (Math.random() - 0.5) * 12 });
      }
    } else {
      placeOrb();
      toggleLog(false);
      const finish = () => { shell.hidden = true; orb.hidden = false; layer.dataset.open = 'false'; };
      if (initial || reducedMotion()) { finish(); return; }
      $('.panel').animate([
        { transform: 'none', opacity: 1, transformOrigin: '90% 0' },
        { transform: 'translate(24px, -12px) scale(0.6)', opacity: 0, transformOrigin: '90% 0' },
      ], { duration: 220, easing: 'cubic-bezier(.4,0,1,1)' }).finished.then(finish, finish);
    }
  }

  function renderMute() {
    const btn = $('[data-act="mute"]');
    btn.replaceChildren(icon(prefs.muted ? 'muted' : 'sound'));
    btn.setAttribute('aria-label', prefs.muted ? 'Unmute sound' : 'Mute sound');
    btn.setAttribute('aria-pressed', String(prefs.muted));
  }

  // ── Welcome & share ─────────────────────────────────────

  function showWelcome() {
    const w = $('[data-role="welcome"]');
    w.hidden = false;
  }

  function hideWelcome() {
    $('[data-role="welcome"]').hidden = true;
    prefs.welcomed = true;
    savePrefs('welcomed');
  }

  async function shareLink() {
    const text = `Dopa's Discord Purifier — wipe your own Discord messages in a few clicks~ ✨ ${SHARE_URL}`;
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Install link copied~ send it to a friend ♡', 'success');
    } catch {
      setStatus(`Share this link~ ${SHARE_URL}`, 'info');
    }
    addLog(`share link: ${SHARE_URL}`, 'info');
  }

  // ── Run events → UI ─────────────────────────────────────

  function wireRunEvents() {
    on('start', ({ targets }) => {
      $('[data-role="count"]').textContent = '0';
      setStatus(targets.length > 1 ? `Batch purge starting~ ${plural(targets.length, 'chat')} ✨` : `Purging ${targets[0].name}~ ✨`, 'info');
      for (const t of targets) addLog(`queued: ${t.label || t.name}`, 'info');
      renderCurrent();
      renderActions();
    });
    on('target-start', ({ target, index, count }) => {
      setPrompt(`purge ${target.name}`);
      addLog(`── Starting: ${target.label || target.name} ──`, 'info');
      if (count > 1) setStatus(`Batch ${index + 1}/${count}: ${target.label || target.name}`, 'info');
      if (target.row) setRowState(target, 'running');
    });
    on('dm-opened', ({ target, previousKey }) => {
      if (target.row) rekeyRow(target, previousKey);
      addLog(`opened a DM with ${target.name} 💬`, 'info');
    });
    on('progress', (p) => {
      renderProgress(p);

    });
    on('kill', ({ target, msg }) => {
      ring.done++;
      // Kill feedback stays on the gauge; moving the whole panel would make Pause/Stop a moving target.
      popCount();
      bleed();
      addLog(`Deleted: "${preview(msg)}"`, 'success', { scrub: `Deleted ✓ ${target.name}` });
      if (!run.paused && !run.stopping) setStatus(`Deleted "${preview(msg, 34)}" ♡`, 'info', { quiet: true });
      if (target.row) setRowState(target, 'running');
    });
    on('fail', ({ target, msg, reason }) => {
      ring.fails.push(ring.done);
      ring.done++;
      const tags = [msg.pinned && 'pinned', msg.type && msg.type !== 0 && msg.type !== 19 && 'system'].filter(Boolean);
      addLog(`FAILED${tags.length ? ` (${tags.join(', ')})` : ''}: "${preview(msg)}" — ${reason}`, 'error');
      if (!run.paused && !run.stopping) setStatus(`Couldn't delete "${preview(msg, 24)}" — ${shortReason(reason)}`, 'warn', { quiet: true });
      if (target.row) setRowState(target, 'running');
    });
    on('gone', ({ msg }) => {
      ring.done++;
      addLog(`already gone (${msg.id.slice(-6)}) — nothing to do`, 'skip');
    });
    on('account-changed', () => {
      if (modal) closeDialog(false);
      const keepVerdict = lastEnd && lastEnd.error;
      lastEnd = null;
      state.selected.clear();
      state.batchRows.clear();
      state.dmsLoaded = false;
      state.guildsLoaded = false;
      state.route = null;
      $('[data-role="dm-list"]').replaceChildren(h('div', { class: 'list-empty', text: 'Loading DMs & friends… 💬' }));
      $('[data-role="server-list"]').replaceChildren(h('div', { class: 'list-empty', text: 'Loading servers… 🏰' }));
      addLog('switched Discord accounts — counts and lists reset', 'warn');
      if (!keepVerdict) setStatus('New account~ counts cleared 🔄', 'warn');
      if (state.tab === 'batch' && !run.active) { loadDMs(); loadServers({ refresh: true }); }
      setTimeout(() => refreshRoute({ keepScan: true }), 0);
    });
    on('skip', ({ msg }) => addLog(`skipped a system message (type ${msg.type}) — Discord won't delete those`, 'skip'));
    on('wait', (w) => {
      setStatus(waitText(w), 'warn');
      addLog(waitText(w), 'warn');
    });
    on('log', ({ text, tone }) => addLog(text, tone));
    on('target-end', ({ target, ok, error, immune, stopped, warn }) => {
      if (immune) addLog(`${target.name} is immune 👑 — skipped`, 'warn');
      else if (ok || warn) addLog(`── Finished: ${target.label || target.name} (${(target.deleted || 0).toLocaleString()} purged) ──`, 'info');
      if (target.row) setRowState(target, immune ? 'immune' : ok ? 'done' : warn ? 'partial' : stopped ? 'stopped' : 'error', error || warn);
    });
    on('pause', (p) => {
      setStatus(`Paused~ ${p.deleted.toLocaleString()} purged so far`, 'warn');
      renderCurrent();
      renderActions();
    });
    on('resume', () => {
      setStatus('Resumed! Purging~ ✨', 'info');
      renderCurrent();
      renderActions();
    });
    on('stopping', () => {
      setStatus('Stopping after this one~ 🛑', 'warn');
      renderActions();
    });
    on('end', (p) => {
      setPrompt('');
      for (const t of state.runTargets) if (t.row && (t.status === 'queued' || t.status === 'running')) setRowState(t, 'stopped');
      addLog('────────────────────', 'info');
      addLog(`SUMMARY: ${p.deleted.toLocaleString()} purged, ${p.failed.toLocaleString()} failed${p.skipped ? `, ${p.skipped} system skipped` : ''}`, 'info');
      if (p.failures.length) {
        addLog('FAILED MESSAGES:', 'error');
        const shown = p.failures.slice(0, 50);
        shown.forEach((f, i) => addLog(`${i + 1}. "${preview(f.msg)}"${f.msg.pinned ? ' [PINNED]' : ''} — ${f.reason}`, 'error'));
        if (p.failures.length > shown.length) addLog(`…and ${(p.failures.length - shown.length).toLocaleString()} more`, 'error');
      }
      scrubLog();
      const minimised = $('[data-role="shell"]').hidden;
      const purged = plural(p.deleted, 'message');
      const problems = p.problems || [];
      if (problems.length) {
        addLog(`NEEDS ANOTHER LOOK: ${problems.map((x) => `${x.target.name} (${shortReason(x.reason)})`).join(', ')}`, 'warn');
      }
      if (p.error) {
        setStatus(`Error: ${p.error} 😿`, 'error');
        lastEnd = { key: state.runKey, text: `Stopped by an error~ ${purged} purged`, tone: 'error', error: true };
      } else if (p.stopped) {
        setStatus(`Stopped! Purged: ${p.deleted.toLocaleString()} | Failed: ${p.failed.toLocaleString()} 🛑`, 'warn');
        lastEnd = { key: state.runKey, text: `Stopped~ ${purged} purged`, tone: 'paused', stopped: true };
      } else if (problems.length) {
        const n = problems.length;
        const indexingOnly = problems.every((x) => /indexing/i.test(x.reason));
        setStatus(`${plural(n, 'chat')} need${n === 1 ? 's' : ''} another go~ see logs`, 'warn');
        lastEnd = { key: state.runKey, text: indexingOnly ? `Purged ${purged} · run again later for older ones` : `Purged ${purged} · ${plural(n, 'chat')} skipped`, tone: 'warn', failed: p.failed, problems: n };
      } else if (p.failed) {
        setStatus(`Done~ ${p.failed.toLocaleString()} wouldn't go · see logs`, 'warn');
        lastEnd = { key: state.runKey, text: `Purged ${purged} · ${p.failed.toLocaleString()} wouldn't go`, tone: 'warn', failed: p.failed, sticker: 'mostly clean~' };
        if (p.deleted > 0) celebrate();
      } else {
        setStatus(`Done in ${formatDuration((p.deleted + p.failed + (p.gone || 0)) / Math.max(p.rate, 0.01))} · 0 failed · ${p.rate.toFixed(1)}/s`, 'success');
        lastEnd = { key: state.runKey, text: p.deleted ? `All clean! Purged ${purged}~ ✨🎉` : 'All clear! Nothing to purge~ ✨', tone: 'cheer', sticker: p.deleted ? 'flawless~' : '' };
        if (p.deleted > 0) celebrate();
      }
      // Minimised through the finish line: the orb carries the outcome until reopened.
      state.orbDone = minimised ? { clean: !p.error && !p.stopped && !problems.length, tone: lastEnd ? lastEnd.tone : 'warn' } : null;
      renderCurrent();
      renderActions();
      if (state.tab === 'batch') loadPendingLists();
    });
    on('end', () => {
      if (!protectionStale) return;
      protectionStale = false;
      protectionChanged({ keepVerdict: true });
    });
  }

  // Lists can't be (re)built mid-run or mid-scan; build them as soon as that ends.
  function loadPendingLists() {
    if (run.active || state.scanning) return;
    if (!state.dmsLoaded) loadDMs();
    if (!state.guildsLoaded) loadServers({ refresh: true });
  }

  // ── Wiring ──────────────────────────────────────────────

  const TOGGLES = new Set(['pause', 'resume', 'stop', 'purify', 'scan', 'minimize', 'restore', 'logs', 'mute']);

  const ACTIONS = {
    scan: () => (state.scanning ? cancelScan() : state.tab === 'current' ? scanCurrent() : scanSelected()),
    purify: () => (state.tab === 'current' ? askPurgeCurrent() : askPurgeSelected()),
    pause: pauseRun,
    resume: resumeRun,
    stop: stopRun,
    logs: () => toggleLog(),
    'close-log': () => toggleLog(false),
    'copy-log': copyLog,
    minimize: () => setOpen(false),
    share: () => shareLink(),
    'welcome-ok': () => hideWelcome(),
    'welcome-batch': () => { hideWelcome(); switchTab('batch'); },
    restore: () => setOpen(true),
    mute: () => { prefs.muted = !prefs.muted; savePrefs('muted'); renderMute(); },
    poke: () => {
      kick({ spin: (Math.random() - 0.5) * 26, squash: 0.7 });
      const img = $('.avatar img');
      if (!reducedMotion()) img.animate([{ transform: 'scale(0.86, 1.12)' }, { transform: 'scale(1.08, 0.94)', offset: 0.45 }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,1.4,.4,1)' });
    },
    cancel: () => closeDialog(false),
    'dm-all': () => selectAllDMs(true),
    'dm-none': () => selectAllDMs(false),
    'dm-refresh': () => loadDMs(),
    'server-refresh': () => loadServers({ refresh: true }),
  };

  function wire() {
    const layer = $('[data-role="layer"]');
    layer.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) { switchTab(tab.dataset.tab); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled || btn.dataset.act === 'confirm') return;
      // A double-click must not flip a toggle twice (Pause→Resume) or open-then-dismiss a dialog.
      if (e.detail > 1 && TOGGLES.has(btn.dataset.act)) return;
      const fn = ACTIONS[btn.dataset.act];
      if (fn) fn();
    });
    // Tab keyboard model: arrows move between tabs.
    $('.tabs').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = state.tab === 'current' ? 'batch' : 'current';
      switchTab(next);
      $(`.tab[data-tab="${next}"]`).focus();
    });
    const confirmBtn = $('[data-act="confirm"]');
    confirmBtn.addEventListener('pointerdown', (e) => { if (e.button === 0) { confirmBtn.setPointerCapture(e.pointerId); beginHold(); } });
    confirmBtn.addEventListener('pointerup', endHold);
    confirmBtn.addEventListener('pointercancel', endHold);
    confirmBtn.addEventListener('keydown', (e) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); beginHold(); }
    });
    confirmBtn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') endHold(); });
    confirmBtn.addEventListener('blur', endHold);
    listen(document, 'visibilitychange', () => { if (document.hidden) endHold(); });
    // Esc keeps you safe even if focus wandered out of the dialog.
    listen(document, 'keydown', (e) => {
      if (modal && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(false); }
    }, true);
    root.addEventListener('keydown', (e) => {
      if (modal && e.key === 'Escape') { e.preventDefault(); closeDialog(false); }
      trapFocus(e);
    });
    $('.modal-layer').addEventListener('pointerdown', (e) => {
      if (!modal) return;
      if (e.target.classList.contains('modal-layer')) {
        if (performance.now() - modal.openedAt > 350) closeDialog(false); // ignore the second half of a double-click
      } else if (!e.target.closest('button')) {
        $('.modal').focus(); // keep focus (and Esc/Tab) inside the dialog
      }
    });
    $('[data-role="filter"]').addEventListener('input', (e) => { state.filter = e.target.value; applyFilter(); });
    listen(window, 'resize', () => {
      const shell = $('[data-role="shell"]');
      placeShell(parseFloat(shell.style.left) || 0, parseFloat(shell.style.top) || 0);
    });
    makeDraggable();
    wireRunEvents();
  }

  // ── Init ────────────────────────────────────────────────

  let host = null;

  function boot() {
    loadPrefs();
    syncProtection();
    host = mount();
    wire();
    renderMute();
    clearLog();
    switchTab(prefs.tab, { initial: true });
    const pos = prefs.x != null && prefs.y != null ? { x: prefs.x, y: prefs.y } : defaultPosition();
    placeShell(pos.x, pos.y);
    setOpen(prefs.open, { initial: true });
    renderProgress(progressSnapshot());
    if (!prefs.welcomed) showWelcome();
    refreshRoute();
    let lastPath = location.pathname;
    every(700, () => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        refreshRoute();
      }
    });
    listen(window, 'popstate', () => refreshRoute());
    listen(window, 'storage', onStorage);
    console.log(`[Dopa Purifier] v${VERSION} ready~ ✨`);
  }

  function whenAppReady(fn) {
    if (document.getElementById('app-mount')) { fn(); return; }
    const obs = new MutationObserver(() => {
      if (document.getElementById('app-mount')) { obs.disconnect(); fn(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    disposers.push(() => obs.disconnect());
  }

  // Undo everything: stop a running purge, drop listeners and timers, remove the UI.
  function destroy() {
    if (run.active) {
      run.stopping = true;
      run.paused = false;
      run.controller.abort();
    }
    if (state.scanAbort) state.scanAbort.abort();
    for (const undo of disposers.splice(0)) {
      try { undo(); } catch { /* already gone */ }
    }
    cancelAnimationFrame(wob.raf);
    cancelAnimationFrame(hold.raf);
    clearTimeout(dialogTimer);
    flushPrefs();
    if (sound.ctx) sound.ctx.close().catch(() => {});
    if (host) host.remove();
    host = null;
  }

  return { start: () => whenAppReady(boot), destroy };
