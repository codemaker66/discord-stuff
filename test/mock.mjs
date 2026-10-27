// Stateful mock of the slice of the Discord web app + REST API the purifier touches.
// Used with Playwright: installMockDiscord(page, opts) routes every https://discord.com/* request.

const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const SYSTEM_UNDELETABLE = new Set([1, 2, 3, 4, 5, 21]);

let snow = 0n;
// Mix 18- and 19-digit snowflakes like real accounts (old DMs are 18 digits).
function mkId(old = false) {
  snow += 1n + BigInt(Math.floor(Math.random() * 3));
  return (old ? 300000000000000000n : 1100000000000000000n) + snow * 1000n;
}

// The worlds and switches every test builds on live here, so no test reads anything under test/out/.
//
// buildWorld options:
//   showcase  friendly stand-ins for the hostile fixtures, for screenshots people will see.
//   crowd     a heavy account from the audit (see CROWDS): 'heavy', 'scale' or 'nodes'.
//   bulk      { channelId: n }: n more messages of yours in that chat, older than today.
//             { 5001: 3000 } is the edge lens's big world: 3,040 of yours in #general.
//   names     names at Discord's limits (see NAMES): 'long', 'rtl', 'zalgo', 'emoji', a list of
//             them, or 'extreme' for all four.
export function buildWorld({ showcase = false, crowd = null, bulk = null, names = null } = {}) {
  snow = 0n;
  oldId = OLD_IDS;
  const me = { id: '1000', username: 'princess.dopa', global_name: 'Dopa (alt)' };
  const me2 = { id: '1001', username: 'second.acc', global_name: 'Second' };
  const users = {
    bardo: { id: '2001', username: 'bardo', global_name: 'Bardo' },
    alice: { id: '2002', username: 'alice', global_name: 'Alice ✿' },
    mallory: showcase ? { id: '2003', username: 'mira', global_name: 'Mira ♡' } : { id: '2003', username: 'mallory', global_name: XSS },
    bob: { id: '2004', username: 'bob', global_name: 'Bob' },
    carol: { id: '2005', username: 'carol', global_name: 'Carol' },
  };
  const guilds = [
    { id: '4001', name: '✿ Cozy Corner', icon: null },
    { id: '4002', name: showcase ? '☾ Night Owls' : XSS, icon: null },
  ];
  const channels = {
    // DMs
    '3001': { id: '3001', type: 1, recipients: [users.bardo] },
    '3002': { id: '3002', type: 1, recipients: [users.alice] },
    '3003': { id: '3003', type: 1, recipients: [users.mallory] },
    '3004': { id: '3004', type: 3, name: null, recipients: [users.alice, users.carol] },
    // Guild channels
    '5001': { id: '5001', type: 0, guild_id: '4001', name: 'general', position: 0 },
    '5002': { id: '5002', type: 0, guild_id: '4001', name: 'art-share', position: 1 },
    '5003': { id: '5003', type: 5, guild_id: '4001', name: 'announcements', position: 2 },
    '5004': { id: '5004', type: 2, guild_id: '4001', name: 'Voice Lounge', position: 3 },
    '5005': { id: '5005', type: 4, guild_id: '4001', name: 'TEXT', position: 0 },
    '5007': { id: '5007', type: 0, guild_id: '4001', name: 'mod-only', position: 4, noAccess: true },
    '5006': { id: '5006', type: 0, guild_id: '4002', name: 'lobby', position: 0 },
    // A thread under #announcements: Discord's channel search returns its messages too.
    '5103': { id: '5103', type: 11, guild_id: '4001', parent_id: '5003', name: 'release-notes-thread', position: 0 },
  };
  const messages = {}; // channelId -> array of messages, oldest first
  const add = (cid, author, n, opts = {}) => {
    messages[cid] ||= [];
    for (let i = 0; i < n; i++) {
      const id = String(mkId(opts.old));
      messages[cid].push({
        id, channel_id: cid, type: opts.type ?? 0, pinned: !!opts.pinned,
        author: { id: author.id, username: author.username, global_name: author.global_name },
        content: opts.content ? opts.content(i) : `${author.username} message #${i} in ${cid} <b>bold?</b>`,
        attachments: [],
      });
    }
  };
  // DM with Alice: interleaved, some old 18-digit ids, a CALL system message by me, a pinned message.
  add('3002', me, 6, { old: true });
  add('3002', users.alice, 30, { old: true });
  add('3002', me, 1, { type: 3, content: () => '' });
  add('3002', me, 20);
  add('3002', users.alice, 25);
  add('3002', me, 1, { pinned: true, content: () => 'pinned memory ♡' });
  add('3002', me, 4, { content: () => '' }); // attachment-only
  add('3003', users.mallory, 5);
  add('3003', me, 7);
  add('3004', users.carol, 10);
  add('3004', me, 3);
  add('3004', me, 1, { type: 1, content: () => '' });
  add('3001', users.bardo, 8);
  add('3001', me, 8);
  add('5001', users.alice, 50);
  add('5001', me, 40, { content: (i) => `general chatter ${i} — "quotes" & <tags>` });
  add('5001', users.bob, 30);
  add('5002', me, 10);
  add('5003', me, 2);
  add('5103', me, 3, { content: (i) => `thread reply ${i}` });
  add('5001', me2, 5, { content: (i) => `second account says ${i}` });
  add('5006', me, 3);
  add('5007', me, 5);
  // Sort each channel by snowflake so listing/search order is realistic.
  for (const cid of Object.keys(messages)) messages[cid].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const relationships = [
    { id: users.bardo.id, type: 1, user: users.bardo },
    { id: users.alice.id, type: 1, user: users.alice },
    { id: users.bob.id, type: 1, user: users.bob },
    { id: users.carol.id, type: 1, user: users.carol },
    { id: '2999', type: 2, user: { id: '2999', username: 'blocked_guy' } },
  ];
  // last_message_id for DM ordering
  for (const c of Object.values(channels)) {
    const list = messages[c.id];
    if (list && list.length) c.last_message_id = list[list.length - 1].id;
  }
  const accounts = { 'mock-token.abc': me, 'mock-token.b': me2 };
  const world = { me, me2, accounts, users, guilds, channels, messages, relationships };
  if (crowd) addCrowd(world, crowd);
  for (const [cid, n] of Object.entries(bulk || {})) addOld(world, cid, n);
  if (names) nameAtLimits(world, names);
  return world;
}

// Heavy accounts, as the audit measured them:
//   heavy  perf/biglist: 600 DMs (every tenth a group), 400 friends with no DM open, and 100 servers
//          of 30 channels (every seventh a category).
//   scale  robust/scale: 600 DMs holding 0-3 of yours each, 200 friends with no DM, and 150 servers of
//          6 channels: 806 rows in the DM list.
//   nodes  perf/batchcost: 600 DMs and 400 friends with no DM (the audit's 14,778-node world: 4.1
//          draws about 14,700 shadow nodes for it), and 200 more of yours in Alice's DM to purge.
export const CROWDS = {
  heavy: { dms: 600, groupEvery: 10, friends: 400, guilds: 100, channels: 30, categoryEvery: 7 },
  scale: { dms: 600, mineEach: (i) => i % 4, friends: 200, guilds: 150, channels: 6 },
  nodes: { dms: 600, friends: 400, bulk: { 3002: 200 } },
};

function addCrowd(world, name) {
  const c = CROWDS[name];
  if (!c) throw new Error(`buildWorld: no crowd '${name}' (${Object.keys(CROWDS).join(', ')})`);
  let uid = 7000;
  let cid = 600000;
  let mid = 1300000000000000000n;
  for (let i = 0; i < c.dms; i++) {
    const user = { id: String(uid++), username: `user${i}`, global_name: `Person ${i} ✿` };
    world.users[`u${i}`] = user;
    const id = String(cid++);
    const group = c.groupEvery && i % c.groupEvery === 0;
    world.channels[id] = { id, type: group ? 3 : 1, name: null, recipients: group ? [user, world.users.carol] : [user], last_message_id: String(1100000000000000000n + BigInt(i)) };
    const mine = c.mineEach ? c.mineEach(i) : 0;
    world.messages[id] = [];
    for (let j = 0; j < mine; j++) world.messages[id].push(message(world.me, id, String(mid++), `hey ${j}`));
  }
  for (let i = 0; i < (c.friends || 0); i++) {
    const user = { id: String(uid++), username: `friend${i}`, global_name: `Friend ${i}` };
    world.users[`f${i}`] = user;
    world.relationships.push({ id: user.id, type: 1, user });
  }
  for (let g = 0; g < (c.guilds || 0); g++) {
    const gid = String(90000 + g);
    world.guilds.push({ id: gid, name: `Server ${g} ☾`, icon: null });
    for (let k = 0; k < c.channels; k++) {
      const id = String(cid++);
      const category = c.categoryEvery && k % c.categoryEvery === 0;
      world.channels[id] = { id, type: category ? 4 : 0, guild_id: gid, name: `channel-${k}`, position: k, parent_id: null };
    }
  }
  for (const [chat, n] of Object.entries(c.bulk || {})) addOld(world, chat, n);
}

const message = (author, cid, id, content) => ({
  id, channel_id: cid, type: 0, pinned: false,
  author: { id: author.id, username: author.username, global_name: author.global_name }, content, attachments: [],
});

// n messages of yours from a few months back: older than any run, so a purge takes them all.
const OLD_IDS = 1500000000000000000n;
let oldId = OLD_IDS;
function addOld(world, cid, n) {
  const list = (world.messages[cid] ||= []);
  for (let i = 0; i < n; i++) list.push(message(world.me, cid, String(oldId += 1000n), `old message ${i}`));
  list.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  if (world.channels[cid] && list.length) world.channels[cid].last_message_id = list[list.length - 1].id;
}

// Discord's ids start with the time they were made (ms since 2015 << 22), so a message sent now sorts
// after everything a run was confirmed over. The low bits keep ids made in one millisecond apart and
// are never 0, so a message sent in the very millisecond a run took its cut-off still sorts after it.
const DISCORD_EPOCH = 1420070400000n;
let lowBits = 0n;
export function snowflakeAt(ms = Date.now()) {
  lowBits = (lowBits % 0x3fffffn) + 1n;
  return String(((BigInt(Math.floor(ms)) - DISCORD_EPOCH) << 22n) | lowBits);
}

// You send n messages to a chat now (or at `at`, in ms), mid-test: what Discord's search and history
// return from then on. Returns the new messages.
export function addMine(world, cid, n = 1, { at = Date.now(), content = (i) => `sent just now ${i}` } = {}) {
  const list = (world.messages[cid] ||= []);
  const added = [];
  for (let i = 0; i < n; i++) added.push(message(world.me, cid, snowflakeAt(at), content(i)));
  list.push(...added);
  if (world.channels[cid]) world.channels[cid].last_message_id = added[added.length - 1].id;
  return added;
}

// Names at Discord's limits: a server, channel and group DM name is at most 100 characters, a
// username or display name 32.
const ZALGO = 'Z̷̡̢̛̖̗̘̙̜̝̞̟̠̤̥̦̩̪̫a̴̡̢̛̖̗̘̙̜̝̞l̴̡̢̛̖̗̘̙̜g̴̡̢̛̖̗̘ơ̴̡̢̖̗̘̙';
export const NAMES = {
  long: (w) => {
    w.guilds[0].name = '✿ The Extremely Cozy Corner of the Internet Where Everyone Hangs Out and Shares Art Every Day, Hi! ✿';
    w.channels['5001'].name = 'general-chatter-for-everyone-who-wants-to-talk-about-anything-and-everything-under-the-sun-forever-x';
    w.channels['3004'].name = 'the extremely long group chat name that someone typed in because they could, and so they did it, ok!';
    w.users.alice.username = 'alice_the_magnificent_wanderer_x';
    w.users.alice.global_name = 'Alice the Magnificent Wanderer ✿';
    w.me.username = 'princess_dopa_the_purifier_xoxox';
  },
  rtl: (w) => {
    w.channels['5002'].name = 'عام-للجميع';
    w.guilds[1].name = 'שרת הקהילה הישראלית הגדול ביותר';
    w.users.alice.global_name = 'مرحبا بالعالم الجميل جدا اليوم';
  },
  zalgo: (w) => { w.users.mallory.global_name = ZALGO; },
  emoji: (w) => {
    w.users.carol.global_name = '🔥🔥🔥';
    w.users.bob.global_name = '👩‍👩‍👧‍👦';
  },
};

function nameAtLimits(world, names) {
  const list = names === 'extreme' ? Object.keys(NAMES) : [names].flat();
  for (const name of list) {
    if (!NAMES[name]) throw new Error(`buildWorld: no names '${name}' (${Object.keys(NAMES).join(', ')} or extreme)`);
    NAMES[name](world);
  }
  // Messages carry a copy of their author's names: they take the new ones too.
  const people = new Map([world.me, ...Object.values(world.users)].map((u) => [u.id, u]));
  for (const chat of Object.values(world.messages)) {
    for (const m of chat) {
      const now = people.get(m.author.id);
      if (now) Object.assign(m.author, { username: now.username, global_name: now.global_name });
    }
  }
}

// Every cfg switch can be flipped mid-test (cfg.offline = true), as Discord's network would.
export async function installMockDiscord(page, opts = {}) {
  const world = opts.world || buildWorld({ showcase: !!opts.showcase });
  const cfg = {
    searchPageSize: 25,
    indexingOnce: new Set(opts.indexingOnce || []), // channel ids that answer 202 on first search
    rateLimitEvery: opts.rateLimitEvery || 0, // every Nth DELETE answers 429
    indexLag: opts.indexLag ?? 2, // deleted messages linger in search results for N more searches
    latencyMs: opts.latencyMs ?? 5,
    badToken: !!opts.badToken,
    deepIndex: new Set(opts.deepIndex || []), // channel ids whose search reports doing_deep_historical_index
    offline: !!opts.offline, // every API request fails the way a dropped connection does
    serverError: opts.serverError || 0, // a status such as 502: Discord answers it to every serverErrorOn request
    serverErrorOn: opts.serverErrorOn || 'DELETE', // 'DELETE', 'GET', 'POST' or '*'
    light: !!opts.light, // Discord's light theme: html.theme-light and a light shell behind the panel
  };
  // refused: requests the offline or serverError switches turned away.
  const stats = { deletes: [], deleteAttempts: 0, searches: 0, lists: 0, opened: [], closed: [], errors: [], log: [], tokens: [], deleteChannels: [], refused: 0 };
  const ghosts = {}; // channelId -> [{msg, ttl}] deleted-but-still-indexed
  const indexed202 = new Set();

  const json = (route, status, body, headers = {}) =>
    route.fulfill({ status, contentType: 'application/json', headers, body: body === undefined ? '' : JSON.stringify(body) });

  const searchIn = (cidsIn, q) => {
    let cids = cidsIn;
    stats.searches++;
    const author = q.get('author_id');
    const maxId = q.get('max_id');
    const minId = q.get('min_id');
    const offset = Number(q.get('offset') || 0);
    let pool = [];
    const withThreads = [...cids, ...Object.values(world.channels).filter((c) => c.type === 11 && cids.includes(c.parent_id)).map((c) => c.id)];
    cids = withThreads;
    for (const cid of cids) {
      pool.push(...(world.messages[cid] || []));
      for (const g of ghosts[cid] || []) if (g.ttl > 0) pool.push(g.msg);
    }
    pool = pool.filter((m) => (!author || m.author.id === author)
      && (!maxId || BigInt(m.id) < BigInt(maxId)) && (!minId || BigInt(m.id) > BigInt(minId))
      && !SYSTEM_UNDELETABLE.has(m.type));
    pool.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
    for (const cid of cids) for (const g of ghosts[cid] || []) g.ttl--;
    const pageItems = pool.slice(offset, offset + cfg.searchPageSize).map((m) => [{ ...m, hit: true }]);
    const out = { total_results: pool.length, messages: pageItems, analytics_id: 'x' };
    if (cids.some((c) => cfg.deepIndex.has(c))) out.doing_deep_historical_index = true;
    return out;
  };

  await page.route('https://discord.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const m = req.method();
    if (!p.startsWith('/api/')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: appHtml(world, p, cfg) });
    }
    // page.route answers before the network, so context.setOffline() can't reach the mock: drop it here.
    if (cfg.offline) { stats.refused++; return route.abort('internetdisconnected'); }
    if (cfg.latencyMs) await new Promise((r) => setTimeout(r, cfg.latencyMs));
    const auth = req.headers()['authorization'];
    stats.log.push(`${m} ${p}${url.search}`);
    stats.tokens.push(auth);
    if (cfg.serverError && (cfg.serverErrorOn === '*' || cfg.serverErrorOn === m)) {
      stats.refused++;
      const said = { 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }[cfg.serverError] || 'Server Error';
      return route.fulfill({ status: cfg.serverError, contentType: 'text/html', body: `<html>${cfg.serverError} ${said}</html>` });
    }
    const user = world.accounts[auth];
    if (cfg.badToken || !user) return json(route, 401, { message: '401: Unauthorized', code: 0 });

    const api = p.replace(/^\/api\/v\d+/, '');
    let mm;
    if (api === '/users/@me' && m === 'GET') return json(route, 200, user);
    if (api === '/users/@me/channels' && m === 'GET') {
      return json(route, 200, Object.values(world.channels).filter((c) => c.type === 1 || c.type === 3));
    }
    if (api === '/users/@me/channels' && m === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      const rid = body.recipients?.[0];
      const user = Object.values(world.users).find((u) => u.id === rid);
      if (!user) return json(route, 400, { message: 'Invalid recipient', code: 50033 });
      let ch = Object.values(world.channels).find((c) => c.type === 1 && c.recipients[0].id === rid);
      if (!ch) {
        const id = String(3100 + stats.opened.length);
        ch = { id, type: 1, recipients: [user] };
        world.channels[id] = ch;
        world.messages[id] = [];
      }
      stats.opened.push(ch.id);
      return json(route, 200, ch);
    }
    if (api === '/users/@me/relationships') return json(route, 200, world.relationships);
    if (api === '/users/@me/guilds') return json(route, 200, world.guilds);
    if ((mm = api.match(/^\/guilds\/(\d+)\/channels$/))) {
      return json(route, 200, Object.values(world.channels).filter((c) => c.guild_id === mm[1]).map(({ noAccess, ...c }) => c));
    }
    if ((mm = api.match(/^\/guilds\/(\d+)\/messages\/search$/))) {
      const gid = mm[1];
      const cid = url.searchParams.get('channel_id');
      const cids = cid ? [cid] : Object.values(world.channels).filter((c) => c.guild_id === gid).map((c) => c.id);
      if (cid && world.channels[cid]?.noAccess) return json(route, 403, { message: 'Missing Access', code: 50001 });
      const key = cid || gid;
      if (cfg.indexingOnce.has(key) && !indexed202.has(key)) {
        indexed202.add(key);
        return json(route, 202, { message: 'Index not yet available. Try again later', code: 110000, documents_indexed: 0, retry_after: 0.2 });
      }
      return json(route, 200, searchIn(cids, url.searchParams));
    }
    if ((mm = api.match(/^\/channels\/(\d+)\/messages\/search$/))) {
      const cid = mm[1];
      if (!world.channels[cid]) return json(route, 404, { message: 'Unknown Channel', code: 10003 });
      if (cfg.indexingOnce.has(cid) && !indexed202.has(cid)) {
        indexed202.add(cid);
        return json(route, 202, { message: 'Index not yet available. Try again later', code: 110000, documents_indexed: 0, retry_after: 0.2 });
      }
      return json(route, 200, searchIn([cid], url.searchParams));
    }
    if ((mm = api.match(/^\/channels\/(\d+)\/messages$/)) && m === 'GET') {
      stats.lists++;
      const cid = mm[1];
      if (world.channels[cid]?.noAccess) return json(route, 403, { message: 'Missing Access', code: 50001 });
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
      const before = url.searchParams.get('before');
      const list = (world.messages[cid] || []).filter((x) => !before || BigInt(x.id) < BigInt(before));
      return json(route, 200, list.slice(-limit).reverse());
    }
    if ((mm = api.match(/^\/channels\/(\d+)\/messages\/(\d+)$/)) && m === 'DELETE') {
      stats.deleteAttempts++;
      const [, cid, mid] = mm;
      if (cfg.rateLimitEvery && stats.deleteAttempts % cfg.rateLimitEvery === 0) {
        return json(route, 429, { message: 'You are being rate limited.', retry_after: 0.15, global: false }, { 'retry-after': '1' });
      }
      const list = world.messages[cid] || [];
      const idx = list.findIndex((x) => x.id === mid);
      if (idx < 0) return json(route, 404, { message: 'Unknown Message', code: 10008 });
      const msg = list[idx];
      if (SYSTEM_UNDELETABLE.has(msg.type)) return json(route, 403, { message: 'Cannot execute action on a system message', code: 50021 });
      if (msg.author.id !== user.id) return json(route, 403, { message: 'Missing Permissions', code: 50013 });
      list.splice(idx, 1);
      (ghosts[cid] ||= []).push({ msg, ttl: cfg.indexLag });
      stats.deletes.push(mid);
      stats.deleteChannels.push(cid);
      return route.fulfill({ status: 204, body: '' });
    }
    if ((mm = api.match(/^\/channels\/(\d+)$/)) && m === 'DELETE') {
      const ch = world.channels[mm[1]];
      if (!ch || ch.type !== 1) return json(route, 403, { message: 'Missing Permissions', code: 50013 });
      stats.closed.push(ch.id);
      return json(route, 200, ch);
    }
    if ((mm = api.match(/^\/channels\/(\d+)$/)) && m === 'GET') {
      const ch = world.channels[mm[1]];
      if (!ch) return json(route, 404, { message: 'Unknown Channel', code: 10003 });
      const { noAccess, ...rest } = ch;
      return json(route, 200, rest);
    }
    stats.errors.push(`unhandled ${m} ${p}`);
    return json(route, 404, { message: 'mock: unhandled', code: 0 });
  });

  return { world, stats, cfg };
}

// ── Fake Discord shell ─────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function appHtml(world, path, { light = false } = {}) {
  const msgs = (world.messages['5001'] || []).slice(-9);
  const avatarColor = (id) => ['#f47fff', '#5865f2', '#23a55a', '#f0b232', '#eb459e'][Number(id) % 5];
  const rows = msgs.map((m) => `
    <div class="msg"><div class="av" style="background:${avatarColor(m.author.id)}"></div>
      <div><div class="who">${esc(m.author.global_name || m.author.username)} <span class="ts">Today at 4:2${Number(m.id.slice(-4)) % 10} PM</span></div>
      <div class="txt">${esc(m.content)}</div></div></div>`).join('');
  // Discord marks its theme on <html>: theme-dark, or theme-light with these colours.
  return `<!doctype html><html class="${light ? 'theme-light' : 'theme-dark'}"><head><meta charset="utf-8"><title>Discord</title>
<style>
  @font-face { font-family: 'gg sans'; src: local('Inter'); font-weight: 400; }
  @font-face { font-family: 'gg sans'; src: local('Inter Medium'); font-weight: 500; }
  @font-face { font-family: 'gg sans'; src: local('Inter SemiBold'); font-weight: 600; }
  @font-face { font-family: 'gg sans'; src: local('Inter Bold'); font-weight: 700; }
  @font-face { font-family: 'gg sans'; src: local('Inter ExtraBold'); font-weight: 800; }
  @font-face { font-family: 'gg sans'; src: local('Inter Black'); font-weight: 900; }
  @font-face { font-family: 'gg mono'; src: local('JetBrains Mono'); }
  html, body { margin: 0; height: 100%; background: #313338; font-family: 'gg sans', sans-serif; color: #dbdee1; overflow: hidden; }
  #app-mount { display: flex; height: 100%; }
  .rail { width: 72px; background: #1e1f22; display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 12px; }
  .rail i { width: 48px; height: 48px; border-radius: 50%; background: #313338; display: block; }
  .rail i:first-child { background: #5865f2; border-radius: 16px; }
  .side { width: 240px; background: #2b2d31; padding: 12px 8px; box-sizing: border-box; }
  .side .gname { font-weight: 700; color: #f2f3f5; padding: 4px 8px 16px; border-bottom: 1px solid #1f2023; margin-bottom: 12px; }
  .side a { display: block; color: #949ba4; padding: 6px 8px; border-radius: 4px; text-decoration: none; font-size: 15px; }
  .side a.on { background: #404249; color: #f2f3f5; }
  .main { flex: 1; display: flex; flex-direction: column; }
  .top { height: 48px; border-bottom: 1px solid #26282c; display: flex; align-items: center; padding: 0 16px; font-weight: 700; color: #f2f3f5; }
  .chat { flex: 1; padding: 16px; overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end; }
  .msg { display: flex; gap: 14px; padding: 6px 0; }
  .av { width: 40px; height: 40px; border-radius: 50%; flex: none; }
  .who { font-weight: 600; color: #f2f3f5; font-size: 15px; } .ts { color: #949ba4; font-size: 12px; font-weight: 400; margin-left: 4px; }
  .txt { font-size: 15px; line-height: 1.4; }
  .box { margin: 0 16px 24px; height: 44px; border-radius: 8px; background: #383a40; color: #6d6f78; display: flex; align-items: center; padding: 0 16px; }
  html.theme-light, .theme-light body { background: #ffffff; color: #313338; }
  .theme-light .rail { background: #e3e5e8; } .theme-light .rail i { background: #ffffff; }
  .theme-light .side { background: #f2f3f5; } .theme-light .side .gname { color: #060607; border-color: #e1e2e4; }
  .theme-light .side a { color: #5c5e66; } .theme-light .side a.on { background: #d7d9dc; color: #060607; }
  .theme-light .top { color: #060607; border-color: #e1e2e4; } .theme-light .who { color: #060607; } .theme-light .txt { color: #313338; }
  .theme-light .box { background: #ebedef; color: #80848e; }
</style></head><body><div id="app-mount" class="app-2CXKsg">
  <div class="rail"><i></i><i></i><i></i><i></i></div>
  <div class="side"><div class="gname">✿ Cozy Corner</div>
    <a href="/channels/4001/5001" class="${path.endsWith('/5001') ? 'on' : ''}"># general</a>
    <a href="/channels/4001/5002" class="${path.endsWith('/5002') ? 'on' : ''}"># art-share</a>
    <a href="/channels/4001/5003"># announcements</a>
    <a href="/channels/@me/3002"># dm alice</a>
  </div>
  <div class="main"><div class="top"># general</div><div class="chat">${rows}</div><div class="box">Message #general</div></div>
</div>
<script>
  // Discord SPA-style navigation: pushState instead of full loads.
  document.addEventListener('click', (e) => { const a = e.target.closest('a[href^="/channels/"]'); if (!a) return; e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); document.title = 'Discord | ' + a.textContent.trim(); });
</script></body></html>`;
}

export const TOKEN = 'mock-token.abc';

// Open a fresh page at a channel path with the token planted the way Discord stores it.
// Besides installMockDiscord's options:
//   viewport, dpr, reducedMotion, permissions  as Playwright's browser context takes them.
//   locale       the browser's language, e.g. 'ar-EG' (numbers and dates follow it).
//   colorScheme  prefers-color-scheme ('light' when light is set; Playwright's own default otherwise).
//   light        Discord's light theme behind the panel (html.theme-light).
//   clock        Playwright's fake clock, installed before the page loads. Time flows as usual
//                until the test moves it: page.clock.fastForward('01:15') skips a 75 s wait at once.
//   prefs        the stored prefs blob, e.g. one an older version wrote (default: welcomed).
//   firstRun     no prefs at all, so the welcome shows.
export async function openDiscord(browser, path = '/channels/4001/5001', opts = {}) {
  const context = await browser.newContext({
    permissions: opts.permissions || [],
    viewport: opts.viewport || { width: 1440, height: 900 },
    deviceScaleFactor: opts.dpr || 1,
    reducedMotion: opts.reducedMotion || 'no-preference',
    ...(opts.locale ? { locale: opts.locale } : {}),
    ...(opts.colorScheme || opts.light ? { colorScheme: opts.colorScheme || 'light' } : {}),
  });
  if (opts.clock) await context.clock.install();
  const page = await context.newPage();
  const mock = await installMockDiscord(page, opts);
  // Token (and, unless testing first run, "already welcomed") planted once in the top frame,
  // so tests can change them later the way Discord would.
  const prefs = opts.firstRun ? null : opts.prefs || { welcomed: true };
  await page.addInitScript(({ t, prefs }) => {
    if (window.top !== window || sessionStorage.getItem('planted')) return;
    try {
      localStorage.setItem('token', JSON.stringify(t));
      if (prefs) localStorage.setItem('dopa-purifier:prefs', JSON.stringify(prefs));
      sessionStorage.setItem('planted', '1');
    } catch {}
  }, { t: opts.token || TOKEN, prefs });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/^Failed to load resource/.test(msg.text())) pageErrors.push('console: ' + msg.text()); });
  await page.goto('https://discord.com' + path);
  return { context, page, ...mock, pageErrors };
}

// The build's pace, made quick for tests. fast true sets 20 ms between deletes and 10 ms between
// searches; an object also sets any other TIMING key by name, e.g. { deleteDelayMs: 150 } or a
// retry step a later build adds. A key the build doesn't have throws, so a renamed constant can't
// quietly leave a test waiting at the real pace. fast false keeps the build's own timings.
export function withTiming(source, fast = true) {
  if (!fast) return source;
  const keys = { deleteDelayMs: 20, searchDelayMs: 10, ...(fast === true ? {} : fast) };
  const timing = /const TIMING = \{([^}]*)\}/.exec(source);
  if (!timing) throw new Error('withTiming: the build has no const TIMING = { … }');
  let body = timing[1];
  for (const [key, value] of Object.entries(keys)) {
    const at = new RegExp(`\\b${key}:\\s*\\d+`);
    if (!at.test(body)) throw new Error(`withTiming: TIMING has no ${key}`);
    body = body.replace(at, `${key}: ${value}`);
  }
  return source.replace(timing[0], () => `const TIMING = {${body}}`);
}

// Inject a userscript, at a quick pace unless fast is false (see withTiming).
export async function injectUserscript(page, source, { fast = true } = {}) {
  await page.addScriptTag({ content: withTiming(source, fast) });
}
