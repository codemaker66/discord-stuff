  // ── Voice: every line the panel says ────────────────────
  // Words. "Chat" is the umbrella word; "channel" means a server channel only; DM and group DM as
  // Discord says them. "Shield" is the verb and "immune" the state. Count is the safe look first,
  // Pick chooses chats in Many chats, Purify is the button and the action, "purged" the result;
  // "purge" stays only as wit (the ring's 'ready for purge', the moods, the terminal). "Delete"
  // appears plainly only in the confirm lead.
  // Lines stay short, kind and plain, above all when something goes wrong: errors reach the panel
  // through plainError(), and Discord's own wording stays in the log. A name from Discord set in a
  // line of ours sits in bidi isolates (U+2068 … U+2069), so a right-to-left name can't reorder the
  // words and numbers around it. The yandere wit lives in the ring, the sticker, the dagger
  // flourish, the mascot and the terminal. Each line has one job: the mood is personality, the
  // readout the verdict, the footer confirms or names the next step, and nothing is said more
  // than twice.
  // Emoji. ♡ care and success, ✨ ready and done, 🦇 the rate-limit breather, 🩸 the confirm dialog
  // only. At most one per line, always as flair (aria-hidden), never on a warn or error line.
  // Status tones. info (rose dot), calm (what the person chose and Discord's normal pacing: paused,
  // stopping, stopped, waits), success ✓, warn ! (needs the person), error ✕, immune ♛.
  // Colour. Rose means act, crimson means irreversible or failed, gold means Bardo.

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

  // A line's emoji is decoration: it shows, but screen readers hear only the words.
  const flaired = (text, flair) => (flair ? [text, h('span', { class: 'flair', 'aria-hidden': 'true', text: ` ${flair}` })] : [text]);

  // Joins the phrases of a line. The space before the dot can't break, so a wrapped line never
  // starts with '·'.
  const SEP = '\u00a0· ';

  // Numbers group the way the browser's language does (de 123.456, hi 1,23,456), always in the
  // digits 0-9 of the English around them.
  const NUM = new Intl.NumberFormat(undefined, { numberingSystem: 'latn' });
  const fmt = (n) => NUM.format(n);

  const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

  // Rounded up, so it never promises less than it takes, and never says '60s', '60 min' or '1h 60m'.
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '';
    const s = Math.max(1, Math.ceil(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.ceil(s / 60);
    if (m < 60) return `${m} min`;
    const hours = Math.floor(m / 60);
    const mins = m % 60;
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

  // saved: what boot read from storage (null when storage is blocked).
  function loadPrefs(saved) {
    if (!saved) return;
    const d = saved.dock;
    if (d && (d.side === 'left' || d.side === 'right') && Number.isFinite(d.dx) && Number.isFinite(d.y)) prefs.dock = { side: d.side, dx: d.dx, y: d.y };
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

  // Pull in shields set in any tab (or the ones boot just read). Returns whether anything changed.
  function syncProtection(saved = withStorage(readStored)) {
    if (!saved) return false; // storage blocked: keep this tab's own shields
    const ids = stringList(saved.protectedIds);
    const released = stringList(saved.released);
    const same = (set, list) => set.size === list.length && list.every((x) => set.has(x));
    if (same(protection.ids, ids) && same(protection.released, released)) return false;
    protection.ids = new Set(ids);
    protection.released = new Set(released);
    return true;
  }

  // Returns whether the shields really reached storage (it can be full or blocked).
  function storeProtection() {
    return withStorage((ls) => {
      const stored = readStored(ls);
      stored.protectedIds = [...protection.ids];
      stored.released = [...protection.released];
      ls.setItem(PREFS_KEY, JSON.stringify(stored));
      return true;
    }) === true;
  }

  // A run's journal lets a reload or a closed laptop keep its place: whose run it was, and which chats
  // it still had to do, by id. No names, counts or message text, and it lapses after a day. It has its
  // own key, so onStorage never mistakes it for a shield.
  const JOURNAL_KEY = 'dopa-purifier:journal';
  const JOURNAL_TTL_MS = 24 * 60 * 60 * 1000;

  function readJournal(ls) {
    try {
      const j = JSON.parse(ls.getItem(JOURNAL_KEY));
      if (!j || j.v !== 1 || typeof j.user !== 'string' || !['current', 'batch'].includes(j.mode) || !Number.isFinite(j.at)) return null;
      return {
        v: 1, user: j.user, mode: j.mode, at: j.at, state: j.state === 'stopped' ? 'stopped' : 'running',
        chat: j.chat && typeof j.chat.id === 'string' ? { id: j.chat.id } : null,
        keys: stringList(j.keys), guilds: stringList(j.guilds),
      };
    } catch { return null; }
  }

  // null removes it. A write that fails costs nothing: the journal only ever helps.
  function storeJournal(j) {
    withStorage((ls) => (j ? ls.setItem(JOURNAL_KEY, JSON.stringify(j)) : ls.removeItem(JOURNAL_KEY)));
  }

  // ── Sound ───────────────────────────────────────────────

  // One lifecycle: the dialog primes the sound (the audio engine and the decode) while you read it,
  // so the hold's commit only starts a source. Stop and Mute hush it with a short fade, and the
  // engine sleeps whenever nothing is playing. The file itself plays exactly as it is.
  const sound = { ctx: null, buffer: null, loading: null, source: null, gain: null, playing: false, primeTimer: 0 };
  const HUSH_S = 0.03; // the fade on Stop or Mute: short enough to be a stop, long enough not to click

  function sleepSound() {
    if (sound.ctx && sound.ctx.state === 'running') sound.ctx.suspend().catch(() => {});
  }

  function primeSound() {
    if (prefs.muted || sound.loading) return;
    try {
      if (!sound.ctx) sound.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const { ctx } = sound;
      // Decode from the embedded base64 directly: fetch() on a data: URL
      // would trip Discord's connect-src CSP.
      const bin = atob(DELETE_SOUND.slice(DELETE_SOUND.indexOf(',') + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      sound.loading = ctx.decodeAudioData(bytes.buffer).then((b) => {
        sound.buffer = b;
        if (!sound.playing) sleepSound();
        return b;
      }, (err) => {
        sound.loading = null;
        console.debug('[Dopa Purifier] sound unavailable:', err);
        return null;
      });
    } catch (err) {
      sound.loading = null;
      console.debug('[Dopa Purifier] sound unavailable:', err);
    }
  }

  async function playDeleteSound() {
    if (prefs.muted) return;
    sound.playing = true;
    try {
      if (!sound.buffer) primeSound();
      const buffer = sound.buffer || await sound.loading;
      const { ctx } = sound;
      if (!prefs.muted && buffer && ctx && ctx.state !== 'running') await ctx.resume();
      if (prefs.muted || !buffer || !ctx) {
        sound.playing = !!sound.source;
        if (!sound.playing) sleepSound();
        return;
      }
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0.6;
      source.buffer = buffer;
      source.connect(gain).connect(ctx.destination);
      source.onended = () => {
        if (sound.source !== source) return;
        sound.source = null;
        sound.gain = null;
        sound.playing = false;
        sleepSound();
      };
      hushSound(); // a second Purify's sound takes over from the first's
      sound.source = source;
      sound.gain = gain;
      source.start(0);
    } catch (err) {
      sound.playing = !!sound.source;
      console.debug('[Dopa Purifier] sound unavailable:', err);
    }
  }

  // A gain ramp of HUSH_S, then the source stops; its onended lets the engine sleep.
  function hushSound() {
    const { source, gain, ctx } = sound;
    if (!source || !ctx) return;
    try {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + HUSH_S);
      source.stop(t + HUSH_S + 0.005);
    } catch { /* already stopped */ }
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
    targetPlain: null,    // plainError() of the chat lookup that failed
    scanning: false,
    counting: null,       // { channelId, abort }: Purify counting an uncounted chat before it asks
    runAs: null,          // the account the last run was confirmed as
    scanError: null,      // { channelId, line, short, code, blocking }: the last failed count of that chat
    runTargets: [],
    batchRows: new Map(), // key → row
    selected: new Set(),  // row keys
    runCounted: new Set(), // chat ids whose count a finished run wrote (the purge itself, not a Count)
    leftSince: new Set(),  // chats left since the route was last read (the panel rests while minimised)
    guildsLoaded: false,
    dmsLoaded: false,
    guildsLoading: false,
    dmsLoading: false,
    filter: '',
  };

  let root = null;  // shadow root
  // Elements the panel builds once are looked up once: a tick on a big account renders the hero and
  // the footer, and each lookup was a walk of thousands of rows. A cached element is checked to still
  // be in the page, or found afresh. Selectors that name the first of many ('.guild') never cache.
  const STABLE = /^(?:\[data-(?:role|act)="[\w-]+"\]|\.(?:panel|hero|gauge|dial|g-track|g-ok|g-head|g-fail|orb|orb-fill|modal-layer|modal|tabs|foot|term|hold-fill|live-dot))$/;
  const found = new Map();
  const $ = (sel) => {
    if (!STABLE.test(sel)) return root.querySelector(sel);
    const kept = found.get(sel);
    if (kept && kept.isConnected && kept.getRootNode() === root) return kept;
    const el = root.querySelector(sel);
    if (el) found.set(sel, el); else found.delete(sel);
    return el;
  };
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
    share: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
    forum: 'M4 5h16v10H9l-5 4z',
    group: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
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
  const ORB_C = 2 * Math.PI * 22; // the orb's ring, r 22 in a 48 box

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
        svg('circle', { ...ARC, class: 'g-fail' })),
      // The sweep for work with no end in sight yet: a 40° dash that turns 230° on the compositor, so
      // it starts at the arc's left end and stops at its right end, never crossing the "3 of 31+" under
      // the ring. It sits under the track and the failure notches (styles: .sweep).
      svg('svg', { class: 'sweep', viewBox: '0 0 200 200', 'aria-hidden': 'true' },
        svg('circle', { ...ARC, pathLength: '360', stroke: ROSE_STROKE, 'stroke-linecap': 'round', 'stroke-dasharray': '40 320' })),
      h('div', { class: 'blood' }),
      h('div', { class: 'sticker', 'data-role': 'sticker', hidden: true }),
      h('div', { class: 'gauge-pct', 'data-role': 'pct' }));
  }

  function buildHero() {
    return h('div', { class: 'hero' },
      h('div', { class: 'burst', 'data-role': 'burst', 'aria-hidden': 'true' }),
      buildGauge(),
      h('div', { class: 'hero-core' },
        h('div', { class: 'hero-face', 'data-role': 'hero-face', 'aria-hidden': 'true' }),
        h('div', { class: 'count', 'data-role': 'count', text: '0' }),
        h('div', { class: 'count-label', 'data-role': 'count-label', text: 'messages purged' }),
        h('div', { class: 'hero-sub', 'data-role': 'hero-sub' })),
      h('div', { class: 'readout', 'data-role': 'readout' },
        h('div', { class: 'readout-line', 'data-role': 'readout-line', text: '' }),
        h('div', { class: 'stats', 'data-role': 'stats', hidden: true },
          h('div', { class: 'stat stat-eta', 'data-role': 'stat-eta' }, h('b', { text: '—' })),
          h('div', { class: 'stat stat-fail', 'data-role': 'stat-fail' }, h('i', { class: 'stat-dot' }), h('b', { text: '0' }), h('span', { text: ' failed' })))));
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

  // The sweep moves only while work is really happening: a run with no known end (spinning), a
  // count (scanning) or the run's last look once every counted message is handled (verifying).
  function drawRing({ total, done: doneRaw, fails, spinning = false, scanning = false, verifying: checking = false }) {
    // A strip's 44 px ring is too small for notches (their gaps fall under a pixel): it draws an arc.
    const layer = $('[data-role="layer"]');
    const small = layer.dataset.tab === 'batch' || layer.dataset.fit === 'strip';
    const key = `${total}|${doneRaw}|${fails.length}|${spinning}|${scanning}|${checking}|${small}`;
    if (key === ring.drawn) return;
    ring.drawn = key;
    const dial = $('.dial');
    dial.classList.toggle('is-spinning', spinning);
    dial.classList.toggle('is-scanning', scanning);
    dial.classList.toggle('is-verifying', checking);
    const beads = !small && total > 0 && total <= G.maxBeads;
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
    return h('div', { class: 'view', 'data-view': 'current', role: 'tabpanel', 'aria-label': 'This chat' },
      h('div', { class: 'target', 'data-role': 'target' },
        h('div', { class: 'target-ico', 'data-role': 'target-ico', 'aria-hidden': 'true', text: '#' }),
        h('div', { class: 'target-text' },
          h('div', { class: 'eyebrow', 'data-role': 'eyebrow' }, h('i', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { 'data-role': 'eyebrow-text', text: 'This chat' })),
          h('div', { class: 'target-line' },
            h('span', { class: 'target-name', 'data-role': 'target-name', text: 'finding this chat…' }),
            h('span', { class: 'target-context', 'data-role': 'target-context' })),
          h('div', { class: 'target-viewing', 'data-role': 'target-viewing', hidden: true })),
        h('span', { class: 'target-tools', 'data-role': 'target-tools' })));
  }

  function buildBatchView() {
    const dmHead = h('div', { class: 'section-head' },
      h('div', { class: 'section-title', id: 'dp-dm-title', text: 'Direct messages' }),
      h('div', { class: 'section-tools' },
        h('button', { class: 'chip', 'data-act': 'dm-all', text: 'All' }),
        h('button', { class: 'chip', 'data-act': 'dm-none', text: 'None' }),
        h('button', { class: 'chip icon-only', 'data-act': 'dm-refresh', 'aria-label': 'Refresh DMs', title: 'Refresh' }, icon('refresh'))));
    const serverHead = h('div', { class: 'section-head' },
      h('div', { class: 'section-title', id: 'dp-server-title', text: 'Servers' }),
      h('div', { class: 'section-tools' },
        h('button', { class: 'chip icon-only', 'data-act': 'server-refresh', 'aria-label': 'Refresh servers', title: 'Refresh' }, icon('refresh'))));
    // Each list is one Tab stop; the arrows walk it (see List keyboard).
    return h('div', { class: 'view', 'data-view': 'batch', role: 'tabpanel', 'aria-label': 'Many chats' },
      h('input', { class: 'filter', type: 'search', 'data-role': 'filter', placeholder: 'Find a chat or server…', 'aria-label': 'Find a chat or server', spellcheck: 'false', autocomplete: 'off' }),
      dmHead,
      h('div', { class: 'list', 'data-role': 'dm-list', role: 'group', 'aria-labelledby': 'dp-dm-title', onkeydown: onListKey, onfocusin: onListFocus },
        h('div', { class: 'list-empty', text: 'Finding your DMs…' })),
      serverHead,
      h('div', { class: 'list', 'data-role': 'server-list', role: 'group', 'aria-labelledby': 'dp-server-title', onkeydown: onListKey, onfocusin: onListFocus },
        h('div', { class: 'list-empty', text: 'Finding your servers…' })));
  }

  function buildPanel() {
    return h('section', { class: 'panel', 'aria-label': "Dopa's Purifier" },
      h('header', { class: 'head', 'data-role': 'drag' },
        h('button', { class: 'avatar', 'data-act': 'poke', 'aria-label': 'Poke Dopa', title: 'boop~' },
          h('img', { src: EMOTE_IMG, alt: '', draggable: 'false' })),
        h('div', { class: 'titles' },
          h('div', { class: 'title', title: `Dopa's Purifier v${VERSION}` }, h('span', { text: "Dopa's Purifier" })),
          h('div', { class: 'mood', 'data-role': 'mood', text: 'awaiting orders, princess~' })),
        h('div', { class: 'head-tools' },
          h('button', { class: 'icon-btn', 'data-act': 'share', 'aria-label': 'Copy the install link', title: 'Copy the install link for a friend ♡' }, icon('share')),
          h('button', { class: 'icon-btn', 'data-act': 'mute', 'aria-label': 'Mute sound', title: 'Sound' }, icon('sound')),
          h('button', { class: 'icon-btn', 'data-act': 'minimize', title: 'Minimise' }, icon('minimize')))),
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'What to purify' },
        h('span', { class: 'tab-pill', 'aria-hidden': 'true' }),
        h('button', { class: 'tab', role: 'tab', 'data-tab': 'current', text: 'This chat' }),
        h('button', { class: 'tab', role: 'tab', 'data-tab': 'batch' }, h('span', { text: 'Many chats' }), h('span', { class: 'tab-badge', 'data-role': 'tab-badge', hidden: true }),
          h('span', { class: 'sr', 'data-role': 'tab-badge-sr', hidden: true, text: ' selected' }))),
      h('div', { class: 'welcome', 'data-role': 'welcome', hidden: true, role: 'dialog', 'aria-labelledby': 'dp-welcome-title' },
        h('div', { class: 'welcome-card' },
          h('div', { class: 'welcome-emote' }, h('img', { src: EMOTE_IMG, alt: '' })),
          h('div', { class: 'welcome-title', id: 'dp-welcome-title' }, flaired('Hi princess~', '♡')),
          h('div', { class: 'welcome-lead', text: 'Clear your side of any chat in two steps:' }),
          h('ol', { class: 'welcome-steps' },
            h('li', {}, h('span', {}, h('b', { text: 'Open a chat' }), ' — any DM, group or server channel')),
            h('li', {}, h('span', {}, h('b', { text: 'Purify' }), ', then hold the red button till it fills'))),
          h('div', { class: 'welcome-note' },
            icon('shield'),
            h('span', { text: 'Only your own messages, and nothing leaves Discord. Tap the shield by a name and that DM is immune~' })),
          h('div', { class: 'welcome-actions' },
            h('button', { class: 'btn btn-purge', 'data-act': 'welcome-ok' }, h('span', {}, flaired('Got it', '♡'))),
            h('button', { class: 'btn btn-quiet', 'data-act': 'welcome-batch', text: 'Pick many chats' })))),
      h('div', { class: 'body', 'data-role': 'body' },
        buildHero(),
        buildCurrentView(),
        buildBatchView()),
      h('footer', { class: 'foot' },
        h('div', { class: 'actions', 'data-role': 'idle-actions' },
          h('button', { class: 'btn btn-quiet', 'data-act': 'scan' }, icon('scan'), h('span', { 'data-role': 'scan-label', text: 'Count' })),
          h('button', { class: 'btn btn-purge', 'data-act': 'purify' }, h('span', { 'data-role': 'purify-label', text: 'Purify' }), h('span', { class: 'btn-count', 'data-role': 'purify-count', hidden: true }),
            h('span', { class: 'sr', 'data-role': 'purify-unit' })),
          h('button', { class: 'btn btn-quiet', 'data-act': 'go-batch', hidden: true }, icon('sparkle'), h('span', { text: 'Pick many chats' }))),
        h('div', { class: 'actions', 'data-role': 'run-actions', hidden: true },
          h('button', { class: 'btn btn-quiet', 'data-act': 'pause' }, icon('pause'), h('span', { text: 'Pause' })),
          h('button', { class: 'btn btn-purge', 'data-act': 'resume', hidden: true }, icon('play'), h('span', { text: 'Resume' })),
          h('button', { class: 'btn btn-stop', 'data-act': 'stop' }, icon('stop'), h('span', { text: 'Stop' }))),
        h('div', { class: 'status-row' },
          h('div', { class: 'status', 'data-role': 'status', role: 'status', 'aria-live': 'polite', dataset: { tone: 'info' } },
            h('span', { class: 'status-dot', 'aria-hidden': 'true' }),
            h('span', { 'data-role': 'status-text' }, flaired('Ready to purify~', '✨'))),
          h('button', { class: 'logs-btn', 'data-act': 'logs', 'aria-pressed': 'false' }, icon('heart'), h('span', { 'data-role': 'logs-label', text: 'Logs' })))));
  }

  function buildTerminal() {
    return h('section', { class: 'term', 'aria-label': 'Purifier log', hidden: true },
      h('header', { class: 'term-head', 'data-role': 'term-drag' },
        h('span', { class: 'term-title' }, 'DOPA-OS ♡ ', h('span', { class: 'term-title-mid', text: 'PURIFIER ' }), 'MAINFRAME'),
        h('button', { class: 'icon-btn', 'data-act': 'copy-log', title: 'Copy log' }, icon('copy')),
        h('button', { class: 'icon-btn', 'data-act': 'close-log', title: 'Close log' }, icon('close'))),
      h('div', { class: 'term-screen' }, h('div', { class: 'term-body', 'data-role': 'term-body', role: 'log', 'aria-live': 'off' })),
      h('footer', { class: 'term-foot', 'aria-hidden': 'true' },
        h('span', {}, 'PURGED ', h('b', { 'data-role': 'tf-purged', text: '000' })),
        h('span', { class: 'tf-fail' }, 'FAILED ', h('b', { 'data-role': 'tf-failed', text: '000' })),
        h('span', { 'data-role': 'tf-rate', text: '' }),
        h('span', { class: 'tf-eta' }, 'ETA ', h('b', { 'data-role': 'tf-eta', text: '--:--' }))));
  }

  // The dialog is described by its one sentence (what, where, as whom, and that it's final), never by
  // a long list; the parts a dialog doesn't have are skipped.
  function buildModal() {
    return h('div', { class: 'modal-layer', hidden: true },
      h('div', { class: 'modal', role: 'alertdialog', tabindex: '-1', 'aria-modal': 'true', 'aria-labelledby': 'dp-modal-title', 'aria-describedby': 'dp-modal-lead dp-modal-pill dp-modal-who dp-modal-warn' },
        h('div', { class: 'modal-emote' }, h('img', { src: EMOTE_IMG, alt: '' })),
        h('div', { class: 'modal-title', id: 'dp-modal-title', 'data-role': 'modal-title' }),
        h('div', { class: 'modal-text', 'data-role': 'modal-text' }),
        h('div', { class: 'modal-buttons' },
          h('button', { class: 'btn btn-quiet', 'data-act': 'cancel', text: 'Never mind~' }),
          h('button', { class: 'btn btn-purge btn-hold', 'data-act': 'confirm', 'aria-describedby': 'dp-modal-hint' },
            h('span', { class: 'hold-fill', 'aria-hidden': 'true' }),
            h('span', { class: 'hold-label', 'data-role': 'confirm-label' }))),
        h('div', { class: 'modal-hint', id: 'dp-modal-hint' },
          h('div', {}, h('span', {}, 'Hold with mouse or ', h('kbd', { text: 'Space' })), ' · ', h('span', {}, h('kbd', { text: 'Esc' }), ' keeps you safe')),
          h('div', {}, 'Screen reader, voice or switch? Just press twice')),
        h('div', { class: 'sr', 'data-role': 'modal-live', 'aria-live': 'assertive', 'aria-atomic': 'true' })));
  }

  function mount() {
    // The panel speaks English, so screen readers use an English voice inside any Discord.
    const host = h('div', { id: 'dopa-purifier-host', lang: 'en' });
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;z-index:2147483600;';
    root = host.attachShadow({ mode: 'open' });
    root.append(
      h('style', { text: CSS }),
      h('div', { class: 'layer', 'data-role': 'layer' },
        h('div', { class: 'shell', 'data-role': 'shell' }, h('div', { class: 'wobble', 'data-role': 'wobble' }, buildPanel())),
        buildTerminal(),
        // The orb draws the hero's 270° arc, open at the bottom.
        h('button', { class: 'orb', 'data-act': 'restore', 'aria-label': "Open Dopa's Purifier", hidden: true },
          svg('svg', { class: 'orb-ring', viewBox: '0 0 48 48', 'aria-hidden': 'true' },
            svg('circle', { class: 'orb-track', cx: '24', cy: '24', r: '22', transform: 'rotate(135 24 24)', 'stroke-dasharray': `${(ORB_C * G.sweep).toFixed(2)} ${ORB_C.toFixed(2)}` }),
            svg('circle', { class: 'orb-fill', cx: '24', cy: '24', r: '22', transform: 'rotate(135 24 24)', 'stroke-dasharray': `0 ${ORB_C.toFixed(2)}` })),
          h('img', { src: EMOTE_IMG, alt: '', draggable: 'false' }),
          h('span', { class: 'orb-badge', 'data-role': 'orb-badge', hidden: true })),
        // Outside the shell, so milestones and the ending are heard while minimised too.
        h('div', { class: 'sr', 'data-role': 'milestone', 'aria-live': 'polite', 'aria-atomic': 'true' }),
        buildModal(),
        h('div', { class: 'fx', 'aria-hidden': 'true' })));
    // Keep Discord's global hotkeys (type-to-focus-composer, Esc, etc.) out of our UI.
    for (const type of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    document.body.appendChild(host);
    watchHost();
    // A two-line status, a two-line name or lists loading change the panel's height: the open log follows.
    const fit = new ResizeObserver(() => placeTerminal());
    fit.observe($('.panel'));
    fit.observe($('.foot'));
    disposers.push(() => fit.disconnect());
    return host;
  }

  // Light Discord gets a lighter shadow under the panel. Discord marks its theme on <html>; where it
  // doesn't, a light page behind us decides.
  function watchHost() {
    const read = () => {
      const html = document.documentElement.classList;
      let light = html.contains('theme-light');
      if (!light && !html.contains('theme-dark')) {
        const [r, g, b, a = 1] = (getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) || []).map(Number);
        light = a > 0.5 && (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
      }
      $('[data-role="layer"]').dataset.host = light ? 'light' : 'dark';
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    disposers.push(() => obs.disconnect());
  }

  // ── Status, meter, gauge ────────────────────────────────

  // Per-kill updates are quiet (aria-live off) so screen readers aren't read every deletion. The
  // flair is the line's one emoji from the palette above. sr is said before the line and never
  // shown, so a number the line no longer repeats is still heard. A new line ends any wait's countdown.
  let waitTick = 0;
  function setStatus(text, tone = 'info', { quiet = false, flair = '', sr = '' } = {}) {
    clearInterval(waitTick);
    waitTick = 0;
    paintStatus(text, tone, { quiet, flair, sr });
  }

  function paintStatus(text, tone, { quiet, flair, sr = '' }) {
    const el = $('[data-role="status"]');
    el.setAttribute('aria-live', quiet ? 'off' : 'polite');
    const said = el.querySelector(':scope > .sr');
    if (said) said.remove();
    if (sr) el.prepend(h('span', { class: 'sr', text: sr }));
    $('[data-role="status-text"]').replaceChildren(...flaired(text, flair));
    el.title = text; // past two lines the line is clamped; hover shows all of it
    el.dataset.tone = tone;
  }

  // A trailing heart is flair: it shows, but isn't read aloud.
  function setMood(text) {
    $('[data-role="mood"]').replaceChildren(...(text.endsWith(' ♡') ? flaired(text.slice(0, -2), '♡') : [text]));
  }

  let shownCount = null;
  let shownEta = null;  // the run's ETA as shown (see renderHero)
  let beaten = null;    // the verdict whose finish has played its beats
  let lastSnapshot = null;
  // { key, text, flair?, tone, sticker?, error?, stopped?, problems?, shielded?, failed? }: the last
  // finished run, shown until the context changes.
  let lastEnd = null;

  function renderProgress(p) {
    lastSnapshot = p;
    renderHero();
  }

  const contextKey = () => (state.tab === 'current' ? `c:${state.target ? state.target.channelId : ''}` : 'batch');

  // A shield the person set, rather than one of the names that are immune from the start.
  const shieldedByYou = (t) => !!t.partner && protection.ids.has(t.partner.id);

  // What the ring says before a run, for each hero state: an icon or the number of your messages
  // found (a count, never a promise of how many will go), the label under it, the readout line and
  // the strip's sub-line (This chat's strip repeats the readout). total sizes the notches.
  function previewFor(name) {
    if (state.tab === 'current') {
      const t = state.target;
      const n = t ? counts.get(t.channelId) : undefined;
      switch (name) {
        case 'none': return { icon: 'sparkle', label: 'open a chat', line: ['Any DM, group or server channel works~'], tone: 'quiet' };
        case 'lookup': return { label: 'finding this chat…', line: [], tone: 'quiet' };
        case 'lookup-error': return { label: "can't read this chat", labelTone: 'error', line: [state.targetPlain.line], tone: 'error' };
        case 'immune': return {
          icon: 'shield', label: 'immune', labelTone: 'immune', tone: 'immune',
          line: shieldedByYou(t) ? [...flaired('Immune', '♡'), ' tap the shield to undo'] : [...flaired('Immune from the start', '♡'), ' nothing here gets purged'],
        };
        case 'counting': return { icon: 'scan', label: 'counting…', line: [], tone: 'quiet' };
        case 'blocked': return { label: 'no access', labelTone: 'error', line: [state.scanError.line], tone: 'error' };
        case 'scan-error': return { icon: 'scan', label: 'not counted yet', line: [state.scanError.line], tone: 'error' };
        case 'unscanned': return { icon: 'scan', label: 'not counted yet', line: flaired('Purify asks before anything goes', '♡'), tone: 'quiet' };
        case 'indexing': return { icon: 'scan', label: 'still indexing', line: ['Discord is still sorting this chat~ purify anyway, or count again soon'], tone: 'quiet' };
        case 'partial': return { count: n, total: n, label: 'found so far', line: ['Discord is still indexing older ones~'], tone: 'ready' };
        case 'clear': return { count: 0, label: 'messages found', line: flaired('All clear~ nothing of yours here', '✨'), tone: 'clear' };
        // The ring keeps its battle cry; every line says Purify, the action.
        default: return { count: n, total: n, label: 'ready for purge', labelTone: 'ready', line: [`about ${formatDuration(estimateSeconds(n))} to purify~`], tone: 'ready' };
      }
    }
    if (name === 'none') return { icon: 'sparkle', label: 'nothing picked yet', line: [], sub: ['pick any DMs or channels below~'], tone: 'quiet' };
    const rows = selectedRows();
    const scanned = rows.filter((r) => r.channelId && counts.has(r.channelId));
    const total = scanned.reduce((sum, r) => sum + counts.get(r.channelId), 0);
    // A closed DM (a friend with no DM open) can't be counted without opening one; the run counts it.
    const closed = rows.filter((r) => r.needsDM && r.status !== 'error').length;
    const toCount = rows.length - scanned.length - closed - rows.filter((r) => r.status === 'error').length;
    // The strip counts the chats Purify would really go through, as the dialog and the run do; the
    // ones it leaves out (all clear, no access) are named after them.
    const blocked = rows.filter(accessError).length;
    const clear = rows.filter(emptyChat).length;
    const chats = plural(purifyTargets(rows).length, 'chat');
    // The numeral already says how many were found, so the line says what is still unknown.
    const parts = [chats, toCount && `${fmt(toCount)} to count`, closed && plural(closed, 'closed DM'), clear && `${fmt(clear)} all clear`, blocked && `${fmt(blocked)} skipped`].filter(Boolean).join(SEP);
    const shared = { line: [], tone: total ? 'ready' : 'quiet' };
    if (name === 'unscanned') return { ...shared, icon: 'scan', label: 'not counted yet', sub: [parts] };
    if (name === 'partial') return { ...shared, count: total, total, label: 'found so far', sub: [parts] };
    if (name === 'clear') return { ...shared, count: 0, label: 'messages found', sub: closed || blocked ? [parts] : flaired(`${plural(rows.length, 'chat')}${SEP}all clear`, '✨') };
    const about = `about ${formatDuration(estimateSeconds(total))}`;
    return {
      ...shared, count: total, total, label: 'ready for purge', labelTone: 'ready',
      // A closed DM is counted as it goes, so the estimate is a floor.
      sub: [closed ? `${parts}${SEP}${about}+` : `${parts}${SEP}${about} to purify~`],
    };
  }

  // The moment the ring describes, for styles and tests (hero[data-state]). This chat before a run:
  // none (no chat open), lookup, lookup-error, immune, counting, blocked (no access), scan-error,
  // unscanned, indexing (still indexing, none found yet), partial, clear or ready. Many chats: none
  // (nothing picked), unscanned, partial, clear or ready. Then run, and done.
  function heroState(mode) {
    if (mode !== 'preview') return mode;
    if (state.tab === 'current') {
      const t = state.target;
      if (!t) return state.targetError === 'none' ? 'none' : 'lookup';
      if (describeFailed()) return 'lookup-error';
      if (t.protected) return 'immune';
      if ((state.counting && state.counting.channelId === t.channelId) || (state.scanning && state.scanKind === 'current')) return 'counting';
      if (state.scanError && state.scanError.channelId === t.channelId) return state.scanError.blocking ? 'blocked' : 'scan-error';
      const n = counts.get(t.channelId);
      if (n === undefined) return 'unscanned';
      if (isPartialCount(t.channelId)) return n ? 'partial' : 'indexing';
      return n ? 'ready' : 'clear';
    }
    const rows = selectedRows();
    if (!rows.length) return 'none';
    const counted = rows.filter((r) => r.channelId && counts.has(r.channelId));
    if (!counted.length) return 'unscanned';
    // A friend with no DM yet, or a chat that failed, can't be counted before the purge.
    const countable = rows.filter((r) => !r.needsDM && r.status !== 'error').length;
    if (counted.length < countable || counted.some((r) => isPartialCount(r.channelId))) return 'partial';
    return counted.some((r) => counts.get(r.channelId)) ? 'ready' : 'clear';
  }

  // What sits in the middle of the ring (hero[data-face]): the count, an icon, or only the label.
  function heroFace(name) {
    if (name === 'run' || name === 'done') return 'count';
    if (state.tab === 'batch') return name === 'none' || name === 'unscanned' ? 'icon' : 'count';
    return ['ready', 'partial', 'clear'].includes(name) ? 'count' : ['lookup', 'lookup-error', 'blocked'].includes(name) ? 'label' : 'icon';
  }

  // How a run that ended on an error sounds, by cause (lastEnd.error is plainError's code when the
  // end handler knows it, else true).
  const ERROR_MOODS = { captcha: 'Discord wants a captcha~', network: 'lost Discord for a sec~', switched: 'stopped to be safe~' };

  function renderHero() {
    const p = lastSnapshot || progressSnapshot();
    const mode = run.active ? 'run' : (lastEnd && lastEnd.key === contextKey() ? 'done' : 'preview');
    const processedNow = p.deleted + p.failed + (p.gone || 0);
    const layer = $('[data-role="layer"]');
    layer.dataset.hero = mode;
    const hero = $('.hero');
    const name = heroState(mode);
    const prevState = hero.dataset.state;
    hero.dataset.state = name;
    hero.dataset.face = heroFace(name);
    const idle = mode === 'preview' ? previewFor(name) : null;
    // The finish plays its beats once, when they can be seen: a finish that lands while the tab is
    // hidden, the panel minimised or mid-unfold is owed, and plays when you look.
    const finishing = mode === 'done' && lastEnd !== beaten && fxVisible() && !fold;
    if (finishing) beaten = lastEnd;
    // While some chats are still uncounted the total is a floor, not a promise.
    const known = p.total > 0 && !p.partial;
    const ringTotal = mode === 'done' && p.partial ? processedNow : p.total;
    const checking = mode === 'run' && verifying();

    const face = $('[data-role="hero-face"]');
    const faceIcon = (idle && idle.icon) || '';
    if (face.dataset.icon !== faceIcon) {
      face.dataset.icon = faceIcon;
      face.replaceChildren(...(faceIcon ? [icon(faceIcon)] : []));
    }

    // Before a run the number is how many of yours were found; in and after one, how many went.
    const shown = idle ? idle.count || 0 : p.deleted;
    const countEl = $('[data-role="count"]');
    if (shown !== shownCount) {
      shownCount = shown;
      countEl.textContent = fmt(shown);
    }
    countEl.classList.toggle('is-found', !!idle && shown > 0);
    countEl.classList.toggle('is-zero', shown === 0);
    // Sized from the larger of the count and the run's total, so it is set once and never jumps mid-run.
    countEl.dataset.len = String(fmt(Math.max(shown, idle ? 0 : p.total)).length);

    const label = $('[data-role="count-label"]');
    const labelText = idle ? idle.label : 'messages purged';
    const labelTone = (idle && idle.labelTone) || '';
    if (label.textContent !== labelText || (label.dataset.tone || '') !== labelTone) {
      // The dagger flourish shows only in strips.
      label.replaceChildren(...(labelTone === 'ready' ? [icon('dagger', 'ico-dagger ico-dagger-l'), labelText, icon('dagger', 'ico-dagger ico-dagger-r')] : [labelText]));
      label.dataset.tone = labelTone;
    }

    if (idle) drawRing({ total: idle.total || 0, done: 0, fails: [], scanning: name === 'counting' });
    else drawRing({ total: mode === 'run' && !known ? 0 : ringTotal, done: ring.done, fails: ring.fails, spinning: mode === 'run' && !known, verifying: checking });

    // "18 of 40" counts processed messages (purged + failed), matching the ring. A finished run with
    // failures says how many really went, and only a clean finish turns rose.
    const pct = $('[data-role="pct"]');
    const went = mode === 'done' && p.failed && !lastEnd.stopped && !lastEnd.error ? p.deleted : processedNow;
    pct.textContent = idle ? ''
      : known ? `${fmt(Math.min(went, p.total))} of ${fmt(p.total)}`
        : p.total ? `${fmt(went)} of ${fmt(p.total)}+` : '';
    pct.classList.toggle('is-full', mode === 'done' && !p.failed && processedNow >= ringTotal && ringTotal > 0);

    // The ETA counts down freely and goes up only for a real slow-down (over 15 %), never a jitter.
    if (mode !== 'run' || p.etaSeconds == null) shownEta = null;
    else if (shownEta == null || p.etaSeconds < shownEta || p.etaSeconds > shownEta * 1.15) shownEta = p.etaSeconds;
    const left = checking ? 'double-checking…' : shownEta != null ? `~${formatDuration(shownEta)} left` : '';

    const readout = $('[data-role="readout"]');
    const line = $('[data-role="readout-line"]');
    const stats = $('[data-role="stats"]');
    stats.hidden = mode !== 'run';
    line.hidden = mode === 'run';
    if (mode === 'run') {
      $('[data-role="stat-eta"] b').textContent = left || 'counting as we go~';
      const fail = $('[data-role="stat-fail"]');
      fail.querySelector('b').textContent = fmt(p.failed);
      fail.classList.toggle('has-fails', p.failed > 0);
      readout.dataset.tone = run.paused ? 'paused' : 'live';
    } else if (mode === 'done') {
      line.replaceChildren(...flaired(lastEnd.text, lastEnd.flair));
      readout.dataset.tone = lastEnd.tone;
    } else {
      line.replaceChildren(...idle.line);
      readout.dataset.tone = idle.tone;
    }
    // The verdict settles in just after the count's last pop: the readout's line, or a strip's sub-line,
    // whichever is drawn. Confetti is This chat's, and only lands on the chat it belongs to.
    if (finishing) {
      const verdict = [line, $('[data-role="hero-sub"]')].find((el) => el.getClientRects().length) || line;
      verdict.animate(reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
        { duration: reducedMotion() ? 200 : 220, delay: 60, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
      if (lastEnd.confetti && state.tab === 'current') celebrate();
    }
    // A count lands gently: the number and the arc fade up as it arrives (opacity only, so reduced
    // motion keeps it).
    if (prevState === 'counting' && ['ready', 'partial', 'clear'].includes(name)) {
      $('.hero-core').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
      $('.g-track').animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.22,1,.36,1)' });
    }

    // A strip has one line under the count: the run's facts, the verdict, or what the ring would say.
    const sub = $('[data-role="hero-sub"]');
    if (mode === 'run') {
      sub.replaceChildren(...(p.total ? [
        `${fmt(processedNow)} of ${fmt(p.total)}${known ? '' : '+'}`,
        left && `${SEP}${left}`,
        p.failed > 0 && h('span', { class: 'sub-fail', text: `${SEP}${fmt(p.failed)} failed` }),
      ].filter(Boolean) : ['counting as we go~']));
    } else if (mode === 'done') sub.replaceChildren(...flaired(lastEnd.text, lastEnd.flair));
    else sub.replaceChildren(...(idle.sub || idle.line.map((x) => (x instanceof Node ? x.cloneNode(true) : x))));
    sub.title = sub.textContent; // the strip truncates; hover shows all of it

    // This chat's strip names the chat Purify acts on first, so a short window needs no scroll to see it.
    if (mode === 'preview' && state.tab === 'current' && state.target && !['lookup', 'lookup-error'].includes(name)) {
      const t = state.target;
      const chat = [iso(t.guildId ? t.name.replace(/^#/, '') : t.name), t.guildId && t.context ? `${SEP}${t.context}` : ''].join('');
      sub.prepend(sub.textContent ? `${chat}${SEP}` : chat);
      sub.title = sub.textContent;
    }

    // Minimised through the finish line: the orb keeps the arc and count until reopened. Its ring is
    // the hero's 270° arc, so it never fills the open bottom.
    const orb = $('.orb');
    const orbFrac = run.active ? (known ? Math.min(1, processedNow / p.total) : 0)
      : state.orbDone ? (state.orbDone.clean ? 1 : (p.total ? Math.min(1, processedNow / p.total) : 0)) : 0;
    $('.orb-fill').setAttribute('stroke-dasharray', `${(ORB_C * G.sweep * orbFrac).toFixed(2)} ${ORB_C.toFixed(2)}`);
    $('.orb-fill').setAttribute('visibility', orbFrac > 0 ? 'visible' : 'hidden');
    const badge = $('[data-role="orb-badge"]');
    badge.textContent = fmt(p.deleted);
    badge.hidden = !(run.active || state.orbDone) || !p.deleted;
    orb.dataset.live = run.active ? 'true' : state.orbDone ? (state.orbDone.clean ? 'done' : 'trouble') : 'false';
    // Hovering the orb says how it's going, so a minimised purge needs no reopening to check on; its
    // name says what it opens, then the same.
    const progress = p.total ? `${fmt(processedNow)} of ${fmt(p.total)}${known ? '' : '+'}` : `${fmt(p.deleted)} so far`;
    const ending = !run.active && state.orbDone ? endingWords(p) : null;
    orb.title = run.active ? (run.paused ? `Paused~ ${progress}` : `Purifying~ ${progress}${shownEta != null ? `${SEP}about ${formatDuration(shownEta)} left` : ''}`)
      : ending ? ending.title : "Open Dopa's Purifier";
    orb.setAttribute('aria-label', run.active ? `Open Dopa's Purifier — ${run.paused ? 'paused' : 'purifying'}, ${progress}`
      : ending ? `Open Dopa's Purifier — ${ending.said}` : "Open Dopa's Purifier");

    let mood = 'awaiting orders, princess~';
    if (mode === 'run') mood = run.stopping ? 'wrapping up~' : run.paused ? 'paused~ take your time' : "purging… don't look~";
    else if (mode === 'done') {
      mood = lastEnd.error ? ERROR_MOODS[lastEnd.error] || 'oh no… something broke' : lastEnd.stopped ? 'stopped~ no rush ♡' : lastEnd.problems ? 'some chats fought back~'
        : lastEnd.shielded ? 'a shield went up~ ♡' : lastEnd.failed ? 'mostly clean, princess ♡' : 'all clean, princess ♡';
    } else if (state.tab === 'batch') mood = "who's first, princess~?";
    else if (state.target && state.target.protected) mood = "this one's immune~";
    setMood(mood);

    // The sticker is stamped beside the ring on the next beat; with reduced motion it fades in.
    const sticker = $('[data-role="sticker"]');
    const stickerText = mode === 'done' && state.tab === 'current' && lastEnd.sticker ? lastEnd.sticker : '';
    if (stickerText !== sticker.textContent || sticker.hidden === !!stickerText) {
      sticker.textContent = stickerText;
      sticker.hidden = !stickerText;
    }
    // Stamped with the finish's beats, even when they were owed (the text was written unseen).
    if (stickerText && finishing && reducedMotion()) sticker.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 200, fill: 'backwards' });
    else if (stickerText && finishing) {
      sticker.animate([
        { transform: 'rotate(4deg) scale(1.6)', opacity: 0 },
        { transform: 'rotate(10deg) scale(.94)', opacity: 1, offset: 0.6 },
        { transform: 'rotate(9deg) scale(1)' },
      ], { duration: 340, delay: 380, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
    }

    $('[data-role="tf-purged"]').textContent = String(p.deleted).padStart(3, '0');
    $('[data-role="tf-failed"]').textContent = String(p.failed).padStart(3, '0');
    $('.tf-fail').classList.toggle('has-fails', p.failed > 0);
    $('[data-role="tf-rate"]').textContent = run.active && p.rate ? `${p.rate.toFixed(1)}/s` : '';
    $('[data-role="tf-eta"]').textContent = run.active && shownEta != null ? clockTime(shownEta) : '--:--';
  }

  function clockTime(seconds) {
    const t = Math.max(0, Math.round(seconds));
    const two = (n) => String(n).padStart(2, '0');
    return t >= 3600 ? `${Math.floor(t / 3600)}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}` : `${two(Math.floor(t / 60))}:${two(t % 60)}`;
  }

  // ── This chat ───────────────────────────────────────────

  // A real lookup failure (not just "no chat open"): Count becomes Try again.
  const describeFailed = () => !!state.targetError && state.targetError !== 'none';

  // The last count of this chat failed: Count becomes Try again, one request the person asks for.
  const scanFailed = (t) => !!t && !!state.scanError && state.scanError.channelId === t.channelId;

  // Discord won't let you read or delete in this chat: a purge could only fail, so Purify waits
  // until a Try again reads it.
  const blockedHere = (t) => (scanFailed(t) && state.scanError.blocking) || (!!t && describeFailed() && !!state.targetPlain && state.targetPlain.blocking);

  // Lines the footer says once, when it next comes to rest: why a dialog went away, or what a run cut
  // short last time left behind. resume: { mode, chatId, left, told }, from the journal.
  const notes = { moved: false, resume: null };

  // What the footer says when it comes to rest: a note waiting for this moment, else that it's ready.
  // Returns setStatus's arguments.
  function restingStatus() {
    const live = routeTarget();
    if (notes.moved) { notes.moved = false; return ['Moved chats~ nothing purged', 'calm']; }
    const r = notes.resume;
    if (r && r.mode === 'batch') {
      notes.resume = null;
      return [`${plural(r.left, 'chat')} left from last time~ Purify selected finishes them`, 'info'];
    }
    if (r && live && live.channelId === r.chatId) {
      notes.resume = null;
      return ['Cut short last time~ Purify picks up the rest', 'info'];
    }
    if (r && !r.told) {
      r.told = true;
      // The journal keeps ids only: the name comes from the lists, when they know it.
      const row = state.batchRows.get(`c:${r.chatId}`);
      return [`Cut short last time in ${row ? iso(row.name) : 'a chat'}~ open it and press Purify`, 'info'];
    }
    return [live ? 'Ready to purify~' : 'Ready when you are~', 'info', { flair: '✨' }];
  }

  // A run's verdict, and the count it wrote, last for the visit they were seen on: back on that chat,
  // Purify counts again instead of resting on an "all clean" that new messages made untrue. Counts from
  // Count stay, so visiting a chat never clears Many chats' "all clear ✓". Returns whether any went.
  function forgetLeftChats() {
    let forgot = false;
    for (const id of state.leftSince) {
      const ended = !!lastEnd && lastEnd.key === `c:${id}`;
      if (ended) lastEnd = null;
      if (ended || state.runCounted.has(id)) {
        counts.delete(id);
        state.runCounted.delete(id);
        forgot = true;
      }
    }
    state.leftSince.clear();
    return forgot;
  }

  let describeSeq = 0;
  let switchTimer = 0;
  async function refreshRoute({ keepScan = false, keepStatus = false } = {}) {
    const route = routeTarget();
    const key = route ? route.channelId : '';
    // Leaving a chat mid-run isn't seeing its verdict: that waits for when you come back.
    if (state.route && state.route.channelId !== key && !run.active) state.leftSince.add(state.route.channelId);
    const forgot = forgetLeftChats();
    if (state.route && route && state.route.channelId === key && !describeFailed()) { if (forgot) renderCurrent(); return; }
    if (!state.route && !route && state.target === null && state.targetError === 'none') return;
    if (state.scanning && state.scanKind === 'current' && !keepScan) cancelScan();
    cancelCount();
    // The footer may still be talking about the last chat (or the failed lookup); an account
    // switch re-reads the same chat and keeps its notice.
    const freshStatus = !keepStatus && (!state.target || state.target.channelId !== key || describeFailed());
    // From one chat to another, the card dims for a moment rather than flashing "finding this chat…",
    // which shows only if Discord takes longer than 250 ms to say what the new chat is. With no target,
    // Purify, Count and the card do nothing meanwhile.
    const switching = !!state.target && !!route && state.target.channelId !== key && !run.active;
    state.route = route;
    state.target = null;
    state.targetError = route ? null : 'none';
    state.targetPlain = null;
    state.scanError = null;
    const seq = ++describeSeq;
    const layer = $('[data-role="layer"]');
    clearTimeout(switchTimer);
    if (switching) {
      layer.dataset.switching = '';
      switchTimer = setTimeout(renderCurrent, 250);
    } else {
      delete layer.dataset.switching;
      renderCurrent();
    }
    if (!route) { if (!run.active) setStatus(...restingStatus()); return; }
    try {
      const target = await describeRoute(route);
      if (seq !== describeSeq) return; // user moved on while we were asking
      state.target = target;
      if (target.protected && !run.active && !keepStatus) {
        notes.moved = false;
        setStatus(`${target.name} is immune~`, 'immune');
      } else if (freshStatus && !run.active && !state.scanning && state.tab === 'current') setStatus(...restingStatus());
    } catch (err) {
      if (seq !== describeSeq) return;
      // Unread, it has no name we can trust; the id would only confuse.
      state.target = { channelId: route.channelId, guildId: route.guildId, kind: route.guildId ? 'guild' : 'dm', name: 'this chat', context: '', protected: false };
      state.targetError = err.message;
      state.targetPlain = plainError(err);
      addLog(`couldn't read this chat · ${err.message}`, 'error');
      setStatus(state.targetPlain.short, 'error');
    }
    clearTimeout(switchTimer);
    delete layer.dataset.switching;
    renderCurrent();
  }

  function renderCurrent() {
    const runningHere = run.active && state.runMode === 'current';
    const shown = runningHere ? state.runTargets[0] : state.target;
    const card = $('[data-role="target"]');
    const blocked = !runningHere && blockedHere(shown);
    const checking = lastLook();
    card.dataset.state = runningHere ? (run.paused ? 'paused' : 'live') : shown && shown.protected ? 'immune' : blocked ? 'blocked' : 'idle';
    card.toggleAttribute('data-checking', checking);
    const purified = !runningHere && lastEnd && lastEnd.key === contextKey() && !lastEnd.stopped && !lastEnd.error && !lastEnd.problems && !lastEnd.shielded
      && !(shown && shown.protected) && state.tab === 'current';
    if (purified) card.dataset.state = 'purified';
    const eyebrow = $('[data-role="eyebrow-text"]');
    if (runningHere) eyebrow.replaceChildren(...(run.paused ? ['Paused · resumes in place'] : checking ? ['Double-checking~'] : [icon('dagger', 'ico-dagger ico-dagger-r'), 'Purifying']));
    else if (shown && shown.protected) eyebrow.replaceChildren(icon('crown', 'ico-crown'), 'Immune');
    else if (purified) eyebrow.replaceChildren(icon('check'), lastEnd.failed ? 'Mostly purified' : 'Purified');
    else if (blocked) eyebrow.replaceChildren('No access');
    else eyebrow.replaceChildren(!shown ? 'This chat' : shown.guildId ? 'Server channel' : shown.kind === 'group' ? 'Group DM' : 'Direct message');
    if (purified && lastEnd.failed) card.dataset.state = 'partial';
    $('[data-role="target-ico"]').replaceChildren(shown && shown.protected ? icon('shield') : !shown ? '✦' : shown.guildId ? '#' : shown.kind === 'group' ? icon('group') : '@');
    // DMs can be shielded right from the card.
    const tools = $('[data-role="target-tools"]');
    const partner = !runningHere && shown && shown.partner;
    tools.replaceChildren(...(partner ? [shieldButton(partner, { protectedNow: !!shown.protected, label: shown.name })] : []));
    const name = $('[data-role="target-name"]');
    const context = $('[data-role="target-context"]');
    if (shown) {
      name.textContent = shown.guildId ? shown.name.replace(/^#/, '') : shown.name;
      context.textContent = shown.guildId ? shown.context : '';
    } else {
      name.textContent = state.targetError === 'none' ? 'No chat open' : 'finding this chat…';
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

  let shownBusy = null;   // what the rows' boxes and the shields last showed (see renderActions)
  let shownActive = null;

  function renderActions() {
    const idle = $('[data-role="idle-actions"]');
    const running = $('[data-role="run-actions"]');
    idle.hidden = run.active;
    running.hidden = !run.active;
    $('[data-act="pause"]').hidden = run.paused;
    $('[data-act="resume"]').hidden = !run.paused;
    $('[data-act="pause"]').disabled = run.stopping;
    $('[data-act="resume"]').disabled = run.stopping;
    // Stopping, Stop keeps focus (and says it's busy) until the run ends and hands it on.
    const stop = $('[data-act="stop"]');
    if (run.stopping) stop.setAttribute('aria-disabled', 'true'); else stop.removeAttribute('aria-disabled');
    const scan = $('[data-act="scan"]');
    const purify = $('[data-act="purify"]');
    const scanLabel = $('[data-role="scan-label"]');
    const purifyLabel = $('[data-role="purify-label"]');
    const purifyCount = $('[data-role="purify-count"]');
    const rows = selectedRows();
    const badge = $('[data-role="tab-badge"]');
    badge.textContent = String(rows.length);
    badge.hidden = !rows.length;
    // No chat open: the one useful thing left is the other tab.
    const noChat = state.tab === 'current' && state.targetError === 'none';
    if (noChat) idle.dataset.mode = 'none'; else delete idle.dataset.mode;
    scan.hidden = noChat;
    purify.hidden = noChat;
    $('[data-act="go-batch"]').hidden = !noChat;
    // Purify counting before it asks: busy, still focused, and deaf to more presses until it lands.
    const counting = !!state.counting;
    if (counting) purify.setAttribute('aria-busy', 'true'); else purify.removeAttribute('aria-busy');
    let clean = false;
    if (state.tab === 'current') {
      const t = state.target;
      const usable = !!t && !t.protected && !state.targetError;
      const n = usable ? counts.get(t.channelId) : undefined;
      const retry = describeFailed() || scanFailed(t);
      clean = usable && n === 0 && !isPartialCount(t.channelId);
      scan.disabled = (!usable && !state.scanning && !describeFailed()) || counting;
      purify.disabled = !usable || state.scanning || clean || blockedHere(t);
      scanLabel.textContent = state.scanning ? 'Cancel' : retry ? 'Try again' : n !== undefined ? 'Count again' : 'Count';
      purifyLabel.textContent = counting ? 'Counting…' : 'Purify';
      purifyCount.textContent = n ? fmt(n) : '';
      purifyCount.hidden = !n || counting;
    } else {
      scan.disabled = !rows.length && !state.scanning;
      // Nothing left to do in any selected chat (all counted at 0, or closed to us): nothing to offer.
      clean = rows.length > 0 && rows.every(emptyChat);
      purify.disabled = !rows.length || state.scanning || !purifyTargets(rows).length;
      scanLabel.textContent = state.scanning ? 'Cancel' : 'Count';
      purifyLabel.textContent = 'Purify selected';
      // The badge counts ticks, the strip the chats that go and the dialog's title what goes: no
      // fourth number on the button.
      purifyCount.textContent = '';
      purifyCount.hidden = true;
    }
    // Resting, not broken: there is simply nothing of yours left to purge.
    purify.classList.toggle('is-clean', clean);
    const busy = run.active || state.scanning;
    // Every row and shield is touched only when that can change: a tick on a big account stays a tick.
    if (busy || busy !== shownBusy || run.active !== shownActive) {
      for (const row of state.batchRows.values()) if (row.box) row.box.disabled = busy;
      for (const b of $$('.shield-btn')) {
        b.disabled = run.active;
        b.title = run.active ? 'Stop purifying to change shields~' : shieldTitle(b.classList.contains('is-on'));
      }
    }
    shownBusy = busy;
    shownActive = run.active;
    for (const act of ['dm-all', 'dm-none', 'dm-refresh', 'server-refresh']) $(`[data-act="${act}"]`).disabled = busy;
    syncGuildChecks();
    syncFold();
    speakCounts(rows);
    $('[data-role="layer"]').dataset.run = run.active ? (run.paused ? 'paused' : 'running') : 'idle';
    applyFocus();
  }

  // Focus follows the work. An action that hides or swaps the focused control names where focus
  // goes next, and it lands as soon as that control can take it. It only moves when focus was
  // already in the panel and the person hasn't gone elsewhere since, so Discord's message box is
  // never touched; :focus-visible keeps the ring off for mouse users.
  let focusNext = null;

  function handFocus(sel) {
    if (root.activeElement) focusNext = sel;
  }

  function applyFocus() {
    if (!focusNext) return;
    const active = document.activeElement;
    if (active && active !== host && active !== document.body) { focusNext = null; return; }
    const el = $(focusNext);
    if (el && !el.hidden && !el.disabled && !el.closest('[inert]') && el.getClientRects().length) {
      el.focus({ preventScroll: true });
      focusNext = null;
    }
  }

  // Counts are cancellable: Count becomes Cancel, and leaving the channel cancels too.
  function beginScan(kind) {
    state.scanning = true;
    state.scanKind = kind;
    state.scanAbort = new AbortController();
    state.scanError = null;
    renderHero(); // the ring says it's counting
    renderActions();
    return state.scanAbort.signal;
  }

  function endScan() {
    state.scanning = false;
    state.scanAbort = null;
    state.scanKind = null;
    renderHero(); // the sweep stops with the count
    if (state.tab === 'batch') setTimeout(loadPendingLists, 0);
  }

  function cancelScan() {
    if (state.scanAbort) state.scanAbort.abort();
  }

  // Purify on an uncounted chat counts it first, with one search. Leaving the chat, the tab, the
  // panel or the account abandons that count at once; the count itself clears state.counting
  // when it settles only while the entry is still its own.
  function cancelCount() {
    if (!state.counting) return;
    state.counting.abort.abort();
    state.counting = null;
  }

  async function scanCurrent() {
    const t = state.target;
    if (!t || t.protected || run.active || state.scanning) return;
    const signal = beginScan('current');
    setStatus('Counting your messages…', 'info');
    try {
      const n = await countMine(t, {
        signal,
        onWait: showWait,
        onProgress: ({ count, scanned }) => setStatus(`Checked ${fmt(scanned)}${SEP}${fmt(count)} of yours so far`, 'info', { quiet: true }),
      });
      counts.set(t.channelId, n);
      state.runCounted.delete(t.channelId); // Count's own now
      if (lastEnd && lastEnd.key === `c:${t.channelId}`) lastEnd = null;
      // Measured against the address, so a chat being re-read (an account switch) still counts as here.
      const here = !state.route || state.route.channelId === t.channelId;
      const where = here ? '' : ` in \u2068${t.name}\u2069`;
      // Shielded while we were counting: there's nothing to offer here any more.
      if (here && state.target && state.target.protected) setStatus(`${state.target.name} is immune~`, 'immune');
      else if (isPartialCount(t.channelId)) {
        setStatus(n ? `${plural(n, 'message')} found so far${where}${SEP}Discord is still indexing older ones` : `Discord is still indexing${where}~ older messages may be hiding`, 'warn');
      } else if (n) {
        setStatus(`${plural(n, 'message')} found${where}${SEP}~${formatDuration(estimateSeconds(n))} to purify`, 'success', { flair: '✨' });
      } else setStatus(`All clear~ nothing of yours ${here ? 'here' : `in \u2068${t.name}\u2069`}`, 'success', { flair: '✨' });
    } catch (err) {
      if (err instanceof Stopped) setStatus('Stopped counting~', 'calm');
      else {
        state.scanError = { channelId: t.channelId, ...plainError(err) };
        addLog(`scan failed · ${err.message}`, 'error');
        setStatus(state.scanError.short, 'error');
      }
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
    let missed = 0;
    let missedWhy = '';
    let searched = false;
    try {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.needsDM) { deferred++; continue; }
        // Search is Discord's tightest limit: pace it like a purge does instead of leaning on 429s.
        if (searched) await sleep(TIMING.searchDelayMs, signal);
        searched = true;
        setStatus(`Counting ${i + 1} of ${rows.length}${SEP}\u2068${row.display}\u2069`, 'info', { quiet: true });
        setRowState(row, 'scanning');
        try {
          const n = await countMine(row, { signal, onWait: showWait });
          counts.set(row.channelId, n);
          state.runCounted.delete(row.channelId);
          grand += n;
          if (isPartialCount(row.channelId)) indexing++;
          setRowState(row, isPartialCount(row.channelId) ? 'indexing' : n ? 'ready' : 'clean');
        } catch (err) {
          if (err instanceof Stopped || err.status === 401 || err.code === 'captcha') throw err;
          addLog(`scan failed · ${row.label} · ${err.message}`, 'error');
          setRowState(row, 'error', err.message);
          if (!missed++) missedWhy = err.message;
        }
        renderHero(); // the strip keeps up as each chat lands
      }
      if (lastEnd && lastEnd.key === 'batch') lastEnd = null;
      const counted = rows.length - deferred - missed;
      if (!searched) setStatus('Closed DMs are counted when you purify them~', 'info', { flair: '♡' });
      else if (missed) setStatus(`Counted~ ${plural(grand, 'message')}${SEP}${plural(missed, 'chat')} skipped${SEP}${shortReason(missedWhy)}${missed > 1 ? ' and more' : ''}`, 'warn');
      else if (indexing) setStatus(`Counted~ ${plural(grand, 'message')} so far${SEP}Discord is still indexing ${plural(indexing, 'chat')}`, 'warn');
      else if (!grand) setStatus(`All clear~ nothing of yours in ${counted === 1 ? 'that chat' : `those ${counted} chats`}`, 'success', { flair: '✨' });
      else setStatus(`Counted~ ${plural(grand, 'message')} in ${plural(counted, 'chat')}`, 'success', { flair: '✨' });
    } catch (err) {
      for (const row of rows) if (row.status === 'scanning') setRowState(row, 'idle');
      if (err instanceof Stopped) setStatus('Stopped counting~', 'calm');
      else {
        addLog(`scan failed · ${err.message}`, 'error');
        setStatus(plainError(err).short, 'error');
      }
    } finally {
      endScan();
      settleBatchSelection(rows); // a chat Discord won't let you into unticks now, not after a purge
      renderHero();
      renderActions();
    }
  }

  // Short enough for the one line a running footer has; a minute or more reads as minutes. Offline
  // has no countdown: the run carries on the moment the browser is back.
  function waitText(w, s = Math.max(1, Math.ceil(w.seconds))) {
    const t = s < 60 ? `${s}s` : `about ${formatDuration(s)}`;
    if (w.kind === 'rate') return `Taking a breather~ back in ${t}`;
    if (w.kind === 'index') return 'Discord is still searching~ hang on…';
    if (w.kind === 'offline') return "Offline~ purifying carries on once you're back";
    if (w.kind === 'network') return `Connection hiccup~ retrying in ${t}`;
    return `Discord is busy~ retrying in ${t}`;
  }

  // Discord's own pacing, said calmly. The seconds count down here, once a second and with no
  // requests; the next line the panel says ends the countdown. Screen readers hear the first line.
  function showWait(w) {
    const end = Date.now() + w.seconds * 1000;
    const left = () => Math.max(1, Math.ceil((end - Date.now()) / 1000));
    const flair = w.kind === 'rate' ? '🦇' : '';
    setStatus(waitText(w, left()), 'calm', { flair });
    if (w.kind === 'index' || w.kind === 'offline' || left() <= 1) return;
    waitTick = setInterval(() => {
      const s = left();
      paintStatus(waitText(w, s), 'calm', { quiet: true, flair });
      if (s <= 1) { clearInterval(waitTick); waitTick = 0; }
    }, 1000);
  }

  // Discord's errors in the panel's own words: `line` for the readout, `short` for the footer, and
  // `code` naming the cause (logged-out, no-access, no-permission, indexing, network, captcha,
  // switched, server, gone or other). `blocking` means a purge there could only fail. Discord's own
  // wording is untrusted: it stays in the log, and reaches the panel only as text.
  const PLAIN_ERRORS = [
    // First: the engine reports an account switch with status 0, like a dropped connection.
    { code: 'switched', when: (e) => /switched Discord accounts/.test(e.message), line: 'You switched Discord accounts~ stopped to be safe', short: 'Switched accounts' },
    { code: 'captcha', when: (e) => e.code === 'captcha' || /captcha|human check/i.test(e.message), line: 'Discord wants a captcha~ solve it in Discord, then press Purify to finish', short: 'Discord wants a captcha' },
    { code: 'logged-out', when: (e) => e.status === 401 || /login token/.test(e.message), line: "You're logged out of Discord~ log in, then press Try again", short: 'Logged out of Discord' },
    { code: 'no-access', when: (e) => e.code === 50001 || /Missing Access/.test(e.message), line: "You can't read this channel, so there's nothing here to purify", short: 'No access here', blocking: true },
    { code: 'no-permission', when: (e) => e.code === 50013 || /Missing Permissions/.test(e.message), line: "Discord won't let you delete here", short: 'No permission here', blocking: true },
    { code: 'indexing', when: (e) => e.status === 202 || /indexing/.test(e.message), line: 'Discord is still sorting this chat~ try again in a minute', short: 'Discord is still indexing' },
    { code: 'network', when: (e) => e.status === 0 || /Network unreachable/.test(e.message), line: "Can't reach Discord~ check your internet, then press Try again", short: "Can't reach Discord" },
    { code: 'server', when: (e) => e.status >= 500, line: 'Discord is having a moment~ try again in a minute', short: 'Discord is having a moment' },
    { code: 'gone', when: (e) => e.code === 10003, line: "This chat doesn't exist any more", short: 'Chat is gone' },
  ];

  // Takes an Error, any { status, code, message }, a run's end ({ error, errorStatus, errorCode })
  // or a bare reason string such as a row's 'Missing Access (code 50001)'.
  function plainError(errLike) {
    const e = typeof errLike === 'string' ? { message: errLike } : errLike || {};
    const message = String(e.message ?? e.error ?? '');
    const tagged = /\(code (\d+)\)$/.exec(message);
    const err = { status: e.status ?? e.errorStatus ?? null, code: e.code ?? e.errorCode ?? (tagged ? Number(tagged[1]) : null), message };
    const known = PLAIN_ERRORS.find((p) => p.when(err));
    if (known) return { line: known.line, short: known.short, code: known.code, blocking: !!known.blocking };
    const said = message.replace(/\s*\(code \d+\)$/, '').replace(/^HTTP (\d+)$/, 'error $1') || 'something went wrong';
    return { line: `Discord said: ${said}`, short: said.length > 28 ? `${said.slice(0, 27)}…` : said, code: 'other', blocking: false };
  }

  // A list that couldn't load, in a list's words: its retry is its own ↻ (not This chat's Try
  // again), and logging in fills the lists by itself. Discord's wording goes to the log.
  function listError(what, err) {
    addLog(`couldn't load ${what} · ${err.message}`, 'error');
    const p = plainError(err);
    if (p.code === 'logged-out') return "You're logged out of Discord~ log in and your chats show up here";
    return `${p.code === 'other' ? p.line : p.short}${SEP}press ↻ to try again`;
  }

  // The dialog names the account doing the deleting, so a switched account can't surprise anyone.
  async function actingAs() {
    try { syncAccount(); const me = await whoAmI(); return me.username; } catch { return null; }
  }

  const COUNT_CAP_MS = 1200;
  const gaveUpCounting = new WeakSet(); // chats (this visit's target) whose count Discord held up

  // Purify on an uncounted chat counts it first with the one search the purge would start with, so
  // the dialog can say how many. It asks who you are first, as the dialog always has; only Discord's
  // search is on the clock. Past COUNT_CAP_MS, or at any wait Discord asks for, the count is given up
  // for this visit and the dialog says "all your messages". Returns { go, who }: whether the dialog
  // should follow, and as whom.
  async function countFirst(t) {
    const ctl = new AbortController();
    state.counting = { channelId: t.channelId, abort: ctl };
    renderCurrent();
    setStatus('Counting your messages…', 'info');
    const who = await actingAs();
    let cap = 0;
    let plain = null;
    let held = null;
    try {
      if (who) {
        cap = setTimeout(() => ctl.abort(), COUNT_CAP_MS);
        counts.set(t.channelId, await countMine(t, {
          signal: ctl.signal,
          searchOnly: true,
          onWait: (w) => { held = w; ctl.abort(); },
        }));
        state.runCounted.delete(t.channelId);
      }
    } catch (err) {
      if (!(err instanceof Stopped)) {
        plain = plainError(err);
        if (plain.blocking) state.scanError = { channelId: t.channelId, ...plain };
        addLog(`count failed · ${err.message}`, 'warn');
      }
    } finally {
      clearTimeout(cap);
    }
    // Someone else ended it (left the chat, the tab, the panel or the account): nothing follows.
    const own = !!state.counting && state.counting.abort === ctl;
    if (own) state.counting = null;
    if (own && !counts.has(t.channelId)) {
      gaveUpCounting.add(t);
      if (!who) addLog("count skipped · Discord didn't say who you are", 'warn');
      else if (held) addLog(`count skipped · Discord asked for a wait (${held.kind}), so the purge counts as it goes`, 'info');
      else if (!plain) addLog('count skipped · Discord took too long, so the purge counts as it goes', 'info');
    }
    renderCurrent();
    // Still the chat on screen, by the address itself: a click away that the panel hasn't caught up
    // with yet must not bring up a dialog for the chat left behind.
    const live = routeTarget();
    const here = !!live && live.channelId === t.channelId && !!state.target && state.target.channelId === t.channelId && !state.target.protected;
    if (!own || !here || run.active || modal || state.scanning) return { go: false };
    // A chat you can't read could only fail: say so instead of asking.
    if (plain && plain.blocking) { setStatus(plain.short, 'error'); return { go: false }; }
    if (counts.get(t.channelId) === 0 && !isPartialCount(t.channelId)) {
      setStatus('All clear~ nothing of yours here', 'success', { flair: '✨' });
      return { go: false };
    }
    setStatus('Ready to purify~', 'info', { quiet: true, flair: '✨' }); // under the dialog, for after it
    return { go: true, who };
  }

  async function askPurgeCurrent() {
    if (!state.target || state.target.protected || run.active || starting || modal || state.counting || state.scanning) return;
    const t = state.target;
    // Another tab is purifying: say so, rather than count or ask.
    if (await runLockHeld()) { setStatus(ELSEWHERE, 'calm'); return; }
    if (state.target !== t || run.active || starting || modal || state.counting || state.scanning) return;
    const blocked = state.scanError && state.scanError.channelId === t.channelId && state.scanError.blocking;
    if (blocked) { setStatus(state.scanError.short, 'error'); return; }
    let who;
    if (counts.has(t.channelId) || gaveUpCounting.has(t)) who = await actingAs();
    else {
      const counted = await countFirst(t);
      if (!counted.go) return;
      ({ who } = counted);
    }
    // Re-read: an account switch may have reset everything meanwhile, or the person moved on (the
    // address says so first, even before the panel has caught up).
    const now = state.target;
    const live = routeTarget();
    if (!now || now.channelId !== t.channelId || now.protected || run.active || starting || modal || state.scanning || state.counting || state.tab !== 'current'
      || !live || live.channelId !== now.channelId) return;
    const n = isPartialCount(now.channelId) ? 0 : counts.get(now.channelId);
    const b = (k) => h('b', { text: fmt(k) });
    // A server channel's search reaches its threads (a forum's or media channel's, its posts) too.
    const reach = !now.guildId ? '' : [0, 2, 5, 13].includes(now.channelType) ? ', threads included,' : [15, 16].includes(now.channelType) ? ', posts included,' : '';
    confirmDialog({
      title: 'Ready to purify?',
      lead: n === 1 ? ['This will delete your ', b(1), ` message${reach} in`]
        : n ? ['This will delete all ', b(n), ` of your messages${reach} in`] : [`This will delete all your messages${reach} in`],
      pill: now,
      channelId: now.channelId,
      who,
      time: longPurge(n),
      confirmLabel: ['Hold to purify', '✨'],
      onConfirm: () => beginRun([{ ...now }], 'current', who),
    });
  }

  // One sentence that says exactly what goes: the counted messages, every message in the chats not
  // counted yet, and that an index still being built may hold older ones. Chats Discord won't let you
  // into are listed as skipped, not counted as purged.
  async function askPurgeSelected() {
    if (!selectedRows().length || run.active || starting || modal) return;
    if (await runLockHeld()) { setStatus(ELSEWHERE, 'calm'); return; }
    const who = await actingAs();
    const rows = selectedRows(); // re-read: an account switch clears the selection
    if (!rows.length || run.active || starting || modal || state.scanning) return;
    // The number never changes at the moment that can't be undone: the title, the list, 'Starting on'
    // and 'Chat 1 of N' all count the chats that really go. All-clear and no-access chats sit it out.
    const targets = purifyTargets(rows);
    const n = targets.length;
    if (!n) return; // nothing left to purge in any of them
    const counted = targets.filter((r) => r.channelId && counts.has(r.channelId));
    const known = counted.reduce((sum, r) => sum + counts.get(r.channelId), 0);
    const uncounted = n - counted.length;
    const partial = counted.some((r) => isPartialCount(r.channelId));
    const b = (k) => h('b', { text: fmt(k) });
    // The chats are named in the list below, and usually aren't the one on screen: '1 chat', never 'this chat'.
    const where = n === 1 ? ' in 1 chat' : ' in these chats';
    const lead = known && !uncounted ? (known === 1 ? ['This will delete your ', b(1), ` message${where}`] : ['This will delete all ', b(known), ` of your messages${where}`])
      : known ? ['This will delete ', b(known), ` of your messages, plus all of yours in `, b(uncounted), ` ${uncounted === 1 ? 'chat' : 'chats'} not counted yet`]
        : n === 1 ? [`This will delete all your messages${where}`] : ['This will delete all your messages in these ', b(n), ' chats'];
    const threads = targets.some((r) => r.guildId) ? ', threads included' : '';
    // A server with many channels picked is one line; its channels are named on hover and when opened.
    const byServer = new Map();
    for (const r of targets) if (r.guildId) byServer.set(r.guildId, [...(byServer.get(r.guildId) || []), r]);
    const msgs = (group) => (group.some((r) => !counts.has(r.channelId)) ? 'not counted' : plural(group.reduce((sum, r) => sum + counts.get(r.channelId), 0), 'message'));
    const list = [];
    for (const r of targets) {
      const group = r.guildId && byServer.get(r.guildId);
      if (group && group.length >= 4) {
        if (group[0] === r) list.push(serverLine(r.context, group, msgs(group)));
        continue;
      }
      const k = r.channelId ? counts.get(r.channelId) : undefined;
      list.push(k === undefined ? { label: r.label, meta: 'not counted', tone: 'unknown' } : { label: r.label, meta: plural(k, 'message') });
    }
    const skipped = rows.filter(accessError);
    for (const r of skipped) list.push({ label: r.label, meta: `skipped · ${shortReason(r.reason)}`, tone: 'skipped' });
    const clear = rows.filter(emptyChat).length;
    if (clear) list.push({ label: `${plural(clear, 'chat')} with nothing of yours`, meta: 'left out', tone: 'unknown' });
    const out = skipped.length + clear;
    confirmDialog({
      title: `Purify ${plural(n, 'chat')}?`,
      lead: [...lead, threads, partial ? ' (Discord may find older ones later)' : '',
        h('span', { 'aria-hidden': 'true', text: ':' }), h('span', { class: 'sr', text: '.' })],
      list,
      listLabel: `${plural(n, 'chat')} to purify${out ? `, ${fmt(out)} left out` : ''}`,
      who,
      time: longPurge(known, uncounted > 0 || partial),
      confirmLabel: ['Hold to purify all', '✨'],
      onConfirm: () => beginRun(targets, 'batch', who),
    });
  }

  // One line in the dialog for a server with many channels picked: its name, how many, and what they
  // hold. Its title and its opened state name every channel, so the line still shows exactly what goes.
  function serverLine(server, group, meta) {
    const names = group.map((r) => `${r.glyph === '#' ? '#' : ''}${r.display}`).join(', ');
    return h('div', { class: 'modal-item modal-server', role: 'listitem' },
      h('details', {},
        h('summary', { title: names },
          h('span', { class: 'modal-item-name' }, icon('chevron', 'modal-server-chev'), `${server}${SEP}${plural(group.length, 'channel')}`),
          h('span', { class: `modal-item-meta${meta === 'not counted' ? ' is-unknown' : ''}`, text: meta })),
        h('div', { class: 'modal-server-names', text: names })));
  }

  // One purge at a time in this browser: a run holds a Web Lock that every Discord tab here shares, and
  // a tab that closes or crashes lets go of it at once. Without Web Locks, or if they fail, nothing is
  // ever blocked. Counting stays free.
  const RUN_LOCK = 'dopa-purifier:run';
  const ELSEWHERE = 'Purifying in another Discord tab~ one at a time keeps your account safe';
  let releaseRunLock = null;
  let starting = false; // from the hold to the run's start, while the lock is asked for

  async function runLockHeld() {
    try {
      const { held } = await navigator.locks.query();
      return held.some((lock) => lock.name === RUN_LOCK);
    } catch { return false; }
  }

  // Resolves true once this tab holds the lock (or there is none to hold), false if another tab has it.
  function takeRunLock() {
    return new Promise((resolve) => {
      try {
        navigator.locks.request(RUN_LOCK, { ifAvailable: true }, (lock) => {
          if (!lock) { resolve(false); return null; }
          resolve(true);
          return new Promise((release) => { releaseRunLock = release; });
        }).catch(() => resolve(true));
      } catch { resolve(true); }
    });
  }

  function freeRunLock() {
    if (releaseRunLock) releaseRunLock();
    releaseRunLock = null;
  }

  // The journal this tab knows of: its own run's, or the one boot found. Written when a run starts and
  // as each chat finishes, never per kill.
  let journal = null;
  let destroying = false; // the panel going away (a plugin reload) cuts a run short; it isn't a Stop

  function startJournal(targets, mode) {
    const user = session.me && session.me.id;
    journal = !user ? null : mode === 'current'
      ? { v: 1, user, mode, at: Date.now(), state: 'running', chat: { id: targets[0].channelId } }
      : {
        v: 1, user, mode, at: Date.now(), state: 'running',
        keys: targets.map((t) => t.key).slice(0, 500),
        guilds: [...new Set(targets.map((t) => t.guildId).filter(Boolean))].slice(0, 500),
      };
    storeJournal(journal); // replaces any older one
  }

  // `who` is the account the person confirmed as; the run is bound to it.
  async function beginRun(targets, mode, who) {
    starting = true;
    const ours = await takeRunLock();
    starting = false;
    if (!ours) {
      // Another tab started first: nothing was sent, and focus goes back to Purify.
      handFocus('[data-act="purify"]');
      setStatus(ELSEWHERE, 'calm');
      renderActions();
      return;
    }
    if (syncProtection()) protectionStale = true; // a shield from another tab; the engine honours it per chat
    state.runTargets = targets;
    state.runMode = mode;
    state.runAs = who || null;
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
    startJournal(targets, mode);
    await startRun(targets);
  }

  // ── Many chats: lists ───────────────────────────────────

  function rowKey(row) {
    return row.channelId ? `c:${row.channelId}` : `u:${row.userId}`;
  }

  // One line per row: the count is the readiness and the pill the outcome, so only news (still
  // indexing, run again later) takes a second line. Each row's checkbox is described by its tag and
  // meta, so a screen reader hears 'DM: Mira, checkbox, checked, 7 msgs' or '… purifying 5 of 7'.
  function setRowState(row, status, detail) {
    const was = row.status;
    row.status = status;
    row.reason = detail || '';
    const el = row.el;
    if (!el || row.protected) return;
    el.dataset.state = status;
    // Hover shows the whole name and what it is, however the line cut them.
    el.title = detail || [row.display, row.sub].filter(Boolean).join(' ');
    const n = counts.get(row.channelId);
    const deleted = fmt(row.deleted || 0);
    const tag = el.querySelector('.row-tag');
    // A running row says so with its pill and tint alone, so it never grows a line as a run moves on.
    const tagText = status === 'partial' ? detail || 'run again later'
      : status === 'indexing' ? 'Discord is still indexing~' : '';
    if (tag.textContent !== tagText) tag.textContent = tagText;
    tag.hidden = !tagText;
    // Each kill changes only the running pill's number, so its spinner keeps turning.
    if (was === 'running' && status === 'running') {
      const done = el.querySelector('.run-pill-live .run-pill-n');
      const total = el.querySelector('.run-pill-live .run-pill-total');
      if (done && (n ? !!total && total.textContent === fmt(n) : !total)) { done.textContent = deleted; return; }
    }
    const msgs = (k) => h('span', { class: 'meta-count' }, h('b', { text: fmt(k) }), h('small', { text: k === 1 ? ' msg' : ' msgs' }));
    const clear = () => h('span', { class: 'meta-clear' }, 'all clear', h('span', { 'aria-hidden': 'true', text: ' ✓' }));
    const pill = (kind, ...children) => h('span', { class: `run-pill run-pill-${kind}` }, ...children);
    const say = (text) => h('span', { class: 'sr', text });
    let meta = null;
    // Friends with a closed DM aren't told so one by one: their fold says it once.
    if (status === 'scanning') meta = pill('scan', h('i', { class: 'spin' }), 'counting');
    else if (status === 'ready') meta = n ? msgs(n) : null;
    else if (status === 'indexing') meta = n ? msgs(n) : 'none yet';
    else if (status === 'clean') meta = clear();
    else if (status === 'queued') meta = pill('queued', 'queued');
    else if (status === 'running') {
      meta = pill('live', h('i', { class: 'spin' }), say('purifying '), h('span', { class: 'run-pill-n', text: deleted }),
        ...(n ? [say(' of '), h('span', { 'aria-hidden': 'true', text: '/' }), h('span', { class: 'run-pill-total', text: fmt(n) })] : []));
    } else if (status === 'done' && !row.deleted && !row.failed) meta = clear();
    else if (status === 'done') meta = pill('done', icon('check'), say('purged '), row.failed ? `${deleted}${SEP}${fmt(row.failed)} failed` : deleted);
    else if (status === 'partial') meta = pill('stopped', `${deleted}${SEP}again later`);
    else if (status === 'error') meta = pill('error', h('span', { 'aria-hidden': 'true', text: '✗ ' }), h('span', { class: 'run-pill-why', text: detail ? shortReason(detail) : 'skipped' }));
    else if (status === 'stopped') meta = pill('stopped', 'stopped');
    el.querySelector('.row-meta').replaceChildren(...(meta ? [meta] : []));
  }

  // A row drawn afresh (a refreshed list, a shield redraw) shows what is already known about its chat.
  function restingState(row) {
    const n = row.channelId ? counts.get(row.channelId) : undefined;
    if (n === undefined) return 'idle';
    return isPartialCount(row.channelId) ? 'indexing' : n ? 'ready' : 'clean';
  }

  // The checkbox is described by the row's tag and meta; the ids follow the row's key.
  function describeRow(row) {
    if (!row.box) return; // an immune row has no checkbox
    const tag = row.el.querySelector('.row-tag');
    const meta = row.el.querySelector('.row-meta');
    tag.id = `dp-tag-${row.key}`;
    meta.id = `dp-meta-${row.key}`;
    row.box.setAttribute('aria-describedby', `${tag.id} ${meta.id}`);
  }

  // Why one message or chat didn't go, in two or three words. Anything else is Discord's own
  // words, without its code.
  function shortReason(reason) {
    if (/Missing Access/i.test(reason)) return 'no access';
    if (/Missing Permissions/i.test(reason)) return 'no permission';
    if (/indexing/i.test(reason)) return 'still indexing';
    if (/system message/i.test(reason)) return 'system message';
    if (/archived/i.test(reason)) return 'archived thread';
    if (/Unknown Message/i.test(reason)) return 'already gone';
    if (/captcha|human check/i.test(reason)) return 'captcha';
    return plainError(reason).short;
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
      tickRow(row, box.checked);
      selectionChanged();
    });
    box.disabled = run.active || state.scanning;
    row.box = box;
    // A DM row with no one to shield (a group) keeps the shield's room, so every count ends on one column.
    const end = row.partner ? shieldButton(row.partner, { protectedNow: false, label: row.display })
      : row.kind !== 'guild' ? h('span', { class: 'shield-slot', 'aria-hidden': 'true' }) : null;
    row.el = h('label', { class: `row${indent ? ' row-indent' : ''}${box.checked ? ' is-selected' : ''}`, dataset: { key } },
      box,
      h('span', { class: 'check-ui', 'aria-hidden': 'true' }, icon('check')),
      ava,
      h('span', { class: 'row-main' },
        h('span', { class: 'row-name', text: row.display }),
        row.sub ? h('span', { class: 'row-sub', text: row.sub }) : null,
        h('span', { class: 'row-tag', hidden: true })),
      h('span', { class: 'row-meta' }),
      end);
    describeRow(row);
    setRowState(row, row.status || restingState(row));
    return row.el;
  }

  // Ticks or unticks one row. A chat whose count a finished run wrote is counted afresh when it is
  // picked again, so new messages since then aren't hidden behind an old 'all clear'.
  function tickRow(row, checked) {
    row.box.checked = checked;
    if (!checked) state.selected.delete(row.key);
    else {
      state.selected.add(row.key);
      if (row.channelId && state.runCounted.has(row.channelId) && !run.active) {
        state.runCounted.delete(row.channelId);
        counts.delete(row.channelId);
        setRowState(row, 'idle');
      }
    }
    row.el.classList.toggle('is-selected', checked);
  }

  // Re-key a friend row once its DM exists, so the row and its selection follow the real channel id.
  function rekeyRow(row, oldKey) {
    const key = rowKey(row);
    if (key === oldKey) return;
    if (state.batchRows.get(oldKey) === row) state.batchRows.delete(oldKey);
    state.batchRows.set(key, row);
    if (state.selected.delete(oldKey)) state.selected.add(key);
    row.key = key;
    if (row.el) {
      row.el.dataset.key = key;
      describeRow(row);
    }
  }

  function snowflakeDesc(a, b) {
    const x = BigInt(a || 0);
    const y = BigInt(b || 0);
    return x === y ? 0 : (x > y ? -1 : 1);
  }

  // The latest load of a list wins: an older one, still retrying through an outage, must not
  // overwrite what a newer one drew.
  let dmSeq = 0;
  let guildSeq = 0;

  async function loadDMs() {
    const list = $('[data-role="dm-list"]');
    if (run.active || state.scanning) {
      if (!state.dmsLoaded) list.replaceChildren(h('div', { class: 'list-empty', text: 'Lists load when purifying is done~' }));
      return;
    }
    const seq = ++dmSeq;
    state.dmsLoading = true;
    list.replaceChildren(h('div', { class: 'list-empty', text: 'Finding your DMs…' }));
    try {
      const [channels, relationships] = await Promise.all([listDMs(), listRelationships()]);
      if (seq !== dmSeq) return;
      state.dmData = { channels, relationships };
      renderDMs();
    } catch (err) {
      if (seq !== dmSeq) return;
      list.replaceChildren(h('div', { class: 'list-empty', text: listError('your DMs', err) }));
    } finally {
      if (seq === dmSeq) state.dmsLoading = false;
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
      label: c.type === 3 ? `Group: ${iso(dmTitle(c))}` : `DM: ${iso(dmTitle(c))}`,
      context: c.type === 3 ? 'Group DM' : 'Direct message',
    }));
    for (const rel of relationships) {
      if (rel.type !== 1 || withDM.has(rel.id)) continue;
      const user = rel.user || {};
      const name = user.global_name || user.username || 'Unknown';
      rows.push({
        kind: 'friend', channelId: null, userId: rel.id, needsDM: true, guildId: null,
        // The word that explains the row comes first, so it survives a long name.
        name, display: name, sub: user.username ? `friend${SEP}@${user.username}` : 'friend', glyph: '',
        partner: user,
        protected: isProtectedUser(user),
        label: `Friend: ${iso(name)}`, context: 'Direct message',
      });
    }
    rows.sort((a, b) => Number(b.protected) - Number(a.protected));
    for (const r of rows) if (r.protected) state.selected.delete(rowKey(r));
    // Friends you have no DM with wait in one fold at the end: 'All' never ticks them, so they read as
    // a choice rather than as chats that were missed.
    const folded = rows.filter((r) => r.needsDM && !r.protected);
    const open = rows.filter((r) => !folded.includes(r));
    // With nothing else to pick (only immune DMs), the fold starts open.
    if (friendsFold.open === null) friendsFold.start = !open.some((r) => !r.protected);
    list.replaceChildren(...(rows.length ? [...open.map((r) => makeRow(r)), folded.length ? buildFold(folded) : null].filter(Boolean)
      : [h('div', { class: 'list-empty', text: 'No DMs here yet~' })]));
    state.dmsLoaded = true;
    applyFilter();
  }

  // The fold of friends with a closed DM, built like a server's line without its select-all box.
  // It opens when the person opens it, while a query finds someone inside, and while anyone inside is
  // ticked, so it never hides a pick. friendsFold.open is the person's own choice (null: not made yet).
  const friendsFold = { open: null, start: false };
  const foldOpen = () => friendsFold.open ?? friendsFold.start;

  function buildFold(rows) {
    const head = h('button', { class: 'fold-head', 'aria-expanded': 'false', 'aria-controls': 'dp-fold-rows' },
      h('span', { class: 'guild-chevron', 'aria-hidden': 'true' }, icon('chevron')),
      h('span', { class: 'guild-name', text: 'Friends with a closed DM' }),
      h('span', { class: 'guild-meta', 'data-role': 'fold-meta', text: plural(rows.length, 'friend') }));
    head.addEventListener('click', () => {
      friendsFold.open = head.getAttribute('aria-expanded') !== 'true';
      syncFold();
    });
    return h('div', { class: 'fold', 'data-role': 'fold' },
      h('div', { class: 'fold-bar', dataset: { key: 'fold:friends' } }, head),
      h('div', { class: 'fold-rows', id: 'dp-fold-rows', hidden: true },
        h('div', { class: 'list-empty fold-note', text: 'Purifying one opens the DM for a moment, then closes it again~' }),
        rows.map((r) => makeRow(r))));
  }

  // Shows the fold open or closed, and how many inside are picked: '2 friends · 1 picked'.
  function syncFold() {
    const fold = $('[data-role="fold"]');
    if (!fold) return;
    const rows = [];
    for (const row of state.batchRows.values()) if (row.needsDM && row.box) rows.push(row);
    const picked = rows.filter((r) => state.selected.has(r.key)).length;
    const found = !!state.filter.trim() && rows.some((r) => !r.el.hidden);
    const open = foldOpen() || picked > 0 || found;
    const head = fold.querySelector('.fold-head');
    const was = head.getAttribute('aria-expanded') === 'true';
    if (was !== open) {
      head.setAttribute('aria-expanded', String(open));
      fold.querySelector('.fold-rows').hidden = !open;
      rove(fold.parentElement);
    }
    const meta = `${plural(rows.length, 'friend')}${picked ? `${SEP}${fmt(picked)} picked` : ''}`;
    const metaEl = fold.querySelector('[data-role="fold-meta"]');
    if (metaEl.textContent !== meta) metaEl.textContent = meta;
  }

  // ── Protection ──────────────────────────────────────────

  // Who is immune, by person rather than by account name: 'Bardo & Dopa ♡ + 1 you shielded'.
  const IMMUNE_PEOPLE = { bardo: 'Bardo', bardosama: 'Bardo', dopameanie: 'Dopa', dopa_meanie: 'Dopa' };

  function immuneSummary() {
    const people = [...new Set([...PROTECTED_USERNAMES].filter((n) => !protection.released.has(n)).map((n) => IMMUNE_PEOPLE[n] || n))];
    const named = people.length ? `${people.join(' & ')} ♡` : 'nobody yet';
    return protection.ids.size ? `${named} + ${protection.ids.size} you shielded` : named;
  }

  function toggleProtection(user) {
    if (!user) return;
    if (run.active) { setStatus('Stop purifying to change shields~', 'warn'); return; }
    const synced = syncProtection(); // start from every tab's shields, not just this one's
    const before = { ids: new Set(protection.ids), released: new Set(protection.released) };
    const shield = !isProtectedUser(user);
    setProtected(user, shield);
    const name = iso(user.global_name || user.username);
    // A shield that didn't save would be gone after a reload: put things back and say so.
    if (!storeProtection()) {
      protection.ids = before.ids;
      protection.released = before.released;
      if (synced) protectionChanged();
      addLog(`couldn't save the shield for ${name} — Discord's storage is full or blocked`, 'error');
      setStatus(`Couldn't save~ ${name} is ${shield ? 'not immune' : 'still immune'} (Discord's storage is full or blocked)`, 'error');
      return;
    }
    addLog(shield ? `shielded ${name} — they're immune now ♡` : `${name} is no longer immune`, 'info');
    setStatus(shield ? `${name} is immune now~` : `${name} can be purged again`, shield ? 'immune' : 'info');
    protectionChanged();
  }

  // Redraw everything that shows who is immune. The redraw rebuilds every shield, so a shield that
  // had focus hands it to the same person's new one: a keyboard toggle keeps its place.
  function protectionChanged({ keepVerdict = false } = {}) {
    const focused = root.activeElement && root.activeElement.closest('.shield-btn');
    const who = focused && focused.dataset.userId;
    if (state.dmData) renderDMs();
    const partner = state.target && state.target.partner;
    if (partner) state.target.protected = isProtectedUser(partner);
    if (!keepVerdict && lastEnd && lastEnd.key === contextKey()) lastEnd = null;
    renderCurrent();
    const again = who && $(`.view:not([hidden]) .shield-btn[data-user-id="${window.CSS.escape(who)}"]`); // CSS here is our stylesheet
    if (again) again.focus();
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

  // 'Shield' is the verb and 'immune' the state. The button keeps one name and aria-pressed says
  // whether the shield is up, so a screen reader never hears 'remove' and 'pressed' at once.
  const shieldTitle = (immune) => (immune ? 'Immune ♡ click to remove the shield' : 'Shield this DM~ never purged');

  function shieldButton(user, { protectedNow, label }) {
    const btn = h('button', {
      class: `shield-btn${protectedNow ? ' is-on' : ''}`,
      type: 'button',
      'data-user-id': user.id,
      'aria-pressed': String(protectedNow),
      'aria-label': `Shield ${iso(label)}`,
      // Drawn mid-purge, it starts as renderActions would leave it (which skips the rows when idle).
      title: run.active ? 'Stop purifying to change shields~' : shieldTitle(protectedNow),
      disabled: run.active,
    }, icon('shield'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleProtection(user);
    });
    return btn;
  }

  // Servers holding chats a run left ticked last time open by themselves, so every tick is in view.
  const restoredGuilds = new Set();
  function openRestoredGuilds() {
    for (const section of $$('.guild')) {
      if (!restoredGuilds.delete(section.dataset.guildId)) continue;
      const head = section.querySelector('.guild-head');
      if (head.getAttribute('aria-expanded') !== 'true') head.click();
    }
  }

  async function loadServers({ refresh = false } = {}) {
    const list = $('[data-role="server-list"]');
    if (run.active || state.scanning) {
      if (!state.guildsLoaded) list.replaceChildren(h('div', { class: 'list-empty', text: 'Lists load when purifying is done~' }));
      return;
    }
    const seq = ++guildSeq;
    state.guildsLoading = true;
    list.replaceChildren(h('div', { class: 'list-empty', text: 'Finding your servers…' }));
    try {
      const guilds = await myGuilds({ refresh });
      if (seq !== guildSeq) return;
      for (const [key, row] of state.batchRows) if (row.kind === 'guild') state.batchRows.delete(key);
      list.replaceChildren(...(guilds.length ? guilds.map(buildGuild) : [h('div', { class: 'list-empty', text: "You're not in any servers~" })]));
      state.guildsLoaded = true;
      applyFilter();
      openRestoredGuilds();
    } catch (err) {
      if (seq !== guildSeq) return;
      list.replaceChildren(h('div', { class: 'list-empty', text: listError('your servers', err) }));
    } finally {
      if (seq === guildSeq) state.guildsLoading = false;
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
    const all = h('input', { type: 'checkbox', class: 'check', 'aria-label': `All channels in ${iso(guild.name)}` });
    const allLabel = h('label', { class: 'guild-all', title: 'Select every channel' }, all, h('span', { class: 'check-ui', 'aria-hidden': 'true' }, icon('check')));
    // The select-all box comes first, where it is drawn, so focus moves the way the eye does.
    const section = h('div', { class: 'guild', dataset: { guildId: guild.id, name: guild.name.toLowerCase() } },
      h('div', { class: 'guild-bar' }, allLabel, head), channelsEl);
    guildParts.set(section, { all, meta: head.querySelector('[data-role="guild-meta"]') });
    let loading = null;
    const load = () => {
      if (!loading) {
        channelsEl.replaceChildren(h('div', { class: 'list-empty', text: 'Finding channels…' }));
        loading = listTextChannels(guild.id).then((channels) => {
          const rows = channels.map((ch) => {
            const glyph = ch.type === 2 || ch.type === 13 ? 'sound' : ch.type === 5 ? 'megaphone' : ch.type === 15 || ch.type === 16 ? 'forum' : '#';
            return {
              kind: 'guild', channelId: ch.id, guildId: guild.id,
              name: `#${ch.name}`, display: ch.name, glyph,
              sub: ch.categoryName ? ch.categoryName.toLowerCase() : '',
              // Only a text channel is '#name'; voice, forum and announcement channels go by their name.
              protected: false, label: `${glyph === '#' ? '#' : ''}${iso(ch.name)} (${iso(guild.name)})`, context: guild.name,
            };
          });
          channelsEl.replaceChildren(...(rows.length ? rows.map((r) => makeRow(r, { indent: true })) : [h('div', { class: 'list-empty', text: 'No channels here you can purify~' })]));
          head.querySelector('[data-role="guild-meta"]').textContent = plural(rows.length, 'channel');
          applyFilter();
          syncGuildChecks();
          // Picks restored from last time join the badge, the strip and Purify once their rows exist.
          if (rows.some((r) => state.selected.has(r.key))) { renderHero(); renderActions(); }
        }, (err) => {
          loading = null;
          channelsEl.replaceChildren(h('div', { class: 'list-empty', text: listError(`${guild.name}'s channels`, err) }));
          throw err;
        });
      }
      return loading;
    };
    const expand = (open) => {
      head.setAttribute('aria-expanded', String(open));
      channelsEl.hidden = !open;
      rove(section.parentElement);
      if (open) load().catch(() => {});
    };
    head.addEventListener('click', () => expand(head.getAttribute('aria-expanded') !== 'true'));
    all.addEventListener('change', async () => {
      const checked = all.checked;
      expand(true);
      try { await load(); } catch { all.checked = false; return; }
      for (const row of state.batchRows.values()) {
        if (row.guildId !== guild.id || !row.box || row.el.hidden) continue;
        tickRow(row, checked);
      }
      selectionChanged();
    });
    return section;
  }

  // Each server's select-all box and meta, found once (a section → { all, meta }).
  const guildParts = new WeakMap();

  // One pass over the rows for every server: a tick on a big account costs one walk, not one per server.
  function syncGuildChecks() {
    const tally = new Map(); // guildId → { n, picked }
    for (const row of state.batchRows.values()) {
      if (!row.guildId || !row.box) continue;
      const t = tally.get(row.guildId) || { n: 0, picked: 0 };
      t.n++;
      if (state.selected.has(row.key)) t.picked++;
      tally.set(row.guildId, t);
    }
    const busy = run.active || state.scanning;
    for (const section of $$('.guild')) {
      const parts = guildParts.get(section);
      if (!parts) continue;
      const { n, picked } = tally.get(section.dataset.guildId) || { n: 0, picked: 0 };
      parts.all.checked = n > 0 && picked === n;
      parts.all.indeterminate = picked > 0 && picked < n;
      parts.all.disabled = busy;
      const meta = picked ? `${fmt(picked)} of ${fmt(n)}` : plural(n, 'channel');
      if (n && parts.meta.textContent !== meta) parts.meta.textContent = meta;
    }
  }

  // Every list is filtered, re-roved and, when nothing in it matches, says so.
  const LISTS = ['[data-role="dm-list"]', '[data-role="server-list"]'];

  // Only what changes is written, so a keystroke on a big account doesn't restyle every row.
  const show = (el, shown) => { if (el.hidden === shown) el.hidden = !shown; };

  function applyFilter() {
    const typed = state.filter.trim();
    const q = typed.toLowerCase();
    for (const row of state.batchRows.values()) {
      if (!row.el) continue;
      // The marks that keep names in reading order are invisible, so they never stop a match.
      const hay = `${row.display} ${row.name} ${row.label} ${row.sub || ''}`.replace(/[\u2066-\u2069]/g, '').toLowerCase();
      show(row.el, !q || hay.includes(q));
    }
    for (const guild of $$('.guild')) {
      const nameHit = !q || guild.dataset.name.includes(q);
      const anyChannel = Array.from(guild.querySelectorAll('.row')).some((r) => !r.hidden);
      show(guild, nameHit || anyChannel);
      if (q && nameHit) for (const r of guild.querySelectorAll('.row')) show(r, true);
    }
    // The fold shows while a query finds someone inside it, and goes back to how it was after.
    const fold = $('[data-role="fold"]');
    if (fold) show(fold, !q || [...fold.querySelectorAll('.row')].some((r) => !r.hidden));
    syncFold();
    for (const list of LISTS.map($)) {
      const none = list.querySelector('[data-role="no-match"]');
      if (none) none.remove();
      const items = list.querySelectorAll(':scope > .row, :scope > .guild, :scope > .fold');
      if (q && items.length && [...items].every((el) => el.hidden)) {
        // A DM that isn't open (and isn't a friend's) isn't in the list at all: say how to bring it.
        const words = list.dataset.role === 'dm-list' ? `No DMs match “${iso(typed)}”~ closed it? Open it in Discord, then press ↻` : `No chats match “${iso(typed)}”~`;
        list.append(h('div', { class: 'list-empty', 'data-role': 'no-match', text: words }));
      }
      rove(list);
    }
  }

  // Keystrokes in the filter land once a frame.
  let filterFrame = 0;
  function onFilterInput(e) {
    state.filter = e.target.value;
    if (filterFrame) return;
    filterFrame = requestAnimationFrame(() => { filterFrame = 0; applyFilter(); });
  }

  function selectAllDMs(checked) {
    for (const row of state.batchRows.values()) {
      if (row.kind === 'guild' || row.protected || !row.box || row.el.hidden) continue;
      if (checked && row.needsDM) continue; // "All" means chats you already have; friends are opt-in
      tickRow(row, checked);
    }
    selectionChanged();
  }

  function selectionChanged() {
    if (lastEnd && lastEnd.key === 'batch') lastEnd = null;
    // Every chat left from last time unticked: the journal has nothing more to keep.
    if (journal && journal.keys && !run.active && !journal.keys.some((k) => state.selected.has(k))) {
      journal = null;
      storeJournal(null);
    }
    renderHero();
    renderActions(); // which brings the servers' boxes and the fold up to date
  }

  // Numbers a screen reader would otherwise hear bare: 'Many chats 4 selected', 'Purify selected 4 chats'.
  function speakCounts(rows) {
    $('[data-role="tab-badge-sr"]').hidden = !rows.length;
    const one = state.tab === 'current' ? !!state.target && counts.get(state.target.channelId) === 1 : rows.length === 1;
    const unit = state.tab === 'current' ? (one ? ' message' : ' messages') : (one ? ' chat' : ' chats');
    $('[data-role="purify-unit"]').textContent = $('[data-role="purify-count"]').hidden ? '' : unit;
  }

  // ── List keyboard ───────────────────────────────────────
  // Each list is one Tab stop, so 129 DMs no longer cost 265 presses to get past. Up and Down walk
  // its lines (keeping to the row's shield, or a server's name, when the next line has one), Home
  // and End jump to either end, Right goes along a line and into a server, Left comes back out or
  // folds the server up. Ticking still takes its own Space or click: moving never selects.
  const CONTROLS = '.check, .shield-btn, .guild-head, .fold-head';
  // A server and the friends' fold open the same way: a head line, then the lines inside it.
  const GROUP = '.guild, .fold';
  const INNER = '.guild-channels, .fold-rows';

  // Shown within its list (the list's own view may be hidden: it is still that list's Tab stop).
  function shownIn(list, el) {
    for (let node = el; node && node !== list; node = node.parentElement) if (node.hidden) return false;
    return true;
  }

  const LINES = '.row, .guild-bar, .fold-bar';
  const linesOf = (list) => Array.from(list.querySelectorAll(LINES)).filter((line) => shownIn(list, line));
  const lineOf = (control) => control.closest(LINES);
  const controlsOf = (line) => Array.from(line.querySelectorAll(CONTROLS));
  const lineKey = (line) => line.dataset.key || `g:${line.parentElement.dataset.guildId}`;

  // The control a list gives Tab, remembered by line and column so it survives the list being redrawn.
  const roving = new Map(); // list's data-role → { key, col }

  // Unvisited, a list starts on its first checkbox rather than Bardo's shield, so a reflex Space
  // ticks a chat instead of lifting a shield.
  function rove(list) {
    if (!list) return;
    const lines = linesOf(list);
    const spot = roving.get(list.dataset.role);
    const kept = spot && lines.find((line) => lineKey(line) === spot.key);
    const line = kept || lines.find((l) => l.querySelector('.check')) || lines[0];
    const cols = line ? controlsOf(line) : [];
    const keep = cols[kept ? Math.min(spot.col, cols.length - 1) : 0];
    for (const control of list.querySelectorAll(CONTROLS)) control.tabIndex = control === keep ? 0 : -1;
  }

  function onListFocus(e) {
    const control = e.target.closest(CONTROLS);
    if (!control) return;
    const list = e.currentTarget;
    const line = lineOf(control);
    roving.set(list.dataset.role, { key: lineKey(line), col: controlsOf(line).indexOf(control) });
    for (const other of list.querySelectorAll(CONTROLS)) other.tabIndex = other === control ? 0 : -1;
    // Keys bring the whole line into view, clear of the sticky strip (scroll-padding). A press doesn't:
    // scrolling under the pointer would move the line away and lose the click.
    if (control.matches(':focus-visible')) line.scrollIntoView({ block: 'nearest' });
  }

  function onListKey(e) {
    const control = e.target.closest(CONTROLS);
    if (!control || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = e.currentTarget;
    const lines = linesOf(list);
    const line = lineOf(control);
    const at = lines.indexOf(line);
    const cols = controlsOf(line);
    const col = cols.indexOf(control);
    const inColumn = (target, c) => { const all = target ? controlsOf(target) : []; return all[Math.min(c, all.length - 1)]; };
    const isHead = control.matches('.guild-head, .fold-head');
    const open = isHead && control.getAttribute('aria-expanded') === 'true';
    let to = null;
    if (e.key === 'ArrowDown') to = inColumn(lines[at + 1], col);
    else if (e.key === 'ArrowUp') to = inColumn(lines[at - 1], col);
    else if (e.key === 'Home') to = inColumn(lines[0], 0);
    else if (e.key === 'End') to = inColumn(lines[lines.length - 1], 0);
    else if (e.key === 'ArrowRight') {
      const child = lines[at + 1] && lines[at + 1].closest(INNER) && lines[at + 1].closest(GROUP) === line.closest(GROUP) ? lines[at + 1] : null;
      if (cols[col + 1]) to = cols[col + 1];
      else if (isHead && !open) control.click();
      else if (open) to = inColumn(child, 0);
    } else if (e.key === 'ArrowLeft') {
      if (open) control.click();
      else if (col > 0) to = cols[col - 1];
      else if (line.closest(INNER)) to = line.closest(GROUP).querySelector('.guild-head, .fold-head');
    } else return;
    e.preventDefault();
    if (to) to.focus({ preventScroll: true }); // onListFocus brings its whole line into view
  }

  // A chat Discord won't let you read or delete in: another go can't change that.
  const accessError = (row) => row.status === 'error' && plainError(row.reason).blocking;

  // A chat counted at nothing of yours (and not still being indexed): purifying it would do nothing.
  const emptyChat = (r) => !!r.channelId && counts.get(r.channelId) === 0 && !isPartialCount(r.channelId);

  // The picked chats Purify really goes through: not the ones counted empty, nor the ones Discord
  // won't let you into. The strip, the dialog and the run all count these.
  const purifyTargets = (rows) => rows.filter((r) => !accessError(r) && !emptyChat(r));

  // Only what's left stays ticked. A Count unticks the chats Discord won't let you into (they keep
  // '✗ no access'), and all-clear chats stay picked so the strip can say so. After a batch (no rows
  // given) the finished and empty chats untick too, so Purify never offers a finished chat again.
  // Rows keep their pills, so the outcome stays readable. Partial, indexing, stopped and
  // done-with-failures rows stay ticked.
  function settleBatchSelection(rows = null) {
    const ended = !rows;
    for (const row of rows || [...state.runTargets, ...selectedRows()]) {
      if (!row.row || !row.box) continue;
      if (accessError(row) || (ended && ((row.status === 'done' && !row.failed) || emptyChat(row)))) {
        state.selected.delete(row.key);
        row.box.checked = false;
        row.el.classList.remove('is-selected');
      }
    }
    syncGuildChecks();
  }

  // The running chat stays in view as a batch moves down the list, unless the person moved
  // around the list themselves in the last few seconds.
  let lastUserScroll = -Infinity;
  function revealRow(target) {
    if (target.el && performance.now() - lastUserScroll > 4000) target.el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // A long purge says how it's going now and then, to screen readers only: past 25, 50 and 75 %,
  // at most once a minute. A total that is still a floor (chats not counted yet) stays quiet.
  const milestone = { next: 25, at: -Infinity };

  function resetMilestones() {
    milestone.next = 25;
    milestone.at = -Infinity;
    $('[data-role="milestone"]').textContent = '';
  }

  function speakProgress(p) {
    if (!p.total || p.partial) return;
    const done = p.deleted + p.failed + (p.gone || 0);
    const passed = Math.floor((done / p.total) * 4) * 25;
    const now = performance.now();
    if (passed < milestone.next || passed >= 100 || now - milestone.at < 60000) return;
    milestone.next = passed + 25;
    milestone.at = now;
    const failed = p.failed ? ` · ${fmt(p.failed)} failed` : '';
    const left = p.etaSeconds != null ? ` · about ${formatDuration(p.etaSeconds)} left` : '';
    $('[data-role="milestone"]').textContent = `${Math.floor((done / p.total) * 100)}% · ${fmt(p.deleted)} of ${fmt(p.total)} purged${failed}${left}`;
  }

  // How a run that finished while minimised ended, for the orb and screen readers: a clean finish by
  // its number, any other by its verdict.
  function endingWords(p) {
    const clean = state.orbDone && state.orbDone.clean && lastEnd && !lastEnd.failed;
    if (clean) return { clean, title: `All clean~ ${fmt(p.deleted)} purged`, said: `all clean, ${fmt(p.deleted)} purged` };
    const text = lastEnd ? lastEnd.text : '';
    return { clean, title: text, said: text };
  }

  // After the main end handler: minimised, the region says how it ended (the panel isn't there to);
  // open, it empties, so no stale milestone outlives the verdict.
  function wireMilestone() {
    on('end', (p) => {
      const minimised = $('[data-role="shell"]').hidden;
      $('[data-role="milestone"]').textContent = minimised && state.orbDone ? `Dopa's Purifier: ${endingWords(p).title}` : '';
    });
  }

  // ── Tabs ────────────────────────────────────────────────

  // A tab switch glides the panel's height instead of cutting it (Arrow, Home and End can switch twice
  // in one glide, so a glide still running hands over from where it is). Opening a list too long to
  // lay out every frame (a heavy account's) cuts instead: a glide that drops frames is worse than none.
  let tabGlide = null;
  const GLIDE_ROWS = 300;

  function switchTab(tab, { initial = false } = {}) {
    const changed = tab !== state.tab;
    if (changed) cancelCount();
    const panel = $('.panel');
    const glide = !initial && changed && !reducedMotion() && !$('[data-role="layer"]').dataset.dragging && !panel.closest('[hidden]')
      && !(tab === 'batch' && state.batchRows.size > GLIDE_ROWS);
    const from = glide ? panel.offsetHeight : 0;
    if (tabGlide) { tabGlide.cancel(); tabGlide = null; }
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
      if (!state.dmsLoaded && !state.dmsLoading) loadDMs();
      if (!state.guildsLoaded && !state.guildsLoading) loadServers();
    }
    if (!initial && changed) $('[data-role="body"]').animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
    renderCurrent();
    layoutPanel();
    const to = glide ? panel.offsetHeight : 0;
    if (glide && Math.abs(to - from) > 1) {
      tabGlide = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' });
      const done = tabGlide;
      done.finished.then(() => { if (tabGlide === done) tabGlide = null; }, () => {});
    }
  }

  // ── Confirm dialog (hold to confirm) ────────────────────

  const HOLD_MS = 850;
  const ARMED_MS = 15000; // how long a first assistive press waits for the second (a switch user needs time)
  const TAP_MS = 250; // a release sooner than this was a tap, not a change of mind
  const SLOP_PX = 12; // how far a finger or pen may drift off the button and still be holding it
  let modal = null; // { onConfirm, restoreFocus, label, openedAt, armed, channelId }
  let dialogTimer = 0;

  // The hold button's words, each a [text, flair] pair (the line's one emoji, unspoken). The two long
  // ones are set smaller; the let-go wraps to "Let go~" over the outcome.
  const HOLD_WORDS = {
    holding: ['Keep holding~'],
    sealed: ['Purifying~', '♡'],
    tap: ['Hold it down~', '♡'],
    letGo: ['Let go~ nothing purged', '♡'],
    armed: ['Press again to purify~'],
  };
  function holdLabel(words) {
    const label = $('[data-role="confirm-label"]');
    label.classList.toggle('is-long', words === HOLD_WORDS.letGo || words === HOLD_WORDS.armed);
    label.replaceChildren(...flaired(...words));
  }

  // While the dialog is up nothing behind it can be reached, by Tab or by a screen reader's browse mode.
  const behindDialog = () => [$('[data-role="shell"]'), $('.term'), $('.orb')];

  // The whole name, however long: it wraps instead of trailing off, at the moment it matters most.
  function targetPill(t) {
    return h('div', { class: 'pill', id: 'dp-modal-pill' },
      h('span', { class: 'pill-glyph', 'aria-hidden': 'true' }, t.guildId ? '#' : (t.kind === 'group' ? icon('group') : '@')),
      h('span', { class: 'pill-name', text: t.guildId ? t.name.replace(/^#/, '') : t.name }),
      // A real space: it is read aloud as a pause, and a long name can break there before the server.
      t.guildId && t.context ? [' ', h('span', { class: 'pill-context', text: `· ${t.context}` })] : null);
  }

  // A purge that takes a while says so at the moment you commit to it: how long, and that Discord has
  // to stay open. What you send meanwhile is safe, since a run never touches messages newer than the
  // moment you confirmed (run.capId).
  const LONG_PURGE_S = 120;
  const KEEP_OPEN = "keep Discord open~ messages you send now aren't touched";
  const longPurge = (n, more = false) => (n > 0 && estimateSeconds(n) >= LONG_PURGE_S ? { seconds: estimateSeconds(n), more } : null);

  // channelId: the chat a This chat dialog asks about. Moving to another chat closes it (see navigated);
  // a Many chats dialog has none and stays.
  // time: { seconds, more } for a long purge (see longPurge), said between who and the warning.
  function confirmDialog({ title, lead, pill, list, listLabel, who, time = null, confirmLabel, onConfirm, channelId = null }) {
    if (modal) return;
    const layer = $('.modal-layer');
    $('[data-role="modal-title"]').textContent = title;
    $('[data-role="modal-text"]').replaceChildren(...[
      h('p', { class: 'modal-lead', id: 'dp-modal-lead' }, lead),
      pill && targetPill(pill),
      list && h('div', { class: 'modal-list', role: 'list', 'aria-label': listLabel || plural(list.length, 'chat'), tabindex: '0' },
        list.map((item) => (item instanceof Node ? item : h('div', { class: 'modal-item', role: 'listitem' },
          h('span', { class: 'modal-item-name', title: item.label, text: item.label }),
          h('span', { class: `modal-item-meta${item.tone ? ` is-${item.tone}` : ''}`, text: item.meta }))))),
      who && h('div', { class: 'modal-who', id: 'dp-modal-who' }, 'deleting as ', h('b', { text: `@${who}` })),
      time && h('div', { class: 'modal-time', id: 'dp-modal-time' }, `About ${formatDuration(time.seconds)}${time.more ? '+' : ''}${SEP}${KEEP_OPEN}`),
      h('div', { class: 'modal-warn', id: 'dp-modal-warn' }, h('span', {}, flaired("This can't be undone", '🩸'))),
    ].filter(Boolean));
    const modalEl = $('.modal');
    const described = (modalEl.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== 'dp-modal-time');
    if (time) described.splice(Math.max(0, described.indexOf('dp-modal-warn')), 0, 'dp-modal-time');
    modalEl.setAttribute('aria-describedby', described.join(' '));
    modal = { onConfirm, restoreFocus: root.activeElement, label: confirmLabel, openedAt: performance.now(), armed: 0, channelId };
    hold.pointer = false;
    hold.sealed = false;
    clearTimeout(dialogTimer);
    delete layer.dataset.sealed;
    $('[data-act="confirm"]').classList.remove('is-sealed');
    layer.hidden = false;
    layer.dataset.open = 'true';
    layer.scrollTop = 0;
    resetHold();
    for (const el of behindDialog()) el.inert = true;
    $('[data-act="cancel"]').focus();
    // Once the dialog has faded in (160 ms), while it is read and long before the earliest commit
    // (HOLD_MS after a press): the commit then only plays.
    clearTimeout(sound.primeTimer);
    sound.primeTimer = setTimeout(primeSound, 240);
  }

  function closeDialog(confirmed) {
    if (!modal) return;
    const { onConfirm, restoreFocus } = modal;
    clearTimeout(modal.armed);
    modal = null;
    for (const el of behindDialog()) el.inert = false;
    $('[data-role="modal-live"]').textContent = '';
    const layer = $('.modal-layer');
    // A finished hold keeps its full bar while the dialog fades: the last thing seen is the seal,
    // never a drain that reads as a cancel.
    const sealed = confirmed && hold.sealed;
    if (sealed) layer.dataset.sealed = 'true';
    else resetHold();
    layer.dataset.open = 'false';
    clearTimeout(dialogTimer);
    dialogTimer = setTimeout(() => {
      if (!modal) layer.hidden = true; // a dialog opened meanwhile keeps its layer
      delete layer.dataset.sealed;
      $('[data-act="confirm"]').classList.remove('is-sealed');
      hold.sealed = false;
      resetHold();
    }, sealed ? 240 : 160);
    if (confirmed) {
      handFocus('[data-act="pause"]'); // the run's own controls take over from the hold
      onConfirm();
    } else if (restoreFocus && restoreFocus.focus) restoreFocus.focus();
  }

  // key: the key (Space or Enter) holding the button down, until it is released.
  const hold = { start: 0, timer: 0, words: 0, active: false, sealed: false, nudge: 0, pointer: false, anim: null, key: null };

  function resetHold() {
    clearTimeout(hold.timer);
    clearTimeout(hold.words);
    clearTimeout(hold.nudge);
    hold.active = false;
    if (hold.anim) { hold.anim.cancel(); hold.anim = null; }
    $('[data-act="confirm"]').classList.remove('is-holding');
    delete $('[data-role="confirm-label"]').dataset.nudge;
    if (modal) holdLabel(modal.armed ? HOLD_WORDS.armed : modal.label);
  }

  // The fill is a compositor animation, so it flows even while Discord keeps the page busy. The
  // commit is timed on the clock, not on frames, so it lands at HOLD_MS however slowly they come.
  function beginHold() {
    if (!modal || hold.active || hold.sealed) return;
    resetHold();
    hold.active = true;
    hold.start = performance.now();
    const btn = $('[data-act="confirm"]');
    btn.classList.add('is-holding');
    // The fill moves from the first frame; the words change only once it's a hold, so a tap reads as
    // one change ('Hold it down~'), never three.
    hold.words = setTimeout(() => { if (hold.active) holdLabel(HOLD_WORDS.holding); }, TAP_MS);
    hold.anim = $('.hold-fill').animate([{ transform: 'translateX(-100%)' }, { transform: 'translateX(0)' }],
      { duration: HOLD_MS, easing: 'linear', fill: 'forwards' });
    const commit = () => {
      if (!hold.active) return;
      const left = HOLD_MS - (performance.now() - hold.start);
      if (left > 0) { hold.timer = setTimeout(commit, left); return; }
      hold.anim.finish(); // full now, even if the last frame of the fill hasn't been drawn yet
      hold.active = false;
      hold.sealed = true;
      btn.classList.add('is-sealed');
      holdLabel(HOLD_WORDS.sealed);
      closeDialog(true);
    };
    hold.timer = setTimeout(commit, HOLD_MS);
  }

  // Let go too soon. A quick tap is taught the gesture with a nudge; any other early end (a let-go,
  // a slide-off, a blur, a hidden tab) just says nothing went. The bar drains from where it really is.
  function endHold(e) {
    if (!hold.active) return;
    const tap = performance.now() - hold.start < TAP_MS && !!e && (e.type === 'pointerup' || e.type === 'keyup');
    const fill = $('.hold-fill');
    if (hold.anim) {
      try { hold.anim.commitStyles(); } catch { /* not rendered: nothing to drain */ }
      hold.anim.cancel();
      hold.anim = null;
    }
    resetHold();
    void fill.offsetWidth; // settle on the committed spot, so the drain transition starts there
    fill.style.transform = '';
    holdLabel(tap ? HOLD_WORDS.tap : HOLD_WORDS.letGo);
    if (tap) {
      const label = $('[data-role="confirm-label"]');
      void label.offsetWidth; // restart the shake on a quick second tap
      label.dataset.nudge = 'true';
    }
    hold.nudge = setTimeout(resetHold, 1400);
  }

  // Screen readers, voice control and switches can't hold, so for them two presses confirm. Their
  // press is a click no pointer went down for: detail 0 in Chromium, detail 1 but no pointerdown
  // in Firefox. Mouse, pen and touch clicks always follow a pointerdown and still need the hold.
  // Arming and its lapse are spoken, since only the button's name changes otherwise.
  function pressConfirm() {
    if (!modal || hold.active || hold.sealed) return;
    if (modal.armed) { closeDialog(true); return; }
    const live = $('[data-role="modal-live"]');
    modal.armed = setTimeout(() => {
      if (!modal) return;
      modal.armed = 0;
      live.textContent = 'Disarmed. Nothing was purged.';
      if (!hold.active) resetHold();
    }, ARMED_MS);
    live.textContent = `Armed — press again within ${ARMED_MS / 1000} seconds to purify, or Esc to cancel.`;
    resetHold();
  }

  // Tab cycles Never mind → Hold → the list of chats (to read it through) and back; from anywhere
  // else in the dialog it starts at the safe choice.
  function trapFocus(e) {
    if (!modal || e.key !== 'Tab') return;
    const items = [$('[data-act="cancel"]'), $('[data-act="confirm"]'), $('.modal-list')].filter(Boolean);
    const i = items.indexOf(root.activeElement);
    e.preventDefault();
    items[i < 0 ? 0 : (i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
  }

  // ── Terminal log ────────────────────────────────────────

  const LOG_LIMIT = 800;
  const LOG_PREFIX = { success: '♡', error: '✗', warn: '⚠', info: '›', skip: '·' };
  // Only the marks that carry meaning are read, as words; the rest are decoration.
  const SAID_PREFIX = { error: 'Error', warn: 'Warning' };

  function linePrefix(tone, text) {
    return SAID_PREFIX[tone] ? h('span', { class: 'line-pfx', role: 'img', 'aria-label': SAID_PREFIX[tone] }, h('span', { 'aria-hidden': 'true', text }))
      : h('span', { class: 'line-pfx', 'aria-hidden': 'true', text });
  }

  function bannerLine(text) {
    return h('div', { class: 'line banner' }, linePrefix('banner', '>'), h('span', { class: 'line-msg', text }));
  }

  function logBanner() {
    return [
      bannerLine('wake up, princess~'),
      bannerLine(`dopa-os v${VERSION} · loading heart.sys · dagger.dll`),
      bannerLine(`immune · ${immuneSummary()}`),
      bannerLine('♡ SYSTEM ONLINE ♡'),
      bannerLine('AWAITING ORDERS, PRINCESS~'),
      h('div', { class: 'line banner rule', 'aria-hidden': 'true' }, h('span', { class: 'line-pfx', text: '>' }), h('span', { class: 'line-msg', text: '♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡♡' })),
      h('div', { class: 'line prompt', 'data-role': 'prompt' },
        h('span', { class: 'prompt-who', text: 'dopa@mainframe' }),
        h('span', { class: 'prompt-sep', 'aria-hidden': 'true', text: ' ♡ ' }),
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

  // wrap: a line worth reading whole (a link to copy) wraps instead of ending in an ellipsis.
  function addLog(text, tone = 'info', { scrub, wrap = false } = {}) {
    const body = $('[data-role="term-body"]');
    const pinned = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    const time = new Date().toTimeString().slice(0, 8);
    const line = h('div', { class: `line ${tone}${wrap ? ' wrap' : ''}` },
      h('span', { class: 'line-time', text: time }),
      linePrefix(tone, LOG_PREFIX[tone] || '›'),
      h('span', { class: 'line-msg', text }));
    if (scrub) line.dataset.scrub = scrub;
    body.insertBefore(line, $('[data-role="prompt"]'));
    const lines = body.querySelectorAll('.line:not(.banner):not(.prompt)');
    if (lines.length > LOG_LIMIT) lines[0].remove();
    if (pinned) body.scrollTop = body.scrollHeight;
  }

  function preview(msg, max = 56) {
    const text = (msg.content || '').replace(/\s+/g, ' ').trim();
    if (!text) return msg.attachments && msg.attachments.length ? '[attachment]' : '[sticker or embed]';
    const chars = [...text];
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
  }

  // The log boots in and fades out the way it came; opening it again mid-fade keeps it.
  let logExit = null;

  function toggleLog(force) {
    const term = $('.term');
    const isOpen = !term.hidden && !logExit;
    const open = force != null ? force : !isOpen;
    $('[data-act="logs"]').setAttribute('aria-pressed', String(open));
    if (open) {
      if (logExit) {
        logExit.cancel();
        logExit = null;
        delete term.dataset.leaving;
        placeTerminal();
      } else if (term.hidden) {
        term.hidden = false;
        placeTerminal();
        term.dataset.boot = 'true';
        setTimeout(() => { delete term.dataset.boot; }, 400);
      }
      const body = $('[data-role="term-body"]');
      body.scrollTop = body.scrollHeight;
    } else if (isOpen) {
      term.dataset.leaving = 'true'; // clicks go through it to whatever is underneath
      unplaceTerminal();
      const exit = term.animate(reducedMotion() ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px) scale(.985)' }], { duration: 140, easing: 'cubic-bezier(.4,0,1,1)' });
      logExit = exit;
      exit.finished.then(() => {
        if (logExit !== exit) return;
        logExit = null;
        delete term.dataset.leaving;
        term.hidden = true;
        unplaceTerminal();
        applyFocus();
      }, () => {});
    }
    applyFocus();
  }

  // The log sits beside the panel, on whichever side has room for it, narrowed to fit and as tall as
  // the panel. With no room on either side it becomes a sheet over the panel's body, above its
  // footer, so Pause, Stop, Logs and the status stay uncovered; what it covers can't be reached.
  const UNDER_SHEET = ['.head', '.tabs', '[data-role="body"]', '[data-role="welcome"]'];

  function sheetCovers(on) {
    const welcome = $('[data-role="welcome"]');
    const welcoming = !welcome.hidden && !welcome.dataset.leaving;
    for (const sel of UNDER_SHEET) {
      const el = $(sel);
      // Lifting the sheet leaves the welcome's own cover where it was.
      el.inert = on || (welcoming && underWelcome().includes(el)) || (el === welcome && !!welcome.dataset.leaving);
    }
  }

  function placeTerminal() {
    const term = $('.term');
    if (term.hidden) return;
    const panelEl = $('.panel');
    const panel = panelEl.getBoundingClientRect();
    const gap = 14;
    const MIN = 280;
    const roomL = panel.left - gap - 8;
    const roomR = innerWidth - panel.right - gap - 8;
    let w;
    let left;
    let top;
    let hgt;
    if (roomL >= MIN || roomR >= MIN) {
      w = Math.min(380, roomL >= MIN ? roomL : roomR);
      left = roomL >= MIN ? panel.left - gap - w : panel.right + gap;
      // offsetHeight ignores the drag's tilt.
      hgt = clamp(panelEl.offsetHeight, 300, innerHeight - 16);
      top = clamp(panel.top, 8, Math.max(8, innerHeight - hgt - 8));
      if (term.hasAttribute('data-over')) {
        delete term.dataset.over;
        sheetCovers(false);
      }
    } else {
      const foot = $('.foot').getBoundingClientRect();
      w = panel.width;
      left = panel.left;
      top = panel.top;
      hgt = Math.max(120, foot.top - panel.top - 8);
      term.dataset.over = '';
      sheetCovers(true);
    }
    term.style.width = `${Math.round(w)}px`;
    term.style.height = `${Math.round(hgt)}px`;
    term.style.left = `${Math.round(left)}px`;
    term.style.top = `${Math.round(top)}px`;
  }

  // Closing the log lifts the sheet at once, and its size goes once it has faded.
  function unplaceTerminal() {
    const term = $('.term');
    if (term.hasAttribute('data-over')) sheetCovers(false);
    if (!term.hidden) return;
    delete term.dataset.over;
    term.style.height = '';
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

  const wob = { rot: new Spring(260, 24, 0), sx: new Spring(260, 15, 1), sy: new Spring(260, 15, 1), raf: 0, last: 0 };

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
      // Settled on a tilt (a drag held still mid-way) it stays there; only true rest clears it.
      const rest = wob.rot.target === 0 && wob.sx.target === 1 && wob.sy.target === 1;
      el.style.transform = rest ? '' : `rotate(${wob.rot.value.toFixed(3)}deg)`;
      wob.raf = 0;
    }
  }

  function kick({ spin = 0, squash = 0 } = {}) {
    if (reducedMotion()) return;
    wob.rot.velocity += spin;
    wob.sx.velocity += squash;
    wob.sy.velocity += -squash;
    if (!wob.raf) {
      wob.last = performance.now();
      wob.raf = requestAnimationFrame(animateWobble);
    }
  }

  // Kills are the panel's only clock: each one pops the count and pings the live dot (and in Many
  // chats, where the footer's line changes per kill, brings it in). Nothing else keeps time, so a wait
  // or a stall is visibly still. Every beat is a transform or an opacity, so the compositor plays it
  // and a long purge costs the page next to nothing.
  function popCount() {
    if (!fxVisible()) return;
    if (reducedMotion()) return;
    if (!run.paused && !run.stopping && state.runMode === 'batch') {
      $('[data-role="status-text"]').animate([{ opacity: 0.7 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
    }
    $('[data-role="count"]').animate([{ transform: 'scale(1.06)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.22,1,.36,1)' });
    const dot = $('.live-dot');
    if (dot.getClientRects().length) {
      dot.animate([{ transform: 'scale(1)', opacity: 0.6 }, { transform: 'scale(3)', opacity: 0 }],
        { duration: 600, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::after' });
    }
  }

  // A couple of drops fall from just outside the ring's leading edge, clear of the number.
  const fxVisible = () => !document.hidden && !$('[data-role="shell"]').hidden;

  function bleed() {
    const zone = $('.blood');
    if (reducedMotion() || !fxVisible() || !zone.getClientRects().length) return; // not drawn: Many chats, a strip
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
    const fx = $('[data-role="burst"]');
    if (!fxVisible() || !fx.getClientRects().length) return; // nowhere to see it: no exhale either
    kick({ squash: 0.35 }); // an exhale, not a jolt
    if (reducedMotion()) return;
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

  // Only a drag moves the remembered spot. Everything else clamps for display, so a window
  // that shrinks and grows back gets the panel back where it was.
  function placeShell(x, y, { remember = false } = {}) {
    const shell = $('[data-role="shell"]');
    const w = panelSize().w || 360; // hidden while minimised: measure as its real width
    const nx = clamp(x, 8, Math.max(8, innerWidth - w - 8));
    const ny = clamp(y, 8, Math.max(8, innerHeight - 120));
    shell.style.left = `${Math.round(nx)}px`;
    shell.style.top = `${Math.round(ny)}px`;
    layoutPanel();
    if (remember) {
      prefs.x = nx;
      prefs.y = parseFloat(shell.style.top); // where it settled once lifted to fit
    }
  }

  // The panel is docked to the side it was dragged nearer to, at the same gap from that edge, so a
  // window that grows keeps it where you left it. Never dragged: the right edge at any window size.
  function dockFor(x, y) {
    const w = panelSize().w || 360;
    const side = x + w / 2 > innerWidth / 2 ? 'right' : 'left';
    return { side, dx: side === 'right' ? innerWidth - x - w : x, y };
  }

  function homePosition() {
    if (!prefs.dock && prefs.x != null && prefs.y != null) {
      prefs.dock = dockFor(prefs.x, prefs.y); // a spot saved before docking, read once in this window
      savePrefs('dock');
    }
    const d = prefs.dock;
    if (!d) return defaultPosition();
    return { x: d.side === 'right' ? innerWidth - d.dx - (panelSize().w || 360) : d.dx, y: d.y };
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
    }
    const maxH = Math.max(240, innerHeight - top - 12);
    $('.panel').style.maxHeight = `${maxH}px`;
    // The height tier follows the real cap, and never reshapes under a drag. Natural heights: full
    // 532, snug 460 and strip 334 px, plus 18 for a chat name on two lines. Below the strip, tight
    // lets the strip scroll away so the rows and the card can be reached.
    const layer = $('[data-role="layer"]');
    if (!layer.dataset.dragging) {
      layer.dataset.fit = maxH >= 556 ? 'full' : maxH >= 482 ? 'snug' : 'strip';
      layer.toggleAttribute('data-tight', maxH < 330);
    }
    placeTerminal();
    placeOrb();
  }

  function defaultPosition() {
    return { x: innerWidth - (panelSize().w || 360) - 20, y: 56 };
  }

  // A drag begins after 3px of movement, so a click on the header never jiggles the panel or moves
  // its remembered spot. The tilt follows the hand gently; on release the spring swings back through
  // rest on its own.
  function makeDraggable() {
    const handle = $('[data-role="drag"]');
    const layer = $('[data-role="layer"]');
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const shell = $('[data-role="shell"]');
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: e.clientX - shell.offsetLeft, dy: e.clientY - shell.offsetTop, lastX: e.clientX, vx: 0, t: performance.now(), moved: false };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) return;
        drag.moved = true;
        layer.dataset.dragging = 'true';
        kick({ squash: -0.2 });
      }
      const now = performance.now();
      const dt = Math.max(1, now - drag.t);
      drag.vx = drag.vx * 0.6 + ((e.clientX - drag.lastX) / dt) * 16 * 0.4;
      drag.lastX = e.clientX;
      drag.t = now;
      placeShell(e.clientX - drag.dx, e.clientY - drag.dy, { remember: true });
      if (!reducedMotion()) {
        wob.rot.target = clamp(drag.vx * 0.25, -3.5, 3.5);
        kick();
      }
      // A hand that holds still levels the panel out gently, rather than at the next twitch.
      clearTimeout(drag.still);
      drag.still = setTimeout(() => { if (drag && drag.moved) { wob.rot.target = 0; kick(); } }, 80);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { moved, vx } = drag;
      clearTimeout(drag.still);
      drag = null;
      if (!moved) return;
      wob.rot.target = 0;
      kick({ squash: Math.min(0.25, Math.abs(vx) * 0.01) });
      delete layer.dataset.dragging;
      layoutPanel(); // the height tier waited for the drop
      prefs.dock = dockFor(prefs.x, prefs.y);
      savePrefs('dock');
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

  // Minimising folds the panel into the orb along one path, and restoring plays it back; a click
  // mid-way reverses what is running instead of starting over. With reduced motion the two
  // cross-fade in place.
  const DRAWER = 'cubic-bezier(.32, .72, 0, 1)';
  let fold = null; // { open, anims }: the fold in flight, settled when its last animation ends

  function foldAnimations(open, panel, orb) {
    if (reducedMotion()) {
      const fade = { duration: 150, easing: 'ease-out', fill: 'both' };
      return [panel.animate([{ opacity: open ? 0 : 1 }, { opacity: open ? 1 : 0 }], fade),
        orb.animate([{ opacity: open ? 1 : 0 }, { opacity: open ? 0 : 1 }], fade)];
    }
    // The panel shrinks into the orb's centre on the drawer curve, while its opacity follows the
    // clock: it holds for the first 35 % of the way, so the orb has appeared before it has gone.
    const pr = panel.getBoundingClientRect();
    const transformOrigin = `${parseFloat(orb.style.left) + 30 - pr.left}px ${parseFloat(orb.style.top) + 30 - pr.top}px`;
    const small = { transform: `scale(${(60 / pr.width).toFixed(3)})`, transformOrigin };
    const whole = { transform: 'none', transformOrigin };
    if (open) {
      return [panel.animate([small, whole], { duration: 320, easing: DRAWER, fill: 'both' }),
        panel.animate([{ opacity: 0 }, { opacity: 1, offset: 0.65 }, { opacity: 1 }], { duration: 320, fill: 'both' }),
        orb.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-out', fill: 'both' })];
    }
    return [orb.animate([{ transform: 'scale(.8)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, delay: 120, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' }),
      panel.animate([whole, small], { duration: 260, easing: DRAWER, fill: 'both' }),
      panel.animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], { duration: 260, fill: 'both' })];
  }

  function setOpen(open, { initial = false } = {}) {
    prefs.open = open;
    if (!initial) savePrefs('open');
    const shell = $('[data-role="shell"]');
    const orb = $('.orb');
    const layer = $('[data-role="layer"]');
    if (fold) {
      if (fold.open !== open) {
        fold.open = open;
        for (const a of fold.anims) a.reverse();
      }
      return;
    }
    const settle = () => {
      const now = fold ? fold.open : open;
      if (fold) for (const a of fold.anims) a.cancel();
      fold = null;
      shell.hidden = !now;
      orb.hidden = now;
      layer.dataset.open = String(now);
      applyFocus();
      if (now) renderHero(); // a finish that landed while minimised plays its beats now
    };
    if (open) {
      state.orbDone = null;
      $('[data-role="milestone"]').textContent = '';
      shell.hidden = false;
      const home = homePosition();
      placeShell(home.x, home.y);
      // Minimised, the panel rested: it reads the chat you're on now, and the lists you'd see.
      if (routeStale && !initial) {
        routeStale = false;
        refreshRoute();
        if (state.tab === 'batch') loadPendingLists();
      }
      applyFocus();
    } else {
      cancelCount();
      placeOrb();
      toggleLog(false);
    }
    if (initial) { settle(); return; }
    shell.hidden = false;
    orb.hidden = false;
    // The first animation is the one that ends last, either way round.
    fold = { open, anims: foldAnimations(open, $('.panel'), orb) };
    fold.anims[0].onfinish = settle;
  }

  function renderMute() {
    const btn = $('[data-act="mute"]');
    btn.replaceChildren(icon(prefs.muted ? 'muted' : 'sound'));
    // A toggle keeps one name; aria-pressed says which way it is.
    btn.setAttribute('aria-pressed', String(prefs.muted));
    btn.title = prefs.muted ? 'Unmute sound' : 'Mute sound';
  }

  // ── Welcome & share ─────────────────────────────────────

  // The card covers the tabs, body and footer, so Tab must not wander behind it. It takes focus
  // only from the bare page, never from Discord's message box.
  const underWelcome = () => [$('.tabs'), $('[data-role="body"]'), $('.foot')];

  function showWelcome() {
    $('[data-role="welcome"]').hidden = false;
    for (const el of underWelcome()) el.inert = true;
    if (document.activeElement === document.body) $('[data-act="welcome-ok"]').focus({ preventScroll: true });
  }

  // The card is gone for focus and clicks at once; it only fades for the eye, as it came in.
  function hideWelcome() {
    const w = $('[data-role="welcome"]');
    if (w.hidden || w.dataset.leaving) return;
    if (w.contains(root.activeElement)) handFocus('.tab[aria-selected="true"]');
    for (const el of underWelcome()) el.inert = false;
    w.dataset.leaving = 'true';
    w.inert = true;
    applyFocus();
    const gone = () => { w.hidden = true; w.inert = false; delete w.dataset.leaving; };
    w.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).finished.then(gone, gone);
    prefs.welcomed = true;
    savePrefs('welcomed');
  }

  async function shareLink() {
    const text = `Dopa's Discord Purifier — wipe your own Discord messages in a few clicks~ ✨ ${SHARE_URL}`;
    try {
      await navigator.clipboard.writeText(text);
      addLog(`share link: ${SHARE_URL}`, 'info');
      setStatus('Install link copied~ send it to a friend', 'success', { flair: '♡' });
    } catch {
      // Discord can lock the clipboard: the link waits in the log, whole, to select and copy.
      addLog(`share link: ${SHARE_URL}`, 'info', { wrap: true });
      setStatus("Couldn't copy~ the link is waiting in Logs", 'info', { flair: '♡' });
      toggleLog(true);
    }
  }

  // ── Run events → UI ─────────────────────────────────────

  // The last look over a counted chat, after its last message went: the card says so.
  const lastLook = () => run.active && !run.paused && state.runMode === 'current' && verifying();

  function wireRunEvents() {
    on('start', ({ targets }) => {
      $('[data-role="count"]').textContent = '0';
      setStatus(targets.length > 1 ? `Starting on ${plural(targets.length, 'chat')}~` : `Purging \u2068${targets[0].name}\u2069~`, 'info', { flair: '✨' });
      for (const t of targets) addLog(`queued: ${t.label || t.name}`, 'info');
      renderCurrent();
      renderActions();
    });
    on('target-start', ({ target, index, count }) => {
      setPrompt(`purge ${target.name}`);
      addLog(`── Starting: ${target.label || target.name} ──`, 'info');
      if (count > 1) setStatus(`Chat ${index + 1} of ${count}${SEP}\u2068${target.name}\u2069`, 'info');
      if (target.row) setRowState(target, 'running');
      revealRow(target);
    });
    on('dm-opened', ({ target, previousKey }) => {
      if (target.row) rekeyRow(target, previousKey);
      addLog(`opened a DM with ${target.name}`, 'info');
    });
    on('progress', (p) => {
      renderProgress(p);
      if (lastLook() !== $('[data-role="target"]').hasAttribute('data-checking')) renderCurrent();
    });
    on('kill', ({ target, msg }) => {
      ring.done++;
      // Kill feedback stays on the gauge; moving the whole panel would make Pause/Stop a moving target.
      popCount();
      bleed();
      addLog(`Deleted: "${preview(msg)}"`, 'success', { scrub: `Deleted ✓ ${target.name}` });
      if (!run.paused && !run.stopping) {
        if (state.runMode === 'batch') {
          const i = state.runTargets.indexOf(target) + 1;
          setStatus(`Chat ${i} of ${state.runTargets.length}${SEP}\u2068${target.name}\u2069${SEP}${fmt(target.deleted)} of ${target.planned ? fmt(target.planned) : '?'}`, 'info', { quiet: true });
        } else setStatus(`Deleted "${preview(msg, 34)}"`, 'info', { quiet: true, flair: '♡' });
      }
      if (target.row) setRowState(target, 'running');
    });
    on('fail', ({ target, msg, reason }) => {
      ring.fails.push(ring.done);
      ring.done++;
      const tags = [msg.pinned && 'pinned', msg.type && msg.type !== 0 && msg.type !== 19 && 'system'].filter(Boolean);
      addLog(`FAILED · ${shortReason(reason)}${tags.length ? ` · ${tags.join(', ')}` : ''} · "${preview(msg, 40)}"`, 'error');
      if (!run.paused && !run.stopping) setStatus(`Couldn't delete "${preview(msg, 24)}"${SEP}${shortReason(reason)}`, 'warn', { quiet: true });
      if (target.row) setRowState(target, 'running');
    });
    on('gone', ({ msg }) => {
      ring.done++;
      addLog(`already gone (${msg.id.slice(-6)}) — nothing to do`, 'skip');
    });
    on('account-changed', () => {
      if (modal) closeDialog(false);
      cancelCount();
      // A run the switch stopped keeps its verdict on screen; anything else was the old account's.
      const keepVerdict = lastEnd && lastEnd.error;
      if (!keepVerdict) lastEnd = null;
      state.runCounted.clear(); // the engine dropped every count
      state.selected.clear();
      state.batchRows.clear();
      state.dmsLoaded = false;
      state.guildsLoaded = false;
      dmSeq++; // what the old account was still fetching isn't ours to draw
      guildSeq++;
      state.dmsLoading = false;
      state.guildsLoading = false;
      state.route = null;
      $('[data-role="dm-list"]').replaceChildren(h('div', { class: 'list-empty', text: 'Finding your DMs…' }));
      $('[data-role="server-list"]').replaceChildren(h('div', { class: 'list-empty', text: 'Finding your servers…' }));
      addLog('switched Discord accounts — counts and lists reset', 'warn');
      if (!keepVerdict) setStatus('Switched Discord accounts~ count again', 'warn');
      if (state.tab === 'batch' && !run.active) { loadDMs(); loadServers({ refresh: true }); }
      // Re-read the chat without a fresh "Ready~": the switch notice (or the stopped run's error) stays.
      setTimeout(() => refreshRoute({ keepScan: true, keepStatus: true }), 0);
    });
    on('skip', ({ msg }) => addLog(`skipped a system message (type ${msg.type}) — Discord won't delete those`, 'skip'));
    on('wait', (w) => {
      showWait(w);
      addLog(waitText(w), 'warn');
    });
    on('log', ({ text, tone }) => addLog(text, tone));
    on('target-end', ({ target, ok, error, immune, midway, stopped, warn }) => {
      if (immune) addLog(midway ? `${target.name} was shielded in another tab — stopped purging there` : `${target.name} is immune — skipped`, 'warn');
      else if (ok || warn) addLog(`── Finished: ${target.label || target.name} (${fmt(target.deleted || 0)} purged) ──`, 'info');
      if (target.row) setRowState(target, immune ? 'immune' : ok ? 'done' : warn ? 'partial' : stopped ? 'stopped' : 'error', error || warn);
    });
    // What the person chose, and the run's own pace, are calm: no alarm badge.
    on('pause', (p) => {
      setStatus(`Paused~ ${fmt(p.deleted)} purged so far`, 'calm');
      renderCurrent();
      renderActions();
    });
    on('resume', () => {
      setStatus('Purging again~', 'info', { flair: '✨' });
      renderCurrent();
      renderActions();
    });
    on('stopping', () => {
      setStatus('Stopping after this one~', 'calm');
      renderActions();
    });
    // Each ending is said once: the readout gives the verdict, the footer confirms it or names the
    // next step, and the mood (renderHero) is the personality.
    on('end', (p) => {
      const fromRun = $('[data-role="run-actions"]').contains(root.activeElement);
      setPrompt('');
      for (const t of state.runTargets) if (t.row && (t.status === 'queued' || t.status === 'running')) setRowState(t, 'stopped');
      addLog('────────────────────', 'info');
      if (p.error) addLog(`STOPPED · ${plainError(p).short}`, 'error');
      else if (p.stopped) addLog('STOPPED by you · nothing after this point was touched', 'warn');
      addLog(`SUMMARY: ${fmt(p.deleted)} purged, ${fmt(p.failed)} failed${p.skipped ? `, ${p.skipped} system skipped` : ''}`, 'info');
      if (p.failures.length) {
        addLog('FAILED MESSAGES:', 'error');
        const shown = p.failures.slice(0, 50);
        shown.forEach((f, i) => addLog(`${i + 1}. ${shortReason(f.reason)}${f.msg.pinned ? ' · pinned' : ''} · "${preview(f.msg, 40)}"`, 'error'));
        if (p.failures.length > shown.length) addLog(`…and ${fmt(p.failures.length - shown.length)} more`, 'error');
      }
      scrubLog();
      const minimised = $('[data-role="shell"]').hidden;
      const purged = plural(p.deleted, 'message');
      const problems = p.problems || [];
      const shielded = p.shielded || [];
      const key = state.runKey;
      if (problems.length) {
        addLog(`NEEDS ANOTHER LOOK: ${problems.map((x) => `${x.target.name} (${shortReason(x.reason)})`).join(', ')}`, 'warn');
      }
      if (p.error) {
        const plain = plainError(p);
        if (plain.code === 'switched') {
          setStatus('Stopped to be safe~ you switched Discord accounts', 'warn');
          lastEnd = { key, text: `Stopped to be safe~ you switched accounts${SEP}${purged} purged${state.runAs ? ` as @${state.runAs}` : ''}`, tone: 'error', error: plain.code };
        } else {
          // A purge that broke off carries on with Purify; Try again is This chat's way to count.
          setStatus(plain.short, 'error');
          lastEnd = { key, text: plain.line.replace(/press Try again$/, 'press Purify to finish'), tone: 'error', error: plain.code };
        }
      } else if (p.stopped) {
        const handled = p.deleted + p.failed + (p.gone || 0);
        setStatus('Stopped~ Purify picks up the rest', 'calm');
        lastEnd = { key, text: p.total > 0 && !p.partial ? `Stopped at ${fmt(handled)} of ${fmt(p.total)}~` : `Stopped~ ${purged} purged`, tone: 'paused', stopped: true };
      } else if (problems.length) {
        const n = problems.length;
        const indexingOnly = problems.every((x) => /indexing/i.test(x.reason));
        setStatus(indexingOnly ? `${plural(n, 'chat')} need${n === 1 ? 's' : ''} another go later~ Discord is still indexing`
          : `${plural(n, 'chat')} skipped${SEP}${shortReason(problems[0].reason)}${n > 1 ? ' and more' : ''}${SEP}see Logs`, 'warn');
        lastEnd = { key, text: indexingOnly ? `Purged ${purged}${SEP}run again later for older ones` : `Purged ${purged}${SEP}${plural(n, 'chat')} skipped`, tone: 'warn', failed: p.failed, problems: n };
      } else if (shielded.length) {
        // Shielded from another tab mid-purge: what's left there stays on purpose, so no "all clean".
        const who = shielded.length === 1 ? `\u2068${shielded[0]}\u2069` : plural(shielded.length, 'chat');
        setStatus(`Done~ ${who} stays shielded`, 'immune');
        lastEnd = { key, text: `Purged ${purged}${SEP}${who} shielded midway`, tone: 'warn', failed: p.failed, shielded: shielded.length };
      } else if (p.failed) {
        setStatus(`Done~ ${fmt(p.failed)} wouldn't go${SEP}reasons in Logs`, 'warn');
        lastEnd = { key, text: `Purged ${fmt(p.deleted)}${SEP}${fmt(p.failed)} wouldn't go`, tone: 'warn', failed: p.failed, sticker: 'mostly clean~' };
        if (p.deleted > 0) lastEnd.confetti = true; // thrown with the finish's beats (renderHero)
      } else if (p.deleted) {
        setStatus(`Done in ${formatDuration(p.elapsedMs / 1000)}${SEP}0 failed`, 'success', { flair: '♡' });
        lastEnd = { key, text: 'All clean~ nothing left of you here', flair: '✨', tone: 'cheer', sticker: 'flawless~' };
        lastEnd.confetti = true; // thrown with the finish's beats (renderHero)
      } else {
        setStatus('Done~ nothing of yours was here', 'success');
        lastEnd = { key, text: 'All clear~ nothing of yours here', flair: '✨', tone: 'clear' };
      }
      // Minimised through the finish line: the orb carries the outcome until reopened.
      state.orbDone = minimised ? { clean: !p.error && !p.stopped && !problems.length && !shielded.length, tone: lastEnd.tone } : null;
      if (state.runMode === 'batch') settleBatchSelection();
      renderCurrent();
      renderActions();
      // Focus on Pause or Stop moves on to the next thing to press once they go.
      if (fromRun) {
        focusNext = ['[data-act="scan"]', '[data-act="go-batch"]'].find((sel) => !$(sel).hidden && !$(sel).disabled) || '.tab[aria-selected="true"]';
        applyFocus();
      }
      if (state.tab === 'batch') loadPendingLists();
    });
    on('end', () => {
      if (!protectionStale) return;
      protectionStale = false;
      protectionChanged({ keepVerdict: true });
    });
    on('start', resetMilestones);
    on('progress', speakProgress);
  }

  // The journal follows the run: a chat that finished leaves it, a reopened DM keeps its new key, and
  // the end decides what stays. A finished run keeps nothing; a deliberate Stop in Many chats keeps its
  // ticks quietly (in This chat, nothing); an error, a crash or the panel going away reads as cut short.
  function wireJournal() {
    on('dm-opened', ({ target, previousKey }) => {
      const at = journal && journal.keys ? journal.keys.indexOf(previousKey) : -1;
      if (at >= 0) journal.keys[at] = rowKey(target);
    });
    on('target-end', ({ target, ok, immune, error }) => {
      if (ok) state.runCounted.add(target.channelId); // the purge wrote this count, not a Count
      if (!journal || !journal.keys) return;
      if (immune || (ok && !target.failed) || (error && plainError(error).blocking)) {
        journal.keys = journal.keys.filter((k) => k !== rowKey(target));
        storeJournal(journal);
      }
    });
    on('end', ({ stopped, error }) => {
      freeRunLock();
      if (!journal || destroying) return;
      if (stopped && journal.mode === 'batch') journal.state = 'stopped';
      else if (stopped || !error) journal = null;
      if (journal && journal.keys && !journal.keys.length) journal = null;
      storeJournal(journal);
    });
  }

  function loadPendingLists() {
    if (run.active || state.scanning) return;
    if (!state.dmsLoaded && !state.dmsLoading) loadDMs();
    if (!state.guildsLoaded && !state.guildsLoading) loadServers({ refresh: true });
  }

  // ── Wiring ──────────────────────────────────────────────

  const TOGGLES = new Set(['pause', 'resume', 'stop', 'purify', 'scan', 'minimize', 'restore', 'logs', 'mute']);

  const ACTIONS = {
    scan: () => (state.scanning ? cancelScan() : state.tab !== 'current' ? scanSelected() : describeFailed() ? refreshRoute() : scanCurrent()),
    purify: () => (state.tab === 'current' ? askPurgeCurrent() : askPurgeSelected()),
    // Focus follows the work: the control that takes over from the one that goes gets focus.
    pause: () => { handFocus('[data-act="resume"]'); pauseRun(); },
    resume: () => { handFocus('[data-act="pause"]'); resumeRun(); },
    stop: () => { hushSound(); stopRun(); },
    logs: () => toggleLog(),
    'close-log': () => { handFocus('[data-act="logs"]'); toggleLog(false); },
    'copy-log': copyLog,
    minimize: () => { handFocus('.orb'); setOpen(false); },
    share: () => shareLink(),
    'welcome-ok': () => hideWelcome(),
    'welcome-batch': () => { switchTab('batch'); hideWelcome(); },
    'go-batch': () => { handFocus('.tab[data-tab="batch"]'); switchTab('batch'); },
    restore: () => { handFocus('[data-act="minimize"]'); setOpen(true); },
    mute: () => { prefs.muted = !prefs.muted; savePrefs('muted'); renderMute(); if (prefs.muted) hushSound(); },
    poke: () => {
      // Mid-run the panel holds still, so Pause and Stop never move under the pointer; Dopa still squashes.
      if (!run.active) kick({ spin: (Math.random() - 0.5) * 26, squash: 0.7 });
      const img = $('.avatar img');
      if (!reducedMotion()) img.animate([{ transform: 'scale(0.86, 1.12)' }, { transform: 'scale(1.08, 0.94)', offset: 0.45 }, { transform: 'none' }], { duration: 480, easing: 'cubic-bezier(.2,1.4,.4,1)' });
    },
    cancel: () => closeDialog(false),
    'dm-all': () => selectAllDMs(true),
    'dm-none': () => selectAllDMs(false),
    'dm-refresh': () => loadDMs(),
    'server-refresh': () => loadServers({ refresh: true }),
  };

  // Esc closes what focus is in (the dialog's own Esc goes first): the log hands focus back to
  // Logs, and the welcome card goes as if dismissed.
  function escapeFrom(el) {
    if (!el) return;
    if (el.closest('.term')) {
      handFocus('[data-act="logs"]');
      toggleLog(false);
    } else if (el.closest('[data-role="welcome"]')) hideWelcome();
  }

  function wire() {
    const layer = $('[data-role="layer"]');
    layer.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (tab) { switchTab(tab.dataset.tab); return; }
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
      if (btn.dataset.act === 'confirm') {
        const assistive = e.detail === 0 || !hold.pointer;
        hold.pointer = false;
        if (assistive) pressConfirm();
        return;
      }
      // A double-click must not flip a toggle twice (Pause→Resume) or open-then-dismiss a dialog.
      if (e.detail > 1 && TOGGLES.has(btn.dataset.act)) return;
      const fn = ACTIONS[btn.dataset.act];
      if (fn) fn();
    });
    // Tab keyboard model: arrows move between the two tabs; Home and End go to the first and last.
    $('.tabs').addEventListener('keydown', (e) => {
      const next = e.key === 'Home' ? 'current' : e.key === 'End' ? 'batch'
        : e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? (state.tab === 'current' ? 'batch' : 'current') : null;
      if (!next) return;
      e.preventDefault();
      switchTab(next);
      $(`.tab[data-tab="${next}"]`).focus();
    });
    const confirmBtn = $('[data-act="confirm"]');
    confirmBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      hold.pointer = true;
      confirmBtn.setPointerCapture(e.pointerId);
      beginHold();
    });
    // Capture keeps a release anywhere reaching endHold; sliding off (even onto Never mind) lets go.
    // A mouse is exact; a finger or pen may wander SLOP_PX. Letting go this way says so, and coming
    // back never resumes: a fresh press starts from empty.
    confirmBtn.addEventListener('pointermove', (e) => {
      if (!hold.active) return;
      const r = confirmBtn.getBoundingClientRect();
      const slop = e.pointerType === 'mouse' ? 0 : SLOP_PX;
      if (e.clientX < r.left - slop || e.clientX > r.right + slop || e.clientY < r.top - slop || e.clientY > r.bottom + slop) endHold();
    });
    confirmBtn.addEventListener('pointerup', endHold);
    confirmBtn.addEventListener('pointercancel', endHold);
    confirmBtn.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault(); // repeats too: a held key must never turn into bare clicks
      if (e.repeat) return;
      beginHold();
      if (hold.active) hold.key = e.key;
    });
    confirmBtn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') endHold(e); });
    confirmBtn.addEventListener('blur', endHold);
    // Coming back to the tab plays a finish's beats that landed while it was hidden.
    listen(document, 'visibilitychange', () => {
      if (document.hidden) endHold();
      else if (lastEnd && lastEnd !== beaten) renderHero();
    });
    // A key still held when the dialog goes (a finished hold, or Esc) belongs to that hold: its
    // repeats and its release must not press whatever focus moved to (Pause, or Purify again).
    for (const type of ['keydown', 'keypress', 'keyup']) {
      listen(document, type, (e) => {
        if (!hold.key || e.key !== hold.key) return;
        if (!modal) { e.preventDefault(); e.stopPropagation(); }
        if (type === 'keyup') hold.key = null;
      }, true);
    }
    listen(window, 'blur', () => { hold.key = null; }); // its release happened somewhere else
    // Esc keeps you safe even if focus wandered out of the dialog.
    listen(document, 'keydown', (e) => {
      if (modal && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(false); }
    }, true);
    root.addEventListener('keydown', (e) => {
      if (modal && e.key === 'Escape') { e.preventDefault(); closeDialog(false); }
      else if (e.key === 'Escape') escapeFrom(root.activeElement);
      trapFocus(e);
    });
    const modalLayer = $('.modal-layer');
    modalLayer.addEventListener('pointerdown', (e) => {
      if (!modal) return;
      if (e.target === modalLayer && e.offsetX >= modalLayer.clientWidth) return; // its scrollbar, not the backdrop
      if (e.target === modalLayer) {
        if (performance.now() - modal.openedAt > 350) closeDialog(false); // ignore the second half of a double-click
      } else if (!e.target.closest('button')) {
        $('.modal').focus(); // keep focus (and Esc/Tab) inside the dialog
      }
    });
    $('[data-role="filter"]').addEventListener('input', onFilterInput);
    for (const type of ['wheel', 'pointerdown', 'keydown']) {
      $('[data-role="body"]').addEventListener(type, () => { lastUserScroll = performance.now(); }, { passive: true });
    }
    listen(window, 'resize', () => {
      const home = homePosition();
      placeShell(home.x, home.y);
    });
    makeDraggable();
    wireRunEvents();
    wireJournal();
    wireMilestone();
  }

  // ── Init ────────────────────────────────────────────────

  let host = null;

  // Following Discord from chat to chat: the Navigation API says so within a few milliseconds, and a
  // poll (one string compare) backs it up, or does the job a little faster where there is no such API.
  // Minimised, the panel only notes where you went, and reads it when it opens.
  let lastPath = '';
  let routeStale = false;

  function navigated() {
    const was = routeTarget(lastPath);
    lastPath = location.pathname;
    const now = routeTarget();
    // A This chat dialog asks about one chat: moving to another closes it, as Never mind would.
    if (modal && modal.channelId && (!now || now.channelId !== modal.channelId)) {
      closeDialog(false);
      notes.moved = true;
      setStatus('Moved chats~ nothing purged', 'calm', { quiet: true }); // said aloud once the new chat is read
    }
    if (!prefs.open && !run.active) {
      if (was) state.leftSince.add(was.channelId);
      cancelCount();
      if (state.scanning && state.scanKind === 'current') cancelScan();
      routeStale = true;
      return;
    }
    refreshRoute();
    // Logging in on /login also arrives as an in-app navigation: lists that failed for want of a
    // token get another go.
    if (state.tab === 'batch') loadPendingLists();
  }

  function followRoute() {
    lastPath = location.pathname;
    const check = () => { if (location.pathname !== lastPath) navigated(); };
    if (window.navigation) listen(window.navigation, 'navigatesuccess', check);
    every(window.navigation ? 700 : 250, check);
    listen(window, 'popstate', check);
  }

  // A run cut short last time (a reload, a closed laptop, a crash) keeps its place. Many chats ticks
  // what it still had to do and says so; This chat says where to pick up. A deliberate Stop brings the
  // ticks back without a word. Nothing starts by itself: Purify still counts first and asks. Nothing
  // comes back for another account, after a day, or while another tab's run holds the lock (it may be
  // that very run).
  async function restoreJournal(saved, looked) {
    if (Math.abs(Date.now() - saved.at) > JOURNAL_TTL_MS) { storeJournal(null); return; }
    let me;
    try { me = await whoAmI(); } catch { return; }
    if (me.id !== saved.user) { storeJournal(null); return; }
    if (await runLockHeld()) return;
    await looked; // the chat on screen is known, so a note about it lands once
    if (run.active || starting || journal) return; // a run began meanwhile: the journal is its own now
    journal = saved;
    if (saved.mode === 'batch') {
      for (const key of saved.keys) {
        state.selected.add(key);
        const row = state.batchRows.get(key);
        if (row && row.box) {
          row.box.checked = true;
          row.el.classList.add('is-selected');
        }
      }
      for (const id of saved.guilds) restoredGuilds.add(id);
      openRestoredGuilds();
      if (saved.state === 'running' && saved.keys.length) notes.resume = { mode: 'batch', left: saved.keys.length };
      selectionChanged();
      loadPendingLists(); // the Many chats badge counts the ticks once their rows are drawn
    } else if (saved.state === 'running' && saved.chat) {
      notes.resume = { mode: 'current', chatId: saved.chat.id };
    }
    if (notes.resume && prefs.open && !run.active && !state.scanning && !state.counting && !modal) setStatus(...restingStatus());
  }

  function boot() {
    // One look at storage: prefs, shields and any journal together.
    const stored = withStorage((ls) => ({ prefs: readStored(ls), journal: readJournal(ls) }));
    loadPrefs(stored && stored.prefs);
    syncProtection(stored && stored.prefs);
    host = mount();
    wire();
    renderMute();
    clearLog();
    // Opened on a chat, the panel opens on that chat; elsewhere it remembers the last tab.
    switchTab(routeTarget() ? 'current' : prefs.tab, { initial: true });
    const pos = homePosition();
    placeShell(pos.x, pos.y);
    setOpen(prefs.open, { initial: true });
    // It arrives placed rather than dropped in: a short rise as it fades in (only the fade, reduced).
    if (prefs.open) {
      $('.panel').animate(reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'translateY(6px) scale(.985)' }, { opacity: 1, transform: 'none' }],
      { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
    renderProgress(progressSnapshot());
    if (!prefs.welcomed) showWelcome();
    // Minimised, it asks Discord nothing about the chat until it opens.
    let looked = Promise.resolve();
    if (prefs.open) looked = refreshRoute();
    else routeStale = true;
    followRoute();
    listen(window, 'storage', onStorage);
    if (stored && stored.journal) restoreJournal(stored.journal, looked);
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

  // Discord is still starting up when this runs: boot waits for a quiet moment, so the panel never adds
  // to Discord's own start (where there is no idle callback, the next task will do).
  function start() {
    whenAppReady(() => {
      if ('requestIdleCallback' in window) {
        const id = requestIdleCallback(boot, { timeout: 1500 });
        disposers.push(() => cancelIdleCallback(id));
      } else {
        const id = setTimeout(boot, 0);
        disposers.push(() => clearTimeout(id));
      }
    });
  }

  // Undo everything: stop a running purge, drop listeners and timers, remove the UI.
  function destroy() {
    destroying = true; // set first: a run ended this way reads as cut short in the journal, not as stopped
    if (run.active) {
      run.stopping = true;
      run.paused = false;
      run.controller.abort();
    }
    freeRunLock();
    if (state.scanAbort) state.scanAbort.abort();
    clearInterval(waitTick);
    for (const undo of disposers.splice(0)) {
      try { undo(); } catch { /* already gone */ }
    }
    cancelAnimationFrame(wob.raf);
    clearTimeout(hold.timer);
    clearTimeout(dialogTimer);
    clearTimeout(switchTimer);
    flushPrefs();
    clearTimeout(sound.primeTimer);
    if (sound.ctx) sound.ctx.close().catch(() => {});
    if (host) host.remove();
    host = null;
  }

  // For the BetterDiscord plugin, whose updates wait for a purge to finish: busy() while one runs, and
  // whenIdle() resolves when it ends.
  const idleWaiters = [];
  const whenIdle = () => (run.active ? new Promise((resolve) => { idleWaiters.push(resolve); }) : Promise.resolve());
  on('end', () => { for (const resolve of idleWaiters.splice(0)) resolve(); });

  return { start, destroy, busy: () => run.active, whenIdle };
