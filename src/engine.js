  // ── Discord session ─────────────────────────────────────

  // token: what requests use. boundToken: the token `me`, guilds and counts belong to.
  const session = { token: null, boundToken: null, me: null, guilds: null };

  // Discord deletes window.localStorage at startup, so read it through a fresh
  // same-origin iframe; if the app has lifted it out of storage, ask Discord's own
  // auth store via webpack. Never fire lifecycle events on Discord's window.
  function readStoredToken() {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    document.body.appendChild(frame);
    try {
      const raw = frame.contentWindow.localStorage.getItem('token');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    } finally {
      frame.remove();
    }
  }

  function readWebpackToken() {
    const chunks = window.webpackChunkdiscord_app;
    if (!chunks || typeof chunks.push !== 'function') return null;
    let token = null;
    try {
      chunks.push([[Symbol('dopa')], {}, (req) => {
        for (const mod of Object.values(req.c || {})) {
          const exp = mod && mod.exports;
          for (const candidate of [exp && exp.default, exp]) {
            if (!candidate || typeof candidate.getToken !== 'function') continue;
            try {
              const t = candidate.getToken();
              if (typeof t === 'string' && t) { token = t; return; }
            } catch { /* not the auth store */ }
          }
        }
      }]);
      chunks.pop();
    } catch { /* webpack shape changed */ }
    return token;
  }

  function currentToken() {
    const token = readStoredToken() || readWebpackToken();
    return typeof token === 'string' && token ? token : null;
  }

  function getToken() {
    if (!session.token) session.token = currentToken();
    return session.token;
  }

  // Discord's account switcher swaps accounts without reloading the page. Call this
  // before every scan, run and channel lookup: if the logged-in token changed, all
  // cached identity (and every count measured as the old account) is dropped.
  // A running purge never changes accounts: it is bound to the token that was
  // confirmed, and stops outright if the logged-in account changes under it.
  function syncAccount() {
    const token = currentToken();
    if (!token) return false;
    if (run.active) {
      if (token !== run.token && !run.accountSwitched) {
        run.accountSwitched = true;
        run.controller.abort();
      }
      return false;
    }
    if (token === session.token && (session.boundToken === null || token === session.boundToken)) return false;
    const switched = session.boundToken !== null && token !== session.boundToken;
    session.token = token;
    session.me = null;
    session.guilds = null;
    session.boundToken = null;
    if (switched) {
      counts.clear();
      partialCounts.clear();
      emit('account-changed', {});
    }
    return switched;
  }

  // ── HTTP ────────────────────────────────────────────────

  class DiscordError extends Error {
    constructor(status, body) {
      const base = body && body.message ? body.message : `HTTP ${status}`;
      super(body && typeof body.code === 'number' && body.code ? `${base} (code ${body.code})` : base);
      this.name = 'DiscordError';
      this.status = status;
      this.code = body && body.code != null ? body.code : null;
    }
  }

  class Stopped extends Error {
    constructor() { super('Stopped'); this.name = 'Stopped'; }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(new Stopped()); return; }
      const onAbort = () => { clearTimeout(timer); reject(new Stopped()); };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function readJson(res) {
    try { return await res.json(); } catch { return null; }
  }

  // Stop and Cancel drop a read at once. A DELETE or POST already sent is left to land, so
  // "after this one" and the counts stay true. The timeout bounds both: a dead connection
  // turns into a network error and takes the usual backoff instead of hanging for ever.
  async function boundedFetch(url, init, signal) {
    const ctl = new AbortController();
    const kill = () => ctl.abort();
    const linked = !!signal && init.method === 'GET';
    if (linked) signal.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, TIMING.requestTimeoutMs);
    try {
      // Read the body here too, so a server that stalls mid-answer is covered as well.
      const res = await fetch(url, { ...init, signal: ctl.signal });
      const body = await res.arrayBuffer();
      const empty = res.status === 204 || res.status === 205 || res.status === 304;
      return new Response(empty ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      clearTimeout(timer);
      if (linked) signal.removeEventListener('abort', kill);
    }
  }

  // One request with Discord's retry rules: 429 → wait retry_after, 202 (search
  // index still building) → wait and retry, 5xx/network/timeout → short backoff,
  // 401 → re-read the token once. Returns the final Response.
  async function request(path, { method = 'GET', body, signal, onWait, beforeRetry } = {}) {
    let authRetried = false;
    let networkFails = 0;
    let serverFails = 0;
    let indexWaits = 0;
    for (let attempt = 0; ; attempt++) {
      if (signal && signal.aborted) throw new Stopped();
      if (attempt && beforeRetry) await beforeRetry();
      const token = run.active && run.token ? run.token : getToken();
      if (!token) throw new DiscordError(401, { message: 'No Discord login token found — are you logged in?' });
      let res;
      try {
        res = await boundedFetch(API + path, {
          method,
          headers: body ? { Authorization: token, 'Content-Type': 'application/json' } : { Authorization: token },
          body: body ? JSON.stringify(body) : undefined,
        }, signal);
      } catch {
        if (signal && signal.aborted) throw new Stopped();
        if (++networkFails > 5) throw new DiscordError(0, { message: 'Network unreachable' });
        const seconds = 2 ** networkFails;
        if (onWait) onWait({ kind: 'network', seconds });
        await sleep(seconds * 1000, signal);
        continue;
      }
      if (res.status === 429) {
        const data = await readJson(res);
        const seconds = Number(data && data.retry_after) || Number(res.headers.get('retry-after')) || 5;
        if (onWait) onWait({ kind: 'rate', seconds, method });
        await sleep(seconds * 1000 + 150, signal);
        continue;
      }
      if (res.status === 202) {
        const data = await readJson(res);
        if (++indexWaits > 8) throw new DiscordError(202, { message: 'Discord is still indexing this channel — try again in a minute' });
        const seconds = Number(data && data.retry_after) || 2;
        if (onWait) onWait({ kind: 'index', seconds });
        await sleep(seconds * 1000, signal);
        continue;
      }
      if (res.status === 401 && !authRetried) {
        authRetried = true;
        if (run.active) {
          // Mid-run, a new token means a new account: stop rather than carry on as someone else.
          syncAccount();
          if (run.accountSwitched) throw new Stopped();
          return res;
        }
        syncAccount();
        session.token = currentToken();
        continue;
      }
      if (res.status === 400) {
        const data = await readJson(res.clone());
        if (data && data.captcha_key) throw new DiscordError(400, { message: 'Discord wants a captcha — finish it in the app, then try again', code: 'captcha' });
      }
      if (res.status >= 500 && ++serverFails <= 3) {
        const seconds = 2 ** serverFails;
        if (onWait) onWait({ kind: 'server', seconds });
        await sleep(seconds * 1000, signal);
        continue;
      }
      return res;
    }
  }

  async function getJson(path, opts) {
    const res = await request(path, opts);
    const data = await readJson(res);
    if (!res.ok) throw new DiscordError(res.status, data);
    return data;
  }

  // ── Lookups ─────────────────────────────────────────────

  async function whoAmI() {
    if (!session.me) {
      const token = getToken();
      session.me = await getJson('/users/@me');
      session.boundToken = token;
    }
    return session.me;
  }

  async function myGuilds({ refresh = false } = {}) {
    if (!session.guilds || refresh) session.guilds = await getJson('/users/@me/guilds');
    return session.guilds;
  }

  const listDMs = () => getJson('/users/@me/channels');
  const listRelationships = () => getJson('/users/@me/relationships');
  const openDM = (userId, opts) => getJson('/users/@me/channels', { ...opts, method: 'POST', body: { recipients: [userId] } });

  async function listTextChannels(guildId) {
    const channels = await getJson(`/guilds/${guildId}/channels`);
    const categories = new Map(channels.filter((c) => c.type === 4).map((c) => [c.id, c]));
    const rank = (c) => {
      const cat = categories.get(c.parent_id);
      return [cat ? cat.position : -1, c.position];
    };
    return channels
      .filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
      .sort((a, b) => {
        const [ca, pa] = rank(a);
        const [cb, pb] = rank(b);
        return ca - cb || pa - pb;
      })
      .map((c) => ({ ...c, categoryName: categories.has(c.parent_id) ? categories.get(c.parent_id).name : '' }));
  }

  function routeTarget() {
    const m = location.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
    if (!m) return null;
    return { guildId: m[1] === '@me' ? null : m[1], channelId: m[2] };
  }

  function dmTitle(channel) {
    if (channel.name) return channel.name;
    const names = (channel.recipients || []).map((r) => r.global_name || r.username);
    return names.length ? names.join(', ') : 'Unknown';
  }

  // Who is immune: the built-in names unless released, plus anyone shielded in the panel.
  const protection = { ids: new Set(), released: new Set() };

  function isProtectedUser(user) {
    if (!user) return false;
    if (protection.ids.has(user.id)) return true;
    const name = String(user.username || '').toLowerCase();
    return PROTECTED_USERNAMES.has(name) && !protection.released.has(name);
  }

  function setProtected(user, on) {
    const name = String(user.username || '').toLowerCase();
    if (on) {
      protection.ids.add(user.id);
      protection.released.delete(name);
    } else {
      protection.ids.delete(user.id);
      if (PROTECTED_USERNAMES.has(name)) protection.released.add(name);
    }
  }

  // Only one-to-one DMs can be immune; a group chat has other people's history in it too.
  const dmPartner = (channel) => (channel.type === 1 && channel.recipients ? channel.recipients[0] : null);
  const isProtectedChannel = (channel) => isProtectedUser(dmPartner(channel));

  // Resolve the channel the user is looking at into a purge target with a human label.
  async function describeRoute(route) {
    syncAccount();
    const channel = await getJson(`/channels/${route.channelId}`);
    if (!route.guildId) {
      return {
        channelId: channel.id,
        guildId: null,
        partner: dmPartner(channel),
        kind: channel.type === 3 ? 'group' : 'dm',
        name: dmTitle(channel),
        context: channel.type === 3 ? 'Group DM' : 'Direct message',
        protected: isProtectedChannel(channel),
      };
    }
    let guildName = '';
    try {
      const guild = (await myGuilds()).find((g) => g.id === route.guildId);
      guildName = guild ? guild.name : '';
    } catch { /* label only */ }
    return {
      channelId: channel.id,
      guildId: route.guildId,
      kind: 'guild',
      name: `#${channel.name || channel.id}`,
      context: guildName,
      protected: false,
    };
  }

  // ── Search & history ────────────────────────────────────

  const snowflake = (id) => BigInt(id);
  const oldestId = (messages) => messages.reduce((min, m) => (snowflake(m.id) < snowflake(min) ? m.id : min), messages[0].id);

  async function searchPage(target, authorId, { maxId, signal, onWait } = {}) {
    const params = new URLSearchParams({ author_id: authorId, sort_by: 'timestamp', sort_order: 'desc' });
    if (target.guildId) {
      params.set('channel_id', target.channelId);
      params.set('include_nsfw', 'true');
    }
    if (maxId) params.set('max_id', maxId);
    const path = target.guildId
      ? `/guilds/${target.guildId}/messages/search?${params}`
      : `/channels/${target.channelId}/messages/search?${params}`;
    const data = await getJson(path, { signal, onWait });
    const found = (data.messages || []).map((group) => group.find((m) => m.hit) || group[0]).filter(Boolean);
    return {
      total: Number(data.total_results) || 0,
      hits: found.filter((m) => m.author && m.author.id === authorId),
      cursor: found.length ? oldestId(found) : null,
      indexing: data.doing_deep_historical_index === true,
    };
  }

  async function historyPage(target, before, { signal, onWait } = {}) {
    const query = before ? `?limit=100&before=${before}` : '?limit=100';
    const page = await getJson(`/channels/${target.channelId}/messages${query}`, { signal, onWait });
    return Array.isArray(page) ? page : [];
  }

  // Count my deletable messages in a target. Search answers in one request; DMs
  // whose search is unavailable fall back to walking the whole history.
  async function countMine(target, { signal, onWait, onProgress, searchOnly = false } = {}) {
    if (!run.active) syncAccount();
    const me = await whoAmI();
    try {
      const { total, indexing } = await searchPage(target, me.id, { signal, onWait });
      if (signal && signal.aborted) throw new Stopped();
      if (indexing) partialCounts.add(target.channelId);
      else partialCounts.delete(target.channelId);
      return total;
    } catch (err) {
      if (err instanceof Stopped || err.status === 401 || err.code === 'captcha' || target.guildId || searchOnly) throw err;
    }
    let count = 0;
    let scanned = 0;
    let before = null;
    for (;;) {
      const page = await historyPage(target, before, { signal, onWait });
      if (!page.length) {
        partialCounts.delete(target.channelId);
        return count;
      }
      scanned += page.length;
      count += page.filter((m) => m.author && m.author.id === me.id && !UNDELETABLE_TYPES.has(m.type)).length;
      if (onProgress) onProgress({ count, scanned });
      before = oldestId(page);
      await sleep(TIMING.searchDelayMs, signal);
    }
  }

  // ── Purge run ───────────────────────────────────────────

  const bus = new EventTarget();
  const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
  const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));

  const counts = new Map(); // channelId → my deletable message count from the last scan
  // Channels whose count came from a search Discord hadn't finished indexing: older messages may be missing.
  const partialCounts = new Set();
  const isPartialCount = (channelId) => partialCounts.has(channelId) && counts.has(channelId);

  const run = {
    active: false,
    paused: false,
    stopping: false,
    controller: null,
    token: null,           // the account this run was confirmed for
    accountSwitched: false,
    deleted: 0,
    failed: 0,
    skipped: 0,
    gone: 0,
    failures: [],
    problems: [], // targets that were skipped or left incomplete
    total: 0,
    uncounted: 0, // targets whose size is still unknown: progress is honest only once this is 0
    startedAt: 0,
    pausedMs: 0,
    pausedAt: 0,
    deleteDelay: TIMING.deleteDelayMs,
    calm: 0,
    seen: new Set(),
    blocked: new Map(), // channelId → why every delete there fails (an archived thread)
  };

  const processed = () => run.deleted + run.failed + run.gone;

  function progressSnapshot() {
    const done = processed();
    const now = run.paused ? run.pausedAt : Date.now();
    const elapsed = Math.max(1, now - run.startedAt - run.pausedMs);
    const perMessage = done ? elapsed / done : run.deleteDelay + 300;
    const remaining = run.total ? Math.max(0, run.total - done) : 0;
    const honest = run.total > 0 && run.uncounted <= 0;
    return {
      deleted: run.deleted,
      failed: run.failed,
      skipped: run.skipped,
      gone: run.gone,
      total: run.total,
      fraction: honest ? Math.min(1, done / run.total) : null,
      etaSeconds: honest && done >= 3 ? (remaining * perMessage) / 1000 : null,
      partial: run.uncounted > 0,
      rate: done ? done / (elapsed / 1000) : 0,
    };
  }

  const tick = () => emit('progress', progressSnapshot());

  async function gate(signal) {
    while (run.paused) await sleep(150, signal);
    if (signal.aborted) throw new Stopped();
  }

  function onWaitFor(target) {
    return (wait) => {
      if (wait.kind === 'rate' && wait.method === 'DELETE') {
        run.calm = 0;
        const slower = Math.min(Math.round(run.deleteDelay * 1.25), TIMING.deleteDelayMs * 4);
        if (slower !== run.deleteDelay) {
          run.deleteDelay = slower;
          emit('log', { tone: 'warn', text: `Discord asked us to slow down — pacing deletes at ${(slower / 1000).toFixed(1)}s` });
        }
      }
      emit('wait', { ...wait, target });
    };
  }

  const ARCHIVED_THREAD = 50083; // Discord's code for a write into an archived thread

  // Another tab shielded the chat we're in: stop deleting there before the next message.
  class Shielded extends Error {}
  const checkShield = (target) => { if (isProtectedUser(target.partner)) throw new Shielded(); };

  async function handleMessage(target, msg, signal) {
    if (run.seen.has(msg.id)) return;
    run.seen.add(msg.id);
    if (UNDELETABLE_TYPES.has(msg.type)) {
      run.skipped++;
      emit('skip', { target, msg });
      return;
    }
    await gate(signal);
    checkShield(target);
    // Channel search also returns messages from the channel's threads, so delete
    // in the channel Discord says the message lives in.
    const where = msg.channel_id || target.channelId;
    // An archived thread refuses every delete alike: the first refusal answers for the rest.
    if (run.blocked.has(where)) {
      recordFailure(target, msg, run.blocked.get(where), ARCHIVED_THREAD);
      tick();
      return;
    }
    const res = await request(`/channels/${where}/messages/${msg.id}`, {
      method: 'DELETE', signal, onWait: onWaitFor(target), beforeRetry: async () => { await gate(signal); checkShield(target); },
    });
    const body = res.ok ? null : await readJson(res);
    if (res.status === 404 && body && body.code === 10008) {
      // Already gone (deleted elsewhere, or a stale search hit): not ours to count.
      run.gone++;
      target.gone = (target.gone || 0) + 1;
      emit('gone', { target, msg });
    } else if (res.ok) {
      run.deleted++;
      target.deleted = (target.deleted || 0) + 1;
      if (++run.calm >= 50 && run.deleteDelay > TIMING.deleteDelayMs) {
        run.calm = 0;
        run.deleteDelay = Math.max(TIMING.deleteDelayMs, Math.round(run.deleteDelay * 0.9));
      }
      emit('kill', { target, msg });
    } else {
      const err = new DiscordError(res.status, body);
      if (res.status === 401 || err.code === 'captcha') throw err;
      if (err.code === ARCHIVED_THREAD) {
        run.blocked.set(where, err.message);
        emit('log', { tone: 'warn', text: `${target.name}: ${where === target.channelId ? 'this thread' : 'a thread in here'} is archived~ reopen it in Discord to purge those ♡` });
      }
      recordFailure(target, msg, err.message, err.code);
    }
    tick();
    await sleep(run.deleteDelay, signal);
  }

  function recordFailure(target, msg, reason, code) {
    run.failed++;
    target.failed = (target.failed || 0) + 1;
    const failure = { target, msg: { id: msg.id, content: msg.content, attachments: msg.attachments, pinned: msg.pinned, type: msg.type }, reason, code };
    run.failures.push(failure);
    emit('fail', failure);
  }

  // Returns { indexing: true } when Discord says older history is not searchable yet.
  async function purgeBySearch(target, signal) {
    const me = await whoAmI();
    const onWait = onWaitFor(target);
    let indexing = false;
    for (let pass = 0; pass < 3; pass++) {
      let maxId = null;
      let emptyStreak = 0;
      let fresh = 0;
      for (;;) {
        await gate(signal);
        const page = await searchPage(target, me.id, { maxId, signal, onWait });
        const { hits, cursor } = page;
        if (page.indexing) indexing = true;
        if (!cursor) {
          // An empty page can be a hiccup in Discord's index; believe it the second time.
          if (++emptyStreak >= 2) break;
          await sleep(TIMING.searchDelayMs * 2, signal);
          continue;
        }
        emptyStreak = 0;
        for (const msg of hits) {
          if (!run.seen.has(msg.id)) fresh++;
          await handleMessage(target, msg, signal);
        }
        maxId = cursor;
        await sleep(TIMING.searchDelayMs, signal);
      }
      // One cheap look at the newest page catches anything the index added mid-run.
      if (!fresh) break;
      await gate(signal);
      const top = await searchPage(target, me.id, { signal, onWait });
      if (top.indexing) indexing = true;
      if (!top.hits.some((m) => !run.seen.has(m.id))) break;
      await sleep(TIMING.searchDelayMs, signal);
    }
    return { indexing };
  }

  async function purgeByHistory(target, signal) {
    const me = await whoAmI();
    const onWait = onWaitFor(target);
    let before = null;
    for (;;) {
      await gate(signal);
      const page = await historyPage(target, before, { signal, onWait });
      if (!page.length) return {};
      for (const msg of page) {
        if (msg.author && msg.author.id === me.id) await handleMessage(target, msg, signal);
      }
      before = oldestId(page);
      await sleep(TIMING.searchDelayMs, signal);
    }
  }

  // targets: [{ channelId, guildId, name, context, kind, protected, userId?, needsDM? }]
  // Leave the cached count describing what is still there, so the button, the
  // dialog and the next run never promise a stale total.
  function settleCount(target, before) {
    const left = before === undefined ? -1 : before - (target.deleted || 0);
    // If more went than we counted, the count was stale: make the next run re-count.
    if (left <= (target.failed || 0)) counts.delete(target.channelId);
    else counts.set(target.channelId, left);
  }

  const fatalError = (err) => err.status === 401 || err.code === 'captcha';

  // targets: [{ channelId, guildId, name, context, kind, protected, userId?, needsDM? }]
  async function startRun(targets) {
    if (run.active) return;
    const switched = syncAccount();
    Object.assign(run, {
      active: true, paused: false, stopping: false, controller: new AbortController(),
      token: getToken(), accountSwitched: false,
      deleted: 0, failed: 0, skipped: 0, gone: 0, failures: [], problems: [], shielded: [],
      startedAt: Date.now(), pausedMs: 0, pausedAt: 0,
      deleteDelay: TIMING.deleteDelayMs, calm: 0, seen: new Set(), blocked: new Map(),
      total: 0,
      uncounted: 0,
    });
    // Only exact counts go into the total. A chat counted while Discord was still indexing
    // stays open, like an unscanned one, until its purge shows how many there really were.
    for (const t of targets) {
      const exact = counts.has(t.channelId) && !partialCounts.has(t.channelId);
      t.planned = !t.protected && exact ? counts.get(t.channelId) : 0;
      t.uncounted = !t.protected && !exact;
      run.total += t.planned;
      if (t.uncounted) run.uncounted++;
    }
    const counted = (t, n) => {
      if (!t.uncounted) return;
      t.uncounted = false;
      run.uncounted--;
      t.planned = n;
      run.total += n;
    };
    const done = (t) => (t.deleted || 0) + (t.failed || 0) + (t.gone || 0);
    // A chat that turns immune keeps only what was already done there in the total.
    const settleImmune = (t) => {
      if (t.uncounted) counted(t, done(t));
      else run.total -= Math.max(0, t.planned - done(t));
    };
    const { signal } = run.controller;
    emit('start', { targets });
    tick();
    let fatal = switched ? new DiscordError(0, { message: 'You switched Discord accounts — scan again first' }) : null;
    try {
      if (fatal) throw fatal;
      await whoAmI();
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        if (signal.aborted) break;
        // Wait out a pause before the shield check, so a shield set while paused still counts.
        await gate(signal);
        if (target.protected || isProtectedUser(target.partner)) {
          settleImmune(target);
          emit('target-end', { target, index: i, ok: false, immune: true });
          continue;
        }
        // Never carry a confirmed purge across an account switch.
        syncAccount();
        if (run.accountSwitched) break;
        emit('target-start', { target, index: i, count: targets.length });
        const before = counts.get(target.channelId);
        try {
          if (target.needsDM) {
            const dm = await openDM(target.userId, { signal, beforeRetry: async () => { await gate(signal); checkShield(target); } });
            const previousKey = target.key;
            target.channelId = dm.id;
            target.needsDM = false;
            target.openedByUs = true;
            emit('dm-opened', { target, previousKey });
            await sleep(TIMING.searchDelayMs * 2, signal); // don't open DMs in a burst
            await gate(signal);
            checkShield(target);
          }
          if (target.uncounted && !counts.has(target.channelId)) {
            // A cheap search count only; history targets find their total as they go.
            try {
              const n = await countMine(target, { signal, onWait: onWaitFor(target), searchOnly: true });
              counts.set(target.channelId, n);
              if (!partialCounts.has(target.channelId)) counted(target, n);
              tick();
            } catch (err) {
              if (err instanceof Stopped || fatalError(err)) throw err;
            }
          }
          const countedBefore = counts.get(target.channelId);
          const result = await (target.guildId ? purgeBySearch(target, signal) : purgeByHistory(target, signal));
          // A chat we couldn't count up front is now fully known.
          counted(target, done(target));
          if (result.indexing) {
            counts.delete(target.channelId);
            run.problems.push({ target, reason: 'Discord is still indexing older messages — run it again later' });
            emit('target-end', { target, index: i, ok: false, warn: 'still indexing' });
            emit('log', { tone: 'warn', text: `${target.name}: Discord is still indexing older messages — run again later to catch them` });
          } else {
            counts.set(target.channelId, target.failed || 0);
            partialCounts.delete(target.channelId);
            emit('target-end', { target, index: i, ok: true });
          }
          // A DM we opened only to look inside, with nothing of ours in it, goes back to how it was.
          if (target.openedByUs && !target.deleted && !target.failed && countedBefore === 0) {
            try { await request(`/channels/${target.channelId}`, { method: 'DELETE', signal }); } catch { /* cosmetic */ }
          }
        } catch (err) {
          if (err instanceof Stopped) {
            settleCount(target, before);
            emit('target-end', { target, index: i, ok: false, stopped: true });
            break;
          }
          if (err instanceof Shielded) {
            settleCount(target, before);
            settleImmune(target);
            run.shielded.push(target);
            emit('target-end', { target, index: i, ok: false, immune: true, midway: true });
            // A DM we opened only to purge, untouched, goes back to how it was.
            if (target.openedByUs && !target.deleted && !target.failed) {
              try { await request(`/channels/${target.channelId}`, { method: 'DELETE', signal }); } catch { /* cosmetic */ }
            }
            continue;
          }
          // A skipped chat is settled too, or every later chat would show "N of M+" with no ETA.
          counted(target, done(target));
          counts.delete(target.channelId);
          if (fatalError(err)) { fatal = err; break; }
          run.problems.push({ target, reason: err.message });
          emit('target-end', { target, index: i, ok: false, error: err.message });
          emit('log', { tone: 'error', text: `${target.name}: ${err.message} — skipping` });
        }
      }
    } catch (err) {
      if (!(err instanceof Stopped)) fatal = err;
    } finally {
      if (run.accountSwitched) fatal = new DiscordError(0, { message: 'You switched Discord accounts — stopped to be safe' });
      const stopped = run.stopping && !run.accountSwitched;
      run.active = false;
      run.paused = false;
      run.stopping = false;
      tick();
      emit('end', {
        stopped, error: fatal ? fatal.message : null, ...progressSnapshot(),
        failures: run.failures.slice(), problems: run.problems.slice(), shielded: run.shielded.map((t) => t.name),
      });
      if (run.accountSwitched) syncAccount(); // now idle: adopt the new account and reset
    }
  }

  function pauseRun() {
    if (!run.active || run.paused || run.stopping) return;
    run.paused = true;
    run.pausedAt = Date.now();
    emit('pause', progressSnapshot());
  }

  function resumeRun({ force = false } = {}) {
    if (!run.active || !run.paused || (run.stopping && !force)) return;
    run.pausedMs += Date.now() - run.pausedAt;
    run.paused = false;
    emit('resume', progressSnapshot());
  }

  function stopRun() {
    if (!run.active || run.stopping) return;
    run.stopping = true;
    if (run.paused) resumeRun({ force: true });
    run.controller.abort();
    emit('stopping', progressSnapshot());
  }
