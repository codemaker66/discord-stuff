// End-to-end behaviour tests for the v4 purifier against the stateful mock Discord.
// node e2e.mjs <userscript.js> [outDir]
// BROWSER=firefox|webkit runs it in another engine (chromium by default); CI smokes a few tests there.
import { chromium, firefox, webkit } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDiscord, injectUserscript, installMockDiscord, buildWorld, withTiming, addMine, TOKEN } from './mock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] || path.join(here, '../dist/dopas-discord-purifier.user.js'));
const PLUGIN = path.join(path.dirname(SRC), 'DopasPurifier.plugin.js');
const OUT = process.argv[3] || path.join(here, 'out/e2e');
fs.mkdirSync(OUT, { recursive: true });
const source = fs.readFileSync(SRC, 'utf8');
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const engines = { chromium, firefox, webkit };
const engine = engines[process.env.BROWSER || 'chromium'];
if (!engine) throw new Error(`BROWSER must be one of ${Object.keys(engines).join(', ')}`);
const browser = await engine.launch();
const results = [];

async function test(name, fn) {
  if (only && !only.some((o) => name === o || name.startsWith(`${o} `))) return; // ONLY=T1 is T1, not T1xx
  const t0 = Date.now();
  let ctx;
  try {
    ctx = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`✓ ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: String(err && err.stack || err).split('\n').slice(0, 4).join(' | ') });
    console.log(`✗ ${name}\n    ${String(err && err.message || err)}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }

async function boot(path, opts = {}) {
  const env = await openDiscord(browser, path, opts);
  await injectUserscript(env.page, source, { fast: opts.fast !== false });
  await env.page.waitForSelector('[data-role="layer"]', { state: 'attached' });
  await settled(env.page);
  return env;
}

// The chat is named and the panel's entrance (D33) has played.
async function settled(page) {
  await page.waitForFunction(() => {
    const r = document.querySelector('#dopa-purifier-host')?.shadowRoot;
    const el = r && r.querySelector('[data-role="target-name"]');
    return el && el.textContent !== 'finding this chat…' && r.querySelector('.panel').getAnimations().length === 0;
  }, null, { timeout: 8000 });
}

// A line joins its phrases with a no-break space before the dot (SEP); tests compare plain spaces.
const spaced = (s) => (typeof s === 'string' ? s.replace(/\u00a0/g, ' ') : s);
const text = async (page, sel) => spaced(await page.locator(sel).first().textContent());
const count = async (page) => Number((await text(page, '[data-role="count"]')).replace(/\D/g, '')) || 0;
const status = (page) => text(page, '[data-role="status-text"]');
// What the footer says aloud: its .sr (a number the line no longer repeats, D37) and then the line.
const heard = (page) => page.evaluate(() => {
  const el = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]');
  const sr = el.querySelector(':scope > .sr');
  return ((sr ? sr.textContent : '') + el.querySelector('[data-role="status-text"]').textContent).replace(/ /g, ' ');
});
// In the page: whether the footer's line, as shown or as heard, matches.
const FOOTER_SAYS = (src) => {
  const el = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]');
  const shown = el.querySelector('[data-role="status-text"]').textContent.replace(/ /g, ' ');
  const sr = el.querySelector(':scope > .sr');
  return new RegExp(src).test(shown) || new RegExp(src).test((sr ? sr.textContent : '') + shown);
};

async function holdConfirm(page, ms = 1100) {
  const btn = page.locator('[data-act="confirm"]');
  await btn.waitFor({ state: 'visible' });
  const box = await btn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

async function waitEnd(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run;
    return t === 'idle';
  }, null, { timeout });
}

const mine = (world, cid) => (world.messages[cid] || []).filter((m) => m.author.id === world.me.id);

await test('T1 guild channel: scan is one request, purge deletes exactly mine', async () => {
  const { page, stats, world, pageErrors, context } = await boot('/channels/4001/5001');
  assert((await text(page, '[data-role="target-name"]')) === 'general', 'target name');
  assert((await text(page, '[data-role="target-context"]')) === '✿ Cozy Corner', 'guild context');
  const before = stats.searches;
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found|clear/i.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  assert(stats.searches - before === 1, `scan used ${stats.searches - before} searches`);
  assert((await heard(page)).startsWith('40 messages found'), `status: ${await status(page)}`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert((await text(page, '.pill-name')) === 'general' && (await text(page, '.pill-context')) === '· ✿ Cozy Corner', 'modal names target');
  assert(/all 40 of your messages/.test(await text(page, '.modal-lead')), 'modal states the count');
  // A quick click must NOT confirm.
  await page.click('[data-act="confirm"]');
  await page.waitForTimeout(300);
  assert(stats.deletes.length === 0, 'tap did not delete');
  assert(await page.locator('.modal-layer').isVisible(), 'modal still open after tap');
  await holdConfirm(page);
  await waitEnd(page);
  assert(stats.deletes.length === 40, `deleted ${stats.deletes.length}`);
  assert(mine(world, '5001').length === 0, 'none of mine left');
  assert(world.messages['5001'].length === 85, 'others untouched (incl. the second account)');
  assert((await count(page)) === 40, 'counter shows 40');
  assert(/^All clean~/.test(await text(page, '[data-role="readout-line"]')), 'hero verdict');
  assert(/^Done in \d+s ♡$/.test(await status(page)), `final status ${await status(page)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await page.screenshot({ path: `${OUT}/t1-done.png` });
  await context.close();
});

await test('T2 DM: search count, history purge, call message skipped not failed', async () => {
  const { page, stats, world, pageErrors, context } = await boot('/channels/@me/3002');
  assert((await text(page, '[data-role="target-name"]')) === 'Alice ✿', 'dm name uses display name');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found|clear/i.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  assert((await heard(page)).startsWith('31 messages found'), `scan status ${await status(page)}`);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  const left = mine(world, '3002');
  assert(left.length === 1 && left[0].type === 3, `left: ${JSON.stringify(left.map((m) => m.type))}`);
  assert(stats.deletes.length === 31, `deleted ${stats.deletes.length}`);
  const logText = await page.locator('[data-role="term-body"]').textContent();
  assert(/kept a call notice — Discord doesn't let anyone delete those/.test(logText), 'skip logged');
  assert(!/FAILED/.test(logText), 'no failures');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T3 protected DM is immune in current tab', async () => {
  const { page, stats, context } = await boot('/channels/@me/3001');
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'purify disabled');
  assert(await page.locator('[data-act="scan"]').isDisabled(), 'scan disabled');
  assert(await page.locator('[data-role="target"]').getAttribute('data-state') === 'immune' && (await text(page, '[data-role="eyebrow"]')).includes('Direct message'), 'immune card');
  assert(stats.deletes.length === 0, 'nothing deleted');
  await page.screenshot({ path: `${OUT}/t3-immune.png` });
  await context.close();
});

await test('T4 hostile names render as text (no XSS)', async () => {
  const { page, context } = await boot('/channels/@me/3003');
  const name = await text(page, '[data-role="target-name"]');
  assert(name.includes('<img'), `name shown literally: ${name}`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert(!(await page.locator('.modal-layer').isVisible()), 'esc closes modal');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('.guild');
  await page.locator('.guild-head').nth(1).click();
  await page.waitForTimeout(400);
  await page.click('[data-act="logs"]');
  await page.waitForTimeout(300);
  const xss = await page.evaluate(() => window.__xss || 0);
  assert(xss === 0, `xss fired ${xss}`);
  await context.close();
});

await test('T5 batch: DM + new friend DM + channels, inaccessible channel skipped, run continues', async () => {
  const { page, stats, world, pageErrors, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  // Bardo row is immune and has no checkbox.
  assert(await page.locator('.row-immune').count() === 1, 'one immune row');
  assert(await page.locator('.row-immune input').count() === 0, 'immune row not selectable');
  await page.click('[data-key="c:3003"]');
  await openFriends(page);
  await page.click('[data-key="u:2004"]');
  await page.locator('.guild-head').first().click();
  await page.waitForSelector('[data-key="c:5002"]');
  await page.click('[data-key="c:5002"]');
  await page.click('[data-key="c:5007"]');
  // The badge counts ticks; Purify selected carries no fourth number (D40).
  assert(await page.locator('[data-role="purify-count"]').isHidden(), 'no count chip on Purify selected');
  assert((await text(page, '[data-role="tab-badge"]')) === '4', 'tab badge');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /Counted~/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), null, { timeout: 15000 });
  assert(stats.opened.length === 0, 'scanning never opens a DM');
  assert(/^2 friends · 1 picked$/.test(spaced(await text(page, '[data-role="fold-meta"]'))), `the fold says its DMs are closed: ${await text(page, '[data-role="fold-meta"]')}`);
  // A chat Discord won't let you into unticks at Count, and says why (D40).
  assert(await page.locator('[data-key="c:5007"]').getAttribute('data-state') === 'error' && !(await page.locator('[data-key="c:5007"] .check').isChecked())
    && (await text(page, '[data-role="tab-badge"]')) === '3', 'mod-only unticked at Count');
  // The count is the readiness: the row stays one line, with no banner.
  const ready = page.locator('[data-key="c:3003"]');
  assert(await ready.getAttribute('data-state') === 'ready' && (await ready.locator('.row-meta').textContent()) === '7 msgs'
    && await ready.locator('.row-tag').isHidden(), `ready row ${await ready.textContent()}`);
  await page.screenshot({ path: `${OUT}/t5-scanned.png` });
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(await page.locator('.modal-item').count() === 3, 'modal lists the 3 that go');
  await holdConfirm(page);
  await waitEnd(page, 40000);
  assert(mine(world, '3003').length === 0, 'mallory DM purged');
  assert(mine(world, '5002').length === 0, 'art-share purged');
  assert(mine(world, '5007').length === 5, 'mod-only untouched');
  assert(stats.deletes.length === 17, `deleted ${stats.deletes.length}`);
  const modState = await page.locator('[data-key="c:5007"]').getAttribute('data-state');
  assert(modState === 'error', `mod-only state ${modState}`);
  const artState = await page.locator('[data-key="c:5002"]').getAttribute('data-state');
  assert(artState === 'done', `art state ${artState}`);
  assert(mine(world, '3001').length === 8, 'bardo untouched');
  assert(stats.opened.length === 1 && stats.closed.includes(stats.opened[0]), 'empty DM opened for the purge was closed again');
  assert(!/skipped/.test(await status(page)), `the chat left out at Count isn't reported again: ${await status(page)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await page.screenshot({ path: `${OUT}/t5-done.png` });
  await context.close();
});

await test('T6 rate limits are absorbed, nothing fails, pace slows', async () => {
  const { page, stats, world, context } = await boot('/channels/4001/5002', { rateLimitEvery: 4 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 30000);
  assert(mine(world, '5002').length === 0, 'all purged');
  const logText = await page.locator('[data-role="term-body"]').textContent();
  assert(/slow down/.test(logText), 'slow-down logged');
  assert(!/FAILED/.test(logText), 'no failures');
  assert(stats.deletes.length === 10, `deleted ${stats.deletes.length}`);
  await context.close();
});

await test('T7 search index 202 is waited out', async () => {
  const { page, context } = await boot('/channels/4001/5001', { indexingOnce: ['5001'] });
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent), null, { timeout: 10000 });
  assert((await heard(page)).startsWith('40 messages found'), await status(page));
  await context.close();
});

await test('T8 pause holds, resume continues, stop stops', async () => {
  const { page, stats, world, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 5);
  await page.click('[data-act="pause"]');
  await page.waitForTimeout(200);
  const a = stats.deletes.length;
  await page.waitForTimeout(700);
  assert(stats.deletes.length === a, `deleted while paused ${a}→${stats.deletes.length}`);
  assert((await status(page)).startsWith('Resume picks up right here~'), await status(page));
  await page.screenshot({ path: `${OUT}/t8-paused.png` });
  await page.click('[data-act="resume"]');
  await page.waitForFunction((n) => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= n + 3, a);
  await page.click('[data-act="stop"]');
  await waitEnd(page, 5000);
  const stoppedAt = stats.deletes.length;
  await page.waitForTimeout(500);
  assert(stats.deletes.length === stoppedAt, 'no deletes after stop');
  assert(stoppedAt < 40 && mine(world, '5001').length === 40 - stoppedAt, 'partial');
  assert(/^Purify picks up the rest~$/.test(await status(page)), await status(page));
  await context.close();
});

await test('T9 bad token surfaces a clear error', async () => {
  const env = await openDiscord(browser, '/channels/4001/5001', { badToken: true });
  await injectUserscript(env.page, source);
  await env.page.waitForSelector('[data-role="layer"]', { state: 'attached' });
  await env.page.waitForTimeout(800);
  await env.page.click('[data-act="scan"]').catch(() => {});
  await env.page.waitForTimeout(500);
  const st = await status(env.page);
  const disabled = await env.page.locator('[data-act="scan"]').isDisabled();
  assert(disabled || /Login not working/.test(st), `status ${st}`);
  assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
  await env.context.close();
});

await test('T10 reduced motion: no particles', async () => {
  const { page, context } = await boot('/channels/4001/5002', { reducedMotion: 'reduce' });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForTimeout(300);
  const drops = await page.locator('.drop').count();
  await waitEnd(page);
  await page.waitForTimeout(100);
  const confetti = await page.locator('.confetti').count();
  assert(drops === 0 && confetti === 0, `drops ${drops} confetti ${confetti}`);
  await context.close();
});

await test('T11 layout: batch fits a 720px viewport; drag clamps and persists', async () => {
  const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1280, height: 720 } });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('.guild');
  await page.locator('.guild-head').first().click();
  await page.waitForTimeout(500);
  const r = await page.locator('.panel').boundingBox();
  assert(r.y + r.height <= 720, `panel bottom ${r.y + r.height}`);
  const foot = await page.locator('.foot').boundingBox();
  assert(foot.y + foot.height <= 720, 'footer visible');
  await page.screenshot({ path: `${OUT}/t11-batch-720.png` });
  const head = await page.locator('.head').boundingBox();
  await page.mouse.move(head.x + 120, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(-400, 2000, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.locator('.panel').boundingBox();
  assert(after.x >= 0 && after.y >= 0 && after.y < 720 - 100, `clamped ${JSON.stringify(after)}`);
  // Away from any chat the panel opens on the tab you last chose (on a chat, on This chat).
  await page.goto('https://discord.com/channels/@me');
  await injectUserscript(page, source);
  await page.waitForSelector('[data-role="layer"]', { state: 'attached' });
  await page.waitForTimeout(400);
  const reloaded = await page.locator('.panel').boundingBox();
  assert(Math.abs(reloaded.x - after.x) < 3, `persisted x ${reloaded.x} vs ${after.x}`);
  assert(await page.locator('.tab[data-tab="batch"][aria-selected="true"]').count() === 1, 'tab persisted');
  await context.close();
});

await test('T12 SPA navigation updates the target', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('a[href="/channels/4001/5002"]');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]').textContent === 'art-share', null, { timeout: 4000 });
  await page.click('a[href="/channels/@me/3002"]');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]').textContent === 'Alice ✿', null, { timeout: 4000 });
  await context.close();
});

await test('T13 minimise keeps the run going and restores', async () => {
  const { page, stats, world, context } = await boot('/channels/4001/5002', { latencyMs: 60 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.click('[data-act="minimize"]');
  await page.locator('.orb').waitFor({ state: 'visible', timeout: 3000 });
  // The orb appears while the panel is still folding into it, then the panel goes.
  await page.locator('.panel').waitFor({ state: 'hidden', timeout: 1000 });
  await waitEnd(page);
  assert(mine(world, '5002').length === 0, 'run completed while minimised');
  assert(await page.locator('.orb[data-live="done"]').count() === 1, 'orb shows the finished run');
  await page.click('.orb');
  await page.waitForTimeout(500);
  assert(await page.locator('.panel').isVisible(), 'restored');
  await context.close();
});

await test('T288 a run that ends while the panel folds into the orb leaves its finish on the orb', async () => {
  // One message of yours in #off-topic, its delete held until the panel has started folding away.
  const world = buildWorld();
  let kept = false;
  world.messages['5002'] = world.messages['5002'].filter((m) => m.author.id !== world.me.id || (m.type === 0 && !kept && (kept = true)));
  const { page, context } = await boot('/channels/4001/5002', { world });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route(/\/api\/v\d+\/channels\/\d+\/messages\/\d+$/, async (route) => {
    if (route.request().method() === 'DELETE') await held;
    await route.fallback();
  });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.click('[data-act="minimize"]');
  release(); // the delete lands and the run ends inside the 320 ms fold
  await waitEnd(page);
  await page.locator('[data-role="shell"]').waitFor({ state: 'hidden', timeout: 3000 });
  const live = await page.locator('.orb').getAttribute('data-live');
  assert(live === 'done', `the orb after a finish mid-fold: ${live}`);
  await context.close();
});

await test('T14 keyboard: Tab is trapped in dialog, Space-hold confirms', async () => {
  const { page, world, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const focused = () => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.activeElement?.dataset.act);
  assert((await focused()) === 'cancel', 'safe default focused');
  await page.keyboard.press('Tab');
  assert((await focused()) === 'confirm', 'tab to confirm');
  await page.keyboard.press('Tab');
  assert((await focused()) === 'cancel', 'wraps');
  await page.keyboard.press('Tab');
  await page.keyboard.down('Space');
  await page.waitForTimeout(1100);
  await page.keyboard.up('Space');
  await waitEnd(page);
  assert(mine(world, '5002').length === 0, 'keyboard hold purged');
  await context.close();
});

await test('T15 batch without scanning: friend DM opened mid-run, totals grow honestly', async () => {
  const { page, stats, world, pageErrors, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await openFriends(page);
  await page.click('[data-key="u:2004"]');
  await page.click('[data-key="c:3002"]');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 30000);
  assert(stats.opened.length === 1, 'bob DM opened during run');
  assert(mine(world, '3002').filter((m) => m.type !== 3).length === 0, 'alice DM purged');
  assert(stats.deletes.length === 31, `deleted ${stats.deletes.length}`);
  const bob = page.locator(`[data-key="c:${stats.opened[0]}"]`);
  assert(await bob.count() === 1, 'bob row re-keyed to its new channel');
  assert((await bob.getAttribute('data-state')) === 'done', `bob state ${await bob.getAttribute('data-state')}`);
  const pct = await text(page, '[data-role="pct"]');
  assert(pct === '31 of 31', `pct ${pct}`);
  const beaded = await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.dial.is-beaded').length);
  assert(beaded === 0, 'the strip draws an arc, never notches (D44)');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T16 thread replies found by a parent-channel search are deleted in their thread', async () => {
  const { page, stats, world, context } = await boot('/channels/4001/5003');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  assert((await heard(page)).startsWith('5 messages found'), await status(page));
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(mine(world, '5103').length === 0 && mine(world, '5003').length === 0, 'thread + channel purged');
  assert(stats.deleteChannels.filter((c) => c === '5103').length === 3, `thread deletes went to the thread: ${stats.deleteChannels}`);
  assert((await count(page)) === 5, 'counter is honest');
  await context.close();
});

await test('T17 account switch in place: next scan uses the new account, lists reset, run refuses stale confirm', async () => {
  const { page, stats, world, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  assert((await heard(page)).startsWith('40 messages found'), await status(page));
  await page.evaluate(() => localStorage.setItem('token', JSON.stringify('mock-token.b')));
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found|Switched Discord accounts/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  await page.waitForTimeout(300);
  if (!/5 messages found/.test(await heard(page))) {
    await page.click('[data-act="scan"]');
    await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  }
  assert(/5 messages found/.test(await heard(page)), `second account count: ${await status(page)}`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(/@second\.acc/.test(await text(page, '.modal-who')), 'dialog names the acting account');
  await holdConfirm(page);
  await waitEnd(page);
  assert(mine(world, '5001').length === 40, 'first account untouched');
  assert(world.messages['5001'].filter((m) => m.author.id === '1001').length === 0, 'second account purged');
  const lastTokens = stats.tokens.slice(-5);
  assert(lastTokens.every((t) => t === 'mock-token.b'), 'requests carry the new token');
  await context.close();
});

// Purify counts first, so a chat you can't read is turned down before any dialog: a purge there could only fail.
await test('T18 current channel without access says so, never "all clean", and asks nothing', async () => {
  const { page, world, stats, context } = await boot('/channels/4001/5007');
  await page.click('[data-act="purify"]');
  await page.waitForFunction(() => /No access here/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  assert(await page.locator('[data-role="status"]').getAttribute('data-tone') === 'error', 'said as an error');
  assert(await page.locator('.modal-layer[data-open="true"]').count() === 0, 'no dialog for a chat that can only fail');
  const sent = stats.log.length;
  await page.locator('[data-act="purify"]').evaluate((b) => b.click()); // again (if it is still offered at all)
  await page.waitForTimeout(300);
  assert(stats.log.length === sent && await page.locator('.modal-layer[data-open="true"]').count() === 0, `a second press asked Discord again: ${stats.log.slice(sent)}`);
  assert(mine(world, '5007').length === 5 && stats.deletes.length === 0, 'nothing deleted');
  const st = await status(page);
  assert(!/All clean|All clear/.test(st), `status ${st}`);
  assert(!/All clean|All clear/.test(await text(page, '[data-role="readout-line"]')), 'readout not all clean');
  assert(await page.locator('.confetti').count() === 0, 'no confetti');
  await context.close();
});

await test('T19 "All" skips friends without a DM', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="u:2004"]', { state: 'attached' });
  await page.click('[data-act="dm-all"]');
  const picked = await page.evaluate(() => [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.row.is-selected')].map((r) => r.dataset.key));
  assert(picked.length === 3 && picked.every((k) => k.startsWith('c:')), `picked ${picked}`);
  await context.close();
});

await test('T20 deleted message text is scrubbed from the log once the run ends', async () => {
  const { page, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  const log = await page.locator('[data-role="term-body"]').textContent();
  assert(!/princess\.dopa message/.test(log), 'no message content left in the log');
  assert(/Deleted ✓/.test(log), 'kills still listed');
  await context.close();
});

await test('T21 deep historical index: warns instead of declaring all clean', async () => {
  const { page, context } = await boot('/channels/4001/5002', { deepIndex: ['5002'] });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  const st = await status(page);
  assert(/later/.test(st), `status ${st}`);
  assert(/indexing/.test(await page.locator('[data-role="term-body"]').textContent()), 'log explains indexing');
  await context.close();
});

await test('T22 reduced motion: no infinite CSS animations anywhere in the UI', async () => {
  const { page, context } = await boot('/channels/4001/5001', { reducedMotion: 'reduce' });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('.row-immune');
  const infinite = await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.getAnimations()
    .filter((a) => a.effect && a.effect.getTiming().iterations === Infinity && a.playState === 'running').map((a) => a.animationName || 'waapi'));
  assert(infinite.length === 0, `still looping: ${infinite}`);
  await context.close();
});

await test('T23 double-clicking Pause really pauses', async () => {
  const { page, stats, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 3);
  await page.dblclick('[data-act="pause"]');
  await page.waitForTimeout(250);
  const a = stats.deletes.length;
  await page.waitForTimeout(600);
  assert(stats.deletes.length === a, `kept deleting after a double-click on Pause (${a}→${stats.deletes.length})`);
  await page.click('[data-act="stop"]');
  await waitEnd(page, 5000);
  await context.close();
});

await test('T24 Esc then immediate reopen leaves a usable dialog', async () => {
  const { page, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.keyboard.press('Escape');
  await page.click('[data-act="purify"]');
  await page.waitForTimeout(400);
  assert(await page.locator('.modal').isVisible(), 'reopened dialog is visible');
  await page.locator('.modal-title').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert(!(await page.locator('.modal').isVisible()), 'Esc works after clicking the dialog body');
  await context.close();
});

await test('T25 resize while minimised restores the panel on-screen', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="minimize"]');
  await page.locator('.orb').waitFor({ state: 'visible' });
  await page.setViewportSize({ width: 800, height: 700 });
  await page.waitForTimeout(200);
  await page.click('.orb');
  await page.waitForTimeout(500);
  const b = await page.locator('.panel').boundingBox();
  assert(b.x >= 0 && b.x + b.width <= 800 && b.y + b.height <= 700, `panel ${JSON.stringify(b)}`);
  await context.close();
});

await test('T26 list tools are locked during a run', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.click('[data-key="c:3002"]');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run === 'running');
  for (const act of ['dm-refresh', 'dm-all', 'dm-none', 'server-refresh']) {
    assert(await page.locator(`[data-act="${act}"]`).isDisabled(), `${act} disabled mid-run`);
  }
  await page.click('[data-act="stop"]');
  await waitEnd(page, 5000);
  await context.close();
});

await test('T27 account switch + navigation mid-run stops the run; nothing is sent as the other account', async () => {
  const { page, stats, world, context } = await boot('/channels/4001/5001', { latencyMs: 40 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 5);
  const firstDelete = stats.log.findIndex((l) => l.startsWith('DELETE'));
  await page.evaluate(() => localStorage.setItem('token', JSON.stringify('mock-token.b')));
  await page.click('a[href="/channels/4001/5002"]');
  await waitEnd(page, 10000);
  const deleteTokens = stats.log.map((l, i) => [l, stats.tokens[i]]).filter(([l]) => l.startsWith('DELETE /api/v9/channels/')).map(([, t]) => t);
  assert(deleteTokens.length > 0 && deleteTokens.every((t) => t === 'mock-token.abc'), `delete tokens: ${[...new Set(deleteTokens)]}`);
  assert(/^Switched accounts~ \d+ messages? purged/.test(await status(page)), `status ${await status(page)}`);
  assert(mine(world, '5001').length > 0, 'run stopped before finishing');
  assert(firstDelete >= 0, 'had deletes');
  await context.close();
});

// A chat Discord is still indexing ends with a problem (#mod-only no longer gets as far as a run: T18).
await test('T28 a run that ends badly while minimised does not show a happy orb', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 400, deepIndex: ['5002'] });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.click('[data-act="minimize"]');
  await page.locator('.orb').waitFor({ state: 'visible' });
  await waitEnd(page);
  const live = await page.locator('.orb').getAttribute('data-live');
  assert(live === 'trouble', `orb state ${live}`);
  await context.close();
});

await test('T29 batch lists opened during a run load when it finishes', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 30 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.click('.tab[data-tab="batch"]');
  await page.waitForTimeout(150);
  assert(/when purifying is done/.test(await text(page, '[data-role="dm-list"]')), 'placeholder while running');
  await waitEnd(page);
  await page.waitForSelector('[data-key="c:3002"]', { timeout: 4000 });
  await page.waitForSelector('.guild', { timeout: 4000 });
  await context.close();
});

await test('T30 after Stop the cached count matches what is left', async () => {
  const { page, world, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 8);
  await page.click('[data-act="stop"]');
  await waitEnd(page, 5000);
  const left = mine(world, '5001').length;
  const chip = await page.locator('[data-role="purify-count"]').isVisible() ? Number(await text(page, '[data-role="purify-count"]')) : null;
  assert(chip === null || chip === left, `chip ${chip} vs ${left} left`);
  assert(await page.locator('[data-act="purify"]').isEnabled(), 'purify still available');
  await context.close();
});

await test('T31 first run: welcome card explains the three steps, "Got it" sticks', async () => {
  const { page, context } = await boot('/channels/4001/5001', { firstRun: true });
  assert(await page.locator('[data-role="welcome"]').isVisible(), 'welcome shown on first run');
  assert(/Purify, then hold the red button/.test(await text(page, '.welcome-steps')), 'steps listed');
  await page.click('[data-act="welcome-ok"]');
  await page.locator('[data-role="welcome"]').waitFor({ state: 'hidden', timeout: 1000 }); // it fades out
  await page.waitForTimeout(400);
  await page.reload();
  await injectUserscript(page, source);
  await page.waitForSelector('[data-role="layer"]', { state: 'attached' });
  await page.waitForTimeout(300);
  assert(!(await page.locator('[data-role="welcome"]').isVisible()), 'not shown again');
  await context.close();
});

await test('T32 Share copies the install link', async () => {
  const { page, context } = await boot('/channels/4001/5001', { permissions: ['clipboard-read', 'clipboard-write'] });
  await page.click('[data-act="share"]');
  await page.waitForTimeout(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert(/https:\/\/\S+/.test(clip) && /Purifier/.test(clip), `clipboard: ${clip}`);
  assert(/copied/.test(await status(page)), await status(page));
  await context.close();
});

await test('T33 shields: protect a DM, it persists, Bardo can be released', async () => {
  const { page, stats, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.hover('[data-key="c:3002"]');
  await page.click('[data-key="c:3002"] .shield-btn');
  await page.waitForTimeout(200);
  assert(await page.locator('[data-key="c:3002"].row-immune').count() === 1, 'Alice row is immune now');
  assert(await page.locator('[data-key="c:3002"] input').count() === 0, 'no checkbox on an immune row');
  await page.click('[data-key="c:3001"] .shield-btn');
  await page.waitForTimeout(200);
  assert(await page.locator('[data-key="c:3001"] input').count() === 1, 'Bardo released and selectable');
  await page.waitForTimeout(400);
  await page.goto('https://discord.com/channels/@me/3002');
  await injectUserscript(page, source);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]').textContent !== 'finding this chat…');
  await page.click('.tab[data-tab="current"]');
  await page.waitForTimeout(200);
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'shielded DM cannot be purified after reload');
  assert(stats.deletes.length === 0, 'nothing deleted');
  await context.close();
});

await test('T34 BetterDiscord plugin: start, stop mid-purge cleans up, start again', async () => {
  const plugin = fs.readFileSync(PLUGIN, 'utf8').replace(/deleteDelayMs:\s*\d+/, 'deleteDelayMs: 40').replace(/searchDelayMs:\s*\d+/, 'searchDelayMs: 10');
  const env = await openDiscord(browser, '/channels/4001/5001', { latencyMs: 20 });
  const { page, stats } = env;
  await page.evaluate((code) => {
    const module = { exports: {} };
    new Function('module', 'exports', code)(module, module.exports);
    window.__bd = new module.exports();
    window.__bd.start();
  }, plugin);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]').textContent === 'general');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 3);
  await page.evaluate(() => window.__bd.stop());
  const after = stats.deletes.length;
  await page.waitForTimeout(600);
  assert(stats.deletes.length <= after + 1, `kept deleting after stop(): ${after} → ${stats.deletes.length}`);
  assert(await page.evaluate(() => !document.querySelector('#dopa-purifier-host') && !window.__dopaPurifier), 'UI and global removed');
  await page.click('a[href="/channels/4001/5002"]');
  await page.waitForTimeout(900);
  assert(env.pageErrors.length === 0, `errors after stop: ${env.pageErrors.join('; ')}`);
  await page.evaluate(() => window.__bd.start());
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]').textContent === 'art-share');
  await env.context.close();
});

await test('T35 on the install page the script only announces itself', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://codemaker66.github.io/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>install</title><p>hi</p>' }));
  await page.goto('https://codemaker66.github.io/discord-stuff/');
  await page.addScriptTag({ content: source });
  const v = await page.evaluate(() => document.documentElement.dataset.dopaPurifier);
  assert(/^\d+\.\d+\.\d+$/.test(v || ''), `version marker ${v}`);
  assert(await page.evaluate(() => !document.querySelector('#dopa-purifier-host')), 'no panel on the install page');
  await context.close();
});

// Two Discord tabs share one prefs entry: an ordinary save in one tab must not drop the other
// tab's shields, and a shield set while another tab is mid-purge still protects that chat.
await test('T36 shields hold across tabs, even mid-purge', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((t) => {
    if (window.top !== window || localStorage.getItem('token')) return;
    localStorage.setItem('token', JSON.stringify(t));
    localStorage.setItem('dopa-purifier:prefs', JSON.stringify({ welcomed: true }));
  }, TOKEN);
  const world = buildWorld();
  const open = async (path) => {
    const page = await context.newPage();
    const { stats } = await installMockDiscord(page, { world, latencyMs: 30 });
    await page.goto('https://discord.com' + path);
    await injectUserscript(page, source);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent !== 'finding this chat…');
    return { page, stats };
  };
  const a = await open('/channels/4001/5001');
  const b = await open('/channels/4001/5002');
  const mine = (cid) => world.messages[cid].filter((m) => m.author.id === world.me.id).length;
  const aliceBefore = mine('3002');
  // Tab B queues Mallory's DM, then Alice's, and starts purging.
  await b.page.click('.tab[data-tab="batch"]');
  await b.page.waitForSelector('[data-key="c:3002"]');
  await b.page.click('[data-key="c:3003"]');
  await b.page.click('[data-key="c:3002"]');
  await b.page.click('[data-act="purify"]');
  await holdConfirm(b.page);
  while (b.stats.deletes.length < 1) await b.page.waitForTimeout(20);
  await b.page.click('[data-act="pause"]');
  // Meanwhile tab A shields Alice.
  await a.page.click('.tab[data-tab="batch"]');
  await a.page.waitForSelector('[data-key="c:3002"]');
  await a.page.click('[data-key="c:3002"] .shield-btn');
  await b.page.waitForTimeout(400);
  await b.page.click('[data-act="resume"]');
  await waitEnd(b.page);
  assert(mine('3003') === 0, `Mallory's DM purged (${mine('3003')} left)`);
  assert(mine('3002') === aliceBefore && !b.stats.deleteChannels.includes('3002'), 'nothing deleted in the DM shielded mid-run');
  assert(await b.page.locator('[data-key="c:3002"].row-immune').count() === 1, 'tab B shows Alice as immune after the run');
  // An ordinary save in tab B (switching tabs) keeps tab A's shield.
  await b.page.click('.tab[data-tab="current"]');
  await b.page.waitForTimeout(500);
  const stored = await a.page.evaluate(() => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    const v = JSON.parse(f.contentWindow.localStorage.getItem('dopa-purifier:prefs'));
    f.remove();
    return v;
  });
  assert(stored.protectedIds.includes('2002') && stored.tab === 'current', `prefs after tab B saved: ${JSON.stringify(stored)}`);
  await context.close();
});

// While Discord is still building its search index, a count is a floor, not a verdict.
await test('T37 scan is honest while Discord is still indexing', async () => {
  {
    const { page, context } = await boot('/channels/4001/5002', { deepIndex: ['5002'] });
    await page.click('[data-act="scan"]');
    await page.waitForFunction(() => /found so far/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
    assert(/10 messages found so far/.test(await heard(page)), `status: ${await heard(page)}`);
    assert(!(await page.locator('[data-act="purify"]').isDisabled()), 'purify offered');
    await context.close();
  }
  {
    const env = await openDiscord(browser, '/channels/4001/5002');
    await env.page.route('https://discord.com/api/v9/guilds/*/messages/search*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ total_results: 0, messages: [], doing_deep_historical_index: true }),
    }));
    await injectUserscript(env.page, source);
    const { page } = env;
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent !== 'finding this chat…');
    await page.click('[data-act="scan"]');
    await page.waitForFunction(() => /still searching/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
    assert(!/All clear/.test(await text(page, '.panel')), 'no "All clear" while indexing');
    assert(!(await page.locator('[data-act="purify"]').isDisabled()), 'purify still offered at 0 found');
    // Batch: the row says it's still indexing instead of "no messages found".
    await page.click('.tab[data-tab="batch"]');
    await page.locator('.guild-head').first().click();
    await page.waitForSelector('[data-key="c:5002"]');
    await page.click('[data-key="c:5002"]');
    await page.click('[data-act="scan"]');
    await page.waitForFunction(() => /Counted~/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
    assert(await page.locator('[data-key="c:5002"][data-state="indexing"]').count() === 1, 'row marked indexing');
    assert(/still searching/.test(await status(page)), `batch status: ${await status(page)}`);
    assert(!(await page.locator('[data-act="purify"]').isDisabled()), 'batch purify offered');
    await env.context.close();
  }
});

// Opening a friend's DM can sit in a 429 wait; Stop (and BetterDiscord's stop()) must end it.
await test('T38 Stop interrupts a rate-limited DM open', async () => {
  const plugin = fs.readFileSync(PLUGIN, 'utf8').replace(/deleteDelayMs:\s*\d+/, 'deleteDelayMs: 20').replace(/searchDelayMs:\s*\d+/, 'searchDelayMs: 10');
  for (const kind of ['userscript', 'betterdiscord']) {
    const env = await openDiscord(browser, '/channels/4001/5001');
    const { page, stats } = env;
    let throttle = true;
    const posts = [];
    await page.route('https://discord.com/api/v9/users/@me/channels', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      posts.push(Date.now());
      if (!throttle) return route.fallback();
      return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 1, global: false }) });
    });
    if (kind === 'userscript') await injectUserscript(page, source);
    else await page.evaluate((code) => { const module = { exports: {} }; new Function('module', 'exports', code)(module, module.exports); window.__bd = new module.exports(); window.__bd.start(); }, plugin);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent === 'general');
    await page.click('.tab[data-tab="batch"]');
    await openFriends(page);
    await page.click('[data-key="u:2004"]'); // Bob: a friend with no DM yet
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (!posts.length) await page.waitForTimeout(20);
    const t0 = Date.now();
    if (kind === 'userscript') await page.click('[data-act="stop"]');
    else await page.evaluate(() => window.__bd.stop());
    await page.waitForTimeout(1600);
    throttle = false;
    await page.waitForTimeout(800);
    assert(posts.filter((t) => t > t0).length === 0, `${kind}: kept POSTing after stop`);
    assert(stats.opened.length === 0, `${kind}: opened a DM after stop`);
    if (kind === 'userscript') assert(await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run) === 'idle', 'run ended');
    assert(env.pageErrors.length === 0, `${kind}: ${env.pageErrors.join('; ')}`);
    await env.context.close();
  }
});

const dialogOpen = async (page) => (await page.locator('.modal-layer').getAttribute('data-open')) === 'true';
const tone = (page) => page.locator('[data-role="status"]').getAttribute('data-tone');

// Like any native button, sliding off the hold button (here onto "Never mind~") lets go of it.
await test('T40 sliding off the hold button cancels the purge, mouse and touch', async () => {
  for (const input of ['mouse', 'touch']) {
    const { page, stats, context } = await boot('/channels/4001/5002');
    await page.click('[data-act="purify"]');
    const confirm = page.locator('[data-act="confirm"]');
    await confirm.waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    const c = await confirm.boundingBox();
    const n = await page.locator('[data-act="cancel"]').boundingBox();
    const from = [c.x + c.width / 2, c.y + c.height / 2];
    const to = [n.x + n.width / 2, n.y + n.height / 2];
    if (input === 'mouse') {
      await page.mouse.move(...from);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.move(...to, { steps: 5 });
      await page.waitForTimeout(1000);
      await page.mouse.up();
    } else {
      // A finger lifting off goes to one place and stays there. Synthetic touch moves are delivered
      // late and coalesced under CDP, so every move sits well past the button's left edge: whichever
      // lands first cancels, instead of a trail of still-inside points keeping the hold alive.
      const cdp = await context.newCDPSession(page);
      const off = [c.x - 48, from[1]];
      const at = ([x, y]) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
      await page.waitForTimeout(120);
      for (let i = 0; i < 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(off) });
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(1000);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await page.waitForTimeout(500);
    assert(stats.deletes.length === 0, `${input}: ${stats.deletes.length} deleted after sliding onto Never mind`);
    assert(await dialogOpen(page), `${input}: dialog still open`);
    await holdConfirm(page); // a real hold still works afterwards
    await waitEnd(page);
    assert(stats.deletes.length === 10, `${input}: hold after the slide-off deleted ${stats.deletes.length}`);
    await context.close();
  }
});

// Screen readers, voice control and switches activate with a bare click (detail 0) and can't hold.
await test('T41 assistive tech confirms with two presses; mouse clicks and keys still need the hold', async () => {
  const { page, stats, context } = await boot('/channels/4001/5002', { clock: true });
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const ax = nodes.find((x) => x.role && x.role.value === 'button' && /purify/i.test((x.name && x.name.value) || '') && !/Never mind/.test(x.name.value));
  const described = ax && ax.description ? ax.description.value : '';
  assert(/press twice/.test(described), `confirm button's accessible description: ${JSON.stringify(described)}`);
  const label = () => text(page, '[data-role="confirm-label"]');
  const press = () => page.locator('[data-act="confirm"]').evaluate((el) => el.click()); // a bare click, as assistive tech sends
  await page.waitForTimeout(400);
  // Ordinary clicks, key taps, and a held key's repeats after the hold was let go are not presses.
  await page.click('[data-act="confirm"]');
  await page.waitForTimeout(700);
  await page.click('[data-act="confirm"]');
  await page.locator('[data-act="confirm"]').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  await page.keyboard.down('Enter');
  await page.click('[data-act="confirm"]');
  for (let i = 0; i < 3; i++) await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await page.waitForTimeout(300);
  assert(await dialogOpen(page) && stats.deletes.length === 0, 'clicks and keys did not confirm');
  assert(!/again/.test(await label()), `not armed by clicks or keys: ${await label()}`);
  await press();
  assert(/Press again/.test(await label()) && await dialogOpen(page), `first press arms: ${await label()}`);
  await page.clock.fastForward(15300); // a first press waits 15 s for the second (D47)
  assert(/^Hold to purify/.test(await label()), `the first press expires: ${await label()}`);
  await press();
  assert(await dialogOpen(page) && stats.deletes.length === 0, 'one press after expiry only arms again');
  await press();
  // The run starts a moment after the press, once this tab holds the run lock (D29).
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run !== 'idle');
  await waitEnd(page);
  assert(stats.deletes.length === 10, `two presses purged ${stats.deletes.length}`);
  await context.close();
});

await test('T42 copy says which button to hold, and an early release says to hold it', async () => {
  const { page, stats, context } = await boot('/channels/4001/5001', { firstRun: true });
  const steps = await text(page, '.welcome-steps');
  assert(/Purify, then hold the red button/.test(steps) && !/Hold Purify/.test(steps), `welcome steps: ${steps}`);
  await page.click('[data-act="welcome-ok"]');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const label = () => text(page, '[data-role="confirm-label"]');
  assert((await label()) === 'Hold to purify ✨', `confirm label: ${await label()}`);
  await page.waitForTimeout(400);
  await page.click('[data-act="confirm"]');
  await page.waitForTimeout(300);
  assert(/Hold it down/.test(await label()), `after a quick click: ${await label()}`);
  await page.waitForTimeout(1500);
  assert((await label()) === 'Hold to purify ✨', `settles back: ${await label()}`);
  assert(stats.deletes.length === 0 && await dialogOpen(page), 'a click never purges');
  await page.click('[data-act="cancel"]');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  await page.click('[data-key="c:3003"]');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert((await label()) === 'Hold to purify all ✨', `batch confirm label: ${await label()}`);
  await context.close();
});

// A shield clicked mid-purge used to do nothing at all, then that chat was purged.
await test('T43 shields are disabled mid-purge, say why, and work again after', async () => {
  const { page, stats, world, context } = await boot('/channels/@me/3003');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.click('[data-key="c:3003"]');
  await page.click('[data-key="c:3002"]');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  while (stats.deletes.length < 1) await page.waitForTimeout(20);
  await page.click('[data-act="pause"]');
  const row = page.locator('[data-key="c:3002"] .shield-btn');
  const card = page.locator('[data-role="target-tools"] .shield-btn');
  assert(await row.isDisabled(), 'row shield disabled mid-purge');
  assert(/Stop purifying/.test(await row.getAttribute('title')), `row title: ${await row.getAttribute('title')}`);
  // During a run the card names the chat being purified (D39) and offers no shield at all.
  assert(await card.count() === 0, 'no shield on the card mid-purge');
  await page.click('[data-act="resume"]');
  await waitEnd(page);
  assert(mine(world, '3002').length === 1, 'the confirmed DM was purged (only the call message stays)');
  assert(await row.isEnabled(), 'row shield usable after the run');
  assert(/^Shield this DM/.test(await row.getAttribute('title')), `title after: ${await row.getAttribute('title')}`);
  await page.hover('[data-key="c:3002"]');
  await row.click();
  await page.waitForTimeout(200);
  assert(await page.locator('[data-key="c:3002"].row-immune').count() === 1, 'shield works after the run');
  await context.close();
});

const storedPrefs = (page) => page.evaluate(() => {
  const f = document.createElement('iframe');
  document.body.appendChild(f);
  try { return JSON.parse(f.contentWindow.localStorage.getItem('dopa-purifier:prefs')); } finally { f.remove(); }
});

// Discord's storage can be full or blocked; a shield that didn't save must not claim "immune now".
await test('T44 a shield that cannot be saved is refused, and nothing changes', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.waitForTimeout(400); // the tab switch's own save lands first
  const fill = () => page.evaluate(() => {
    // To the last code unit: big chunks alone leave room for a shield.
    for (const size of [256 * 1024, 4096, 256, 16, 1]) {
      const s = 'x'.repeat(size);
      try { for (let i = 0; ; i++) localStorage.setItem(`fill-${size}-${i}`, s); } catch {}
    }
  });
  await fill();
  const before = await storedPrefs(page);
  await page.hover('[data-key="c:3002"]');
  await page.click('[data-key="c:3002"] .shield-btn');
  await page.waitForTimeout(200);
  assert(/Couldn't save/.test(await status(page)) && !/immune now/.test(await status(page)), `status: ${await status(page)}`);
  assert(await tone(page) === 'error', 'shown as an error');
  assert(await page.locator('[data-key="c:3002"].row-immune').count() === 0, 'Alice is not shown as immune');
  assert(await page.locator('[data-key="c:3002"] .shield-btn').getAttribute('aria-pressed') === 'false', 'shield not pressed');
  // Releasing Bardo is refused the same way, and leaves him immune.
  await page.hover('[data-key="c:3001"]');
  await page.click('[data-key="c:3001"] .shield-btn');
  await page.waitForTimeout(200);
  assert(/still immune/.test(await status(page)), `release status: ${await status(page)}`);
  assert(await page.locator('[data-key="c:3001"].row-immune').count() === 1, 'Bardo still immune');
  assert(JSON.stringify(await storedPrefs(page)) === JSON.stringify(before), 'stored prefs untouched');
  // After a reload the page agrees with what it said (reloaded on a chat, the panel opens on This chat).
  await page.reload();
  await injectUserscript(page, source);
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  assert(await page.locator('[data-key="c:3002"].row-immune').count() === 0, 'still not immune after reload');
  // With room again, the same click saves exactly that one shield.
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fill-')) localStorage.removeItem(k); });
  await page.hover('[data-key="c:3002"]');
  await page.click('[data-key="c:3002"] .shield-btn');
  await page.waitForTimeout(200);
  assert(/immune now/.test(await status(page)), `status with room: ${await status(page)}`);
  const saved = await storedPrefs(page);
  assert(JSON.stringify(saved.protectedIds) === '["2002"]' && JSON.stringify(saved.released) === '[]', `saved shields: ${JSON.stringify(saved)}`);
  await context.close();
});

await test('T45 shielding the open DM mid-scan ends on "immune", not an offer to purge', async () => {
  const { page, context } = await boot('/channels/@me/3002', { latencyMs: 600 });
  const scanLabel = () => text(page, '[data-role="scan-label"]');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="scan-label"]').textContent === 'Cancel');
  await page.click('[data-role="target-tools"] .shield-btn');
  assert((await scanLabel()) === 'Cancel', 'shielded while the scan was still running');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="scan-label"]').textContent !== 'Cancel', null, { timeout: 15000 });
  assert(/^Open another chat to purify~$/.test(await status(page)) && /is immune/.test(await heard(page)), `status: ${await heard(page)}`);
  assert(await tone(page) === 'immune', 'immune tone');
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'purify stays off');
  await context.close();
});

// Purify asks Discord before its dialog (it counts the chat, then asks who you are); a Scan pressed
// meanwhile must never end up under the dialog. Scan is either unavailable while Purify counts, or it wins.
await test('T46 Scan pressed while Purify is still asking never opens the dialog over the scan', async () => {
  const env = await openDiscord(browser, '/channels/4001/5002');
  const { page, stats } = env;
  let slow = false;
  const later = (ms) => async (route) => { if (slow) await new Promise((r) => setTimeout(r, ms)); return route.fallback(); };
  await page.route('https://discord.com/api/v9/users/@me', later(1500));
  await page.route('https://discord.com/api/v9/guilds/*/messages/search*', later(3000));
  await injectUserscript(page, source);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent === 'art-share');
  slow = true;
  await page.click('[data-act="purify"]');
  await page.waitForTimeout(300);
  await page.locator('[data-act="scan"]').evaluate((b) => b.click()); // a press; a disabled Scan ignores it
  const overlap = await page.evaluate(() => new Promise((resolve) => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const t0 = performance.now();
    const look = () => {
      const open = r.querySelector('.modal-layer').dataset.open === 'true';
      const scanning = r.querySelector('[data-role="scan-label"]').textContent === 'Cancel';
      if (open && scanning) resolve('the dialog opened over a running scan');
      else if (performance.now() - t0 > 4500) resolve('');
      else requestAnimationFrame(look);
    };
    look();
  }));
  assert(!overlap, overlap);
  slow = false;
  // Whichever came first settles: the scan's count, or a dialog that couldn't wait for one.
  await page.waitForFunction(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    return r.querySelector('.modal-layer').dataset.open === 'true' || /found/.test(r.querySelector('[data-role="status"]').textContent);
  }, null, { timeout: 15000 });
  if (await dialogOpen(page)) {
    await page.click('[data-act="cancel"]');
    await page.click('[data-act="scan"]');
    await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent), null, { timeout: 15000 });
  }
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(/all 10 of your messages/.test(await text(page, '.modal-lead')), `dialog after the scan: ${await text(page, '.modal-lead')}`);
  assert(stats.deletes.length === 0, 'nothing deleted');
  await env.context.close();
});

await test('T47 batch confirm never leads with "0+" before a scan', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.click('[data-act="dm-all"]');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  let lead = await shownLead(page);
  assert(!/\b0\+/.test(lead) && lead === 'This will delete all your messages in these 3 chats:', `nothing counted: ${lead}`);
  assert((await text(page, '.modal-lead b')) === '3', 'the bold word is the number of chats');
  await page.click('[data-act="cancel"]');
  // One chat counted, two not: the known number, plus all of yours in the rest.
  await page.click('[data-act="dm-none"]');
  await page.click('[data-key="c:3003"]');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /Counted~/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  await page.click('[data-act="dm-all"]');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  lead = await shownLead(page);
  assert(lead === 'This will delete 7 of your messages, plus all of yours in 2 chats not counted yet:', `partly counted: ${lead}`);
  await context.close();
});

// Firefox's accessibility press (NVDA, JAWS, Voice Control, Dragon, TalkBack) is Gecko's
// DispatchClickEvent: mousedown, mouseup and a click with detail 1, but no pointer events.
await test('T48 a click no pointer went down for (Firefox assistive tech) confirms with two presses', async () => {
  const { page, stats, context } = await boot('/channels/4001/5002');
  const label = () => text(page, '[data-role="confirm-label"]');
  const geckoPress = () => page.locator('[data-act="confirm"]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, composed: true, cancelable: true, button: 0, detail: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  });
  const openConfirm = async () => {
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await page.waitForTimeout(400);
  };
  // A hold given up with Esc must not swallow the next dialog's first press.
  await openConfirm();
  const c = await page.locator('[data-act="confirm"]').boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.mouse.up();
  assert(!(await dialogOpen(page)) && stats.deletes.length === 0, 'Esc mid-hold keeps you safe');
  await openConfirm();
  // A mouse click and a tap before it aren't first presses.
  await page.click('[data-act="confirm"]');
  const cdp = await context.newCDPSession(page);
  const at = [{ x: c.x + c.width / 2, y: c.y + c.height / 2, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1600);
  assert(!/again/.test(await label()), `a click and a tap don't arm: ${await label()}`);
  await geckoPress();
  await page.waitForTimeout(200);
  assert(/Press again/.test(await label()) && await dialogOpen(page) && stats.deletes.length === 0,
    `first press only arms: ${await label()}, ${stats.deletes.length} deleted`);
  await geckoPress();
  // The run starts a moment after the press, once this tab holds the run lock (D29).
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run !== 'idle');
  await waitEnd(page);
  assert(stats.deletes.length === 10, `two presses purged ${stats.deletes.length}`);
  await context.close();
});

// ── Engine: hung requests, pause between chats, honest progress, archived threads, pacing ──

const api = (r) => `${r.method()} ${new URL(r.url()).pathname.replace('/api/v9', '')}`;

// Every API request the page starts, with when it started.
function recordRequests(page) {
  const sent = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) sent.push({ t: Date.now(), what: api(r) }); });
  return { sent, since: (t0) => sent.filter((r) => r.t > t0).map((r) => r.what) };
}

// Holds matching requests until release() (or for `ms`), so a click can land while one is in flight.
async function holdRequests(page, pattern, { match = () => true, ms = 0, once = true } = {}) {
  const hold = { held: 0, done: 0, release: null };
  const released = new Promise((r) => { hold.release = r; });
  await page.route(pattern, async (route) => {
    if ((once && hold.held) || !match(route.request())) return route.fallback();
    hold.held++;
    await (ms ? new Promise((r) => setTimeout(r, ms)) : released);
    hold.done++;
    try { await route.fallback(); } catch { /* the page gave up on it */ }
  });
  return hold;
}

// Boot a build whose timings the caller set itself.
async function bootWith(src, path, opts = {}) {
  const env = await openDiscord(browser, path, opts);
  await injectUserscript(env.page, src, { fast: false });
  await settled(env.page);
  return env;
}

async function pickBatch(page, keys) {
  await page.click('.tab[data-tab="batch"]');
  if (keys.some((k) => /^c:5/.test(k))) await page.locator('.guild-head').first().click();
  if (keys.some((k) => /^u:/.test(k))) await openFriends(page);
  for (const k of keys) {
    await page.waitForSelector(`[data-key="${k}"]`);
    await page.click(`[data-key="${k}"]`);
  }
}

// The confirm lead as shown: its closing colon is shown, and a full stop is said instead (D40).
function shownLead(page) {
  return page.evaluate(() => [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.modal-lead').childNodes]
    .filter((n) => !(n.nodeType === 1 && n.classList.contains('sr'))).map((n) => n.textContent).join('').replace(/ /g, ' '));
}

// The filter lands once a frame (D41): wait for the next one.
function frame(page) {
  return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

// Friends with a closed DM wait in a fold at the end of the DM list (D43): open it, if it isn't.
async function openFriends(page) {
  const head = page.locator('.fold-head');
  await head.waitFor();
  if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
}

// What another Discord tab does when it shields someone: write prefs, fire "storage" here.
const shieldFromOtherTab = (page, userId) => page.evaluate((id) => {
  const f = document.createElement('iframe');
  document.body.appendChild(f);
  const ls = f.contentWindow.localStorage;
  const p = JSON.parse(ls.getItem('dopa-purifier:prefs') || '{}');
  p.protectedIds = [...(p.protectedIds || []), id];
  ls.setItem('dopa-purifier:prefs', JSON.stringify(p));
  f.remove();
  window.dispatchEvent(new StorageEvent('storage', { key: 'dopa-purifier:prefs' }));
}, userId);

const untilStatus = (page, re, timeout = 3000) => page.waitForFunction(FOOTER_SAYS, re.source, { timeout });

// fetch() used to get no signal: a request that never answers trapped Cancel scan and Stop.
await test('T50 Cancel scan and Stop end a hung search at once', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  const hold = await holdRequests(page, /\/messages\/search/, { once: false });
  await page.click('[data-act="scan"]');
  while (hold.held < 1) await page.waitForTimeout(10);
  await page.click('[data-act="scan"]'); // Cancel scan
  await untilStatus(page, /Stopped counting/, 1500).catch(() => { throw new Error('Cancel scan stuck on a hung search'); });
  assert((await text(page, '[data-role="scan-label"]')) === 'Count', 'Count is back');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  while (hold.held < 2) await page.waitForTimeout(10); // the run's count search hangs too
  await page.click('[data-act="stop"]');
  await waitEnd(page, 1500).catch(() => { throw new Error('Stop stuck on a hung search'); });
  assert(/^Purify picks up the rest~$/.test(await status(page)), `status ${await status(page)}`);
  hold.release();
  await context.close();
});

// A DELETE already sent is left to land (counts stay true), but a dead one is bounded by the timeout.
await test('T51 a DELETE that never answers times out: Stop ends the run, otherwise it retries', async () => {
  const timed = source.replace(/requestTimeoutMs:\s*\d+/, 'requestTimeoutMs: 1500');
  for (const stop of [true, false]) {
    const env = await openDiscord(browser, '/channels/4001/5002');
    const { page, world } = env;
    let armed = false;
    const hold = await holdRequests(page, /\/api\/v9\/channels\/5002\/messages\/\d+$/, { match: (r) => armed && r.method() === 'DELETE' });
    const reqs = recordRequests(page);
    await injectUserscript(page, timed);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent === 'art-share');
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 3);
    armed = true;
    while (!hold.held) await page.waitForTimeout(10);
    if (stop) {
      const t0 = Date.now();
      await page.click('[data-act="stop"]');
      assert(/Stopping after this one/.test(await status(page)), `status ${await status(page)}`);
      await waitEnd(page, 4000).catch(() => { throw new Error('Stop waited on the hung DELETE for ever'); });
      assert(reqs.since(t0).length === 0, `sent after Stop: ${reqs.since(t0)}`);
      assert(/^Purify picks up the rest~$/.test(await status(page)), `status ${await status(page)}`);
    } else {
      await waitEnd(page, 10000).catch(() => { throw new Error('run never got past the hung DELETE'); });
      assert(mine(world, '5002').length === 0, `${mine(world, '5002').length} left`);
      const log = await page.locator('[data-role="term-body"]').textContent();
      assert(/Connection hiccup/.test(log), 'the retry wait was shown');
      assert(/^Done in \d+s ♡$/.test(await status(page)), `status ${await status(page)}`);
    }
    hold.release();
    assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
    await env.context.close();
  }
});

// Pause used to be checked only inside a chat: a paused batch still opened the next DM and searched it.
await test('T52 Pause holds between chats, before opening a DM, and before the last look', async () => {
  // Pause while `hold` is in flight, then watch well past its answer: nothing new may start.
  const pausedHere = async (page, hold, reqs, label) => {
    await page.click('[data-act="pause"]');
    const t0 = Date.now();
    while (!hold.done) await page.waitForTimeout(10);
    await page.waitForTimeout(600);
    assert(reqs.since(t0).length === 0, `${label}: sent while paused: ${reqs.since(t0)}`);
    assert(/^Resume picks up right here~$/.test(await status(page)), `${label}: status ${await status(page)}`);
  };
  // (a) group DM → friend Bob: Pause during the group's last history page; Stop then ends the run.
  {
    const { page, stats, context } = await boot('/channels/4001/5001');
    const hold = await holdRequests(page, /\/channels\/3004\/messages\?limit=100&before=/, { ms: 1000 });
    const reqs = recordRequests(page);
    await pickBatch(page, ['c:3004', 'u:2004']);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (!hold.held) await page.waitForTimeout(5);
    await pausedHere(page, hold, reqs, 'a');
    assert(stats.opened.length === 0, 'no DM opened while paused');
    const t0 = Date.now();
    await page.click('[data-act="stop"]');
    await waitEnd(page, 2000);
    assert(reqs.since(t0).length === 0 && stats.opened.length === 0, `after Stop: ${reqs.since(t0)}`);
    assert(/^Purify picks up the rest~$/.test(await status(page)), `a: status ${await status(page)}`);
    await context.close();
  }
  // (b) Mallory → Alice: Alice is shielded (from another tab) while paused between them.
  {
    const { page, stats, world, context } = await boot('/channels/4001/5001');
    const aliceBefore = mine(world, '3002').length;
    const hold = await holdRequests(page, /\/channels\/3003\/messages\?limit=100&before=/, { ms: 1000 });
    await pickBatch(page, ['c:3003', 'c:3002']);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (!hold.held) await page.waitForTimeout(5);
    await page.click('[data-act="pause"]');
    while (!hold.done) await page.waitForTimeout(10);
    await page.waitForTimeout(300); // Mallory's chat is finished; the run is between chats
    await shieldFromOtherTab(page, '2002');
    await page.waitForTimeout(200);
    await page.click('[data-act="resume"]');
    await waitEnd(page);
    assert(mine(world, '3003').length === 0, 'Mallory purged');
    assert(mine(world, '3002').length === aliceBefore && !stats.deleteChannels.includes('3002'), 'nothing deleted in the DM shielded while paused');
    await context.close();
  }
  // (c) #art-share → #announcements: Pause during art-share's last empty search page.
  {
    const { page, stats, world, context } = await boot('/channels/4001/5001');
    let pages = 0;
    const hold = await holdRequests(page, /\/guilds\/4001\/messages\/search\?/, {
      ms: 1000, match: (r) => /channel_id=5002/.test(r.url()) && /max_id=/.test(r.url()) && stats.deleteChannels.length >= 10 && ++pages === 2,
    });
    const reqs = recordRequests(page);
    await pickBatch(page, ['c:5002', 'c:5003']);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (!hold.held) await page.waitForTimeout(5);
    await pausedHere(page, hold, reqs, 'c');
    await page.click('[data-act="resume"]');
    await waitEnd(page);
    assert(mine(world, '5002').length === 0 && mine(world, '5003').length === 0 && mine(world, '5103').length === 0, 'both purged after Resume');
    await context.close();
  }
  // (d) friend Bob: Pause while his DM is being opened; nothing is searched until Resume.
  {
    const { page, stats, context } = await boot('/channels/4001/5001');
    const hold = await holdRequests(page, 'https://discord.com/api/v9/users/@me/channels', { ms: 1000, match: (r) => r.method() === 'POST' });
    const reqs = recordRequests(page);
    await pickBatch(page, ['u:2004']);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (!hold.held) await page.waitForTimeout(5);
    await pausedHere(page, hold, reqs, 'd');
    await page.click('[data-act="resume"]');
    await waitEnd(page);
    assert(stats.opened.length === 1 && stats.closed.length === 1, `opened ${stats.opened} closed ${stats.closed}`);
    await context.close();
  }
});

// A chat that is skipped (no access, or shielded mid-run) must still settle the uncounted tally.
await test('T53 a skipped chat leaves progress honest: "N of 40", an ETA, no "+"', async () => {
  const hero = async (page) => ({ pct: await text(page, '[data-role="pct"]'), eta: await text(page, '[data-role="stat-eta"] b') });
  {
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 25 });
    await pickBatch(page, ['c:5007', 'c:5001']); // #mod-only (no access) first
    await page.click('[data-act="scan"]');
    await untilStatus(page, /Counted~/);
    // Count unticked #mod-only (D40); ticked again by hand, it sits the run out rather than being searched.
    await page.click('[data-key="c:5007"]');
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 20);
    const mid = await hero(page);
    assert(/^\d+ of 40$/.test(mid.pct) && /left|double-checking/.test(mid.eta), `mid-run ${JSON.stringify(mid)}`);
    await waitEnd(page);
    const end = await hero(page);
    assert(end.pct === '40 of 40', `end ${JSON.stringify(end)}`);
    // D40 leaves #mod-only out before the run (the dialog lists it as skipped), so the finish is clean.
    assert(/^Done in \d+s ♡$/.test((await status(page)).replace(/[\u2068\u2069]/g, '')), `status ${await status(page)}`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001');
    const hold = await holdRequests(page, /\/channels\/3003\/messages\?limit=100&before=/);
    await pickBatch(page, ['c:3003', 'c:3002']); // neither scanned
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (!hold.held) await page.waitForTimeout(5);
    await shieldFromOtherTab(page, '2002'); // Alice, while Mallory's chat is still going
    hold.release();
    await waitEnd(page);
    const end = await hero(page);
    assert(end.pct === '7 of 7', `end after Alice was shielded mid-run ${JSON.stringify(end)}`);
    await context.close();
  }
});

// Every DELETE in an archived thread answers 400/50083: one is enough to know.
await test('T54 an archived thread costs one DELETE per run, not one per message', async () => {
  const world = buildWorld();
  for (let i = 0; i < 10; i++) {
    world.messages['5103'].push({ id: String(1300000000000000000n + BigInt(i) * 1000n), channel_id: '5103', type: 0, pinned: false, author: world.me, content: `old forum reply ${i}`, attachments: [] });
  }
  const { page, stats, context } = await boot('/channels/4001/5003', { world });
  let threadDeletes = 0;
  await page.route(/\/api\/v9\/channels\/5103\/messages\/\d+$/, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    threadDeletes++;
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Thread is archived', code: 50083 }) });
  });
  for (const runNo of [1, 2]) {
    const before = threadDeletes;
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    assert(threadDeletes - before === 1, `run ${runNo}: ${threadDeletes - before} DELETEs into the archived thread`);
    assert(/^Done in \d+s · reasons in Logs$/.test(await status(page)) && /^13 couldn't be purged/.test(await heard(page)), `run ${runNo}: status ${await heard(page)}`);
    const log = await page.locator('[data-role="term-body"]').textContent();
    assert((log.match(/archived~ reopen it in Discord/g) || []).length === 1, `run ${runNo}: archived note logged once`);
  }
  assert(stats.deletes.length === 2 && mine(world, '5003').length === 0, `announcements purged (${stats.deletes.length})`);
  assert(mine(world, '5103').length === 13, 'thread replies untouched');
  await context.close();
});

// Scan selected used to fire one search per chat back to back; it now paces them like a purge.
await test('T55 Scan selected paces its searches and can be cancelled between them', async () => {
  const paced = source.replace(/deleteDelayMs:\s*\d+/, 'deleteDelayMs: 20').replace(/searchDelayMs:\s*\d+/, 'searchDelayMs: 400');
  const { page, context } = await bootWith(paced, '/channels/4001/5001');
  const searches = [];
  page.on('request', (r) => { if (/messages\/search/.test(r.url())) searches.push(Date.now()); });
  await page.click('.tab[data-tab="batch"]');
  await page.locator('.guild-all').first().click();
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="tab-badge"]').textContent === '5');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 8000);
  const gaps = searches.slice(1).map((t, i) => t - searches[i]);
  assert(searches.length === 5 && Math.min(...gaps) >= 370, `${searches.length} searches, gaps ${gaps}`);
  const n = searches.length;
  await page.click('[data-act="scan"]');
  while (searches.length === n) await page.waitForTimeout(5);
  await page.waitForTimeout(50); // now in the pause before the next chat
  await page.click('[data-act="scan"]'); // Cancel scan
  await untilStatus(page, /Stopped counting/, 1000);
  await page.waitForTimeout(600);
  assert(searches.length === n + 1, `searched after Cancel: ${searches.length - n - 1}`);
  await context.close();
});

// Friends without a DM are counted at purge (scanning would open their DM), so never "need a scan".
// Reads the Batch strip's own line (the readout line is hidden there) and checks it stays inside the panel.
await test('T56 a friend with no DM yet is counted at purge, not "needs a scan" for ever', async () => {
  const { page, stats, context } = await boot('/channels/4001/5001');
  const strip = () => page.evaluate(() => {
    const root = document.querySelector('#dopa-purifier-host').shadowRoot;
    const el = root.querySelector('[data-role="hero-sub"]');
    const body = root.querySelector('.body');
    return { text: el.textContent.replace(/\u00a0/g, ' '), title: el.title.replace(/\u00a0/g, ' '), shown: el.offsetWidth > 0, whole: el.scrollWidth <= el.clientWidth,
      past: Math.round(el.getBoundingClientRect().right - root.querySelector('[data-role="shell"]').getBoundingClientRect().right),
      sideways: body.scrollWidth - body.clientWidth, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' };
  });
  // Every line stays inside the panel and fits whole; a longer one would end in an ellipsis and hover in full.
  const check = async (when, expected) => {
    const s = await strip();
    assert(s.shown && s.past <= 0 && s.sideways <= 0, `${when}: "${s.text}" runs ${s.past}px past the panel (body ${s.sideways}px sideways)`);
    assert(s.whole && s.ellipsis, `${when}: "${s.text}" ${s.whole ? 'has no ellipsis to fall back on' : 'is cut short'}`);
    assert((expected instanceof RegExp ? expected.test(s.text) : s.text === expected) && s.title === s.text, `${when}: "${s.text}" (title "${s.title}")`);
  };
  await pickBatch(page, ['u:2004']);
  await check('Bob alone', '1 chat · 1 closed DM');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /counted when you purify them/);
  const said = await page.evaluate(() => {
    const el = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
    return { text: el.textContent, whole: el.scrollWidth <= el.clientWidth };
  });
  assert(said.text === 'Closed DMs are counted when you purify them~ ♡' && said.whole, `status "${said.text}"${said.whole ? '' : ' is cut short'}`);
  await page.click('[data-key="c:3002"]');
  await check('before scan', '2 chats · 1 to count · 1 closed DM');
  for (let i = 0; i < 2; i++) {
    await page.click('[data-act="scan"]');
    await untilStatus(page, /Counted~/);
    // Counted, with a closed DM still to open: the estimate stays, as a floor (D40).
    await check(`after scan ${i + 1}`, /^2 chats · 1 closed DM · about \d+s\+$/);
  }
  await page.click('[data-key="c:3003"]');
  await page.click('[data-key="u:2005"]');
  await check('four chats', '4 chats · 1 to count · 2 closed DMs');
  assert(stats.opened.length === 0, 'scanning opened no DM');
  await context.close();
});

const nameIs = (page, name) => page.waitForFunction((n) => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]').textContent === n, name, { timeout: 4000 });
const statusMatches = (page, re, timeout = 8000) => page.waitForFunction(FOOTER_SAYS, re.source, { timeout });

// Any failed lookup of the open chat ends the same way; a 5xx blip that outlasts request()'s
// retries is the usual cause (one 403 here keeps the test fast). Try again is the user's, never a poll's.
await test('T60 a failed channel lookup offers Try again, and Try again recovers', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  let lookups = 0;
  await page.route('https://discord.com/api/v9/channels/5002', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (++lookups > 1) return route.fallback();
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Access', code: 50001 }) });
  });
  await page.click('a[href="/channels/4001/5002"]');
  await statusMatches(page, /^No access here$/);
  await page.waitForTimeout(1500);
  assert(lookups === 1, `looked the channel up again by itself (${lookups})`);
  assert(await page.locator('[data-act="scan"]').isEnabled(), 'Scan is usable after a failed lookup');
  assert((await text(page, '[data-role="scan-label"]')) === 'Try again', `scan label ${await text(page, '[data-role="scan-label"]')}`);
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'no purging an unread chat');
  await page.click('[data-act="scan"]');
  await nameIs(page, 'art-share');
  assert(lookups === 2, `retry looked it up once (${lookups})`);
  assert((await status(page)) === 'Ready to purify~ ✨', `status after retry: ${await status(page)}`);
  assert((await text(page, '[data-role="scan-label"]')) === 'Count', 'Try again is Count again');
  await page.click('[data-act="scan"]');
  await statusMatches(page, /found/);
  assert((await heard(page)).startsWith('10 messages found'), await status(page));
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T61 resizing the window never moves the panel for good', async () => {
  const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1440, height: 900 } });
  const spot = () => page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const s = r.querySelector('[data-role="shell"]');
    return { x: s.offsetLeft, y: s.offsetTop, gap: innerWidth - s.offsetLeft - r.querySelector('.panel').offsetWidth };
  });
  const squeeze = async () => {
    await page.setViewportSize({ width: 720, height: 380 }); // snapped to half a screen, short
    await page.waitForTimeout(200);
    const small = await spot();
    assert(small.x >= 8 && small.gap >= 8 && small.y >= 8, `on screen while small ${JSON.stringify(small)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);
  };
  const home = await spot();
  assert(home.gap === 20 && home.y === 56, `default spot ${JSON.stringify(home)}`);
  await squeeze();
  const back = await spot();
  assert(back.gap === 20 && back.y === 56, `never-dragged panel back on the right edge ${JSON.stringify(back)}`);
  // Dragged to a spot of your own: squeezed onto the screen, then back to that spot, kept across reloads.
  const head = await page.locator('.head').boundingBox();
  await page.mouse.move(head.x + 120, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(head.x + 120 - 760, head.y + 20 + 244, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const mine = await spot();
  assert(mine.x === 300 && mine.y === 300, `dragged to ${JSON.stringify(mine)}`);
  await squeeze();
  const again = await spot();
  assert(again.x === 300 && again.y === 300, `dragged spot after a resize ${JSON.stringify(again)}`);
  await page.reload();
  await injectUserscript(page, source);
  await page.waitForSelector('[data-role="layer"]', { state: 'attached' });
  await page.waitForTimeout(300);
  const reloaded = await spot();
  assert(reloaded.x === 300 && reloaded.y === 300, `dragged spot after reload ${JSON.stringify(reloaded)}`);
  await context.close();
});

// Discord logs you in without reloading the page, so the panel is already up on /login.
await test('T62 Batch lists that failed on the login page load once you log in', async () => {
  const env = await openDiscord(browser, '/login');
  const { page, context } = env;
  await page.evaluate(() => {
    localStorage.removeItem('token');
    localStorage.setItem('dopa-purifier:prefs', JSON.stringify({ welcomed: true, tab: 'batch' }));
  });
  await injectUserscript(page, source);
  await page.waitForFunction(() => /Discord login/.test(document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="server-list"]')?.textContent || '')); // D38's line
  assert(/Discord login/.test(await text(page, '[data-role="dm-list"]')), 'DM list says why it is empty');
  await page.evaluate((t) => {
    localStorage.setItem('token', JSON.stringify(t));
    history.pushState({}, '', '/channels/4001/5001');
  }, TOKEN);
  await page.waitForSelector('[data-key="c:3002"]', { timeout: 4000 });
  await page.waitForSelector('.guild', { timeout: 4000 });
  assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
  await context.close();
});

await test('T63 the footer drops the last chat\'s verdict when you open another', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="scan"]');
  await statusMatches(page, /40 messages found/);
  await page.click('a[href="/channels/4001/5002"]');
  await nameIs(page, 'art-share'); // the footer is settled by the time the name shows
  assert((await status(page)) === 'Ready to purify~ ✨', `on art-share after scanning general: ${await status(page)}`);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(/^Done in/.test(await status(page)), `done: ${await status(page)}`);
  await page.click('a[href="/channels/@me/3002"]');
  await nameIs(page, 'Alice ✿');
  assert((await status(page)) === 'Ready to purify~ ✨', `on Alice after purging art-share: ${await status(page)}`);
  // Batch verdicts are about the selection, not the open chat: they stay.
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  await page.click('[data-key="c:3003"]');
  await page.click('[data-act="scan"]');
  await statusMatches(page, /Counted~/);
  const verdict = await status(page);
  await page.click('a[href="/channels/4001/5001"]');
  await nameIs(page, 'general');
  await page.waitForTimeout(300);
  assert((await status(page)) === verdict, `batch verdict replaced: ${await status(page)}`);
  await context.close();
});

await test('T64 first run: the welcome card takes focus, and Tab never lands behind it', async () => {
  const focused = (page) => page.evaluate(() => {
    const el = document.querySelector('#dopa-purifier-host').shadowRoot.activeElement;
    return el ? { id: el.dataset.act || el.dataset.tab || el.className, behind: !!el.closest('.tabs, [data-role="body"], .foot') } : null;
  });
  {
    const { page, context } = await boot('/channels/4001/5001', { firstRun: true, viewport: { width: 1280, height: 720 } });
    assert((await focused(page))?.id === 'welcome-ok', `focus on arrival: ${JSON.stringify(await focused(page))}`);
    const title = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      return r.getElementById(r.querySelector('[data-role="welcome"]').getAttribute('aria-labelledby'))?.textContent;
    });
    assert(title === 'Hi princess~ ♡', `dialog named ${title}`);
    const stops = [];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      stops.push(await focused(page));
    }
    // A null stop means focus left the shadow root entirely — onto Discord's own page behind the card.
    assert(stops.every(Boolean), `Tab escaped the card into Discord: ${JSON.stringify(stops)}`);
    const inside = stops.filter(Boolean);
    assert(inside.every((f) => !f.behind), `Tab reached controls under the card: ${JSON.stringify(inside)}`);
    assert(inside.some((f) => f.id === 'welcome-batch'), `Tab reaches both card buttons: ${JSON.stringify(inside)}`);
    await page.locator('[data-act="welcome-ok"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-role="welcome"]').waitFor({ state: 'hidden', timeout: 1000 }); // it fades out
    assert((await focused(page))?.id === 'current', `focus after "Got it": ${JSON.stringify(await focused(page))}`);
    assert(await page.evaluate(() => ['.tabs', '[data-role="body"]', '.foot'].every((s) => !document.querySelector('#dopa-purifier-host').shadowRoot.querySelector(s).inert)), 'panel usable again');
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { firstRun: true });
    await page.keyboard.press('Tab');
    assert((await focused(page))?.id === 'welcome-batch', `second stop: ${JSON.stringify(await focused(page))}`);
    await page.keyboard.press('Enter');
    assert((await focused(page))?.id === 'batch', `focus after "Purge many chats": ${JSON.stringify(await focused(page))}`);
    await page.waitForSelector('[data-key="c:3002"]');
    await context.close();
  }
});

// Words in the panel's faintest ink must still clear WCAG AA (4.5:1) on what is really behind them.
await test('T65 "all clear ✓" and the filter placeholder are readable', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  const lum = ([r, g, b]) => [r, g, b].map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // The text colour as styled, against the median pixel of the rendered box (the backdrop: text is the minority).
  const contrast = async (locator, pseudo) => {
    const color = (await locator.evaluate((el, p) => getComputedStyle(el, p).color, pseudo)).match(/\d+/g).slice(0, 3).map(Number);
    const png = (await locator.screenshot()).toString('base64');
    const backdrop = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
      px.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
      return px[px.length >> 1];
    }, png);
    return { ratio: ratio(color, backdrop), color, backdrop };
  };
  await page.click('.tab[data-tab="batch"]');
  await page.locator('.guild-head').first().click();
  await page.waitForSelector('[data-key="c:5004"]');
  await page.click('[data-key="c:5004"]'); // Voice Lounge: none of mine
  await page.click('[data-act="scan"]');
  await page.waitForSelector('[data-key="c:5004"][data-state="clean"]', { timeout: 8000 });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const meta = page.locator('[data-key="c:5004"] .row-meta');
  assert((await meta.textContent()) === 'all clear ✓', `meta ${await meta.textContent()}`);
  const clean = await contrast(meta, null);
  assert(clean.ratio >= 4.5, `"all clear ✓" at ${clean.ratio.toFixed(2)}:1 ${JSON.stringify(clean)}`);
  const placeholder = await contrast(page.locator('[data-role="filter"]'), '::placeholder');
  assert(placeholder.ratio >= 4.5, `filter placeholder at ${placeholder.ratio.toFixed(2)}:1 ${JSON.stringify(placeholder)}`);
  await context.close();
});

// A list load can sit in request()'s 5xx backoff for ~14 s. Here the first load of each list is
// held, then fails: by then a newer load has drawn the list, and the old failure must not win.
await test('T66 Batch lists: a slow old load never overwrites a newer one, and navigating doesn\'t ask twice', async () => {
  const { page, pageErrors, context } = await boot('/channels/@me/3002'); // a DM: the servers aren't cached yet
  const gets = { channels: 0, guilds: 0 };
  const held = [];
  let failed = 0;
  let release;
  const released = new Promise((r) => { release = r; });
  await page.route(/\/api\/v9\/users\/@me\/(channels|guilds)$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const list = route.request().url().endsWith('/guilds') ? 'guilds' : 'channels';
    if (++gets[list] > 1) return route.fallback();
    held.push(list);
    await released;
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Access', code: 50001 }) });
    failed++;
  });
  await page.click('.tab[data-tab="batch"]');
  while (held.length < 2) await page.waitForTimeout(20);
  await page.evaluate(() => history.pushState({}, '', '/channels/@me/3003'));
  await page.waitForTimeout(900);
  await page.click('a[href="/channels/@me/3002"]');
  await page.waitForTimeout(900);
  assert(gets.channels === 1 && gets.guilds === 1, `navigating while the lists load asked again ${JSON.stringify(gets)}`);
  await page.click('[data-act="dm-refresh"]');
  await page.click('[data-act="server-refresh"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.waitForSelector('.guild');
  release();
  while (failed < 2) await page.waitForTimeout(20);
  await page.waitForTimeout(300);
  const dms = await text(page, '[data-role="dm-list"]');
  const servers = await text(page, '[data-role="server-list"]');
  assert(!/Failed/.test(dms) && await page.locator('[data-key="c:3002"]').count() === 1, `DM list after the old load failed: ${dms.slice(0, 60)}`);
  assert(!/Failed/.test(servers) && await page.locator('.guild').count() > 0, `server list after the old load failed: ${servers.slice(0, 60)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// The old account's list, still on its way when Discord switches accounts, isn't the new one's.
await test('T67 a DM list still loading for the old account is dropped after an account switch', async () => {
  const { page, pageErrors, context } = await boot('/channels/@me/3002');
  await page.click('[data-act="scan"]'); // binds the panel to this account
  await statusMatches(page, /found/);
  let gets = 0;
  let served = false;
  let release;
  const released = new Promise((r) => { release = r; });
  await page.route('https://discord.com/api/v9/users/@me/channels', async (route) => {
    if (route.request().method() !== 'GET' || ++gets > 1) return route.fallback();
    await released;
    const pal = { id: '3999', type: 1, last_message_id: '9999', recipients: [{ id: '2999', username: 'old.pal', global_name: 'Old Pal' }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([pal]) });
    served = true;
  });
  await page.click('.tab[data-tab="batch"]');
  while (!gets) await page.waitForTimeout(20);
  await page.click('.tab[data-tab="current"]');
  await page.evaluate(() => localStorage.setItem('token', JSON.stringify('mock-token.b')));
  await page.click('a[href="/channels/4001/5001"]');
  await page.waitForFunction(() => /switched Discord accounts/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="term-body"]').textContent));
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]', { timeout: 4000 });
  release();
  while (!served) await page.waitForTimeout(20);
  await page.waitForTimeout(300);
  assert(await page.locator('[data-key="c:3999"]').count() === 0, 'drew the old account\'s DMs');
  assert(await page.locator('[data-key="c:3002"]').count() === 1, `DM list: ${(await text(page, '[data-role="dm-list"]')).slice(0, 60)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// BetterDiscord only updates plugins from its own store, so ours fetches its published file, asks,
// and rewrites itself in the plugins folder (BetterDiscord then reloads it). BdApi is stubbed with the
// names and semantics of BetterDiscord 1.14.4: Net.fetch → Response, Utils.semverCompare(current, remote)
// > 0 when remote is newer, UI.showConfirmationModal(title, content, { onConfirm }), Plugins.folder.
await test('T70 BetterDiscord plugin offers its own update and rewrites its file', async () => {
  const plugin = fs.readFileSync(PLUGIN, 'utf8');
  const raw = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8')).purifier.raw;
  const version = /@version\s+(\S+)/.exec(plugin)[1];
  const newer = plugin.replace(/(@version\s+)\S+/, (_, head) => `${head}99.0.0`);
  async function run({ body, status = 200, delay = 0, stopEarly = false }) {
    const env = await openDiscord(browser, '/channels/4001/5001');
    await env.page.evaluate(({ code, body, status, delay, stopEarly }) => {
      const log = window.__bdLog = { fetches: [], modals: [], writes: [] };
      const folder = '/home/friend/.config/BetterDiscord/plugins';
      const parts = (v) => v.split('.').map(Number);
      window.BdApi = {
        Net: { async fetch(url) {
          log.fetches.push(url);
          await new Promise((r) => setTimeout(r, delay));
          if (body === null) throw new TypeError('Failed to fetch');
          return new Response(body, { status });
        } },
        Utils: { semverCompare(current, remote) {
          const [a, b] = [parts(current), parts(remote)];
          for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i] ? 1 : -1;
          return 0;
        } },
        UI: {
          showConfirmationModal(title, content, options) { log.modals.push({ title, content, confirmText: options.confirmText }); window.__bdConfirm = options.onConfirm; },
          showToast(text) { log.toasts = (log.toasts || []).concat(text); },
        },
        Plugins: { folder },
      };
      // The plugins folder holds our own file until something writes over it.
      window.__bdDisk = code;
      const fsStub = { readFileSync: () => window.__bdDisk, writeFileSync(file, data) { log.writes.push({ file, data }); window.__bdDisk = data; } };
      const pathStub = { join: (...p) => p.join('/') };
      const require = (m) => ({ fs: fsStub, path: pathStub })[m];
      const module = { exports: {} };
      new Function('require', 'module', 'exports', '__filename', '__dirname', code)(require, module, module.exports, `${folder}/Dopa (renamed).plugin.js`, folder);
      window.__bd = new module.exports({ name: 'DopasPurifier', filename: 'Dopa (renamed).plugin.js' });
      window.__bd.start();
      if (stopEarly) window.__bd.stop();
    }, { code: plugin, body, status, delay, stopEarly });
    await env.page.waitForTimeout(delay + 400);
    const log = await env.page.evaluate(() => window.__bdLog);
    return { env, log };
  }

  // A newer version is out: one look, one question, and "Update" writes exactly that file over ours.
  {
    const { env, log } = await run({ body: newer });
    assert(log.fetches.length === 1 && log.fetches[0] === `${raw}/dist/DopasPurifier.plugin.js`, `fetched ${log.fetches}`);
    assert(log.modals.length === 1 && log.modals[0].content.includes('v99.0.0') && log.modals[0].content.includes(`v${version}`), JSON.stringify(log.modals));
    assert(await env.page.locator('#dopa-purifier-host').count() === 1, 'the panel still starts');
    assert(log.writes.length === 0, 'nothing written before saying yes');
    await env.page.evaluate(() => window.__bdConfirm());
    const writes = await env.page.evaluate(() => window.__bdLog.writes);
    assert(writes.length === 1 && writes[0].file === '/home/friend/.config/BetterDiscord/plugins/Dopa (renamed).plugin.js', JSON.stringify(writes.map((w) => w.file)));
    assert(writes[0].data === newer, 'wrote the fetched plugin verbatim');
    assert(env.pageErrors.length === 0, env.pageErrors.join('; '));
    await env.context.close();
  }
  // Same version, GitHub errors, a page that isn't the plugin, no network, or disabled mid-check: no offer, no noise.
  for (const [label, opts] of [
    ['same version', { body: plugin }],
    ['404', { body: '404: Not Found', status: 404 }],
    ['not the plugin', { body: '<!doctype html><title>@name DopasPurifier @version 99.0.0</title>' }],
    ['offline', { body: null }],
    ['stopped before the answer', { body: newer, delay: 300, stopEarly: true }],
  ]) {
    const { env, log } = await run(opts);
    assert(log.fetches.length === 1, `${label}: looked once`);
    assert(log.modals.length === 0 && log.writes.length === 0, `${label}: ${JSON.stringify(log.modals)}`);
    assert(env.pageErrors.length === 0, `${label}: ${env.pageErrors.join('; ')}`);
    await env.context.close();
  }
  // A dialog that outlived its copy (plugin turned off, or reloaded) writes nothing when confirmed.
  {
    const { env, log } = await run({ body: newer });
    assert(log.modals.length === 1, 'offered');
    await env.page.evaluate(() => { window.__bd.stop(); window.__bdConfirm(); });
    assert((await env.page.evaluate(() => window.__bdLog.writes)).length === 0, 'stale dialog wrote the plugin');
    await env.context.close();
  }
  // Another Discord window already updated the shared file: confirming here never writes over it.
  {
    const { env, log } = await run({ body: newer });
    assert(log.modals.length === 1, 'offered');
    await env.page.evaluate((v) => { window.__bdDisk = v; window.__bdConfirm(); }, newer.replace(/(@version\s+)\S+/, (_, head) => `${head}99.1.0`));
    const writes = await env.page.evaluate(() => window.__bdLog.writes);
    assert(writes.length === 0, `wrote over a newer file: ${writes.map((w) => /@version\s+(\S+)/.exec(w.data)[1])}`);
    assert(env.pageErrors.length === 0, env.pageErrors.join('; '));
    await env.context.close();
  }
});

// Another tab shields the very chat this tab is purging: deleting there stops at the next message.
await test('T80 a shield from another tab stops the purge inside that chat', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((t) => {
    if (window.top !== window || localStorage.getItem('token')) return;
    localStorage.setItem('token', JSON.stringify(t));
    localStorage.setItem('dopa-purifier:prefs', JSON.stringify({ welcomed: true }));
  }, TOKEN);
  const world = buildWorld();
  const open = async (path) => {
    const page = await context.newPage();
    const { stats } = await installMockDiscord(page, { world, latencyMs: 60 });
    await page.goto('https://discord.com' + path);
    await injectUserscript(page, source);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent !== 'finding this chat…');
    return { page, stats };
  };
  const mine = (cid) => world.messages[cid].filter((m) => m.author.id === world.me.id && m.type === 0).length;
  const a = await open('/channels/4001/5001');
  const b = await open('/channels/@me/3002'); // tab B purges Alice's DM
  await a.page.click('.tab[data-tab="batch"]');
  await a.page.waitForSelector('[data-key="c:3002"]');
  await b.page.click('[data-act="purify"]');
  await holdConfirm(b.page);
  while (b.stats.deletes.length < 3) await b.page.waitForTimeout(10);
  await a.page.hover('[data-key="c:3002"]');
  await a.page.click('[data-key="c:3002"] .shield-btn');
  const atShield = b.stats.deletes.length;
  await waitEnd(b.page);
  const after = b.stats.deletes.length - atShield;
  assert(after <= 2, `${after} more deleted after the shield`);
  assert(mine('3002') > 20, `Alice's DM kept its messages (${mine('3002')} left)`);
  assert(/shielded in another tab/.test(await text(b.page, '[data-role="term-body"]')), 'tab B logs why it stopped');
  assert(await b.page.locator('[data-role="target"]').first().getAttribute('data-state') === 'immune', 'tab B shows the chat as immune');
  // What's left there stays on purpose: no "All clean", no purified card.
  assert(/stays shielded/.test(await status(b.page)), `tab B status: ${await status(b.page)}`);
  assert(!/All clean/.test(await text(b.page, '[data-role="readout-line"]')), `tab B verdict: ${await text(b.page, '[data-role="readout-line"]')}`);
  assert(await b.page.locator('[data-role="target"]').getAttribute('data-state') !== 'purified', 'card not marked purified');
  await context.close();
});

// A friend shielded while we wait to open their DM: no DM gets opened, and nothing is looked at.
await test('T85 shielding a friend while their DM is being opened opens nothing', async () => {
  const env = await openDiscord(browser, '/channels/4001/5001');
  const { page, stats } = env;
  let throttle = true;
  await page.route('https://discord.com/api/v9/users/@me/channels', (route) => {
    if (route.request().method() !== 'POST' || !throttle) return route.fallback();
    return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.5, global: false }) });
  });
  await injectUserscript(page, source);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent === 'general');
  await page.click('.tab[data-tab="batch"]');
  await openFriends(page);
  await page.click('[data-key="u:2004"]'); // Bob: a friend with no DM yet
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForTimeout(200);
  // Another tab shields Bob during the 429 wait.
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    const ls = f.contentWindow.localStorage;
    const p = JSON.parse(ls.getItem('dopa-purifier:prefs') || '{}');
    p.protectedIds = [...(p.protectedIds || []), '2004'];
    ls.setItem('dopa-purifier:prefs', JSON.stringify(p));
    f.remove();
    window.dispatchEvent(new StorageEvent('storage', { key: 'dopa-purifier:prefs' }));
  });
  throttle = false;
  await waitEnd(page);
  assert(stats.opened.length === 0, `opened ${stats.opened.length} DM(s) for a shielded friend`);
  assert(stats.deletes.length === 0, 'nothing deleted');
  assert(env.pageErrors.length === 0, env.pageErrors.join('; '));
  await env.context.close();
});

// Noticing an account switch by opening another chat must not bury the stopped run's error.
await test('T81 after a mid-run account switch the error stays on screen', async () => {
  for (const tab of ['current', 'batch']) {
    const { page, stats, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
    if (tab === 'batch') {
      await page.click('.tab[data-tab="batch"]');
      await page.waitForSelector('[data-key="c:3003"]');
      await page.click('[data-key="c:3003"]');
      await page.click('[data-key="c:3002"]');
    }
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (stats.deletes.length < 3) await page.waitForTimeout(10);
    await page.evaluate(() => localStorage.setItem('token', JSON.stringify('mock-token.b')));
    if (tab === 'current') await page.click('a[href="/channels/4001/5002"]');
    await waitEnd(page, 15000);
    await page.waitForTimeout(1500); // the re-read of the chat and the lists have landed by now
    assert(/^Switched accounts~ \d+ messages? purged/.test(await status(page)), `${tab}: status ${await status(page)}`);
    assert(await page.locator('[data-role="status"]').getAttribute('data-tone') === 'warn', `${tab}: warn tone (it needs the person; nothing is broken)`);
    await context.close();
  }
});

// Headers arrive, then the body never finishes: Cancel scan, Stop and the timeout all still work.
await test('T82 a response that stalls mid-body can be cancelled, stopped, or times out', async () => {
  const stall = async (page) => page.evaluate(() => {
    window.__stalls = 0;
    const real = window.fetch;
    window.fetch = (url, init = {}) => {
      if (!/\/messages\/search/.test(String(url))) return real(url, init);
      window.__stalls++;
      // Like a real fetch: the body errors only when the request's signal aborts.
      const body = new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('{"total_results": 40, "messages": ['));
        if (init.signal) init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')), { once: true });
      } });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    };
  });
  const stalls = (page) => page.evaluate(() => window.__stalls);
  {
    const { page, context } = await boot('/channels/4001/5001');
    await stall(page);
    await page.click('[data-act="scan"]');
    while (!(await stalls(page))) await page.waitForTimeout(20);
    await page.waitForTimeout(300);
    await page.click('[data-act="scan"]'); // Cancel scan
    await page.waitForFunction(() => /Stopped counting/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), null, { timeout: 2000 });
    await context.close();
  }
  {
    const { page, stats, context } = await boot('/channels/4001/5001');
    await stall(page);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    while (!(await stalls(page))) await page.waitForTimeout(20);
    await page.waitForTimeout(300);
    await page.click('[data-act="stop"]');
    await waitEnd(page, 2000);
    assert(stats.deletes.length === 0, 'nothing deleted');
    await context.close();
  }
  {
    // A short timeout: the stalled read is given up and retried with the usual backoff.
    const env = await openDiscord(browser, '/channels/4001/5001');
    await injectUserscript(env.page, source.replace(/requestTimeoutMs:\s*\d+/, 'requestTimeoutMs: 800'));
    await env.page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent === 'general');
    await stall(env.page);
    await env.page.click('[data-act="scan"]');
    await env.page.waitForFunction(() => window.__stalls >= 2, null, { timeout: 5000 });
    await env.context.close();
  }
});

// A count taken while Discord was still indexing is a floor: the run doesn't treat it as the total.
await test('T83 a "found so far" scan doesn\'t cap the run\'s progress', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 30 });
  let first = true;
  await page.route(/\/guilds\/4001\/messages\/search/, (route) => {
    if (!first) return route.fallback();
    first = false;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ total_results: 3, messages: [], doing_deep_historical_index: true }) });
  });
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /so far/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').textContent));
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(await count(page) === 10, `purged ${await count(page)}`);
  assert(await text(page, '[data-role="pct"]') === '10 of 10', `progress ${await text(page, '[data-role="pct"]')}`);
  await context.close();
});

// A scanned chat that turns immune mid-run leaves the total, so the finish reads whole.
await test('T84 a chat shielded mid-run drops out of the run total', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 25 });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  await page.click('[data-key="c:3003"]');
  await page.click('[data-key="c:3002"]');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /Counted~/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  let release;
  const released = new Promise((r) => { release = r; });
  let held = false;
  await page.route(/\/channels\/3003\/messages\?limit=100&before=/, async (route) => {
    if (held) return route.fallback();
    held = true;
    await released;
    return route.fallback();
  });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  while (!held) await page.waitForTimeout(10);
  // Another tab shields Alice while Mallory's DM is still going.
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    const ls = f.contentWindow.localStorage;
    const p = JSON.parse(ls.getItem('dopa-purifier:prefs') || '{}');
    p.protectedIds = [...(p.protectedIds || []), '2002'];
    ls.setItem('dopa-purifier:prefs', JSON.stringify(p));
    f.remove();
    window.dispatchEvent(new StorageEvent('storage', { key: 'dopa-purifier:prefs' }));
  });
  release();
  await waitEnd(page);
  assert(await text(page, '[data-role="pct"]') === '7 of 7', `progress ${await text(page, '[data-role="pct"]')}`);
  await context.close();
});

// The shared helpers every package builds on live inside the userscript's closure: this build also
// hands the named ones to the page, so a test can call them directly.
const HOOK = 'return { start, destroy, busy: () => run.active || starting, whenIdle };';
async function bootProbe(path, names, opts = {}) {
  assert(source.includes(HOOK), 'the build still ends its closure the way the probe expects');
  const env = await openDiscord(browser, path, opts);
  await injectUserscript(env.page, source.replace(HOOK, `window.__dp = { ${names.join(', ')} };\n  ${HOOK}`));
  await settled(env.page);
  return env;
}

const heroIs = (page) => page.evaluate(() => {
  const hero = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.hero');
  return `${hero.dataset.state}/${hero.dataset.face}`;
});

await test('T90 errors in plain words, emoji as flair, and the calm tone', async () => {
  const { page, pageErrors, context } = await bootProbe('/channels/4001/5007', ['plainError', 'setStatus', 'DiscordError']);
  const plain = (make) => page.evaluate(`window.__dp.plainError(${make})`);
  // Missing Access blocks (a purge there could only fail), however it arrives; a dropped
  // connection doesn't.
  for (const make of [
    "new window.__dp.DiscordError(403, { message: 'Missing Access', code: 50001 })",
    "'Missing Access (code 50001)'", // a batch row's reason
    "{ status: 403, code: 50001, message: 'whatever Discord says' }",
  ]) {
    const p = await plain(make);
    assert(p.blocking === true && p.code === 'no-access' && p.short === 'No access here', `${make} → ${JSON.stringify(p)}`);
    assert(p.line === "You can't read this channel, so Purify can't reach your messages here", `no-access line ${p.line}`);
  }
  for (const make of ["new window.__dp.DiscordError(0, { message: 'Network unreachable' })", "{ message: 'Network unreachable' }"]) {
    const p = await plain(make);
    assert(p.blocking === false && p.code === 'network' && p.short === "Can't reach Discord", `${make} → ${JSON.stringify(p)}`);
  }
  // A run's end reports an account switch with status 0, like a dropped connection: it must not read as one.
  const switched = await plain("{ error: 'You switched Discord accounts — stopped to be safe', errorStatus: 0, errorCode: null }");
  assert(switched.code === 'switched' && !switched.blocking, `switched → ${JSON.stringify(switched)}`);
  const cases = {
    "new window.__dp.DiscordError(401, { message: '401: Unauthorized', code: 0 })": 'logged-out',
    "new window.__dp.DiscordError(401, { message: 'No Discord login token found — are you logged in?' })": 'logged-out',
    "new window.__dp.DiscordError(403, { message: 'Missing Permissions', code: 50013 })": 'no-permission',
    "new window.__dp.DiscordError(202, { message: 'Discord is still indexing this channel — try again in a minute' })": 'indexing',
    "new window.__dp.DiscordError(400, { message: 'Discord wants a captcha — finish it in the app, then try again', code: 'captcha' })": 'captcha',
    "new window.__dp.DiscordError(503, { message: 'Service Unavailable' })": 'server',
    "new window.__dp.DiscordError(404, { message: 'Unknown Channel', code: 10003 })": 'gone',
    "new window.__dp.DiscordError(400, { message: 'Invalid Form Body', code: 50035 })": 'other',
    "new window.__dp.DiscordError(418, null)": 'other',
  };
  for (const [make, code] of Object.entries(cases)) {
    const p = await plain(make);
    assert(p.code === code, `${make} → ${JSON.stringify(p)}`);
    assert(p.blocking === (code === 'no-permission'), `only access problems block: ${JSON.stringify(p)}`);
    assert(!/\(code|HTTP|401: Unauthorized|[\u{1F300}-\u{1FAFF}]/u.test(`${p.line} ${p.short}`), `plain words only: ${JSON.stringify(p)}`);
    assert(p.short.length <= 28, `short fits: ${p.short}`);
  }
  assert((await plain(Object.keys(cases)[7])).line === 'Discord said: Invalid Form Body', 'anything else quotes Discord without its code');
  assert((await plain(Object.keys(cases)[8])).line === 'Discord said: error 418', 'a bare status still reads as words');

  // The real path: counting #mod-only (no access) leaves the ring on "blocked".
  assert(await heroIs(page) === 'unscanned/icon', `before the scan ${await heroIs(page)}`);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /^No access here$/);
  assert(await heroIs(page) === 'blocked/label', `after a no-access scan ${await heroIs(page)}`);

  // Flair: the emoji shows, but the status speaks only its words.
  const statusNow = () => page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const s = r.querySelector('[data-role="status"]');
    const t = r.querySelector('[data-role="status-text"]');
    const flair = t.querySelector('.flair');
    return { text: t.textContent, words: t.firstChild.nodeValue, flair: flair && flair.textContent, hidden: flair && flair.getAttribute('aria-hidden'), tone: s.dataset.tone, title: s.title };
  });
  await page.evaluate(() => window.__dp.setStatus('Paused~ 3 purged so far', 'calm', { flair: '♡' }));
  const st = await statusNow();
  assert(st.text === 'Paused~ 3 purged so far ♡' && st.words === 'Paused~ 3 purged so far' && st.flair === ' ♡' && st.hidden === 'true', `flair ${JSON.stringify(st)}`);
  assert(st.tone === 'calm' && st.title === 'Paused~ 3 purged so far', `tone and title ${JSON.stringify(st)}`);
  const spoken = await page.locator('[data-role="status"]').ariaSnapshot();
  assert(spoken.includes('Paused~ 3 purged so far') && !spoken.includes('♡'), `screen readers hear: ${spoken}`);
  await page.evaluate(() => window.__dp.setStatus('Stopped counting~', 'calm'));
  assert((await statusNow()).flair === null && (await statusNow()).text === 'Stopped counting~', 'no flair, no span');

  // Calm wears the --t2 words and a plain coral dot: no '!' badge and no ping, even mid-run.
  await page.evaluate(() => window.__dp.setStatus('Stopping after this one~', 'calm'));
  const calm = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const layer = r.querySelector('[data-role="layer"]');
    layer.dataset.run = 'running';
    const dot = r.querySelector('.status-dot');
    const mark = getComputedStyle(dot, '::before');
    const out = { words: getComputedStyle(r.querySelector('[data-role="status"]')).color, dot: getComputedStyle(dot).color, disc: getComputedStyle(dot).backgroundColor, glyph: mark.content, ping: mark.animationName };
    layer.dataset.run = 'idle';
    return out;
  });
  assert(calm.words === 'rgb(207, 179, 193)' && calm.dot === 'rgb(255, 170, 140)', `calm colours ${JSON.stringify(calm)}`);
  assert(calm.glyph === '""' && calm.ping === 'none' && calm.disc === 'rgba(0, 0, 0, 0)', `calm dot is plain ${JSON.stringify(calm)}`);

  // The panel's own ready line uses the flair too.
  await page.evaluate(() => history.pushState({}, '', '/channels/4001/5002'));
  await untilStatus(page, /Ready to purify/, 4000);
  const ready = await statusNow();
  assert(ready.words === 'Ready to purify~' && ready.flair === ' ✨', `ready line ${JSON.stringify(ready)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T91 shared contracts: type tokens, .sr, height tiers, ring faces, focus hand-off', async () => {
  const { page, stats, pageErrors, context } = await bootProbe('/channels/4001/5002', ['handFocus', 'applyFocus'], { viewport: { width: 1280, height: 720 }, latencyMs: 20 });
  const tokens = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const css = getComputedStyle(r.querySelector('[data-role="layer"]'));
    const names = ['--fs-cap', '--fs-meta', '--fs-body', '--fs-em', '--fs-title', '--fs-strip', '--fs-hero', '--track-cap', '--ease-drawer'];
    const sr = document.createElement('span');
    sr.className = 'sr';
    sr.textContent = 'words for screen readers only';
    r.querySelector('.foot').append(sr);
    const box = sr.getBoundingClientRect();
    const out = { ...Object.fromEntries(names.map((n) => [n, css.getPropertyValue(n).trim()])), sr: [box.width, box.height, getComputedStyle(sr).clipPath] };
    sr.remove();
    return out;
  });
  const want = { '--fs-cap': '10.5px', '--fs-meta': '11.5px', '--fs-body': '13px', '--fs-em': '14px', '--fs-title': '20px', '--fs-strip': '24px', '--fs-hero': '56px', '--track-cap': '.1em', '--ease-drawer': 'cubic-bezier(.32, .72, 0, 1)' };
  for (const [name, value] of Object.entries(want)) assert(tokens[name] === value, `${name} is ${tokens[name]}`);
  assert(JSON.stringify(tokens.sr) === '[1,1,"inset(50%)"]', `.sr box ${JSON.stringify(tokens.sr)}`);

  // Height tiers follow the panel's real cap.
  const fit = () => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.fit);
  for (const [width, height, tier] of [[1280, 720, 'full'], [1280, 600, 'snug'], [1093, 500, 'strip'], [1440, 900, 'full']]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(50);
    assert(await fit() === tier, `${width}×${height} is ${await fit()}, not ${tier}`);
  }
  // A drag 200px down never reshapes the panel under the cursor; the drop does.
  await page.setViewportSize({ width: 1280, height: 720 });
  // The panel at rest before it is picked up: no wobble left, and a frame drawn in its new place.
  await page.waitForFunction(() => {
    const p = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.panel');
    return p.getAnimations().length === 0 && !p.style.transform;
  }, null, { timeout: 3000 });
  await frame(page);
  const head = await page.locator('[data-role="drag"]').boundingBox();
  await page.mouse.move(head.x + 120, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(head.x + 120, head.y + 120, { steps: 4 });
  await page.mouse.move(head.x + 120, head.y + 220, { steps: 4 });
  assert(await fit() === 'full', `mid-drag ${await fit()}`);
  await page.mouse.up();
  const fitBecomes = (tier) => page.waitForFunction((t) => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.fit === t, tier, { timeout: 2000 }).then(() => true, () => false);
  assert(await fitBecomes('strip'), `after the drop ${await fit()}`);
  await page.mouse.move(head.x + 120, head.y + 220);
  await page.mouse.down();
  await page.mouse.move(head.x + 120, head.y + 20, { steps: 6 });
  await page.mouse.up();
  assert(await fitBecomes('full'), `dragged home ${await fit()}`);

  // Ring faces: unscanned → counting → ready → the run and its last look → done.
  assert(await heroIs(page) === 'unscanned/icon', `idle ${await heroIs(page)}`);
  const count = await holdRequests(page, /\/messages\/search/);
  await page.click('[data-act="scan"]');
  while (!count.held) await page.waitForTimeout(5);
  assert(await heroIs(page) === 'counting/icon', `scanning ${await heroIs(page)}`);
  count.release();
  await untilStatus(page, /found/);
  assert(await heroIs(page) === 'ready/count', `counted ${await heroIs(page)}`);
  const look = await holdRequests(page, /\/messages\/search/, { match: () => stats.deletes.length >= 10 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  while (!look.held) await page.waitForTimeout(5);
  assert(await text(page, '[data-role="stat-eta"] b') === 'double-checking…', `last look ${await text(page, '[data-role="stat-eta"] b')}`);
  assert(await heroIs(page) === 'run/count', `running ${await heroIs(page)}`);
  look.release();
  await waitEnd(page);
  assert(await heroIs(page) === 'done/count', `finished ${await heroIs(page)}`);
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  assert(await heroIs(page) === 'none/icon', `nothing picked ${await heroIs(page)}`);
  await page.click('[data-key="c:3003"]');
  assert(await heroIs(page) === 'unscanned/icon', `picked, not counted ${await heroIs(page)}`);
  await page.click('.tab[data-tab="current"]');
  for (const [path, want] of [['/channels/@me/3001', 'immune/icon'], ['/channels/@me', 'none/icon']]) {
    await page.evaluate((p) => history.pushState({}, '', p), path);
    await page.waitForFunction((w) => {
      const hero = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.hero');
      return `${hero.dataset.state}/${hero.dataset.face}` === w;
    }, want, { timeout: 4000 });
  }

  // Focus follows the work, inside the panel only.
  const focused = () => page.evaluate(() => {
    const el = document.querySelector('#dopa-purifier-host').shadowRoot.activeElement;
    return el ? el.dataset.act : document.activeElement.id || document.activeElement.tagName;
  });
  await page.locator('[data-act="logs"]').focus();
  await page.evaluate(() => { window.__dp.handFocus('[data-act="minimize"]'); window.__dp.applyFocus(); });
  assert(await focused() === 'minimize', `handed straight over: ${await focused()}`);
  await page.evaluate(() => { window.__dp.handFocus('.orb'); window.__dp.applyFocus(); });
  assert(await focused() === 'minimize', `the hidden orb waits: ${await focused()}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.activeElement?.dataset.act === 'restore', null, { timeout: 2000 });
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-role="shell"]:not([hidden])');
  await page.evaluate(() => { const box = document.createElement('textarea'); box.id = 'composer'; document.body.append(box); });
  await page.locator('[data-act="logs"]').focus();
  await page.evaluate(() => window.__dp.handFocus('.orb'));
  await page.focus('#composer');
  await page.evaluate(() => window.__dp.applyFocus());
  await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-act="minimize"]').click());
  await page.waitForSelector('.orb:not([hidden])');
  await page.waitForTimeout(100);
  assert(await focused() === 'composer', `a hand-off never pulls focus out of Discord's message box: ${await focused()}`);
  await page.evaluate(() => { window.__dp.handFocus('[data-act="restore"]'); window.__dp.applyFocus(); });
  assert(await focused() === 'composer', `nothing is handed from outside the panel: ${await focused()}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

const batchSnapshot = (page, keys) => page.evaluate((ks) => {
  const r = document.querySelector('#dopa-purifier-host').shadowRoot;
  return {
    ticked: [...r.querySelectorAll('.row.is-selected')].map((el) => el.dataset.key).sort(),
    checked: r.querySelectorAll('.row .check:checked').length,
    badge: r.querySelector('[data-role="tab-badge"]').hidden ? '' : r.querySelector('[data-role="tab-badge"]').textContent,
    purify: r.querySelector('[data-act="purify"]').disabled ? 'disabled' : 'enabled',
    states: ks.map((k) => `${k}=${r.querySelector(`[data-key="${k}"]`).dataset.state}`).join(' '),
  };
}, keys);

await test('T92 after a batch only what is left stays ticked', async () => {
  {
    const { page, stats, pageErrors, context } = await boot('/channels/4001/5001');
    const keys = ['c:3003', 'c:5002', 'c:5007']; // a DM, #art-share and #mod-only (no access), none counted
    await pickBatch(page, keys);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page, 30000);
    const after = await batchSnapshot(page, keys);
    assert(after.ticked.length === 0 && after.checked === 0, `still ticked ${JSON.stringify(after)}`);
    assert(after.badge === '' && after.purify === 'disabled', `nothing left to offer ${JSON.stringify(after)}`);
    assert(after.states === 'c:3003=done c:5002=done c:5007=error', `outcomes stay readable ${after.states}`);
    const sent = stats.log.length;
    await page.locator('[data-act="purify"]').evaluate((b) => b.click());
    await page.waitForTimeout(300);
    assert(await page.locator('.modal-layer[data-open="true"]').count() === 0, 'no dialog for a finished batch');
    assert(stats.log.length === sent, `requests after the batch: ${stats.log.slice(sent).join(', ')}`);
    assert(await heroIs(page) === 'done/count', `the verdict stays ${await heroIs(page)}`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    // Stopped part-way: the finished chat unticks, and the rest stay ticked for the next go.
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 25 });
    const keys = ['c:5002', 'c:3002', 'c:3003'];
    await pickBatch(page, keys);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-key="c:3002"]').dataset.state === 'running', null, { timeout: 15000 });
    await page.click('[data-act="stop"]');
    await waitEnd(page);
    const after = await batchSnapshot(page, keys);
    assert(after.ticked.join() === 'c:3002,c:3003' && after.badge === '2' && after.purify === 'enabled', `after Stop ${JSON.stringify(after)}`);
    assert(after.states === 'c:5002=done c:3002=stopped c:3003=stopped', `outcomes ${after.states}`);
    await context.close();
  }
});

await test('T93 the running chat scrolls into view, unless you just moved around the list', async () => {
  const geometry = (page) => page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const body = r.querySelector('[data-role="body"]').getBoundingClientRect();
    const strip = r.querySelector('.hero').getBoundingClientRect();
    const row = r.querySelector('[data-key="c:5004"]').getBoundingClientRect();
    return { visible: row.top >= strip.bottom - 1 && row.bottom <= body.bottom + 1, scrollTop: r.querySelector('[data-role="body"]').scrollTop };
  });
  // Picked without a pointer, so the list doesn't count as touched; #Voice Lounge sits below the fold.
  const pickQuietly = async (page) => {
    await page.click('.tab[data-tab="batch"]');
    await page.waitForSelector('.guild-head');
    await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.guild-head').click());
    await page.waitForSelector('[data-key="c:5004"]');
    await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      r.querySelector('[data-key="c:5004"] .check').click();
      r.querySelector('[data-role="body"]').scrollTop = 0;
    });
    const before = await geometry(page);
    assert(!before.visible && before.scrollTop === 0, `the chat starts out of view ${JSON.stringify(before)}`);
  };
  {
    const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1280, height: 600 } });
    await pickQuietly(page);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await page.waitForFunction(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const body = r.querySelector('[data-role="body"]').getBoundingClientRect();
      const row = r.querySelector('[data-key="c:5004"]').getBoundingClientRect();
      return row.top >= r.querySelector('.hero').getBoundingClientRect().bottom - 1 && row.bottom <= body.bottom + 1;
    }, null, { timeout: 3000 });
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1280, height: 600 } });
    await pickQuietly(page);
    const body = await page.locator('[data-role="body"]').boundingBox();
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
    await page.mouse.wheel(0, 40);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="body"]').scrollTop >= 40);
    await page.evaluate(() => { document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="body"]').scrollTop = 0; });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await page.waitForTimeout(600);
    const after = await geometry(page);
    assert(!after.visible && after.scrollTop === 0, `the list stayed where the person left it ${JSON.stringify(after)}`);
    await context.close();
  }
});

// ── The hero, the ring, the height tiers and motion (WP-A) ──

// What the ring shows right now: its state and face, what's visible in the middle, and the line under it.
const ringNow = (page) => page.evaluate(() => {
  const r = document.querySelector('#dopa-purifier-host').shadowRoot;
  const shown = (el) => el.getClientRects().length > 0;
  const hero = r.querySelector('.hero');
  const label = r.querySelector('.count-label');
  const count = r.querySelector('[data-role="count"]');
  const face = r.querySelector('[data-role="hero-face"]');
  const line = r.querySelector('[data-role="readout-line"]');
  const heard = (el) => [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join('');
  return {
    is: `${hero.dataset.state}/${hero.dataset.face}`,
    count: shown(count) ? count.textContent : null,
    countColor: getComputedStyle(count).color,
    icon: shown(face) ? face.dataset.icon : null,
    label: label.textContent,
    labelColor: getComputedStyle(label).color,
    daggers: [...label.querySelectorAll('.ico-dagger')].filter(shown).length,
    labelLines: Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).fontSize)),
    line: line.textContent.replace(/\u00a0/g, ' '),
    heard: heard(line).replace(/\u00a0/g, ' '),
    sub: r.querySelector('[data-role="hero-sub"]').textContent.replace(/\u00a0/g, ' '),
    pct: r.querySelector('[data-role="pct"]').textContent,
  };
});
const heroAt = (page, want, timeout = 4000) => page.waitForFunction((w) => {
  const hero = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.hero');
  return `${hero.dataset.state}/${hero.dataset.face}` === w;
}, want, { timeout });
// Waits for a held request to arrive, and says so if it never does.
async function heldBy(hold, ms = 10000) {
  const t0 = Date.now();
  while (!hold.held) {
    if (Date.now() - t0 > ms) throw new Error('the request to hold never came');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const goTo = (page, path) => page.evaluate((p) => history.pushState({}, '', p), path);
const luminance = ([r, g, b]) => {
  const ch = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const rgb = (css) => css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
const contrast = (a, b) => { const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

// How far the ring's label, count and sticker stay from the arc: positive means clear, in px. Measured
// once the panel's wobble has come to rest, so a finish's squash doesn't skew it.
const ringClearance = async (page) => {
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="wobble"]').style.transform === '', null, { timeout: 4000 });
  return ringGeometry(page);
};
const ringGeometry = (page) => page.evaluate(() => {
  const r = document.querySelector('#dopa-purifier-host').shadowRoot;
  const g = r.querySelector('.gauge').getBoundingClientRect();
  const k = g.width / 200;
  const cx = g.left + g.width / 2, cy = g.top + g.height / 2;
  const inner = (84 - 5) * k; // the arc's centre line less half a bead
  const corners = (b) => [[b.left, b.top], [b.right, b.top], [b.left, b.bottom], [b.right, b.bottom]];
  const inside = (el) => {
    const b = el.getBoundingClientRect();
    return b.width ? Math.round(inner - Math.max(...corners(b).map(([x, y]) => Math.hypot(x - cx, y - cy)))) : null;
  };
  const count = r.querySelector('[data-role="count"]');
  const cb = count.getBoundingClientRect();
  const fs = parseFloat(getComputedStyle(count).fontSize);
  // The digits' ink sits inside the line box by about 0.14em top and bottom.
  const ink = { getBoundingClientRect: () => ({ left: cb.left, right: cb.right, top: cb.top + fs * 0.14, bottom: cb.bottom - fs * 0.13, width: cb.width }) };
  const sticker = r.querySelector('[data-role="sticker"]');
  let stickerClear = null;
  if (!sticker.hidden) {
    const s = sticker.getBoundingClientRect();
    // The card as drawn: its own box turned by its rotation about its centre.
    const [ma, mb] = getComputedStyle(sticker).transform.slice(7).split(',').map(Number);
    const turn = Math.atan2(mb, ma);
    const w = sticker.offsetWidth / 2, h = sticker.offsetHeight / 2;
    const sx = s.left + s.width / 2, sy = s.top + s.height / 2;
    const card = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => [sx + x * Math.cos(turn) - y * Math.sin(turn), sy + x * Math.sin(turn) + y * Math.cos(turn)]);
    const toEdge = (px, py, [ax, ay], [bx, by]) => {
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      return Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
    };
    const within = (px, py) => card.every(([ax, ay], i) => { const [bx, by] = card[(i + 1) % 4]; return (bx - ax) * (py - ay) - (by - ay) * (px - ax) >= 0; });
    const half = 7 * k; // a failure notch stands 14 units proud of the arc's centre line
    let min = Infinity;
    for (let a = 135; a <= 405; a += 1) {
      const t = (a * Math.PI) / 180;
      const x = cx + 84 * k * Math.cos(t), y = cy + 84 * k * Math.sin(t);
      const d = within(x, y) ? 0 : Math.min(...card.map((c, i) => toEdge(x, y, c, card[(i + 1) % 4])));
      min = Math.min(min, d - half);
    }
    const body = r.querySelector('[data-role="body"]').getBoundingClientRect();
    stickerClear = { arc: Math.round(min), arcRaw: Number(min.toFixed(2)), right: Math.round(body.right - s.right), top: Math.round(s.top - body.top) };
  }
  return { label: inside(r.querySelector('.count-label')), count: count.getClientRects().length ? inside(ink) : null, countWidth: Math.round(cb.width), ring: Math.round(g.width), stickerClear };
});

await test('T100 before a run the ring says how many of yours it found, never "0 messages purged"', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  const seen = [];
  const look = async () => { const r = await ringNow(page); seen.push(r); return r; };
  let r = await look();
  assert(r.is === 'unscanned/icon' && r.icon === 'scan' && r.count === null && r.label === 'not counted yet', `uncounted ${JSON.stringify(r)}`);
  assert(r.line === 'Purify asks before anything goes ♡' && r.heard === 'Purify asks before anything goes' && r.pct === '', `uncounted line ${JSON.stringify(r)}`);
  const search = await holdRequests(page, /\/messages\/search/);
  await page.click('[data-act="scan"]');
  await heldBy(search);
  r = await look();
  assert(r.is === 'counting/icon' && r.label === 'counting…' && r.line === '', `counting ${JSON.stringify(r)}`);
  search.release();
  await untilStatus(page, /found/);
  r = await look();
  assert(r.is === 'ready/count' && r.count === '40' && r.label === 'ready for purge' && r.daggers === 0, `counted ${JSON.stringify(r)}`);
  assert(/^about \d+s to purify~$/.test(r.line) && r.pct === '', `counted line ${JSON.stringify(r)}`);
  // The found count is plain --t1 with no glow; the label is rose, far above AA on the panel.
  const glass = await page.evaluate(() => getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]')).getPropertyValue('--glass').trim());
  const glassRgb = `rgb(${parseInt(glass.slice(1, 3), 16)}, ${parseInt(glass.slice(3, 5), 16)}, ${parseInt(glass.slice(5, 7), 16)})`;
  assert(r.countColor === 'rgb(248, 235, 241)' && r.labelColor === 'rgb(255, 160, 194)', `colours ${r.countColor} ${r.labelColor}`);
  assert(contrast(r.labelColor, glassRgb) >= 9.5, `READY FOR PURGE contrast ${contrast(r.labelColor, glassRgb).toFixed(2)}`);
  for (const [path, want] of [['/channels/4001/5004', 'clear/count'], ['/channels/4001/5007', 'blocked/label']]) {
    await goTo(page, path);
    await heroAt(page, 'unscanned/icon');
    await page.click('[data-act="scan"]');
    await heroAt(page, want);
    r = await look();
    if (want === 'clear/count') assert(r.count === '0' && r.label === 'messages found' && r.line === 'All clear~ nothing of yours here ✨' && r.heard === 'All clear~ nothing of yours here', `clear ${JSON.stringify(r)}`);
    else assert(r.count === null && r.label === 'no access' && r.labelColor === 'rgb(255, 128, 144)' && r.line === "You can't read this channel, so Purify can't reach your messages here", `blocked ${JSON.stringify(r)}`);
  }
  await goTo(page, '/channels/@me/3001');
  await heroAt(page, 'immune/icon');
  r = await look();
  assert(r.icon === 'shield' && r.label === 'immune' && r.labelColor === 'rgb(247, 203, 110)', `immune ${JSON.stringify(r)}`);
  assert(r.line === 'Safe from the start~ Bardo & Dopa made the purifier ♡' && r.heard === 'Safe from the start~ Bardo & Dopa made the purifier', `immune line ${JSON.stringify(r)}`);
  assert(await text(page, '[data-role="mood"]') === "this one's immune~", `mood ${await text(page, '[data-role="mood"]')}`);
  // A shield you set yourself says how to undo it.
  await goTo(page, '/channels/@me/3002');
  await heroAt(page, 'unscanned/icon');
  await page.click('[data-role="target-tools"] .shield-btn');
  await heroAt(page, 'immune/icon');
  r = await look();
  assert(r.line === 'You shielded this DM ♡ tap the shield to undo', `your shield ${JSON.stringify(r)}`);
  await goTo(page, '/channels/@me');
  await heroAt(page, 'none/icon');
  r = await look();
  assert(r.icon === 'sparkle' && r.label === 'open a chat' && r.line === 'Any DM, group or server channel works~', `no chat ${JSON.stringify(r)}`);
  for (const s of seen) assert(s.label !== 'messages purged', `a preview said "messages purged": ${JSON.stringify(s)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T101 the Many chats strip counts what it found, says what is left to know, and stays one height in a run', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 15 });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  let r = await ringNow(page);
  assert(r.is === 'none/icon' && r.label === 'nothing picked yet' && r.sub === 'pick any DMs or channels below~', `nothing picked ${JSON.stringify(r)}`);
  assert(r.labelLines === 1, `the strip's label wraps ${JSON.stringify(r)}`);
  await openFriends(page);
  for (const k of ['c:3003', 'c:3002', 'u:2004']) await page.click(`[data-key="${k}"]`);
  r = await ringNow(page);
  assert(r.is === 'unscanned/icon' && r.label === 'not counted yet' && r.sub === '3 chats · 2 to count · 1 closed DM', `picked ${JSON.stringify(r)}`);
  assert(r.labelLines === 1, `the strip's label wraps ${JSON.stringify(r)}`);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 8000);
  r = await ringNow(page);
  assert(r.is === 'ready/count' && r.count === '38' && r.label === 'ready for purge' && r.daggers === 2, `counted ${JSON.stringify(r)}`);
  assert(/^3 chats · 1 closed DM · about \d+s\+$/.test(r.sub), `counted, with a closed DM ${JSON.stringify(r)}`);
  await page.click('[data-key="u:2004"]');
  r = await ringNow(page);
  assert(/^2 chats · about \d+s to purify~$/.test(r.sub), `ready ${JSON.stringify(r)}`);
  await page.locator('.guild-head').first().click();
  await page.waitForSelector('[data-key="c:5002"]');
  await page.click('[data-key="c:5002"]');
  r = await ringNow(page);
  assert(r.is === 'partial/count' && r.count === '38' && r.label === 'found so far' && r.daggers === 0 && r.sub === '3 chats · 1 to count', `partly counted ${JSON.stringify(r)}`);
  const strip = () => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.hero').offsetHeight);
  const before = await strip();
  // Every fifth DELETE in #art-share is refused, so the strip has failures to show.
  let k = 0;
  await page.route(/\/api\/v9\/channels\/5002\/messages\/\d+$/, (route) => {
    if (route.request().method() !== 'DELETE' || ++k % 5) return route.fallback();
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Permissions', code: 50013 }) });
  });
  let n = 0;
  const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 44 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await heldBy(held);
  await page.waitForTimeout(100);
  const run = await page.evaluate(() => {
    const root = document.querySelector('#dopa-purifier-host').shadowRoot;
    const fail = root.querySelector('.sub-fail');
    return { height: root.querySelector('.hero').offsetHeight, readout: getComputedStyle(root.querySelector('[data-role="readout"]')).display, sub: root.querySelector('[data-role="hero-sub"]').textContent.replace(/\u00a0/g, ' '), fail: fail && getComputedStyle(fail).color };
  });
  assert(run.height === before, `the strip changed height in the run: ${before} → ${run.height}`);
  assert(run.readout === 'none' && /^\d+ of \d+\+?( · ~\d+s left)? · 1 failed$/.test(run.sub) && run.fail === 'rgb(255, 128, 144)', `run strip ${JSON.stringify(run)}`);
  held.release();
  await waitEnd(page);
  assert(await strip() === before, 'the strip keeps its height at the finish');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T102 the panel keeps one height from preview to run; time left leads the stats', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  const height = () => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.panel').offsetHeight);
  const preview = await height();
  let n = 0;
  const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 10 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await heldBy(held);
  assert(await height() === preview, `panel ${preview} → ${await height()} when the run started`);
  const stats = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const cells = [...r.querySelector('[data-role="stats"]').children];
    const fail = r.querySelector('[data-role="stat-fail"]');
    return { cells: cells.map((c) => c.dataset.role), eta: cells[0].textContent, etaWeight: getComputedStyle(cells[0].querySelector('b')).fontWeight, failWords: getComputedStyle(fail.querySelector('b')).color };
  });
  assert(stats.cells.join() === 'stat-eta,stat-fail', `stat cells ${stats.cells}`);
  assert(/^~\d+s left$/.test(stats.eta) && stats.etaWeight === '700', `time left ${JSON.stringify(stats)}`);
  assert(stats.failWords === 'rgb(160, 131, 147)', `no failures reads quietly ${stats.failWords}`);
  await page.click('[data-act="pause"]');
  await page.waitForTimeout(250);
  const paused = await page.evaluate(() => getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="stats"]')).opacity);
  assert(paused === '1', `paused stats opacity ${paused}`); // D54: read at AA; the pause shows four other ways
  await page.click('[data-act="resume"]');
  held.release();
  await waitEnd(page);
  await context.close();
});

await test('T103 short screens keep the chat, the count and the buttons in view; the welcome fits', async () => {
  for (const [width, height, tier] of [[1280, 600, 'snug'], [1093, 500, 'strip'], [720, 450, 'strip']]) {
    const { page, context } = await boot('/channels/4001/5001', { viewport: { width, height }, firstRun: true });
    const fits = (sel) => page.evaluate((s) => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const el = r.querySelector(s).getBoundingClientRect();
      const box = (s.startsWith('[data-act="welcome') ? r.querySelector('[data-role="welcome"]') : s === '[data-role="target"]' ? r.querySelector('[data-role="body"]') : r.querySelector('.panel')).getBoundingClientRect();
      return el.top >= box.top - 0.5 && el.bottom <= box.bottom + 0.5 && el.bottom <= innerHeight && el.width > 0;
    }, sel);
    const where = `${width}×${height}`;
    assert(await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.fit) === tier, `${where} tier`);
    const welcome = await page.evaluate(() => getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="welcome"]')).backgroundColor);
    assert(welcome === 'rgb(23, 12, 19)', `${where}: the welcome lets the panel show through (${welcome})`);
    assert(await fits('[data-act="welcome-ok"]'), `${where}: "Got it" is off screen`);
    await page.click('[data-act="welcome-ok"]');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    assert(await fits('[data-role="target"]') && await fits('[data-act="purify"]'), `${where}: the chat or Purify needs a scroll`);
    assert(await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="body"]').scrollTop) === 0, `${where}: scrolled`);
    if (tier === 'snug') {
      // The smaller ring still keeps every word clear of the arc.
      let c = await ringClearance(page);
      assert(c.ring === 168 && c.label >= 4 && c.count >= 4, `${where} counted ${JSON.stringify(c)}`);
      await goTo(page, '/channels/4001/5002');
      await heroAt(page, 'unscanned/icon');
      c = await ringClearance(page);
      assert(c.label >= 4, `${where} uncounted ${JSON.stringify(c)}`);
    } else {
      const r = await ringNow(page);
      // D52: the strip's line starts with the chat Purify acts on.
      assert(r.count === '40' && r.label === 'ready for purge' && r.daggers === 2 && /^general · ✿ Cozy Corner · about \d+s to purify~$/.test(r.sub.replace(/[\u2068\u2069]/g, '')), `${where} strip ${JSON.stringify(r)}`);
    }
    await context.close();
  }
  const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1440, height: 900 } });
  for (const [width, height, tier] of [[1440, 900, 'full'], [1280, 720, 'full'], [340, 700, 'full']]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(50);
    const m = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const b = r.querySelector('.panel').getBoundingClientRect();
      return { fit: r.querySelector('[data-role="layer"]').dataset.fit, width: Math.round(b.width), inside: b.left >= 8 && b.right <= innerWidth - 8 };
    });
    assert(m.fit === tier && m.width === Math.min(360, width - 16) && m.inside, `${width}×${height} ${JSON.stringify(m)}`);
  }
  await context.close();
});

await test('T104 the ring moves only with real work: a sweep on the arc, nothing on a loop', async () => {
  const looping = (page) => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.getAnimations()
    .filter((a) => a.effect && a.effect.getTiming().iterations === Infinity && a.playState === 'running')
    .map((a) => `${a.animationName || 'waapi'}@${a.effect.target.getAttribute('class') || a.effect.target.tagName}`).sort());
  {
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
    // Counting: a faint sweep on the arc.
    const search = await holdRequests(page, /\/messages\/search/);
    await page.click('[data-act="scan"]');
    await heldBy(search);
    // Counting has one busy signal: the sweep (the face no longer breathes, D49).
    assert((await looping(page)).join() === 'dp-turn@sweep', `counting: ${await looping(page)}`);
    search.release();
    await untilStatus(page, /found/);
    assert((await looping(page)).length === 0, `after the count: ${await looping(page)}`);
    // A steady run with a known end keeps no time of its own: kills are the clock.
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 8);
    assert((await looping(page)).length === 0, `steady run: ${await looping(page)}`);
    await waitEnd(page);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/@me/3002');
    // No count yet: the run's own count is in flight, so the sweep says "working, end unknown".
    let confirming = false;
    const search = await holdRequests(page, /\/messages\/search/, { match: () => confirming });
    // Purify's own count meets a rate limit, so it's abandoned and the dialog opens without a number.
    let first = true;
    await page.route(/\/messages\/search/, (route) => {
      if (!first) return route.fallback();
      first = false;
      return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 1, global: false }) });
    });
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    confirming = true;
    await holdConfirm(page);
    await heldBy(search);
    assert((await looping(page)).join() === 'dp-turn@sweep', `unknown total: ${await looping(page)}`);
    // The sweep is a 40° dash on the ring's own circle, starting at the arc's left end (135°) and turned
    // at most 230° about the ring's centre, so its far end stops at 405°, the arc's right end: it never
    // crosses the open bottom where "3 of 31+" sits.
    const geo = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const sweep = r.querySelector('.sweep');
      const c = sweep.querySelector('circle');
      const a = sweep.getAnimations().find((x) => x.animationName === 'dp-turn');
      const frames = a.effect.getKeyframes().map((k) => k.transform).filter(Boolean);
      const turns = frames.map((t) => Number(/rotate\((-?[\d.]+)deg\)/.exec(t)[1]));
      return {
        circle: [c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r'), c.getAttribute('pathLength'), c.getAttribute('transform')].join(),
        dash: c.getAttribute('stroke-dasharray'), turns, origin: getComputedStyle(sweep).transformOrigin,
        under: getComputedStyle(sweep).zIndex,
      };
    });
    const dash = Number(geo.dash.split(' ')[0]);
    assert(geo.circle === '100,100,84,360,rotate(135 100 100)' && dash === 40, `the sweep's dash ${JSON.stringify(geo)}`);
    assert(Math.min(...geo.turns) >= 0 && 135 + dash + Math.max(...geo.turns) <= 405, `the sweep turns past the arc ${JSON.stringify(geo.turns)}`);
    assert(/^98px 98px/.test(geo.origin) && geo.under === '-1', `the sweep turns about the ring's centre, under its notches ${JSON.stringify(geo)}`);
    search.release();
    await waitEnd(page);
    await context.close();
  }
  {
    // The last look: every message handled, the ring full, and a pale sweep while it re-checks.
    const { page, stats, context } = await boot('/channels/4001/5002');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    const look = await holdRequests(page, /\/messages\/search/, { match: () => stats.deletes.length >= 10 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await heldBy(look);
    const last = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      return { dial: r.querySelector('.dial').getAttribute('class'), head: getComputedStyle(r.querySelector('.g-head')).visibility, eta: r.querySelector('[data-role="stat-eta"] b').textContent };
    });
    assert(/is-verifying/.test(last.dial) && last.head === 'hidden' && last.eta === 'double-checking…', `last look ${JSON.stringify(last)}`);
    assert((await looping(page)).join() === 'dp-turn@sweep', `last look: ${await looping(page)}`);
    look.release();
    await waitEnd(page);
    await context.close();
  }
  {
    // Reduced motion: no sweep at all, only the track breathing (opacity), never a frozen fake arc.
    const { page, context } = await boot('/channels/@me/3002', { reducedMotion: 'reduce' });
    let confirming = false;
    const search = await holdRequests(page, /\/messages\/search/, { match: () => confirming });
    // Purify's own count meets a rate limit, so it's abandoned and the dialog opens without a number.
    let first = true;
    await page.route(/\/messages\/search/, (route) => {
      if (!first) return route.fallback();
      first = false;
      return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 1, global: false }) });
    });
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    confirming = true;
    await holdConfirm(page);
    await heldBy(search);
    const rm = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      return { sweep: getComputedStyle(r.querySelector('.sweep')).display, track: getComputedStyle(r.querySelector('.g-track')).animationName };
    });
    assert(rm.sweep === 'none' && rm.track === 'dp-breathe', `reduced motion ${JSON.stringify(rm)}`);
    search.release();
    await waitEnd(page);
    await context.close();
  }
});

// A build at a steadier pace, with the named closure bindings on window.__dp.
// timing: more TIMING keys to set, e.g. { waitUnitMs: 10 } for Discord's waits and the backoff.
async function bootPaced(path, { deleteMs, probe = [], timing = {}, ...opts }) {
  const src = withTiming(source, { deleteDelayMs: deleteMs, ...timing })
    .replace(HOOK, `window.__dp = { ${probe.join(', ')} };\n  ${HOOK}`);
  return bootWith(src, path, opts);
}

await test('T105 pace and time left are honest from the first kill; big counts fit; the orb says how it is going', async () => {
  {
    const { page, context } = await bootPaced('/channels/4001/5002', { deleteMs: 150 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    const preview = (await ringNow(page)).line;
    assert(preview === 'about 4s to purify~', `preview ${preview}`);
    await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      window.__seen = [];
      const note = () => window.__seen.push({ purged: Number(r.querySelector('[data-role="tf-purged"]').textContent), eta: r.querySelector('[data-role="stat-eta"] b').textContent, rate: r.querySelector('[data-role="tf-rate"]').textContent });
      new MutationObserver(note).observe(r.querySelector('.term-foot'), { subtree: true, childList: true, characterData: true });
      new MutationObserver(note).observe(r.querySelector('[data-role="stats"]'), { subtree: true, childList: true, characterData: true });
    });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    const seen = await page.evaluate(() => window.__seen);
    const etas = seen.map((s) => s.eta).filter((e) => /left$/.test(e));
    assert(etas[0] === '~4s left', `the first time left (${etas[0]}) disagrees with the preview's "about 4s"`);
    assert(seen.every((s) => s.purged >= 3 || s.rate === ''), `a rate before the third kill: ${JSON.stringify(seen.find((s) => s.purged < 3 && s.rate))}`);
    const rates = seen.filter((s) => s.rate).map((s) => parseFloat(s.rate));
    assert(rates.length && Math.max(...rates) <= (1000 / 150) * 1.15, `rates ${rates.join(', ')}`);
    await context.close();
  }
  {
    // The shown ETA falls freely and rises only for a real slow-down, never for a jitter under 15 %.
    const { page, context } = await bootProbe('/channels/4001/5001', ['renderProgress', 'progressSnapshot', 'counts', 'renderCurrent']);
    let n = 0;
    const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 2 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await heldBy(held);
    const shownFor = (eta) => page.evaluate((s) => {
      window.__dp.renderProgress({ ...window.__dp.progressSnapshot(), etaSeconds: s });
      return document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="stat-eta"] b').textContent;
    }, eta);
    const steps = [[40, '~40s left'], [44, '~40s left'], [38, '~38s left'], [45, '~45s left'], [50, '~45s left'], [30, '~30s left']];
    for (const [eta, want] of steps) assert(await shownFor(eta) === want, `eta ${eta} shows ${await shownFor(eta)}, not ${want}`);
    held.release();
    await waitEnd(page);
    // Five digits step the number down so it stays inside the ring.
    await goTo(page, '/channels/4001/5002');
    await heroAt(page, 'unscanned/icon');
    await page.evaluate(() => { window.__dp.counts.set('5002', 12345); window.__dp.renderCurrent(); });
    await heroAt(page, 'ready/count');
    const big = await ringClearance(page);
    assert(big.countWidth <= 137 && big.count >= 4, `12,345 ${JSON.stringify(big)}`);
    // A million still fits, if anyone ever gets there.
    await page.evaluate(() => { window.__dp.counts.set('5002', 1234567); window.__dp.renderCurrent(); });
    const huge = await ringClearance(page);
    assert(huge.count >= 4, `1,234,567 ${JSON.stringify(huge)}`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    let n = 0;
    const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 10 });
    const orb = () => page.evaluate(() => { const o = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.orb'); return { title: o.title, label: o.getAttribute('aria-label') }; });
    assert((await orb()).title === "Open Dopa's Purifier", `idle orb ${JSON.stringify(await orb())}`);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await heldBy(held);
    await page.click('[data-act="pause"]');
    await page.click('[data-act="minimize"]');
    await page.waitForSelector('.orb:not([hidden])');
    const paused = await orb();
    assert(/^Paused~ \d+ of 40$/.test(paused.title) && paused.label === `Open Dopa's Purifier — paused, ${paused.title.slice(8)}`, `paused orb ${JSON.stringify(paused)}`);
    await page.click('.orb');
    await page.waitForSelector('[data-role="shell"]:not([hidden])');
    await page.click('[data-act="resume"]');
    await page.click('[data-act="minimize"]');
    await page.waitForSelector('[data-role="shell"][hidden]', { state: 'attached' });
    const live = await orb();
    assert(/^Purifying~ \d+ of 40( · about \d+s left)?$/.test(spaced(live.title)) && /^Open Dopa's Purifier — purifying, \d+ of 40$/.test(live.label), `running orb ${JSON.stringify(live)}`);
    held.release();
    await waitEnd(page);
    assert((await orb()).title === 'All clean~ 40 purged', `finished orb ${JSON.stringify(await orb())}`);
    await context.close();
  }
});

// Samples, every frame for `ms`, the opacity and transform of the named elements (and whether they render).
const sampleFrames = (page, sels, ms, start = '') => page.evaluate(({ sels, ms, start }) => new Promise((done) => {
  const r = document.querySelector('#dopa-purifier-host').shadowRoot;
  if (start) r.querySelector(start).click();
  const frames = [];
  const t0 = performance.now();
  const tick = () => {
    frames.push(sels.map((s) => {
      const el = r.querySelector(s);
      const cs = getComputedStyle(el);
      return { o: el.getClientRects().length ? Number(cs.opacity) : 0, t: cs.transform };
    }));
    if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(frames);
  };
  requestAnimationFrame(tick);
}), { sels, ms, start });

await test('T106 reduced motion keeps gentle fades: the dialog and the orb fade, nothing moves', async () => {
  const { page, context } = await boot('/channels/4001/5002', { reducedMotion: 'reduce' });
  // What is animating on an element: its name, length and the properties it changes.
  const motion = (sel) => page.evaluate((s) => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector(s).getAnimations().map((a) => ({
    name: a.animationName || a.transitionProperty || 'script', ms: a.effect.getTiming().duration,
    props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((p) => !['offset', 'computedOffset', 'easing', 'composite'].includes(p))))].join(),
  })), sel);
  const opening = page.evaluate(() => new Promise((done) => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const layer = r.querySelector('.modal-layer');
    const seen = [];
    new MutationObserver((_, obs) => {
      if (layer.dataset.open !== 'true') return;
      obs.disconnect();
      const t0 = performance.now();
      const tick = () => {
        seen.push(Number(getComputedStyle(layer).opacity));
        if (performance.now() - t0 < 260) requestAnimationFrame(tick); else done(seen);
      };
      tick();
    }).observe(layer, { attributes: true });
  }));
  opening.catch(() => {}); // a failure below closes the page under it
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const open = [...await motion('.modal-layer'), ...await motion('.modal')];
  assert(open.length === 2 && open.every((m) => m.name === 'dp-fade' && m.ms === 160 && m.props === 'opacity'), `dialog opening ${JSON.stringify(open)}`);
  const seen = await opening;
  assert(seen.some((o) => o > 0.02 && o < 0.98) && seen[seen.length - 1] === 1, `dialog opacity ${seen.map((o) => o.toFixed(2))}`);
  await page.click('[data-act="cancel"]');
  const closing = await motion('.modal-layer');
  assert(closing.length === 1 && closing[0].name === 'opacity' && closing[0].ms === 160, `dialog closing ${JSON.stringify(closing)}`);
  assert((await motion('.modal')).every((m) => !/transform/.test(m.props)), `the dialog moves on its way out ${JSON.stringify(await motion('.modal'))}`);
  assert(await page.evaluate(() => getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.modal')).transform) === 'none', 'the dialog shrinks on its way out');
  await page.waitForSelector('.modal-layer', { state: 'hidden', timeout: 1000 });
  const moving = await page.evaluate(() => [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.btn, .tab-pill, .icon-btn, .orb, .logs-btn, .tab')]
    .map((el) => getComputedStyle(el).transitionProperty).filter((p) => /transform|all/.test(p)));
  assert(moving.length === 0, `transform transitions left: ${moving}`);
  // Minimising cross-fades the panel and the orb in place.
  await page.click('[data-act="minimize"]');
  const fold = [...await motion('.panel'), ...await motion('.orb')];
  assert(fold.length >= 2 && fold.every((m) => m.props === 'opacity' && m.ms <= 160), `minimise ${JSON.stringify(fold)}`);
  await page.waitForSelector('.orb:not([hidden])');
  await page.waitForSelector('[data-role="shell"][hidden]', { state: 'attached', timeout: 1000 });
  await context.close();
});

const wobbleTurn = (page, ms) => page.evaluate((ms) => new Promise((done) => {
  const w = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="wobble"]');
  const out = [];
  const t0 = performance.now();
  const tick = () => {
    const m = /rotate\((-?[\d.]+)deg\)/.exec(w.style.transform);
    out.push(m ? Number(m[1]) : 0);
    if (performance.now() - t0 < ms) requestAnimationFrame(tick); else done(out);
  };
  tick();
}), ms);

await test('T107 motion polish: minimise lands in the orb, tabs fade, the header ignores clicks, a calm drag, a stamped finish', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 20 });
  // The orb appears while the panel shrinks into it: no frame shows neither.
  const fold = await sampleFrames(page, ['.panel', '.orb'], 420, '[data-act="minimize"]');
  const blank = fold.findIndex(([p, o]) => Math.max(p.o, o.o) < 0.1);
  assert(blank === -1, `blank frame ${blank} of ${fold.length}: ${JSON.stringify(fold.map(([p, o]) => [p.o.toFixed(2), o.o.toFixed(2)]))}`);
  const scales = fold.map(([p]) => (p.t === 'none' ? 1 : Number(p.t.slice(7).split(',')[0]))).filter((s, i) => fold[i][0].o > 0);
  assert(Math.min(...scales) < 0.4, `the panel never shrank toward the orb: ${Math.min(...scales)}`);
  // A click mid-way plays the same path back, either way round.
  const press = (sel) => page.evaluate((s) => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector(s).click(), sel);
  const settled = () => page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    return { open: !r.querySelector('[data-role="shell"]').hidden && r.querySelector('.orb').hidden, closed: r.querySelector('[data-role="shell"]').hidden && !r.querySelector('.orb').hidden, moving: r.getAnimations().filter((a) => a.effect && ['panel', 'orb'].includes(a.effect.target.className)).length };
  });
  for (const [first, second, want] of [['.orb', '[data-act="minimize"]', 'closed'], [null, '.orb', 'open'], ['[data-act="minimize"]', '.orb', 'open']]) {
    if (first) {
      await press(first);
      await page.waitForTimeout(90);
    }
    await press(second);
    await page.waitForTimeout(450);
    const s = await settled();
    assert(s[want] && s.moving === 0, `${first} then ${second} ends ${JSON.stringify(s)}, not ${want}`);
  }
  // Tabs switch without a wobble; the new view fades in.
  await page.click('.tab[data-tab="batch"]');
  const tabFade = await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="body"]').getAnimations().length);
  assert(tabFade === 1 && Math.max(...(await wobbleTurn(page, 150)).map(Math.abs)) === 0, `tab switch fade ${tabFade}`);
  await page.click('.tab[data-tab="current"]');
  await page.waitForTimeout(250);
  // A click on the header, or a 2px slip, is not a drag.
  const head = await page.locator('.titles').boundingBox();
  const before = await storedPrefs(page);
  await page.mouse.move(head.x + 40, head.y + 8);
  await page.mouse.down();
  await page.mouse.move(head.x + 42, head.y + 8);
  const slip = await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.dragging ?? '');
  await page.mouse.up();
  const still = await wobbleTurn(page, 120);
  await page.waitForTimeout(300);
  const after = await storedPrefs(page);
  assert(slip === '' && still.every((v) => v === 0) && await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="wobble"]').style.transform) === '', 'a header click jiggled the panel');
  assert(JSON.stringify([after.x, after.y]) === JSON.stringify([before.x, before.y]), `a header click moved the remembered spot ${JSON.stringify([before.x, before.y])} → ${JSON.stringify([after.x, after.y])}`);
  // A fast drag tilts at most 3.5°, and the release swings back through rest without a shove.
  await page.mouse.move(head.x + 40, head.y + 8);
  await page.mouse.down();
  const turns = wobbleTurn(page, 900);
  for (let i = 1; i <= 6; i++) { await page.mouse.move(head.x + 40 - i * 60, head.y + 8 + i * 8); await page.waitForTimeout(16); }
  await page.mouse.up();
  const tilt = Math.max(...(await turns).map(Math.abs));
  assert(tilt > 0.3 && tilt <= 3.6, `drag tilt ${tilt.toFixed(2)}°`);
  // Every control answers a press.
  const mute = await page.locator('[data-act="mute"]').boundingBox();
  await page.mouse.move(mute.x + mute.width / 2, mute.y + mute.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  const pressed = await page.evaluate(() => getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-act="mute"]')).transform);
  await page.mouse.up();
  assert(pressed.startsWith('matrix(0.9,'), `mute press ${pressed}`);
  // The finish in beats: the verdict settles in at 60ms, the sticker is stamped at 380ms, no spin.
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.hero === 'done', null, { timeout: 15000 });
  const beats = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const one = (el) => el.getAnimations().map((a) => ({ delay: a.effect.getTiming().delay, duration: a.effect.getTiming().duration, first: a.effect.getKeyframes()[0].transform }))[0] || null;
    return { line: one(r.querySelector('[data-role="readout-line"]')), sticker: one(r.querySelector('[data-role="sticker"]')) };
  });
  assert(beats.line && beats.line.delay === 60 && beats.line.duration === 220, `readout beat ${JSON.stringify(beats.line)}`);
  assert(beats.sticker && beats.sticker.delay === 380 && beats.sticker.duration === 340 && beats.sticker.first === 'rotate(4deg) scale(1.6)', `sticker beat ${JSON.stringify(beats.sticker)}`);
  assert(Math.max(...(await wobbleTurn(page, 500)).map(Math.abs)) < 0.05, 'the finish spun the panel');
  await context.close();
});

await test('T108 endings: only a clean finish turns the count rose, the sticker sits clear of every notch', async () => {
  {
    const { page, context } = await boot('/channels/4001/5001');
    let k = 0;
    await page.route(/\/api\/v9\/channels\/5001\/messages\/\d+$/, (route) => {
      if (route.request().method() !== 'DELETE' || ++k % 8) return route.fallback();
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Permissions', code: 50013 }) });
    });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await page.waitForTimeout(800);
    const end = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const pct = r.querySelector('[data-role="pct"]');
      return { pct: pct.textContent, colour: getComputedStyle(pct).color, mood: r.querySelector('[data-role="mood"]').textContent, sticker: r.querySelector('[data-role="sticker"]').textContent };
    });
    assert(end.pct === '35 of 40' && end.colour === 'rgb(207, 179, 193)', `with failures ${JSON.stringify(end)}`);
    assert(end.mood === 'mostly clean, princess ♡' && end.sticker === 'mostly clean~', `with failures ${JSON.stringify(end)}`);
    const c = await ringClearance(page);
    assert(c.stickerClear && c.stickerClear.arc >= 2 && c.stickerClear.right >= 0 && c.stickerClear.top >= 0, `the sticker covers the ring or leaves the body ${JSON.stringify(c.stickerClear)}`);
    await context.close();
  }
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }]) {
    const { page, context } = await boot('/channels/4001/5002', { viewport });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await page.waitForTimeout(800);
    const end = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const pct = r.querySelector('[data-role="pct"]');
      return { pct: pct.textContent, colour: getComputedStyle(pct).color, mood: r.querySelector('[data-role="mood"]').textContent };
    });
    assert(end.pct === '10 of 10' && end.colour === 'rgb(255, 196, 216)' && end.mood === 'all clean, princess ♡', `clean ${JSON.stringify(end)}`);
    const c = await ringClearance(page);
    assert(c.stickerClear && c.stickerClear.arc >= 2 && c.stickerClear.right >= 0 && c.stickerClear.top >= 0, `${viewport.height}px: the sticker ${JSON.stringify(c.stickerClear)}`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 20 });
    let n = 0;
    const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 5 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await heldBy(held);
    await page.click('[data-act="stop"]');
    held.release();
    await waitEnd(page);
    assert(await text(page, '[data-role="mood"]') === 'stopped~ no rush ♡', `stopped mood ${await text(page, '[data-role="mood"]')}`);
    await context.close();
  }
});

await test('T109 seven type sizes and one caps tracking', async () => {
  const css = JSON.parse(/const CSS = ("(?:[^"\\]|\\.)*");/.exec(source)[1]).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = [...css.matchAll(/--fs-[a-z]+:\s*([\d.]+px)/g)].map((m) => m[1]);
  assert(tokens.join() === '10.5px,11.5px,13px,14px,20px,24px,56px', `type tokens ${tokens}`);
  // Decorative glyphs keep their own sizes, and the ring's count and label step down to fit the arc.
  const exempt = /\.status-dot|\.target-ico|\.guild-badge|\.confetti-glyph|\[data-len=|\[data-fit="snug"\]\[data-tab="current"\] \.count/;
  const raw = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sizes = [...body.matchAll(/font-size:\s*([^;]+)/g)].map((m) => m[1].trim())
      .concat([...body.matchAll(/(?:^|;)\s*font:\s*([^;]+)/g)].map((m) => (/(?:^|\s)(\d+(?:\.\d+)?px)(?=\/|\s)/.exec(m[1]) || [])[1]).filter(Boolean));
    for (const size of sizes) if (!/^var\(--fs-[a-z]+\)$/.test(size) && !exempt.test(selector)) raw.push(`${selector.trim()} → ${size}`);
    // Every sans caps label shares one tracking; the terminal's mono keeps its own.
    const track = /letter-spacing:\s*([^;]+)/.exec(body);
    if (/text-transform:\s*uppercase/.test(body) || (track && /^\.1\d*em$/.test(track[1].trim()) && !/--mono/.test(body))) {
      if (!track || track[1].trim() !== 'var(--track-cap)') raw.push(`${selector.trim()} → tracking ${track ? track[1] : 'none'}`);
    }
  }
  assert(raw.length === 0, `sizes and caps outside the scale:\n      ${raw.join('\n      ')}`);
  // On screen: every word in the panel uses one of the seven sizes.
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  const used = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const out = new Set();
    for (const el of r.querySelectorAll('.panel *')) {
      if (!el.getClientRects().length || el.closest('.target-ico, .status-dot')) continue;
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) out.add(getComputedStyle(el).fontSize);
    }
    return [...out].sort((a, b) => parseFloat(a) - parseFloat(b));
  });
  assert(used.every((s) => ['10.5px', '11.5px', '13px', '14px', '20px', '24px', '56px'].includes(s)), `sizes on screen ${used}`);
  await context.close();
});

// ---- WP-J (4.2) ----
// Layout, visual system and accessibility: D51–D56, and amendments J1–J3 (T280–T283 extend T163, T102,
// T103 and T108).

// Runs fn(shadowRoot, arg) in the page (inPanel is declared further down).
const jPanel = (page, fn, arg) => page.evaluate(([src, a]) => new Function('r', 'a', `return (${src})(r, a);`)(document.querySelector('#dopa-purifier-host').shadowRoot, a), [fn.toString(), arg]);
// The page's pixels in a box, as [r, g, b] rows (at the page's device scale).
async function shotPixels(page, clip) {
  const b64 = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = `data:image/png;base64,${src}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const rows = [];
    for (let y = 0; y < c.height; y++) {
      const row = [];
      for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; row.push([d[i], d[i + 1], d[i + 2]]); }
      rows.push(row);
    }
    return rows;
  }, b64);
}
const pxRatio = (a, b) => contrast(`rgb(${a.join(',')})`, `rgb(${b.join(',')})`);
// Whether each control is the topmost thing at its own centre.
const hitsSelf = (page, sels) => jPanel(page, (r, list) => Object.fromEntries(list.map((sel) => {
  const b = r.querySelector(sel).getBoundingClientRect();
  const el = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  return [sel, !!el && !!el.closest(sel)];
})), sels);
const rectOf = (page, sel) => jPanel(page, (r, s) => { const b = r.querySelector(s).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; }, sel);

await test('T238 with no room beside the panel the log is a sheet over its body; Pause, Stop and Logs stay clear', async () => {
  for (const [width, height, over] of [[640, 360, true], [627, 333, true], [683, 384, false], [720, 450, false]]) {
    const where = `${width}×${height}`;
    const { page, pageErrors, context } = await boot('/channels/4001/5001', { viewport: { width, height }, latencyMs: 10 });
    let n = 0;
    const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 3 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await heldBy(held);
    await page.click('[data-act="logs"]');
    await page.waitForTimeout(450);
    const hits = await hitsSelf(page, ['[data-act="copy-log"]', '[data-act="close-log"]', '[data-act="pause"]', '[data-act="stop"]', '[data-act="logs"]']);
    assert(Object.values(hits).every(Boolean), `${where}: something is covered ${JSON.stringify(hits)}`);
    const m = await jPanel(page, (r) => {
      const t = r.querySelector('.term');
      const b = t.getBoundingClientRect();
      const p = r.querySelector('.panel').getBoundingClientRect();
      return { over: t.hasAttribute('data-over'), inView: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, apart: b.right <= p.left || b.left >= p.right,
        inert: ['.head', '.tabs', '[data-role="body"]'].map((s) => r.querySelector(s).inert) };
    });
    assert(m.over === over && m.inView, `${where}: ${JSON.stringify(m)}`);
    if (over) {
      assert(m.inert.every(Boolean), `${where}: what the sheet covers can still be reached ${JSON.stringify(m)}`);
      await page.focus('[data-act="logs"]');
      await page.keyboard.press('Tab');
      const next = await jPanel(page, (r) => r.activeElement && r.activeElement.dataset.act);
      assert(next === 'copy-log', `${where}: Tab from Logs went to ${next}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const lifted = await jPanel(page, (r) => ({ focus: r.activeElement && r.activeElement.dataset.act, inert: ['.head', '.tabs', '[data-role="body"]'].some((s) => r.querySelector(s).inert), over: r.querySelector('.term').hasAttribute('data-over') }));
      assert(lifted.focus === 'logs' && !lifted.inert && !lifted.over, `${where}: closing the sheet ${JSON.stringify(lifted)}`);
    } else assert(m.apart && !m.inert.some(Boolean), `${where}: side by side ${JSON.stringify(m)}`);
    held.release();
    await page.click('[data-act="stop"]');
    await waitEnd(page, 8000);
    assert(pageErrors.length === 0, `${where}: page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T239 side by side, the log is as tall as the panel, before and after the lists load', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="logs"]');
  await page.waitForTimeout(450);
  const heights = () => jPanel(page, (r) => ({ term: r.querySelector('.term').getBoundingClientRect().height, panel: r.querySelector('.panel').offsetHeight }));
  let h = await heights();
  assert(Math.abs(h.term - h.panel) <= 1, `This chat: log ${h.term} vs panel ${h.panel}`);
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.waitForTimeout(300);
  h = await heights();
  assert(Math.abs(h.term - h.panel) <= 1, `Many chats: log ${h.term} vs panel ${h.panel}`);
  await context.close();
});

await test('T240 in a 280px log the summary and Discord\'s reasons read whole', async () => {
  const { page, context } = await boot('/channels/4001/5002', { viewport: { width: 682, height: 800 } });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  await page.click('[data-act="logs"]');
  await page.waitForTimeout(450);
  const m = await jPanel(page, (r) => {
    const line = [...r.querySelectorAll('.term-body .line')].find((l) => /SUMMARY/.test(l.textContent));
    const msg = line.querySelector('.line-msg');
    return { width: Math.round(r.querySelector('.term').getBoundingClientRect().width), text: msg.textContent, whole: msg.scrollWidth <= msg.clientWidth };
  });
  assert(m.width === 280, `log width ${m.width}`);
  assert(m.whole, `the summary is cut ${JSON.stringify(m)}`);
  await context.close();
});

await test('T241 a dragged panel stays docked to its side when the window grows', async () => {
  const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1280, height: 720 } });
  const gap = () => jPanel(page, (r) => innerWidth - r.querySelector('[data-role="shell"]').offsetLeft - r.querySelector('.panel').offsetWidth);
  const head = await page.locator('.titles').boundingBox();
  await page.mouse.move(head.x + 40, head.y + 8);
  await page.mouse.down();
  await page.mouse.move(head.x, head.y + 8, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const before = await gap();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.waitForTimeout(200);
  const after = await gap();
  assert(before === 60 && after === before, `right gap ${before} → ${after}`);
  await context.close();
});

await test('T242 minimised, screen readers hear how the purge ended; reopening empties the region', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 10 });
  let n = 0;
  const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 3 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await heldBy(held);
  await page.click('[data-act="minimize"]');
  await page.waitForSelector('[data-role="shell"][hidden]', { state: 'attached' });
  held.release();
  await waitEnd(page);
  const region = () => jPanel(page, (r) => { const m = r.querySelector('[data-role="milestone"]'); return { text: m.textContent, shown: !m.closest('[hidden]'), atomic: m.getAttribute('aria-atomic') }; });
  const said = await region();
  assert(said.text === "Dopa's Purifier: All clean~ 10 purged" && said.shown && said.atomic === 'true', `minimised ending ${JSON.stringify(said)}`);
  await page.click('.orb');
  await page.waitForSelector('[data-role="shell"]:not([hidden])');
  assert((await region()).text === '', `after reopening ${JSON.stringify(await region())}`);
  await context.close();
});

await test('T243 a run that ends with the panel open leaves no milestone behind', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 10 });
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  await page.evaluate(() => {
    window.__said = [];
    const m = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="milestone"]');
    new MutationObserver(() => { if (m.textContent) window.__said.push(m.textContent); }).observe(m, { childList: true, characterData: true, subtree: true });
  });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  const end = await jPanel(page, (r) => r.querySelector('[data-role="milestone"]').textContent);
  assert((await page.evaluate(() => window.__said.length)) >= 1 && end === '', `milestones ${JSON.stringify(await page.evaluate(() => window.__said))}, at the end ${JSON.stringify(end)}`);
  await context.close();
});

await test('T244 the orb says what it opens and how it is going; hearts and marks are not read as symbols', async () => {
  {
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 10 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    let n = 0;
    const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 15 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await heldBy(held);
    await page.click('[data-act="pause"]');
    await page.click('[data-act="minimize"]');
    await page.waitForSelector('.orb:not([hidden])');
    const orb = await jPanel(page, (r) => ({ title: r.querySelector('.orb').title, label: r.querySelector('.orb').getAttribute('aria-label') }));
    assert(orb.label === "Open Dopa's Purifier — paused, 14 of 40" && orb.title === 'Paused~ 14 of 40', `paused orb ${JSON.stringify(orb)}`);
    held.release();
    await context.close();
  }
  const { page, context } = await boot('/channels/4001/5001');
  let k = 0;
  await page.route(/\/api\/v9\/channels\/5001\/messages\/\d+$/, (route) => {
    if (route.request().method() !== 'DELETE' || ++k % 8) return route.fallback();
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Permissions', code: 50013 }) });
  });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  await page.click('[data-act="logs"]');
  await page.waitForTimeout(450);
  const cdp = await context.newCDPSession(page);
  const nodes = (await cdp.send('Accessibility.getFullAXTree')).nodes.filter((x) => !x.ignored).map((x) => ({ role: x.role && x.role.value, name: (x.name && x.name.value) || '' }));
  const texts = nodes.filter((x) => x.role === 'StaticText').map((x) => x.name);
  assert(!texts.some((t) => /^[\s♡>✗⚠›·]+$/.test(t)), `symbols read aloud: ${JSON.stringify(texts.filter((t) => /^[\s♡>✗⚠›·]+$/.test(t)).slice(0, 5))}`);
  assert(texts.includes('mostly clean, princess') && !texts.some((t) => /princess ♡/.test(t)), `the mood reads ${JSON.stringify(texts.filter((t) => /princess/.test(t)))}`);
  assert(nodes.some((x) => x.role === 'image' && x.name === 'Error'), 'a failed line is marked Error in words');
  // Copying keeps every mark: what the log shows is what you paste.
  await page.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__copied = t; }; });
  await page.click('[data-act="copy-log"]');
  const copied = await page.evaluate(() => window.__copied);
  assert(/^>wake up, princess~\n>dopa-os v\d+\.\d+\.\d+ · loading heart\.sys · dagger\.dll\n/.test(copied) && /\n>♡{29}\n/.test(copied) && /\n\d\d:\d\d:\d\d✗FAILED · /.test(copied) && /\n\d\d:\d\d:\d\d›SUMMARY: 35 purged, 5 failed/.test(copied),
    `copied log ${JSON.stringify(copied.slice(0, 300))}`);
  await context.close();
});

await test('T245 the chosen tab\'s pill has an edge you can see (3:1 against the track, at 1x)', async () => {
  const { page, context } = await boot('/channels/4001/5001', { dpr: 1 });
  await page.mouse.move(5, 5);
  const pill = await rectOf(page, '.tab-pill');
  const y = Math.round(pill.top + pill.height / 2);
  const x = Math.round(pill.left);
  const [row] = await shotPixels(page, { x: x - 2, y, width: 4, height: 1 });
  const ratio = pxRatio(row[2], row[0]);
  assert(ratio >= 3, `pill edge ${row[2]} vs track ${row[0]}: ${ratio.toFixed(2)}:1`);
  await context.close();
});

await test('T246 before a run the caption sits midway between ring and card; the caps label never hops', async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }]) {
    const where = `${viewport.width}×${viewport.height}`;
    const { page, context } = await boot('/channels/4001/5001', { viewport });
    await heroAt(page, 'unscanned/icon');
    const geo = () => jPanel(page, (r) => {
      const g = r.querySelector('.gauge').getBoundingClientRect();
      const k = g.width / 200;
      const arcEnd = g.top + g.height / 2 + 84 * k * Math.SQRT1_2 + 4 * k; // the arc's ends, cap included
      const card = r.querySelector('[data-role="target"]').getBoundingClientRect().top;
      const line = r.querySelector('[data-role="readout-line"]').getBoundingClientRect();
      return { off: line.top + line.height / 2 - (arcEnd + card) / 2, label: r.querySelector('.count-label').getBoundingClientRect().top };
    });
    const icon = await geo();
    await page.click('[data-act="scan"]');
    await heroAt(page, 'ready/count');
    const counted = await geo();
    assert(Math.abs(icon.off) <= 4 && Math.abs(counted.off) <= 4, `${where}: caption off midway by ${icon.off.toFixed(1)} / ${counted.off.toFixed(1)}px`);
    assert(Math.abs(icon.label - counted.label) <= 0.5, `${where}: the label hops ${icon.label} → ${counted.label}`);
    await context.close();
  }
});

await test('T247 the orb draws the hero\'s 270° arc and never fills its open bottom', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 10 });
  let n = 0;
  const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 3 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await heldBy(held);
  await page.click('[data-act="minimize"]');
  await page.waitForSelector('[data-role="shell"][hidden]', { state: 'attached' });
  held.release();
  await waitEnd(page);
  const orb = await jPanel(page, (r) => ['.orb-track', '.orb-fill'].map((s) => {
    const c = r.querySelector(s);
    const cs = getComputedStyle(c);
    return { dash: Number(c.getAttribute('stroke-dasharray').split(' ')[0]), turn: c.getAttribute('transform'), css: cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0) ? cs.transitionProperty : '' };
  }));
  const arc = 0.75 * 2 * Math.PI * 22;
  assert(orb.every((c) => c.turn === 'rotate(135 24 24)' && Math.abs(c.dash - arc) < 0.01), `the orb's arc ${JSON.stringify(orb)}`);
  assert(!/stroke-dasharray|all/.test(orb[1].css), `the fill animates while minimised: ${orb[1].css}`);
  await context.close();
});

await test('T248 a disabled Purify is a solid muted box, not the queued pill\'s dashed outline', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  const s = await jPanel(page, (r) => { const b = r.querySelector('[data-act="purify"]'); const cs = getComputedStyle(b); return { disabled: b.disabled, outline: cs.outlineStyle, shadow: cs.boxShadow }; });
  assert(s.disabled && s.outline === 'none' && /inset/.test(s.shadow) && /1px/.test(s.shadow), `disabled Purify ${JSON.stringify(s)}`);
  await context.close();
});

await test('T249 a label that cannot fit keeps its first letters, in any font and with WCAG text spacing', async () => {
  const fonts = ['Verdana, sans-serif', "'DejaVu Sans', sans-serif"];
  const spacing = '.layer * { letter-spacing: .12em !important; word-spacing: .16em !important; }';
  const leftCut = (page) => jPanel(page, (r) => [...r.querySelectorAll('.btn')].filter((b) => b.getClientRects().length && !b.closest('[hidden]')).flatMap((b) => {
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const t = walker.nextNode();
    if (!t) return [];
    const range = document.createRange();
    range.selectNodeContents(t);
    const first = range.getClientRects()[0];
    return first && first.left < b.getBoundingClientRect().left - 0.5 ? [b.textContent.trim()] : [];
  }));
  const style = (page, css) => jPanel(page, (r, c) => { let s = r.querySelector('#t249'); if (!s) { s = document.createElement('style'); s.id = 't249'; r.append(s); } s.textContent = c; }, css);
  for (const font of fonts) {
    const { page, context } = await boot('/channels/4001/5001', { firstRun: true });
    const check = async (state) => {
      for (const extra of ['', spacing]) {
        await style(page, `.layer { --font: ${font} !important; } ${extra}`);
        const cut = await leftCut(page);
        assert(cut.length === 0, `${font}, ${state}${extra ? ' (WCAG spacing)' : ''}: ${JSON.stringify(cut)}`);
      }
      await style(page, '');
    };
    await check('welcome');
    await page.click('[data-act="welcome-ok"]');
    await check('idle');
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await check('confirm');
    await page.keyboard.press('Escape');
    await pickBatch(page, ['c:3002', 'c:3003']);
    await check('batch');
    await context.close();
  }
});

await test('T250 marks show in forced colours; light Discord gets a light shadow; the welcome has no seam and sits centred', async () => {
  {
    const { page, context } = await boot('/channels/4001/5001');
    await page.emulateMedia({ forcedColors: 'active' });
    await page.evaluate(() => { navigator.clipboard.writeText = async () => {}; });
    await page.click('[data-act="share"]');
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').dataset.tone === 'success');
    const dot = await rectOf(page, '.status-dot');
    const px = (await shotPixels(page, { x: dot.left, y: dot.top, width: dot.width, height: dot.height })).flat();
    const ground = px[0];
    const inked = px.filter((p) => pxRatio(p, ground) >= 3).length;
    assert(inked >= 10, `the success mark in forced colours: ${inked} px`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { light: true });
    const lift = await jPanel(page, (r) => ({ host: r.querySelector('[data-role="layer"]').dataset.host, shadow: getComputedStyle(r.querySelector('.panel')).boxShadow }));
    assert(lift.host === 'light' && /rgba\(0, 0, 0, 0\.14\)/.test(lift.shadow) && !/0\.75\)/.test(lift.shadow), `light Discord ${JSON.stringify(lift)}`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { firstRun: true, viewport: { width: 1440, height: 900 } });
    await page.waitForTimeout(400);
    const w = await rectOf(page, '[data-role="welcome"]');
    const cx = Math.round(w.left + w.width / 2);
    const rows = await shotPixels(page, { x: cx - 30, y: Math.round(w.top) - 2, width: 60, height: 4 });
    const mean = (row) => [0, 1, 2].map((i) => row.reduce((s, p) => s + p[i], 0) / row.length);
    const [above, below] = [mean(rows[0]), mean(rows[3])];
    const step = Math.max(...above.map((v, i) => Math.abs(v - below[i])));
    assert(step < 2, `seam at the welcome's top ${above.map(Math.round)} → ${below.map(Math.round)} (${step.toFixed(2)})`);
    const gaps = await jPanel(page, (r) => {
      const box = r.querySelector('[data-role="welcome"]').getBoundingClientRect();
      const card = r.querySelector('.welcome-card').getBoundingClientRect();
      return { top: card.top - box.top, bottom: box.bottom - card.bottom };
    });
    assert(Math.abs(gaps.top - gaps.bottom) <= 10, `welcome gaps ${JSON.stringify(gaps)}`);
    await context.close();
  }
});

await test('T280 (extends T163) in forced colours, focus shows on checkboxes, the filter and the chosen tab', async () => {
  for (const colorScheme of ['dark', 'light']) {
    const { page, context } = await boot('/channels/4001/5001', { colorScheme });
    await page.emulateMedia({ forcedColors: 'active' });
    await page.click('.tab[data-tab="batch"]');
    await page.locator('.guild-head').first().click();
    await page.waitForSelector('[data-key="c:5004"]');
    await page.waitForSelector('[data-key="c:3004"]');
    // The tab's glide (D50) has settled, so the before and after pictures frame the same pixels.
    await page.waitForFunction(() => !document.querySelector('#dopa-purifier-host').shadowRoot.getAnimations().some((a) => a.effect.getTiming().iterations !== Infinity));
    await page.mouse.move(5, 5);
    for (const [name, sel, box] of [['group DM box', '[data-key="c:3004"] .check', '[data-key="c:3004"] .check-ui'], ['channel box', '[data-key="c:5004"] .check', '[data-key="c:5004"] .check-ui'],
      ['filter', '[data-role="filter"]', '[data-role="filter"]'], ['chosen tab', '.tab[aria-selected="true"]', '.tab[aria-selected="true"]']]) {
      await jPanel(page, (r) => r.activeElement && r.activeElement.blur());
      await jPanel(page, (r, s) => r.querySelector(s).scrollIntoView({ block: 'center' }), box);
      await page.waitForTimeout(100);
      const b = await rectOf(page, box);
      const clip = { x: Math.floor(b.left) - 6, y: Math.floor(b.top) - 6, width: Math.ceil(b.width) + 12, height: Math.ceil(b.height) + 12 };
      const blurred = await shotPixels(page, clip);
      await page.keyboard.press('Shift'); // the last input was a key, so focus shows as it does for Tab
      await jPanel(page, (r, s) => r.querySelector(s).focus(), sel);
      await page.waitForTimeout(100);
      const focused = await shotPixels(page, clip);
      let changed = 0;
      focused.forEach((row, y) => row.forEach((p, x) => { if (pxRatio(p, blurred[y][x]) >= 3) changed++; }));
      assert(changed >= 128, `${colorScheme}: focus on the ${name} changes ${changed} px²`);
    }
    await context.close();
  }
});

await test('T281 (extends T102) the snug panel keeps one height from preview to run', async () => {
  const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1280, height: 600 } });
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  const height = () => jPanel(page, (r) => ({ fit: r.querySelector('[data-role="layer"]').dataset.fit, h: r.querySelector('.panel').offsetHeight }));
  const preview = await height();
  let n = 0;
  const held = await holdRequests(page, /\/messages\/\d+$/, { match: (q) => q.method() === 'DELETE' && ++n === 5 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await heldBy(held);
  const running = await height();
  assert(preview.fit === 'snug' && running.h === preview.h, `snug ${JSON.stringify(preview)} → ${JSON.stringify(running)}`);
  held.release();
  await waitEnd(page);
  await context.close();
});

await test('T282 (extends T103) tight windows keep the chat named, the count and Purify in view, and every row reachable', async () => {
  for (const [width, height, tight] of [[627, 333, true], [480, 270, true], [470, 250, true], [640, 360, false], [683, 384, false], [720, 450, false]]) {
    const where = `${width}×${height}`;
    const { page, context } = await boot('/channels/4001/5001', { viewport: { width, height } });
    const isTight = await jPanel(page, (r) => r.querySelector('[data-role="layer"]').hasAttribute('data-tight'));
    assert(isTight === tight, `${where}: data-tight ${isTight}`);
    if (!tight) { await context.close(); continue; }
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    const sub = await jPanel(page, (r) => {
      const s = r.querySelector('[data-role="hero-sub"]').getBoundingClientRect();
      const body = r.querySelector('[data-role="body"]').getBoundingClientRect();
      return { text: r.querySelector('[data-role="hero-sub"]').textContent.replace(/[\u2068\u2069]/g, '').replace(/\u00a0/g, ' '), inside: s.top >= body.top - 0.5 && s.bottom <= body.bottom + 0.5 };
    });
    assert(sub.text.startsWith('general · ✿ Cozy Corner') && sub.inside, `${where}: the strip line ${JSON.stringify(sub)}`);
    // The count takes no pointer (the ring's core is see-through to clicks): its own strip is on top of it.
    const shown = await jPanel(page, (r) => {
      const c = r.querySelector('[data-role="count"]').getBoundingClientRect();
      const body = r.querySelector('[data-role="body"]').getBoundingClientRect();
      const el = r.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
      return !!el && !!el.closest('.hero') && c.top >= body.top && c.bottom <= body.bottom;
    });
    const hits = await hitsSelf(page, ['[data-act="purify"]']);
    assert(shown && Object.values(hits).every(Boolean), `${where}: count ${shown}, ${JSON.stringify(hits)}`);
    // Many chats: walking the DMs keeps each focused row whole in the body, never under the strip.
    await page.click('.tab[data-tab="batch"]');
    await page.waitForSelector('[data-key="c:3002"]');
    await page.focus('[data-role="dm-list"] .check');
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(120);
      const seen = await jPanel(page, (r) => {
        // A line of the list: a row, or a server's or the friends fold's bar (D43), which the arrows also stop on.
        const row = r.activeElement.closest('.row, .guild-bar, .fold-bar').getBoundingClientRect();
        const body = r.querySelector('[data-role="body"]').getBoundingClientRect();
        const strip = r.querySelector('.hero').getBoundingClientRect();
        // A row taller than the whole body (470×250: 44px of body for a two-line row) shows from its top.
        const fits = row.height <= body.height ? row.bottom <= body.bottom + 0.5 : row.top <= body.top + 8;
        return { inside: row.top >= body.top - 0.5 && fits, under: row.top < strip.bottom - 0.5 && row.bottom > strip.top + 0.5, row: [row.top, row.bottom], body: [body.top, body.bottom] };
      });
      assert(seen.inside && !seen.under, `${where}: row ${i + 2} ${JSON.stringify(seen)}`);
    }
    await context.close();
  }
});

await test('T283 (extends T108) the sticker grows away from the ring, whatever the word\'s width', async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 600 }]) {
    const where = `${viewport.width}×${viewport.height}`;
    const { page, context } = await boot('/channels/4001/5001', { viewport });
    let k = 0;
    await page.route(/\/api\/v9\/channels\/5001\/messages\/\d+$/, (route) => {
      if (route.request().method() !== 'DELETE' || ++k % 8) return route.fallback();
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Permissions', code: 50013 }) });
    });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await page.waitForTimeout(800);
    const a = (await ringClearance(page)).stickerClear;
    await jPanel(page, (r) => { const s = document.createElement('style'); s.textContent = '.sticker { letter-spacing: .06em !important; }'; r.append(s); });
    const b = (await ringClearance(page)).stickerClear;
    assert(a && b && a.arcRaw >= 2 && b.arcRaw >= 2 && Math.abs(a.arcRaw - b.arcRaw) <= 0.5 && a.right >= 0 && a.top >= 0, `${where}: sticker ${JSON.stringify({ a, b })}`);
    await context.close();
  }
});

// ── Confirm, hold and count-first (T120–T133) ──

const isOpen = (page) => page.locator('.modal-layer[data-open="true"]').count().then((n) => n > 0);
const statusText = (page) => text(page, '[data-role="status-text"]');

// A world with n more DMs, as someone with a long DM list has.
function manyDMs(world, n) {
  for (let i = 0; i < n; i++) {
    const id = String(3200 + i);
    const user = { id: String(2100 + i), username: `pal${i}`, global_name: `Pal number ${i}` };
    world.users[`pal${i}`] = user;
    world.channels[id] = { id, type: 1, recipients: [user], last_message_id: String(1000 + i) };
  }
  return world;
}

// Open a chat, press Purify, hold: the dialog already knows how many. The count is the one search the
// purge starts with anyway, so a whole purge sends exactly what a scanned one does.
await test('T120 Purify counts an uncounted chat first, with one search, and the dialog says how many', async () => {
  const traffic = {};
  for (const flow of ['purify-first', 'scan-first']) {
    const { page, stats, world, pageErrors, context } = await bootProbe('/channels/4001/5002', ['state'], { latencyMs: 20 });
    const s0 = stats.searches;
    const l0 = stats.log.length;
    if (flow === 'scan-first') {
      await page.click('[data-act="scan"]');
      await untilStatus(page, /found/);
    }
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 3000 });
    assert(await text(page, '.modal-lead') === 'This will delete all 10 of your messages, threads included, in', `${flow}: lead ${await text(page, '.modal-lead')}`);
    assert(stats.searches - s0 === 1, `${flow}: ${stats.searches - s0} searches before the hold`);
    assert(await text(page, '.modal-who') === 'deleting as @princess.dopa', `${flow}: ${await text(page, '.modal-who')}`);
    await holdConfirm(page);
    await waitEnd(page);
    assert(stats.deletes.length === 10 && mine(world, '5002').length === 0, `${flow}: deleted ${stats.deletes.length}`);
    assert(await page.evaluate(() => window.__dp.state.runAs) === 'princess.dopa', 'the run remembers who confirmed it');
    traffic[flow] = { searches: stats.searches - s0, requests: stats.log.length - l0 };
    assert(pageErrors.length === 0, `${flow}: page errors ${pageErrors.join('; ')}`);
    await context.close();
  }
  assert(JSON.stringify(traffic['purify-first']) === JSON.stringify(traffic['scan-first']), `counting first costs nothing extra: ${JSON.stringify(traffic)}`);
});

await test('T121 Purify on a chat with none of mine, or one I can\'t read, opens no dialog', async () => {
  {
    const { page, stats, context } = await boot('/channels/4001/5004'); // #Voice Lounge: nothing of mine
    const s0 = stats.searches;
    await page.click('[data-act="purify"]');
    await untilStatus(page, /All clear/);
    await page.waitForTimeout(1000);
    assert(!(await isOpen(page)), 'no dialog when there is nothing to purge');
    assert(await statusText(page) === 'All clear~ nothing of yours here ✨', `status ${await statusText(page)}`);
    assert(await page.locator('[data-role="status"]').getAttribute('data-tone') === 'success', 'a calm success');
    assert(stats.searches - s0 === 1, `${stats.searches - s0} searches`);
    assert(await page.locator('[data-act="purify"]').isDisabled(), 'Purify rests once it knows');
    await context.close();
  }
  {
    const { page, stats, context } = await boot('/channels/4001/5007'); // #mod-only: Missing Access
    await page.click('[data-act="purify"]');
    await untilStatus(page, /No access here/);
    await page.waitForTimeout(500);
    assert(!(await isOpen(page)), 'no dialog for a purge that could only fail');
    assert(await heroIs(page) === 'blocked/label', `the ring says why ${await heroIs(page)}`);
    assert(/count failed · Missing Access/.test(await text(page, '[data-role="term-body"]')), 'Discord\'s own words stay in the log');
    assert(stats.deletes.length === 0, 'nothing deleted');
    await context.close();
  }
});

// The count never makes anyone wait on Discord: any wait it asks for, or 1.2 s without an answer,
// and Purify asks anyway, without a number. That search is not tried again on the next press.
await test('T122 a count Discord holds up is given up: the dialog says "all your messages", and asks once', async () => {
  for (const kind of ['rate', 'index', 'network', 'slow']) {
    const env = await openDiscord(browser, '/channels/4001/5002');
    const { page, stats } = env;
    let searches = 0;
    await page.route('https://discord.com/api/v9/guilds/*/messages/search*', async (route) => {
      if (++searches > 1) return route.fallback();
      const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (kind === 'rate') return reply(429, { message: 'You are being rate limited.', retry_after: 2, global: false });
      if (kind === 'index') return reply(202, { message: 'Index not yet available. Try again later', code: 110000, retry_after: 2 });
      if (kind === 'network') return route.abort('failed');
      await new Promise((r) => setTimeout(r, 2500));
      try { await route.fallback(); } catch { /* the page gave up on it */ }
    });
    await injectUserscript(page, source);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent === 'art-share');
    const t0 = Date.now();
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 4000 });
    const took = Date.now() - t0;
    assert(await text(page, '.modal-lead') === 'This will delete all your messages, threads included, in', `${kind}: lead ${await text(page, '.modal-lead')}`);
    assert(searches === 1, `${kind}: ${searches} searches`);
    assert(kind === 'slow' ? took >= 1100 && took < 2200 : took < 1000, `${kind}: the dialog took ${took}ms`);
    assert(/count skipped/.test(await text(page, '[data-role="term-body"]')), `${kind}: the log says why there's no number`);
    await page.click('[data-act="cancel"]');
    assert(await statusText(page) === 'Ready to purify~ ✨', `${kind}: footer after Never mind ${await statusText(page)}`);
    const quick = Date.now();
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 1000 });
    assert(searches === 1 && Date.now() - quick < 800, `${kind}: the second press asked again (${searches}) or waited ${Date.now() - quick}ms`);
    assert(stats.deletes.length === 0, `${kind}: nothing deleted`);
    await env.context.close();
  }
  // Only the search is on the clock: a slow "who are you" (which the dialog always waited for) doesn't cost the number.
  const env = await openDiscord(browser, '/channels/4001/5002');
  const later = (ms) => async (route) => { await new Promise((r) => setTimeout(r, ms)); try { await route.fallback(); } catch { /* gave up */ } };
  await injectUserscript(env.page, source);
  await env.page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent === 'art-share');
  await env.page.route('https://discord.com/api/v9/users/@me', later(900));
  await env.page.route('https://discord.com/api/v9/guilds/*/messages/search*', later(500));
  await env.page.click('[data-act="purify"]');
  await env.page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 4000 });
  assert(await text(env.page, '.modal-lead') === 'This will delete all 10 of your messages, threads included, in', `slow who-are-you: ${await text(env.page, '.modal-lead')}`);
  await env.context.close();
});

// Counting happens only when the person presses Purify or Scan: browsing chats with the panel open costs nothing.
await test('T123 moving between chats with the panel open sends no searches', async () => {
  const { page, stats, context } = await boot('/channels/4001/5001');
  const s0 = stats.searches;
  for (const p of ['/channels/4001/5002', '/channels/@me/3003', '/channels/@me/3002', '/channels/4001/5001']) {
    await page.evaluate((x) => history.pushState({}, '', x), p);
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(6000);
  assert(stats.searches === s0, `${stats.searches - s0} searches while browsing`);
  await context.close();
});

await test('T124 leaving the chat, the tab or the panel while Purify counts opens no dialog', async () => {
  for (const leave of ['chat', 'tab', 'panel']) {
    const { page, stats, context } = await boot('/channels/4001/5002');
    const hold = await holdRequests(page, /\/messages\/search/);
    await page.click('[data-act="purify"]');
    for (let i = 0; !hold.held && i < 200; i++) await page.waitForTimeout(10);
    assert(hold.held, `${leave}: Purify counted first`);
    if (leave === 'chat') await page.evaluate(() => history.pushState({}, '', '/channels/4001/5001')); // as Discord does: no popstate
    if (leave === 'tab') await page.click('.tab[data-tab="batch"]');
    if (leave === 'panel') await page.click('[data-act="minimize"]');
    hold.release();
    await page.waitForTimeout(1600);
    assert(!(await isOpen(page)), `${leave}: a dialog opened after leaving`);
    if (leave === 'tab') {
      // Left by the person, not given up on Discord's account: the next press counts again.
      await page.click('.tab[data-tab="current"]');
      const s0 = stats.searches;
      await page.click('[data-act="purify"]');
      await page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 3000 });
      assert(stats.searches - s0 === 1 && /all 10 of your messages/.test(await text(page, '.modal-lead')), `back on the tab: ${await text(page, '.modal-lead')}`);
    }
    assert(stats.deletes.length === 0, `${leave}: nothing deleted`);
    await context.close();
  }
});

// Letting go is the safe outcome, so it's said plainly; only a quick tap is taught the gesture.
await test('T125 letting go early says nothing went; a tap still teaches; a finger may wander 12px', async () => {
  const { page, stats, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.waitForTimeout(400);
  const label = () => text(page, '[data-role="confirm-label"]');
  const nudged = () => page.locator('[data-role="confirm-label"]').evaluate((el) => el.dataset.nudge === 'true');
  const c = await page.locator('[data-act="confirm"]').boundingBox();
  const mid = [c.x + c.width / 2, c.y + c.height / 2];
  await page.mouse.move(...mid);
  await page.mouse.down();
  await page.waitForTimeout(450);
  await page.mouse.up();
  assert(/^Let go~\snothing\spurged ♡$/.test(await label()) && !(await nudged()), `a let-go at half way: ${await label()}`);
  const name = await page.locator('[data-act="confirm"]').evaluate((el) => el.querySelector('.flair').getAttribute('aria-hidden'));
  assert(name === 'true', 'the heart is flair, not words');
  const lines = await page.locator('[data-role="confirm-label"]').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  const fits = await page.locator('[data-act="confirm"]').evaluate((b) => b.querySelector('.hold-label').getBoundingClientRect().width <= b.clientWidth);
  assert(lines === 2 && fits, `the long line sits on two lines inside the button (${lines} lines, fits ${fits})`);
  assert(stats.deletes.length === 0 && await dialogOpen(page), 'nothing deleted');
  await page.waitForTimeout(1500);
  assert(await label() === 'Hold to purify ✨', `settles back: ${await label()}`);
  await page.click('[data-act="confirm"]');
  assert(/^Hold it down~ ♡$/.test(await label()) && await nudged(), `a quick tap: ${await label()}`);
  await page.waitForTimeout(1500);
  // A mouse is exact: 2px past the edge lets go, and says so.
  await page.mouse.move(...mid);
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.move(c.x + c.width + 2, mid[1]);
  assert(/^Let go~/.test(await label()), `mouse slide-off: ${await label()}`);
  await page.mouse.up();
  await page.waitForTimeout(1500);
  // A finger 20px off lets go; 10px off still holds, to the end. (Touch goes through CDP: Chromium only.)
  if (engine !== chromium) { await context.close(); return; }
  const cdp = await context.newCDPSession(page);
  const at = ([x, y]) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(mid) });
  await page.waitForTimeout(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at([c.x + c.width + 20, mid[1]]) });
  await page.waitForTimeout(100);
  assert(/^Let go~/.test(await label()), `touch 20px off: ${await label()}`);
  await page.waitForTimeout(900);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert(stats.deletes.length === 0 && await dialogOpen(page), 'a finger that slid away purged nothing');
  await page.waitForTimeout(1500);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(mid) });
  await page.waitForTimeout(150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at([c.x + c.width + 10, mid[1]]) });
  await page.waitForTimeout(900);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await waitEnd(page);
  assert(stats.deletes.length === 10, `a finger 10px off kept holding: ${stats.deletes.length} deleted`);
  await context.close();
});

// The fill is a compositor animation, timed exactly; at the commit it seals full and stays full while
// the dialog fades (it used to drain back, which read as a cancel).
await test('T126 a finished hold seals: the bar stays full until the dialog is gone', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 30 });
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.waitForTimeout(400);
  const sampler = page.evaluate(() => new Promise((resolve) => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const btn = r.querySelector('[data-act="confirm"]');
    const fill = r.querySelector('.hold-fill');
    const layer = r.querySelector('.modal-layer');
    const out = { frames: [], anim: null, pressedAt: 0, sealedAt: 0, hiddenAt: 0 };
    btn.addEventListener('pointerdown', () => {
      out.pressedAt = performance.now();
      requestAnimationFrame(() => {
        const a = fill.getAnimations()[0];
        out.anim = a ? { duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing, props: a.effect.getKeyframes().map((k) => k.transform) } : null;
      });
    }, { once: true });
    // The commit is stamped the moment the label is written "Purifying", before the run starts up.
    const label = r.querySelector('[data-role="confirm-label"]');
    const stamp = (words) => { if (!out.sealedAt && /Purifying/.test(words)) out.sealedAt = performance.now(); };
    const own = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(label, 'textContent', { configurable: true, get() { return own.get.call(this); }, set(v) { stamp(String(v)); own.set.call(this, v); } });
    const replace = label.replaceChildren.bind(label);
    label.replaceChildren = (...kids) => { stamp(kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join('')); replace(...kids); };
    const look = () => {
      if (out.sealedAt) {
        if (layer.hidden) { out.hiddenAt = performance.now(); resolve(out); return; }
        const b = btn.getBoundingClientRect();
        const f = fill.getBoundingClientRect();
        out.frames.push({ fill: Math.min(b.right, f.right) - Math.max(b.left, f.left), button: b.width });
      }
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    setTimeout(() => resolve(out), 6000);
  }));
  await holdConfirm(page);
  const s = await sampler;
  assert(s.anim && s.anim.duration === 850 && s.anim.easing === 'linear' && /translateX/.test(s.anim.props.join()), `the fill is a timed transform animation: ${JSON.stringify(s.anim)}`);
  const commit = s.sealedAt - s.pressedAt;
  // Never early, and within about a frame (it used to wait for a frame, and land 20-50ms late).
  assert(commit >= 850 && commit < 850 + 20, `commit at ${Math.round(commit)}ms`);
  // The seal holds for a real fade, not an instant vanish; the frame count is a loose floor, since
  // rAF sampling thins out under parallel load even while the setTimeout fade runs its full length.
  const fade = s.hiddenAt - s.sealedAt;
  assert(fade >= 120 && fade < 900, `the dialog went in ${Math.round(fade)}ms, not a held fade`);
  assert(s.frames.length >= 2, `${s.frames.length} frames between the commit and the dialog going`);
  const low = s.frames.filter((f) => f.fill < f.button - 1);
  assert(!low.length, `the bar drained while the dialog faded: ${JSON.stringify(low.slice(0, 3))}`);
  assert(s.hiddenAt - s.sealedAt >= 200 && s.hiddenAt - s.sealedAt < 450, `the dialog left after ${Math.round(s.hiddenAt - s.sealedAt)}ms`);
  await waitEnd(page);
  await context.close();
});

await test('T127 the confirm dialog shows a long chat and server name in full, and says it plainly', async () => {
  const world = buildWorld();
  world.channels['5002'].name = 'art-share-and-commissions-for-the-spring-zine-collab-please-read-the-pinned-rules-first-ok';
  world.guilds[0].name = '✿ The Extremely Cozy Corner of the Internet for Night Owls ♡';
  const { page, context } = await boot('/channels/4001/5002', { world });
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const pill = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const box = r.querySelector('.pill').getBoundingClientRect();
    const modal = r.querySelector('.modal').getBoundingClientRect();
    const whole = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].every((q) => q.left >= box.left - 0.5 && q.right <= box.right + 0.5 && q.top >= box.top - 0.5 && q.bottom <= box.bottom + 0.5);
    };
    const el = r.querySelector('.pill');
    return { name: r.querySelector('.pill-name').textContent, name90: whole(r.querySelector('.pill-name')), server: whole(r.querySelector('.pill-context')),
      clipped: el.scrollWidth > el.clientWidth, inModal: box.left >= modal.left && box.right <= modal.right, ellipsis: getComputedStyle(r.querySelector('.pill-name')).textOverflow };
  });
  assert(pill.name.length === 90 && pill.name90 && pill.server && !pill.clipped && pill.inModal && pill.ellipsis !== 'ellipsis', `pill ${JSON.stringify(pill)}`);
  // The words: who is deleting, the one plain warning (its blood drop unspoken), and a two-line hint.
  assert(await text(page, '.modal-who') === 'deleting as @princess.dopa', `who ${await text(page, '.modal-who')}`);
  const warn = await page.locator('.modal-warn').evaluate((el) => ({ text: el.textContent, flair: el.querySelector('.flair')?.getAttribute('aria-hidden') }));
  assert(warn.text === "This can't be undone 🩸" && warn.flair === 'true', `warn ${JSON.stringify(warn)}`);
  const hint = await page.locator('#dp-modal-hint').evaluate((el) => [...el.children].map((d) => d.textContent));
  assert(JSON.stringify(hint) === JSON.stringify(['Hold with mouse or Space · Esc keeps you safe', 'Screen reader, voice or switch? Just press twice']), `hint ${JSON.stringify(hint)}`);
  await page.click('[data-act="cancel"]');
  // A short name is still a single capsule.
  await page.evaluate(() => { history.pushState({}, '', '/channels/@me/3002'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]').textContent === 'Alice ✿');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const short = await page.locator('.pill').boundingBox();
  assert(short.height <= 31, `one line for "general": ${short.height}px`);
  await context.close();
});

// 200% zoom on a 1366×768 laptop: every part of the dialog on screen, even for a long list.
await test('T128 at 200% zoom the confirm dialog fits, even for 129 chats', async () => {
  for (const viewport of [{ width: 683, height: 384 }, { width: 640, height: 360 }]) {
    const { page, context } = await boot('/channels/4001/5001', { world: manyDMs(buildWorld(), 126), viewport });
    await page.click('.tab[data-tab="batch"]');
    await page.waitForSelector('[data-key="c:3250"]');
    await page.click('[data-act="dm-all"]');
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await page.waitForTimeout(500);
    for (const sel of ['.modal-title', '[data-act="cancel"]', '[data-act="confirm"]', '#dp-modal-hint']) {
      const b = await page.locator(sel).boundingBox();
      assert(b.y >= 0 && b.y + b.height <= viewport.height && b.x >= 0 && b.x + b.width <= viewport.width, `${viewport.width}×${viewport.height}: ${sel} at ${JSON.stringify(b)}`);
    }
    assert(await text(page, '.modal-title') === 'Purify 129 chats?', `title ${await text(page, '.modal-title')}`);
    await context.close();
  }
});

await test('T129 Many chats: one sentence says what goes, and chats without access are listed as skipped', async () => {
  const meta = (page) => page.evaluate(() => [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.modal-item')].map((el) => {
    const name = el.querySelector('.modal-item-name');
    const m = el.querySelector('.modal-item-meta');
    return `${name.title === name.textContent ? '' : '!title '}${m.textContent}${m.classList.contains('is-skipped') ? ' (skipped)' : m.classList.contains('is-unknown') ? ' (unknown)' : ''}`;
  }));
  const openConfirm = async (page) => {
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    return { title: await text(page, '.modal-title'), lead: await shownLead(page) };
  };
  {
    const { page, stats, context } = await boot('/channels/4001/5001');
    await pickBatch(page, ['c:3003', 'c:3002', 'u:2004', 'c:5002', 'c:5007']);
    await page.click('[data-act="scan"]');
    await untilStatus(page, /Counted~/, 15000);
    let d = await openConfirm(page);
    assert(d.title === 'Purify 4 chats?', `title ${d.title}`);
    assert(d.lead === 'This will delete 48 of your messages, plus all of yours in 1 chat not counted yet, threads included:', `some counted: ${d.lead}`);
    // #mod-only unticked at Count (D40): it isn't in the list of what goes.
    assert(JSON.stringify(await meta(page)) === JSON.stringify(['7 messages', '31 messages', 'not counted (unknown)', '10 messages']), `list ${JSON.stringify(await meta(page))}`);
    assert(await page.locator('.modal-list').getAttribute('role') === 'list' && await page.locator('.modal-list').getAttribute('aria-label') === '4 chats to purify', 'a named list');
    await page.click('[data-act="cancel"]');
    await page.click('[data-key="u:2004"]');
    await page.click('[data-key="c:5007"]'); // ticked again by hand: listed as skipped, after what goes
    d = await openConfirm(page);
    assert(d.title === 'Purify 3 chats?' && d.lead === 'This will delete all 48 of your messages in these chats, threads included:', `all counted: ${JSON.stringify(d)}`);
    assert(JSON.stringify(await meta(page)) === JSON.stringify(['7 messages', '31 messages', '10 messages', 'skipped · no access (skipped)']), `list ${JSON.stringify(await meta(page))}`);
    assert(await page.locator('.modal-list').getAttribute('aria-label') === '3 chats to purify, 1 left out', 'the list says one sits out');
    await page.click('[data-act="cancel"]');
    for (const k of ['c:3002', 'c:5002']) await page.click(`[data-key="${k}"]`);
    d = await openConfirm(page);
    assert(d.title === 'Purify 1 chat?' && d.lead === 'This will delete all 7 of your messages in 1 chat:', `one chat: ${JSON.stringify(d)}`);
    await page.click('[data-act="cancel"]');
    // Only a chat without access (still ticked from above) and one with nothing of mine left: nothing to ask about.
    await page.click('[data-key="c:3003"]');
    await page.click('[data-key="c:5004"]');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /Counted~/, 15000);
    const sent = stats.log.length;
    await page.locator('[data-act="purify"]').evaluate((b) => b.click());
    await page.waitForTimeout(400);
    assert(!(await isOpen(page)) && stats.log.length === sent, `nothing to purge, yet ${stats.log.slice(sent)} / dialog ${await isOpen(page)}`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { deepIndex: ['5002'] });
    await pickBatch(page, ['c:3003', 'c:5002']);
    await page.click('[data-act="scan"]');
    await untilStatus(page, /Counted~/, 15000);
    const d = await openConfirm(page);
    assert(d.lead === 'This will delete all 17 of your messages in these chats, threads included (Discord may find older ones later):', `still indexing: ${d.lead}`);
    await context.close();
  }
});

await test('T130 screen readers: nothing behind the dialog, the armed press is spoken, the description is the sentence', async () => {
  const ax = async (context, page) => {
    const cdp = await context.newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    await cdp.detach();
    return nodes.filter((n) => !n.ignored);
  };
  {
    const { page, context } = await boot('/channels/4001/5002', { clock: true });
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    const nodes = await ax(context, page);
    const buttons = nodes.filter((n) => n.role && n.role.value === 'button').map((n) => n.name && n.name.value);
    assert(JSON.stringify(buttons) === JSON.stringify(['Never mind~', 'Hold to purify']), `reachable buttons ${JSON.stringify(buttons)}`);
    const dialog = nodes.find((n) => n.role && n.role.value === 'alertdialog');
    const said = dialog.description ? dialog.description.value : '';
    assert(/^This will delete all 10 of your messages, threads included, in art-share · ✿ Cozy Corner deleting as @princess\.dopa This can't be undone$/.test(said.replace(/\s+/g, ' ').trim()), `described as ${JSON.stringify(said)}`);
    const live = page.locator('[data-role="modal-live"]');
    assert(await live.getAttribute('aria-live') === 'assertive', 'an assertive region');
    const press = () => page.locator('[data-act="confirm"]').evaluate((el) => el.click());
    await page.waitForTimeout(400);
    await press();
    assert(await live.textContent() === 'Armed — press again within 15 seconds to purify, or Esc to cancel.', `armed: ${await live.textContent()}`);
    // A switch user stepping Never mind → Hold at 2-3 s a step still makes it (D47); past 15 s it lapses.
    await page.clock.fastForward(14000);
    assert(/^Armed/.test(await live.textContent()), `still armed at 14 s: ${await live.textContent()}`);
    await page.clock.fastForward(1300);
    assert(await live.textContent() === 'Disarmed. Nothing was purged.', `lapsed: ${await live.textContent()}`);
    await page.keyboard.press('Escape');
    assert(await live.textContent() === '' && !(await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="shell"]').inert)), 'closing clears the region and frees the panel');
    assert(await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.activeElement?.dataset.act) === 'purify', 'focus back on Purify');
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { world: manyDMs(buildWorld(), 126) });
    await page.click('.tab[data-tab="batch"]');
    await page.waitForSelector('[data-key="c:3250"]');
    await page.click('[data-act="dm-all"]');
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    const dialog = (await ax(context, page)).find((n) => n.role && n.role.value === 'alertdialog');
    const said = dialog.description ? dialog.description.value : '';
    assert(said.length < 300 && /129 chats/.test(said) && !/Pal number/.test(said), `a ${said.length}-character description: ${said.slice(0, 120)}`);
    // Tab: Never mind → Hold → the list → Never mind.
    const focused = () => page.evaluate(() => { const el = document.querySelector('#dopa-purifier-host').shadowRoot.activeElement; return el && (el.dataset.act || el.className); });
    const stops = [await focused()];
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); stops.push(await focused()); }
    assert(stops.join() === 'cancel,confirm,modal-list,cancel', `Tab order ${stops}`);
    await context.close();
  }
});

await test('T131 Purify\'s glow switches with its fill, both ways', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 300 });
  // Every frame the bloom is either all there (with the gradient) or not at all: without it Purify wears
  // its resting hairline (D56's solid muted box), the same on every frame.
  const watch = page.evaluate(() => new Promise((resolve) => {
    const p = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-act="purify"]');
    const bloom = getComputedStyle(p).boxShadow;
    const odd = [];
    let flips = 0;
    let was = null;
    let rest = null;
    const t0 = performance.now();
    const look = () => {
      const cs = getComputedStyle(p);
      const fill = cs.backgroundImage !== 'none';
      if (!fill && rest === null) rest = cs.boxShadow;
      if (fill ? cs.boxShadow !== bloom : cs.boxShadow === bloom || cs.boxShadow !== rest) odd.push({ t: Math.round(performance.now() - t0), fill, glow: cs.boxShadow.slice(0, 40) });
      if (was !== null && was !== fill) flips++;
      was = fill;
      if (performance.now() - t0 < 2500) requestAnimationFrame(look); else resolve({ odd, flips });
    };
    look();
  }));
  await page.click('[data-act="scan"]'); // Purify rests while the scan runs, then comes back
  const { odd, flips } = await watch;
  assert(flips >= 2, `Purify went off and on (${flips} flips)`);
  assert(!odd.length, `the glow lagged the fill in ${odd.length} frames: ${JSON.stringify(odd.slice(0, 3))}`);
  await context.close();
});

await test('T132 Stop keeps its place and its size when the run is paused', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 3);
  const running = await page.locator('[data-act="stop"]').boundingBox();
  await page.click('[data-act="pause"]');
  await page.waitForTimeout(300);
  const paused = await page.locator('[data-act="stop"]').boundingBox();
  const resume = await page.locator('[data-act="resume"]').boundingBox();
  assert(paused.x === running.x && paused.width === running.width, `Stop moved: ${JSON.stringify({ running, paused })}`);
  assert(resume.x < paused.x, 'Resume takes Pause\'s place');
  await page.click('[data-act="stop"]');
  await waitEnd(page, 5000);
  await context.close();
});

// After a keyboard hold, focus moves to Pause. The key still down belongs to the hold: its repeats and
// its release press nothing. The same after Esc mid-hold: they don't press Purify into a new dialog.
await test('T133 after a keyboard hold focus is on Pause, and the held key presses nothing more', async () => {
  const focused = (page) => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.activeElement?.dataset.act);
  for (const key of ['Space', 'Enter']) {
    const { page, stats, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    await page.locator('[data-act="purify"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await page.waitForTimeout(400);
    await page.keyboard.press('Tab'); // Never mind → Hold
    await page.keyboard.down(key);
    await page.waitForTimeout(1000);
    assert(await focused(page) === 'pause', `${key}: focus after the hold ${await focused(page)}`);
    for (let i = 0; i < 4; i++) await page.keyboard.down(key); // the keyboard's own repeats
    await page.keyboard.up(key);
    await page.waitForTimeout(300);
    const run = await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run);
    assert(run === 'running', `${key}: the held key pressed Pause (${run})`);
    await page.keyboard.press(key); // a fresh press is the person's
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run === 'paused', null, { timeout: 2000 });
    await page.click('[data-act="stop"]');
    await waitEnd(page, 5000);
    // Esc while still holding: the release lands on Purify and must not open the dialog again.
    await page.locator('[data-act="purify"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await page.waitForTimeout(400);
    await page.keyboard.press('Tab');
    await page.keyboard.down(key);
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    for (let i = 0; i < 4; i++) await page.keyboard.down(key);
    await page.keyboard.up(key);
    await page.waitForTimeout(400);
    assert(!(await isOpen(page)) && await focused(page) === 'purify', `${key}: after Esc mid-hold the dialog is ${await isOpen(page) ? 'open again' : 'closed'}, focus on ${await focused(page)}`);
    assert(stats.deletes.length >= 1, `${key}: the hold purged`);
    await context.close();
  }
});

// ── Flow, words and feedback: plain errors, focus that follows the work, one name per idea, honest
// endings, calm waits, whole status lines ──

const panelText = (page) => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.panel').innerText);
const logText = (page) => page.locator('[data-role="term-body"]').textContent();
const focusedAct = (page) => page.evaluate(() => {
  const el = document.querySelector('#dopa-purifier-host').shadowRoot.activeElement;
  return el ? el.dataset.act || el.dataset.tab || el.className : null;
});
const untilFocus = (page, act, timeout = 2000) => page.waitForFunction((a) => {
  const el = document.querySelector('#dopa-purifier-host').shadowRoot.activeElement;
  return !!el && (el.dataset.act === a || el.dataset.tab === a);
}, act, { timeout });
const statusParts = (page) => page.evaluate(() => {
  const r = document.querySelector('#dopa-purifier-host').shadowRoot;
  const s = r.querySelector('[data-role="status"]');
  const t = r.querySelector('[data-role="status-text"]');
  const flair = t.querySelector('.flair');
  return { words: t.firstChild ? t.firstChild.nodeValue.replace(/\u00a0/g, ' ') : '', flair: flair ? flair.textContent : '', tone: s.dataset.tone, glyph: getComputedStyle(r.querySelector('.status-dot'), '::before').content };
});
// Discord's own wording (codes, HTTP statuses, raw messages) belongs in the log only.
const RAW = /\(code|HTTP|Unauthorized|Missing Access|Service Unavailable|Network unreachable/;

await test('T140 a chat Discord won\'t open says so plainly, keeps Purify off, and Try again reads it again', async () => {
  {
    const env = await openDiscord(browser, '/channels/4001/5001', { badToken: true });
    await injectUserscript(env.page, source);
    const { page } = env;
    await untilStatus(page, /^Login not working$/, 6000);
    assert(await tone(page) === 'error', `logged out: tone ${await tone(page)}`);
    assert(await text(page, '[data-role="target-name"]') === 'this chat', `the card never shows a raw id: ${await text(page, '[data-role="target-name"]')}`);
    assert(await text(page, '[data-role="scan-label"]') === 'Try again', `scan label ${await text(page, '[data-role="scan-label"]')}`);
    assert(await page.locator('[data-act="purify"]').isDisabled(), 'no purging an unread chat');
    assert(await heroIs(page) === 'lookup-error/label', `ring ${await heroIs(page)}`);
    assert(!RAW.test(await panelText(page)), `raw words in the panel: ${await panelText(page)}`);
    assert(/couldn't read this chat · 401: Unauthorized/.test(await logText(page)), 'the log keeps what Discord said');
    assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
    await env.context.close();
  }
  {
    const { page, world, stats, pageErrors, context } = await boot('/channels/4001/5007');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^No access here$/);
    const card = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      return { state: r.querySelector('[data-role="target"]').dataset.state, eyebrow: r.querySelector('[data-role="eyebrow-text"]').textContent, color: getComputedStyle(r.querySelector('[data-role="eyebrow"]')).color };
    });
    assert(card.state === 'blocked' && card.eyebrow === 'Server channel' && card.color !== 'rgb(255, 128, 144)', `card ${JSON.stringify(card)}`);
    assert(await tone(page) === 'error' && await heroIs(page) === 'blocked/label', `tone ${await tone(page)}, ring ${await heroIs(page)}`);
    assert(await page.locator('[data-act="purify"]').isDisabled(), 'a purge here could only fail: Purify is off');
    assert(await text(page, '[data-role="scan-label"]') === 'Try again', `scan label ${await text(page, '[data-role="scan-label"]')}`);
    assert(!RAW.test(await panelText(page)), `raw words in the panel: ${await panelText(page)}`);
    assert(/scan failed · Missing Access \(code 50001\)/.test(await logText(page)), 'the log keeps what Discord said');
    // Access granted meanwhile: one Try again, the one request the person asked for, brings Purify back.
    world.channels['5007'].noAccess = false;
    const before = stats.searches;
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^5 messages found/);
    assert(stats.searches - before === 1, `Try again searched ${stats.searches - before} times`);
    assert(await page.locator('[data-act="purify"]').isEnabled(), 'Purify is back after a good count');
    assert(await text(page, '[data-role="eyebrow-text"]') === 'Server channel' && await text(page, '[data-role="scan-label"]') === 'Count again', 'the card and Count are themselves again');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T141 a count that fails says why in plain words: still indexing, offline, Discord down', async () => {
  // request()'s backoff waits seconds; here a second lasts 10 ms, so the cases take no time.
  const quick = withTiming(source, { waitUnitMs: 10 });
  const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const cases = [
    ['still indexing', json(202, { message: 'Index not yet available. Try again later', code: 110000, retry_after: 0.01 }), 'Discord is still searching'],
    ['offline', (route) => route.abort('internetdisconnected'), "Can't reach Discord"],
    ['Discord down', json(503, { message: 'Service Unavailable' }), 'Discord is having a moment'],
  ];
  for (const [label, answer, short] of cases) {
    const { page, pageErrors, context } = await bootWith(quick, '/channels/4001/5001');
    await page.route(/\/guilds\/4001\/messages\/search/, answer);
    await page.click('[data-act="scan"]');
    await untilStatus(page, new RegExp(`^${short}$`), 8000);
    assert(await tone(page) === 'error', `${label}: tone ${await tone(page)}`);
    assert(await heroIs(page) === 'scan-error/icon', `${label}: ring ${await heroIs(page)}`);
    assert(await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"]').title) === short, `${label}: title`);
    assert(await text(page, '[data-role="scan-label"]') === 'Try again', `${label}: the line's "Try again" is a real button`);
    assert(await page.locator('[data-act="purify"]').isEnabled(), `${label}: only a chat you can't get into turns Purify off`);
    assert(!RAW.test(await panelText(page)), `${label}: raw words in the panel: ${await panelText(page)}`);
    assert(/scan failed · /.test(await logText(page)), `${label}: logged`);
    assert(pageErrors.length === 0, `${label}: page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T142 a purge that breaks off says what happened and how to carry on', async () => {
  const answers = {
    captcha: { status: 400, body: { captcha_key: ['captcha-required'], captcha_sitekey: 'x' }, short: 'Discord wants a human check', line: "Discord wants to check you're human~ take a break, then press Purify to finish" },
    'logged out': { status: 401, body: { message: '401: Unauthorized', code: 0 }, short: 'Login not working', line: "Couldn't use your Discord login~ reload Discord, then press Purify to finish" },
  };
  for (const [label, a] of Object.entries(answers)) {
    const { page, stats, pageErrors, context } = await boot('/channels/4001/5002', { latencyMs: 20 });
    let n = 0;
    await page.route(/\/api\/v9\/channels\/5002\/messages\/\d+$/, (route) => {
      if (route.request().method() !== 'DELETE' || ++n < 4) return route.fallback();
      return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.body) });
    });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    assert(stats.deletes.length === 3, `${label}: ${stats.deletes.length} deleted before it broke off`);
    assert(await text(page, '[data-role="readout-line"]') === a.line, `${label}: verdict "${await text(page, '[data-role="readout-line"]')}"`);
    assert(await status(page) === a.short && await tone(page) === 'error', `${label}: footer "${await status(page)}" (${await tone(page)})`);
    assert(new RegExp(`STOPPED · ${a.short}`).test(await logText(page)), `${label}: the log says where it stopped`);
    assert(!RAW.test(await panelText(page)), `${label}: raw words in the panel: ${await panelText(page)}`);
    assert(pageErrors.length === 0, `${label}: page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T143 a list that can\'t load says why and how to try again, and loading says nothing extra', async () => {
  const { page, pageErrors, context } = await boot('/channels/@me/3002'); // a DM: the servers aren't cached yet
  let fail = true;
  await page.route(/\/api\/v9\/users\/@me\/guilds$/, (route) => (fail ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Invalid Form Body', code: 50035 }) }) : route.fallback()));
  await page.route(/\/api\/v9\/users\/@me\/relationships$/, (route) => (fail ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Access', code: 50001 }) }) : route.fallback()));
  const said = await status(page);
  await page.click('.tab[data-tab="batch"]');
  await page.waitForFunction(() => /try again/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="server-list"]').textContent));
  await page.waitForFunction(() => /try again/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="dm-list"]').textContent));
  assert(await text(page, '[data-role="server-list"]') === 'Discord said: Invalid Form Body · press ↻ to try again', `servers: ${await text(page, '[data-role="server-list"]')}`);
  assert(await text(page, '[data-role="dm-list"]') === 'No access here · press ↻ to try again', `DMs: ${await text(page, '[data-role="dm-list"]')}`);
  const log = await logText(page);
  assert(/couldn't load your servers · Invalid Form Body \(code 50035\)/.test(log) && /couldn't load your DMs · Missing Access \(code 50001\)/.test(log), 'the log keeps what Discord said');
  fail = false;
  await page.click('[data-act="dm-refresh"]');
  await page.click('[data-act="server-refresh"]');
  await page.waitForSelector('[data-key="c:3003"]');
  await page.waitForSelector('.guild');
  await page.waitForTimeout(200);
  assert(await status(page) === said, `a routine load doesn't take over the footer: "${await status(page)}"`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T144 focus follows the work: Pause, Resume and Stop hand it on, and the controls never move', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 3);
  await page.locator('[data-act="pause"]').focus();
  const running = await page.locator('[data-act="stop"]').boundingBox();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run === 'paused');
  assert(await focusedAct(page) === 'resume', `after Pause: ${await focusedAct(page)}`);
  const paused = await page.locator('[data-act="stop"]').boundingBox();
  assert(JSON.stringify(running) === JSON.stringify(paused), `Stop moved: ${JSON.stringify(running)} → ${JSON.stringify(paused)}`);
  const resume = await page.locator('[data-act="resume"]').boundingBox();
  assert(resume.x === running.x - 8 - resume.width && resume.y === running.y, 'Resume takes Pause\'s slot');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run === 'running');
  assert(await focusedAct(page) === 'pause', `after Resume: ${await focusedAct(page)}`);
  await page.keyboard.press('Tab');
  assert(await focusedAct(page) === 'stop', `Tab from Pause: ${await focusedAct(page)}`);
  // The next DELETE is held, so the run stays "stopping" while we look.
  const hold = await holdRequests(page, /\/api\/v9\/channels\/5001\/messages\/\d+$/, { match: (r) => r.method() === 'DELETE' });
  while (!hold.held) await page.waitForTimeout(5);
  await page.keyboard.press('Space');
  await untilStatus(page, /^Stopping after this one~$/);
  const stop = await page.evaluate(() => {
    const b = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-act="stop"]');
    return { busy: b.getAttribute('aria-disabled'), disabled: b.disabled, opacity: getComputedStyle(b).opacity };
  });
  assert(stop.busy === 'true' && !stop.disabled && stop.opacity === '0.55', `Stop while stopping ${JSON.stringify(stop)}`);
  assert(await focusedAct(page) === 'stop', `focus stays on Stop: ${await focusedAct(page)}`);
  await page.keyboard.press('Space'); // pressing it again is harmless
  hold.release();
  await waitEnd(page, 5000);
  await untilFocus(page, 'scan');
  // Minimise and restore, and the log's close button, hand focus to what replaces them.
  await page.locator('[data-act="minimize"]').focus();
  await page.keyboard.press('Enter');
  await untilFocus(page, 'restore');
  await page.keyboard.press('Enter');
  await untilFocus(page, 'minimize');
  await page.locator('[data-act="logs"]').focus();
  await page.keyboard.press('Enter');
  await page.locator('[data-act="close-log"]').focus();
  await page.keyboard.press('Enter');
  await untilFocus(page, 'logs');
  await page.locator('.term').waitFor({ state: 'hidden', timeout: 1000 });
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T145 the log sits beside the panel and never covers Pause or Stop, at any window size', async () => {
  for (const [width, height] of [[1440, 900], [720, 450], [683, 384]]) {
    const { page, pageErrors, context } = await boot('/channels/4001/5001', { viewport: { width, height }, latencyMs: 30 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 2);
    await page.click('[data-act="logs"]');
    await page.waitForTimeout(450);
    const where = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const hit = (sel) => {
        const b = r.querySelector(sel).getBoundingClientRect();
        const el = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return !!el && !!el.closest(sel);
      };
      const term = r.querySelector('.term').getBoundingClientRect();
      const panel = r.querySelector('.panel').getBoundingClientRect();
      return { pause: hit('[data-act="pause"]'), stop: hit('[data-act="stop"]'), logs: hit('[data-act="logs"]'), apart: term.right <= panel.left || term.left >= panel.right,
        term: [Math.round(term.left), Math.round(term.width), Math.round(term.bottom)] };
    });
    assert(where.pause && where.stop && where.logs, `${width}×${height}: the log covers the controls ${JSON.stringify(where)}`);
    assert(where.apart && where.term[0] >= 8 && where.term[1] >= 280 && where.term[2] <= height, `${width}×${height}: the log sits beside the panel, on screen ${JSON.stringify(where)}`);
    if (width === 1440) assert(where.term[1] === 380, `full width with room: ${where.term[1]}`);
    await page.click('[data-act="stop"]');
    await waitEnd(page, 5000);
    assert(pageErrors.length === 0, `${width}×${height}: page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T146 one name per idea: This chat, Many chats, a chat\'s kind, and who is immune', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { firstRun: true, latencyMs: 20 });
  const welcome = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    return { lead: r.querySelector('.welcome-lead').textContent, steps: r.querySelectorAll('.welcome-steps li').length, more: r.querySelector('[data-act="welcome-batch"]').textContent };
  });
  assert(welcome.lead === 'Clear your side of any chat in two steps:' && welcome.steps === 2 && welcome.more === 'Pick many chats', `welcome ${JSON.stringify(welcome)}`);
  await page.click('[data-act="welcome-ok"]');
  const names = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    return { tabs: [...r.querySelectorAll('.tab')].map((t) => t.firstChild.textContent).join('|'), list: r.querySelector('.tabs').getAttribute('aria-label'),
      panels: [...r.querySelectorAll('.view')].map((v) => v.getAttribute('aria-label')).join('|') };
  });
  assert(names.tabs === 'This chat|Many chats' && names.list === 'What to purify' && names.panels === 'This chat|Many chats', `names ${JSON.stringify(names)}`);
  const kind = () => page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const ico = r.querySelector('[data-role="target-ico"]');
    return `${r.querySelector('[data-role="eyebrow-text"]').textContent}|${r.querySelector('[data-role="target-name"]').textContent.replace(/[\u2066-\u2069]/g, '')}|${ico.querySelector('svg') ? 'svg' : ico.textContent}`;
  });
  assert(await kind() === 'Server channel|general|#', `server channel: ${await kind()}`);
  for (const [path, want] of [['/channels/@me/3002', 'Direct message|Alice ✿|@'], ['/channels/@me/3004', 'Group DM|Alice ✿, Carol|svg'], ['/channels/@me', 'This chat|No chat open|✦']]) {
    await page.evaluate((p) => history.pushState({}, '', p), path);
    await page.waitForFunction((w) => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const ico = r.querySelector('[data-role="target-ico"]');
      return `${r.querySelector('[data-role="eyebrow-text"]').textContent}|${r.querySelector('[data-role="target-name"]').textContent.replace(/[\u2066-\u2069]/g, '')}|${ico.querySelector('svg') ? 'svg' : ico.textContent}` === w;
    }, want, { timeout: 4000 }).catch(async () => { throw new Error(`${path}: ${await kind()}`); });
  }
  assert(!/Current channel|Batch|Protect|forever|👥/.test(await panelText(page)), `retired words: ${await panelText(page)}`);
  // "Many chats 12" fits its half of the switch.
  const fits = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const badge = r.querySelector('[data-role="tab-badge"]');
    badge.textContent = '12';
    badge.hidden = false;
    const tab = r.querySelector('.tab[data-tab="batch"]').getBoundingClientRect();
    const b = badge.getBoundingClientRect();
    const words = r.querySelector('.tab[data-tab="batch"] span').getBoundingClientRect();
    badge.hidden = true;
    return { tab: Math.round(tab.width), inside: b.right <= tab.right - 6 && words.left >= tab.left + 6 };
  });
  assert(fits.inside, `"Many chats 12" overflows its ${fits.tab}px tab`);
  // Who is immune, by person; a batch says which chat of how many it's on.
  await page.click('[data-act="logs"]');
  assert((await logText(page)).includes('immune · Bardo & Dopa ♡>'), `banner: ${(await logText(page)).slice(0, 160)}`);
  await page.click('[data-act="logs"]');
  await page.evaluate(() => {
    const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
    window.__said = [];
    new MutationObserver(() => window.__said.push(t.textContent)).observe(t, { childList: true, subtree: true, characterData: true });
  });
  await pickBatch(page, ['c:3002', 'c:3004']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 20000);
  const said = await page.evaluate(() => window.__said);
  assert(said.includes('Starting on 2 chats~ ✨'), `start: ${said.slice(0, 3)}`);
  // Names from Discord sit in bidi isolates, so a right-to-left name can't reorder the line.
  // Names sit in bidi isolates (a group's members are isolated one by one inside), so compare the words read
  // and check the isolate is there.
  const read = said.map((x) => x.replace(/[\u2066-\u2069]/g, '').replace(/\u00a0/g, ' '));
  assert(read.includes('Chat 1 of 2 · Alice ✿') && read.includes('Chat 2 of 2 · Alice ✿, Carol'), `chats: ${said.filter((x) => /^Chat \d of 2 · [^·]+$/.test(x))}`);
  assert(read.includes('Chat 1 of 2 · 1 of 31 · Alice ✿') && read.includes('Chat 2 of 2 · 3 of 3 · Alice ✿, Carol'), `per kill: ${said.filter((x) => / of \d+ · /.test(x)).slice(0, 3)}`);
  assert(said.some((x) => x.startsWith('Chat 2 of 2\u00a0· \u2068')), 'the chat name is isolated');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T147 with no chat open, the one button left goes to Many chats, and a chat brings Scan and Purify back in place', async () => {
  const { page, pageErrors, context } = await boot('/channels/@me', { firstRun: true });
  await page.click('[data-act="welcome-ok"]');
  await page.locator('[data-role="welcome"]').waitFor({ state: 'hidden', timeout: 1000 });
  // Layout boxes (offset*), so the panel's little wobble on a tab switch doesn't count as movement.
  const footer = () => page.evaluate(() => [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.foot [data-role="idle-actions"] button')]
    .filter((b) => b.getClientRects().length && !b.disabled).map((b) => ({ act: b.dataset.act, text: b.textContent, y: b.offsetTop, h: b.offsetHeight, w: b.offsetWidth })));
  const none = await footer();
  assert(none.length === 1 && none[0].act === 'go-batch' && none[0].text === 'Pick many chats' && none[0].h === 40, `footer with no chat ${JSON.stringify(none)}`);
  assert(none[0].w === 328, `one full-width button: ${none[0].w}px`);
  const said = await statusParts(page);
  assert(said.words === 'Ready when you are~' && said.flair === ' ✨', `footer line ${JSON.stringify(said)}`);
  await page.locator('.tab[data-tab="current"]').focus();
  await page.keyboard.press('Tab');
  assert(await focusedAct(page) === 'go-batch', `Tab reaches it: ${await focusedAct(page)}`);
  await page.keyboard.press('Enter');
  assert(await page.locator('.tab[data-tab="batch"][aria-selected="true"]').count() === 1, 'Many chats is open');
  await untilFocus(page, 'batch');
  await page.click('.tab[data-tab="current"]');
  await page.click('a[href="/channels/4001/5001"]');
  await nameIs(page, 'general');
  await page.waitForFunction(() => !document.querySelector('#dopa-purifier-host').shadowRoot.getAnimations().some((a) => a.effect.getTiming().iterations !== Infinity)); // the tab's glide (D50) has settled
  const pair = await footer();
  assert(pair.map((b) => b.act).join() === 'scan,purify' && pair.every((b) => b.y === none[0].y && b.h === 40), `Scan and Purify back in place ${JSON.stringify(pair)} vs ${JSON.stringify(none)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T148 the panel opens on the chat you are looking at, and elsewhere on your last tab', async () => {
  const env = await openDiscord(browser, '/channels/4001/5001');
  const { page, stats, context } = env;
  await page.evaluate(() => localStorage.setItem('dopa-purifier:prefs', JSON.stringify({ welcomed: true, tab: 'batch' })));
  await injectUserscript(page, source);
  await nameIs(page, 'general');
  await page.waitForTimeout(300);
  assert(await page.locator('.tab[data-tab="current"][aria-selected="true"]').count() === 1, 'on a chat: This chat');
  assert(!stats.log.some((l) => /\/users\/@me\/(channels|relationships)$/.test(l)), `lists fetched for a tab nobody opened: ${stats.log}`);
  assert((await storedPrefs(page)).tab === 'batch', 'opening on the chat is not a choice to remember');
  await page.goto('https://discord.com/channels/@me');
  await injectUserscript(page, source);
  await page.waitForSelector('[data-key="c:3002"]');
  assert(await page.locator('.tab[data-tab="batch"][aria-selected="true"]').count() === 1, 'away from chats: the last tab');
  assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
  await context.close();
});

await test('T149 endings are honest and said once: all clean, all clear, stopped', async () => {
  {
    const { page, pageErrors, context } = await boot('/channels/4001/5002', { latencyMs: 25 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 3);
    const height = () => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.panel').offsetHeight);
    const during = await height();
    await waitEnd(page);
    await page.waitForTimeout(300);
    assert(await height() === during, `the finish grows the panel ${during} → ${await height()}`);
    assert(/^All clean~ nothing left of you here/.test(await text(page, '[data-role="readout-line"]')), `verdict "${await text(page, '[data-role="readout-line"]')}"`);
    const done = await statusParts(page);
    assert(/^Done in \d+s$/.test(done.words) && done.flair === ' ♡' && done.tone === 'success', `footer ${JSON.stringify(done)}`);
    const purify = await page.evaluate(() => {
      const b = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-act="purify"]');
      const s = getComputedStyle(b);
      return { disabled: b.disabled, clean: b.classList.contains('is-clean'), color: s.color, outline: s.outlineStyle };
    });
    assert(purify.disabled && purify.clean && purify.color === 'rgb(255, 196, 216)' && purify.outline === 'none', `Purify rests ${JSON.stringify(purify)}`);
    assert(await page.locator('[data-role="target-note"]').count() === 0, 'no extra note on the card');
    assert(!/STOPPED/.test(await logText(page)), 'nothing stopped');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    // Nothing of yours there: the batch says so, without a cheer.
    const { page, context } = await boot('/channels/4001/5001');
    await pickBatch(page, ['c:5004']);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    assert(/^All clear~ nothing of yours here/.test(await text(page, '[data-role="hero-sub"]')), `verdict "${await text(page, '[data-role="hero-sub"]')}"`);
    const done = await statusParts(page);
    assert(done.words === 'Done~ nothing of yours was here' && !done.flair && done.tone === 'success', `footer ${JSON.stringify(done)}`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /40 messages found/);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 3);
    await page.click('[data-act="stop"]');
    await waitEnd(page, 5000);
    assert(/^Stopped~ \d+ of yours still here$/.test(await text(page, '[data-role="readout-line"]')), `verdict "${await text(page, '[data-role="readout-line"]')}"`);
    const done = await statusParts(page);
    assert(done.words === 'Purify picks up the rest~' && done.tone === 'calm', `footer ${JSON.stringify(done)}`);
    assert(/STOPPED by you · nothing after this point was touched/.test(await logText(page)), 'the log marks where you stopped');
    assert(await page.locator('[data-act="purify"]').isEnabled(), 'and Purify does pick up the rest');
    await context.close();
  }
});

await test('T150 a finish with failures counts what went, and the log gives each reason first, in full', async () => {
  const world = buildWorld();
  for (let i = 0; i < 10; i++) {
    world.messages['5103'].push({ id: String(1300000000000000000n + BigInt(i) * 1000n), channel_id: '5103', type: 0, pinned: false, author: world.me, content: `old forum reply ${i}`, attachments: [] });
  }
  const { page, pageErrors, context } = await boot('/channels/4001/5003', { world });
  await page.route(/\/api\/v9\/channels\/5103\/messages\/\d+$/, (route) => (route.request().method() !== 'DELETE' ? route.fallback()
    : route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Thread is archived', code: 50083 }) })));
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(await text(page, '[data-role="readout-line"]') === "13 messages couldn't be purged", `verdict "${await text(page, '[data-role="readout-line"]')}"`);
  const done = await statusParts(page);
  assert(/^Done in \d+s · reasons in Logs$/.test(done.words) && done.tone === 'warn' && !done.flair, `footer ${JSON.stringify(done)}`);
  await page.click('[data-act="logs"]');
  const lines = await page.evaluate(() => [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.line.error .line-msg')]
    .map((m) => ({ text: m.textContent, whole: m.scrollWidth <= m.clientWidth, wrap: getComputedStyle(m).whiteSpace })));
  assert(lines.some((l) => /^FAILED · archived thread · "old forum reply \d"$/.test(l.text)), `failure lines: ${lines.slice(0, 2).map((l) => l.text)}`);
  assert(lines.some((l) => /^1\. archived thread · "/.test(l.text)), `summary lines: ${lines.map((l) => l.text).filter((t) => /^\d+\./.test(t)).slice(0, 2)}`);
  assert(lines.every((l) => l.whole && l.wrap === 'normal'), `error lines are cut short: ${JSON.stringify(lines.filter((l) => !l.whole).slice(0, 2))}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T151 an account switch mid-batch keeps the verdict: what was purged, and why it stopped', async () => {
  const { page, stats, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await pickBatch(page, ['c:3003', 'c:3002']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  while (stats.deletes.length < 3) await page.waitForTimeout(10);
  await page.evaluate(() => localStorage.setItem('token', JSON.stringify('mock-token.b')));
  await waitEnd(page, 15000);
  await page.waitForTimeout(1500); // the lists and the chat have been re-read as the new account by now
  const verdict = await text(page, '[data-role="hero-sub"]');
  assert(verdict === 'Stopped to be safe~ you switched accounts', `verdict "${verdict}"`);
  assert(await heroIs(page) === 'done/count', `the verdict stays on screen: ${await heroIs(page)}`);
  const said = await statusParts(page);
  assert(/^Switched accounts~ \d+ messages? purged( as @princess\.dopa)?$/.test(said.words) && said.tone === 'warn', `footer ${JSON.stringify(said)}`);
  assert(/STOPPED · Switched accounts/.test(await logText(page)), 'the log says why it stopped');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T152 waits and pauses are calm, and a breather counts down without asking Discord', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5002', { latencyMs: 20 });
  let n = 0;
  await page.route(/\/api\/v9\/channels\/5002\/messages\/\d+$/, (route) => (route.request().method() !== 'DELETE' || ++n !== 3 ? route.fallback()
    : route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 3, global: false }) })));
  const reqs = recordRequests(page);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilStatus(page, /^Taking a breather~ back in 3s/, 6000);
  const wait = await statusParts(page);
  assert(wait.words === 'Taking a breather~ back in 3s' && wait.flair === ' 🦇' && wait.tone === 'calm' && wait.glyph === '""', `the wait ${JSON.stringify(wait)}`);
  // Mid-run the footer has one line: the whole wait, countdown included, fits on it.
  assert(await page.evaluate(() => { const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]'); return t.scrollWidth <= t.clientWidth; }), 'the wait is cut short mid-run');
  const t0 = Date.now();
  await page.waitForTimeout(2150);
  assert((await statusParts(page)).words === 'Taking a breather~ back in 1s', `counted down: ${(await statusParts(page)).words}`);
  assert(reqs.since(t0).length === 0, `asked Discord while waiting: ${reqs.since(t0)}`);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 4, null, { timeout: 4000 });
  await page.click('[data-act="pause"]');
  const paused = await statusParts(page);
  assert(paused.words === 'Resume picks up right here~' && paused.tone === 'calm' && paused.glyph === '""', `paused ${JSON.stringify(paused)}`);
  await page.click('[data-act="resume"]');
  const again = await statusParts(page);
  assert(again.words === 'Purifying~ you can minimise me' && again.flair === ' ✨' && again.tone === 'info', `resumed ${JSON.stringify(again)}`);
  await waitEnd(page);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T153 the footer speaks words, not emoji, and the small lines are kind', async () => {
  const { page, pageErrors, context } = await bootProbe('/channels/@me/3002', ['preview']);
  // Search unavailable for this DM: the count walks the history, and says how far it has got.
  await page.route(/\/channels\/3002\/messages\/search/, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Access', code: 50001 }) }));
  const walk = await holdRequests(page, /\/channels\/3002\/messages\?limit=100&before=/);
  await page.click('[data-act="scan"]');
  while (!walk.held) await page.waitForTimeout(5);
  assert(await status(page) === 'Checked 87 · 31 of yours so far', `progress "${await status(page)}"`);
  const spoken = await page.locator('[data-role="status"]').ariaSnapshot();
  assert(!/\p{Extended_Pictographic}/u.test(spoken), `the status reads out emoji: ${spoken}`);
  walk.release();
  await untilStatus(page, /^31 messages found/);
  const found = await statusParts(page);
  assert(found.flair === '' && found.words === "Counted~ press Purify when you're ready" && !/\p{Extended_Pictographic}/u.test(await page.locator('[data-role="status"]').ariaSnapshot()), `found ${JSON.stringify(found)}`);
  assert(await page.evaluate(() => window.__dp.preview({ content: '', attachments: [] })) === '[sticker or embed]', 'a message with no words');
  // Discord can lock the clipboard: the link waits in the log, whole.
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('locked', 'NotAllowedError')); });
  await page.click('[data-act="share"]');
  await untilStatus(page, /^Couldn't copy~ the link is waiting in Logs/);
  const share = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const line = [...r.querySelectorAll('.line.wrap .line-msg')].pop();
    return { open: !r.querySelector('.term').hidden, text: line && line.textContent, whole: !!line && line.scrollWidth <= line.clientWidth };
  });
  assert(share.open && /^share link: https:\/\/\S+$/.test(share.text) && share.whole, `share fallback ${JSON.stringify(share)}`);
  assert((await statusParts(page)).flair === ' ♡', 'said kindly');
  // An account switch says what to do next, and asks Discord nothing for it.
  await page.evaluate(() => localStorage.setItem('token', JSON.stringify('mock-token.b')));
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Switched Discord accounts|found/);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T154 the footer shows the whole message; Esc, Home and End, and the mute button behave', async () => {
  {
    const { page, pageErrors, context } = await bootProbe('/channels/4001/5001', ['setStatus', 'waitText']);
    const line = () => page.evaluate(() => {
      const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
      return { whole: t.scrollHeight <= t.clientHeight + 1 && t.scrollWidth <= t.clientWidth + 1, lines: Math.round(t.clientHeight / 16), wrap: getComputedStyle(t).whiteSpace };
    });
    for (const said of [
      "Couldn't save~ Alice the Magnificent Wanderer ✿ isn't immune yet",
      "Discord wants to check you're human~ take a break, then press Purify to finish",
      "Couldn't copy~ the link is waiting in Logs",
    ]) {
      await page.evaluate((s) => window.__dp.setStatus(s, 'error'), said);
      const l = await line();
      assert(l.whole && l.lines <= 2, `"${said}" is cut short ${JSON.stringify(l)}`);
    }
    const rowH = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      window.__dp.setStatus('Ready to purify~', 'info');
      return r.querySelector('.status-row').getBoundingClientRect().height;
    });
    assert(rowH === 44, `a one-line status keeps its 44px row: ${rowH}`);
    await page.evaluate(() => { document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run = 'running'; });
    assert((await line()).wrap === 'nowrap', 'mid-run the line holds still on one row');
    // Discord's waits come mostly mid-run, so each fits that one line whole, its longest countdown too.
    for (const kind of ['rate', 'index', 'network', 'server']) {
      await page.evaluate((k) => window.__dp.setStatus(window.__dp.waitText({ kind: k, seconds: 32 }), 'calm', { flair: k === 'rate' ? '🦇' : '' }), kind);
      assert((await line()).whole, `the ${kind} wait is cut short mid-run: ${await status(page)}`);
    }
    await page.evaluate(() => { document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="layer"]').dataset.run = 'idle'; });
    // Esc inside the log closes it and hands focus back to Logs.
    await page.click('[data-act="logs"]');
    await page.locator('[data-act="copy-log"]').focus();
    await page.keyboard.press('Escape');
    await untilFocus(page, 'logs');
    await page.locator('.term').waitFor({ state: 'hidden', timeout: 1000 });
    assert(await page.locator('[data-act="logs"]').getAttribute('aria-pressed') === 'false', 'Logs is unpressed');
    // Home and End on the tabs.
    await page.locator('.tab[data-tab="current"]').focus();
    await page.keyboard.press('End');
    assert(await focusedAct(page) === 'batch' && await page.locator('.tab[data-tab="batch"][aria-selected="true"]').count() === 1, 'End: Many chats');
    await page.keyboard.press('Home');
    assert(await focusedAct(page) === 'current' && await page.locator('.tab[data-tab="current"][aria-selected="true"]').count() === 1, 'Home: This chat');
    // The mute toggle keeps its name; aria-pressed says which way it is.
    const mute = async () => {
      const cdp = await context.newCDPSession(page);
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const node = nodes.find((x) => x.name && /mute/i.test(x.name.value || '') && x.role && x.role.value === 'button');
      const pressed = await page.locator('[data-act="mute"]').getAttribute('aria-pressed');
      return { name: node && node.name.value, pressed, title: await page.locator('[data-act="mute"]').getAttribute('title') };
    };
    const before = await mute();
    await page.click('[data-act="mute"]');
    const after = await mute();
    assert(before.name === 'Mute sound' && after.name === 'Mute sound', `the name stays put: ${before.name} → ${after.name}`);
    assert(before.pressed === 'false' && after.pressed === 'true' && before.title === 'Mute sound' && after.title === 'Unmute sound', `state ${JSON.stringify([before, after])}`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    // Esc in the welcome card dismisses it, for good.
    const { page, context } = await boot('/channels/4001/5001', { firstRun: true });
    assert(await focusedAct(page) === 'welcome-ok', `focus on arrival: ${await focusedAct(page)}`);
    await page.keyboard.press('Escape');
    await page.locator('[data-role="welcome"]').waitFor({ state: 'hidden', timeout: 1000 });
    assert(await focusedAct(page) === 'current', `focus after Esc: ${await focusedAct(page)}`);
    await page.waitForTimeout(400);
    assert((await storedPrefs(page)).welcomed === true, 'remembered as seen');
    await context.close();
  }
});

await test('T155 the log and the welcome leave the way they came; the tab pill glides without overshoot', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { firstRun: true });
  await page.click('[data-act="welcome-ok"]');
  const leaving = await page.evaluate(() => {
    const w = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="welcome"]');
    return { shown: !w.hidden, inert: w.inert, fading: w.getAnimations().some((a) => a.playState === 'running') };
  });
  assert(leaving.shown && leaving.inert && leaving.fading, `the welcome fades, out of reach at once ${JSON.stringify(leaving)}`);
  await page.locator('[data-role="welcome"]').waitFor({ state: 'hidden', timeout: 1000 });
  const pill = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.tab-pill'));
    return `${s.transitionProperty} ${s.transitionDuration} ${s.transitionTimingFunction}`;
  });
  assert(pill === 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)', `tab pill ${pill}`);
  await page.click('[data-act="logs"]');
  assert(await page.evaluate(() => getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.term')).animationDuration) === '0.36s', 'a quicker boot');
  await page.waitForTimeout(450);
  await page.click('[data-act="close-log"]');
  const closing = await page.evaluate(() => {
    const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.term');
    return { shown: !t.hidden, fading: t.getAnimations().some((a) => a.playState === 'running'), through: getComputedStyle(t).pointerEvents };
  });
  assert(closing.shown && closing.fading && closing.through === 'none', `the log fades out ${JSON.stringify(closing)}`);
  await page.locator('.term').waitFor({ state: 'hidden', timeout: 1000 });
  // Opened again mid-fade, it simply stays.
  await page.click('[data-act="logs"]');
  await page.waitForTimeout(450);
  await page.click('[data-act="logs"]');
  await page.click('[data-act="logs"]');
  await page.waitForTimeout(400);
  const kept = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const t = r.querySelector('.term');
    return { shown: !t.hidden, opacity: getComputedStyle(t).opacity, through: getComputedStyle(t).pointerEvents, pressed: r.querySelector('[data-act="logs"]').getAttribute('aria-pressed') };
  });
  assert(kept.shown && kept.opacity === '1' && kept.through === 'auto' && kept.pressed === 'true', `reopened mid-fade ${JSON.stringify(kept)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T156 Many chats: the strip keeps up mid-scan, and a chat that shuts you out is never offered', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  await pickBatch(page, ['c:5002', 'c:5007']);
  const second = await holdRequests(page, /\/guilds\/4001\/messages\/search\?.*channel_id=5007/);
  await page.click('[data-act="scan"]');
  while (!second.held) await page.waitForTimeout(5);
  await page.waitForTimeout(100);
  assert(await heroIs(page) === 'partial/count', `mid-scan strip ${await heroIs(page)}`);
  second.release();
  await untilStatus(page, /^Counted~/);
  const done = await statusParts(page);
  assert(done.words === "Counted~ 10 messages · skipped 1 chat you can't read" && done.tone === 'success', `scan verdict ${JSON.stringify(done)}`);
  await page.click('[data-key="c:5002"]'); // untick #art-share: only #mod-only is left
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'nothing to offer in a chat Discord keeps you out of');
  await page.click('[data-key="c:5002"]');
  assert(await page.locator('[data-act="purify"]').isEnabled(), 'with #art-share ticked again there is');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T157 the card says "Double-checking~" during the last look', async () => {
  const { page, stats, pageErrors, context } = await boot('/channels/4001/5002', { latencyMs: 20 });
  await page.click('[data-act="scan"]');
  await untilStatus(page, /10 messages found/);
  const look = await holdRequests(page, /\/messages\/search/, { match: () => stats.deletes.length >= 10 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  while (!look.held) await page.waitForTimeout(5);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="eyebrow-text"]').textContent === 'Double-checking~', null, { timeout: 2000 })
    .catch(async () => { throw new Error(`eyebrow "${await text(page, '[data-role="eyebrow-text"]')}"`); });
  look.release();
  await waitEnd(page);
  assert(await text(page, '[data-role="eyebrow-text"]') === 'Purified', `after: ${await text(page, '[data-role="eyebrow-text"]')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T158 while Purify counts first it says so, stays focused, and Scan waits', async () => {
  const { page, pageErrors, context } = await bootProbe('/channels/4001/5001', ['state', 'renderActions']);
  const purify = () => page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const b = r.querySelector('[data-act="purify"]');
    return { busy: b.getAttribute('aria-busy'), label: r.querySelector('[data-role="purify-label"]').textContent, disabled: b.disabled,
      count: !r.querySelector('[data-role="purify-count"]').hidden, scan: r.querySelector('[data-act="scan"]').disabled };
  });
  await page.locator('[data-act="purify"]').focus();
  await page.evaluate(() => { window.__dp.state.counting = { channelId: '5001', abort: new AbortController() }; window.__dp.renderActions(); });
  const busy = await purify();
  assert(busy.busy === 'true' && busy.label === 'Counting…' && !busy.disabled && !busy.count && busy.scan, `counting ${JSON.stringify(busy)}`);
  assert(await focusedAct(page) === 'purify', `focus stays on Purify: ${await focusedAct(page)}`);
  await page.evaluate(() => { window.__dp.state.counting = null; window.__dp.renderActions(); });
  const rest = await purify();
  assert(rest.busy === null && rest.label === 'Purify' && !rest.disabled && !rest.scan, `after ${JSON.stringify(rest)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// ── WP-D: the Many chats list, its keyboard and words, and control contrast ──
const BIDI = /[\u2066-\u2069]/g;
const unmarked = (s) => String(s || '').replace(BIDI, '');
const inPanel = (page, fn, arg) => page.evaluate(([src, a]) => new Function('r', 'a', `return (${src})(r, a);`)(document.querySelector('#dopa-purifier-host').shadowRoot, a), [fn.toString(), arg]);
// A world with forty more DMs, so the list is long enough to scroll and to need a keyboard model.
function longWorld() {
  const world = buildWorld();
  for (let i = 0; i < 40; i++) {
    const id = String(7000 + i);
    const user = { id: String(8000 + i), username: `friend${i}`, global_name: `Friend ${i}` };
    world.channels[id] = { id, type: 1, recipients: [user], last_message_id: String(100 + i) };
    world.messages[id] = [{ id: String(1200000000000000000n + BigInt(i)), channel_id: id, type: 0, pinned: false, author: world.me, content: `hi ${i}`, attachments: [] }];
  }
  return world;
}

await test('T160 a mixed batch ends with nothing left ticked: no hold for 0, no requests', async () => {
  const { page, stats, pageErrors, context } = await boot('/channels/4001/5001');
  // The selection the pictures use: two DMs, a closed DM, #art-share and #mod-only (no access).
  await pickBatch(page, ['c:3003', 'c:3002', 'u:2004', 'c:5002', 'c:5007']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 40000);
  const after = await inPanel(page, (r) => ({
    ticked: r.querySelectorAll('.row.is-selected').length + r.querySelectorAll('.row .check:checked').length,
    badge: r.querySelector('[data-role="tab-badge"]').hidden,
    purify: r.querySelector('[data-act="purify"]').disabled,
    done: r.querySelectorAll('.row[data-state="done"]').length,
    skipped: r.querySelector('[data-key="c:5007"]').dataset.state,
  }));
  assert(after.ticked === 0 && after.badge && after.purify, `still offered ${JSON.stringify(after)}`);
  assert(after.done === 4 && after.skipped === 'error', `outcomes stay readable ${JSON.stringify(after)}`);
  const sent = stats.log.length;
  await page.locator('[data-act="purify"]').evaluate((b) => b.click());
  await page.waitForTimeout(400);
  assert(await page.locator('.modal-layer[data-open="true"]').count() === 0, 'no hold offered for 0 messages');
  assert(stats.log.length === sent, `requests after the batch: ${stats.log.slice(sent).join(', ')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T161 Many chats rows: one line each, one count column, said once', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 15 });
  const keys = ['c:3004', 'c:3003', 'c:3002', 'u:2004', 'c:5002', 'c:5004', 'c:5007'];
  await pickBatch(page, keys);
  const look = () => inPanel(page, (r, ks) => Object.fromEntries([...ks, 'u:2005'].map((k) => {
    const el = r.querySelector(`[data-key="${k}"]`);
    const meta = el.querySelector('.row-meta');
    return [k, { h: Math.round(el.getBoundingClientRect().height), right: meta.getBoundingClientRect().right, meta: meta.textContent,
      tag: el.querySelector('.row-tag').hidden ? '' : el.querySelector('.row-tag').textContent, title: el.title, state: el.dataset.state }];
  })), keys);
  const before = await look();
  assert(await page.locator('.hint').count() === 0, 'the permanent tip is gone');
  const filter = page.locator('[data-role="filter"]');
  assert(await filter.getAttribute('placeholder') === 'Find a chat or server…' && await filter.getAttribute('aria-label') === 'Find a chat or server', 'filter words');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  const after = await look();
  for (const k of Object.keys(before)) assert(after[k].h === before[k].h, `${k} grew from ${before[k].h} to ${after[k].h}px: ${JSON.stringify(after[k])}`);
  assert(before['c:3002'].h === 38 && before['c:5002'].h === 32, `row heights ${before['c:3002'].h}/${before['c:5002'].h}`);
  // Group, DMs and closed DMs end their counts on one column.
  const edges = ['c:3004', 'c:3003', 'c:3002', 'u:2004', 'u:2005'].map((k) => after[k].right);
  assert(Math.max(...edges) - Math.min(...edges) <= 1, `count column ${edges.join(', ')}`);
  assert(after['c:3003'].state === 'ready' && after['c:3003'].tag === '' && after['c:3003'].meta === '7 msgs', `ready ${JSON.stringify(after['c:3003'])}`);
  // The fold says 'closed DM' once (D43); the row's hover says whose it is.
  assert(after['u:2004'].meta === '' && spaced(after['u:2004'].title) === 'Bob friend · @bob', `closed DM ${JSON.stringify(after['u:2004'])}`);
  assert(after['c:5004'].meta === 'all clear ✓', `clean ${JSON.stringify(after['c:5004'])}`);
  const err = after['c:5007'];
  assert(err.state === 'error' && err.tag === '' && err.meta === '✗ no access' && /Missing Access/.test(err.title), `said once ${JSON.stringify(err)}`);
  // Bardo's row shows one gold mark per meaning; the shield that undoes it appears on hover.
  const shield = page.locator('.row-immune .shield-btn');
  await page.mouse.move(5, 5);
  assert(await shield.evaluate((b) => getComputedStyle(b).opacity) === '0', 'immune shield rests hidden');
  await page.hover('.row-immune');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.row-immune .shield-btn')).opacity === '1');
  // A running pill changes only its number: the same spinner keeps turning.
  await page.click('[data-act="dm-none"]');
  for (const k of ['c:5002', 'c:5004', 'c:5007']) await page.click(`[data-key="${k}"]`);
  await page.click('[data-key="c:3002"]');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => {
    const spin = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-key="c:3002"] .run-pill-live .spin');
    if (spin) window.__spin = spin;
    return !!spin;
  }, null, { timeout: 15000 });
  const first = await text(page, '[data-key="c:3002"] .run-pill-n');
  await page.waitForFunction((n) => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const el = r.querySelector('[data-key="c:3002"] .run-pill-n');
    return el && el.textContent !== n && Number(el.textContent.split('/')[0]) >= 4;
  }, first, { timeout: 15000 });
  assert(await page.evaluate(() => window.__spin === document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-key="c:3002"] .spin')), 'the spinner was rebuilt mid-run');
  await page.click('[data-act="stop"]');
  await waitEnd(page);
  await context.close();
});

await test('T162 the lists say what they are doing, and when nothing matches', async () => {
  {
    const { page, context } = await boot('/channels/4001/5001');
    await page.click('.tab[data-tab="batch"]');
    await page.waitForSelector('[data-key="c:3002"]');
    await page.fill('[data-role="filter"]', 'zzz');
    await frame(page);
    const none = await inPanel(page, (r) => ['dm-list', 'server-list'].map((l) => (r.querySelector(`[data-role="${l}"] [data-role="no-match"]`) || {}).textContent));
    assert(unmarked(none[0]) === 'No DMs match “zzz”~ closed it? Open it in Discord, then press ↻' && unmarked(none[1]) === 'No chats match “zzz”~', `no-match ${JSON.stringify(none)}`);
    await page.fill('[data-role="filter"]', '<img src=x onerror="window.__xss=1">');
    await frame(page);
    assert(/No DMs match “<img/.test(unmarked(await text(page, '[data-role="dm-list"] [data-role="no-match"]'))) && !(await page.evaluate(() => window.__xss)), 'the query is shown as text');
    // The marks that keep names in reading order never stop a match.
    await page.fill('[data-role="filter"]', 'dm: alice');
    await frame(page);
    assert(await page.locator('[data-key="c:3002"]').isVisible() && await page.locator('[data-role="no-match"]').count() === 1, 'label search finds Alice');
    await page.fill('[data-role="filter"]', '');
    await frame(page);
    assert(await page.locator('[data-role="no-match"]').count() === 0, 'clearing the filter clears the note');
    // A server's channels are found, then a server with nothing to purge says so.
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(/\/api\/v9\/guilds\/4002\/channels$/, async (route) => { await held; route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
    await page.locator('.guild-head').nth(1).click();
    await page.waitForFunction(() => /Finding channels…/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.guild')[1].textContent));
    release();
    await page.waitForFunction(() => /No channels here you can purify~/.test(document.querySelectorAll && document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.guild')[1].textContent));
    await context.close();
  }
  {
    const world = buildWorld();
    for (const [id, c] of Object.entries(world.channels)) if (c.type === 1 || c.type === 3) delete world.channels[id];
    world.relationships = [];
    world.guilds = [];
    const { page, context } = await boot('/channels/@me', { world });
    await page.click('.tab[data-tab="batch"]');
    await page.waitForFunction(() => /No DMs here yet~/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="dm-list"]').textContent));
    await page.waitForFunction(() => /You're not in any servers~/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="server-list"]').textContent));
    await context.close();
  }
});

await test('T163 forced colours show only real ticks, the chosen tab and the hold; controls clear 3:1', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.emulateMedia({ forcedColors: 'active' });
  await pickBatch(page, ['c:3002', 'c:5002']);
  await page.waitForTimeout(300); // the tick fades in
  const look = () => inPanel(page, (r) => {
    const probe = document.createElement('i');
    probe.style.cssText = 'forced-color-adjust:none;background:Highlight';
    r.append(probe);
    const highlight = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const ticks = [...r.querySelectorAll('.row .check, .guild-all .check')].map((c) => ({ checked: c.checked, mixed: c.indeterminate, shown: getComputedStyle(c.nextElementSibling.querySelector('.ico')).opacity }));
    const fill = r.querySelector('.hold-fill');
    return { highlight, ticks, tab: getComputedStyle(r.querySelector('.tab[aria-selected="true"]')).backgroundColor, fill: getComputedStyle(fill).backgroundColor, fillW: fill.getBoundingClientRect().width };
  });
  const s = await look();
  assert(s.ticks.length > 8 && s.ticks.every((t) => t.mixed || (t.shown === (t.checked ? '1' : '0'))), `ticks ${JSON.stringify(s.ticks)}`);
  assert(s.tab === s.highlight, `selected tab ${s.tab} vs Highlight ${s.highlight}`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const box = await page.locator('[data-act="confirm"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(350);
  const held = await look();
  await page.mouse.move(5, 5); // slide off: nothing is purged
  await page.mouse.up();
  assert(held.fill === held.highlight && held.fillW > 20, `hold fill ${held.fill} ${held.fillW}px`);
  await page.keyboard.press('Escape');
  await page.emulateMedia({ forcedColors: 'none' });
  await page.click('[data-act="mute"]');
  await page.waitForTimeout(300);
  const normal = await inPanel(page, (r) => ({
    ring: getComputedStyle(r.querySelector('.row:not(.is-selected) .check-ui')).boxShadow,
    tick: getComputedStyle(r.querySelector('.row:not(.is-selected) .check-ui .ico')).opacity,
    muted: getComputedStyle(r.querySelector('[data-act="mute"]')).color,
    glyph: getComputedStyle(r.querySelector('.row-glyph')).color,
  }));
  assert(/0\.42/.test(normal.ring) && normal.tick === '0', `checkbox ring ${JSON.stringify(normal)}`);
  assert(normal.muted === 'rgb(160, 131, 147)' && normal.glyph === 'rgb(160, 131, 147)', `muted icon and channel glyph at --t3 ${JSON.stringify(normal)}`);
  await context.close();
});

await test('T164 screen readers hear each row, the badge and the Purify count in words', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await pickBatch(page, ['c:3002', 'c:5002']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/);
  const cdp = await context.newCDPSession(page);
  const tree = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes.filter((n) => !n.ignored)
    .map((n) => ({ role: n.role && n.role.value, name: unmarked(n.name && n.name.value).trim(), desc: unmarked(n.description && n.description.value).trim(),
      checked: ((n.properties || []).find((p) => p.name === 'checked') || {}).value }));
  let nodes = await tree();
  const alice = nodes.find((n) => n.role === 'checkbox' && n.name === 'DM: Alice ✿');
  assert(alice && alice.desc === '31 msgs' && alice.checked && alice.checked.value === 'true', `Alice reads ${JSON.stringify(alice)}`);
  assert(nodes.some((n) => n.role === 'tab' && / 2 selected$/.test(n.name)), `tab ${JSON.stringify(nodes.filter((n) => n.role === 'tab'))}`);
  // Purify selected carries no count (D40): the badge and the strip say how many.
  assert(nodes.some((n) => n.role === 'button' && n.name === 'Purify selected'), `purify ${JSON.stringify(nodes.filter((n) => n.role === 'button' && /Purify/.test(n.name)))}`);
  assert(nodes.some((n) => n.role === 'group' && n.name === 'Direct messages') && nodes.some((n) => n.role === 'group' && n.name === 'Servers'), 'lists are named groups');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  nodes = await tree();
  const done = nodes.find((n) => n.role === 'checkbox' && n.name === 'DM: Alice ✿');
  assert(done && done.desc === 'purged 31', `a finished row reads ${JSON.stringify(done)}`);
  assert(!nodes.some((n) => /✗|✓/.test(n.name + n.desc)), 'no glyph names');
  await page.click('.tab[data-tab="current"]');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  nodes = await tree();
  assert(nodes.some((n) => n.role === 'button' && n.name === 'Purify 40 messages'), `this chat ${JSON.stringify(nodes.filter((n) => n.role === 'button' && /Purify/.test(n.name)))}`);
  await context.close();
});

await test('T165 a long purge speaks its progress at most once a minute, and never a floor', async () => {
  const listen = (page) => page.evaluate(() => {
    window.__said = [];
    new MutationObserver(() => { const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="milestone"]').textContent; if (t) window.__said.push(t); })
      .observe(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="milestone"]'), { childList: true, characterData: true, subtree: true });
  });
  {
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 10 });
    // The panel's own clock, to step past the minute without waiting for it.
    await page.evaluate(() => { const real = performance.now.bind(performance); let skew = 0; performance.now = () => real() + skew; window.__skew = (ms) => { skew += ms; }; });
    assert(await page.locator('[data-role="milestone"]').getAttribute('aria-live') === 'polite', 'a polite region');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    await listen(page);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => window.__said.length === 1, null, { timeout: 15000 });
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 21, null, { timeout: 15000 });
    assert((await page.evaluate(() => window.__said)).length === 1, 'quiet for the rest of the minute');
    await page.evaluate(() => window.__skew(61000));
    await waitEnd(page);
    const said = await page.evaluate(() => window.__said);
    assert(said.length === 2, `announcements ${JSON.stringify(said)}`);
    assert(/^(2[5-9]|[34]\d)% · \d+ of 40 purged · about .+ left$/.test(said[0]) && /^([5-9]\d)% · \d+ of 40 purged/.test(said[1]), `words ${JSON.stringify(said)}`);
    await context.close();
  }
  {
    // Not counted: while a chat is still uncounted the total is a floor ('31 of 31+'), and stays unsaid.
    const { page, context } = await boot('/channels/4001/5001', { latencyMs: 10 });
    await pickBatch(page, ['c:3002', 'c:3003']);
    await page.evaluate(() => {
      window.__floors = [];
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      new MutationObserver(() => window.__floors.push(`${r.querySelector('[data-role="milestone"]').textContent} @ ${r.querySelector('[data-role="pct"]').textContent}`))
        .observe(r.querySelector('[data-role="milestone"]'), { childList: true, characterData: true, subtree: true });
    });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    const said = (await page.evaluate(() => window.__floors)).filter((s) => !s.startsWith(' @'));
    assert(said.length && said.every((s) => !s.endsWith('+')), `spoken over a floor ${JSON.stringify(said)}`);
    await context.close();
  }
});

await test('T166 right-to-left names keep their place in labels and titles', async () => {
  const world = buildWorld();
  world.channels['5008'] = { id: '5008', type: 0, guild_id: '4001', name: 'الدردشة-العامة', position: 5 };
  world.messages['5008'] = [];
  world.guilds[0].name = 'سيرفر الأصدقاء المسائي';
  world.channels['3004'].recipients = [{ id: '2101', username: 'mohammed', global_name: 'محمد العتيبي' }, { id: '2102', username: 'shira', global_name: 'שירה כהן' }];
  const { page, context } = await boot('/channels/4001/5001', { world });
  await pickBatch(page, ['c:5008', 'c:3004']);
  const label = await page.locator('[data-key="c:5008"] .check').getAttribute('aria-label');
  assert(label === '#\u2068الدردشة-العامة\u2069 (\u2068سيرفر الأصدقاء المسائي\u2069)', `channel label ${JSON.stringify(label)}`);
  // Where each part lands on screen: '#' and the channel come first, the server after.
  const order = (sel, marks) => inPanel(page, (r, [s, ms]) => {
    const t = r.querySelector(s).firstChild;
    return ms.map((m) => { const i = t.data.indexOf(m); const range = document.createRange(); range.setStart(t, i); range.setEnd(t, i + 1); return Math.round(range.getBoundingClientRect().left); });
  }, [sel, marks]);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const [hash, channel, paren, server] = await order('.modal-item-name', ['#', 'ا', '(', 'س']);
  assert(hash < channel && channel < paren && paren < server, `dialog order # ${hash}, channel ${channel}, ( ${paren}, server ${server}`);
  await page.keyboard.press('Escape');
  const [arabic, hebrew] = await order('[data-key="c:3004"] .row-name', ['م', 'ש']);
  assert(arabic < hebrew, `group members swap: Arabic at ${arabic}, Hebrew at ${hebrew}`);
  await context.close();
});

await test('T167 each list is one Tab stop and the arrows walk it', async () => {
  const { page, context } = await boot('/channels/4001/5001', { world: longWorld(), viewport: { width: 1280, height: 720 } });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:7039"]');
  const at = async () => { const a = await look(); return a && { ...a, what: unmarked(a.what) }; };
  const look = () => inPanel(page, (r) => {
    const a = r.activeElement;
    if (!a) return null;
    const line = a.closest('.row, .guild-bar, .fold-bar');
    const strip = r.querySelector('.hero').getBoundingClientRect().bottom;
    return { what: a.dataset.act || a.getAttribute('aria-label') || a.className, key: line && (line.dataset.key || 'guild'), checked: a.checked,
      clear: !line || line.getBoundingClientRect().top >= strip - 1, expanded: a.getAttribute('aria-expanded') };
  });
  await page.locator('[data-role="filter"]').focus();
  const stops = [];
  for (let i = 0; i < 12 && !(stops.length && stops[stops.length - 1].what === 'server-refresh'); i++) {
    await page.keyboard.press('Tab');
    stops.push(await at());
  }
  // The DM list is one stop, on its first checkbox: a reflex Space ticks a chat, never lifts Bardo's shield.
  assert(stops.map((s) => s.what).join(' | ') === 'dm-all | dm-none | dm-refresh | Group: Alice ✿, Carol | server-refresh', `Tab stops ${JSON.stringify(stops)}`);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('ArrowDown');
  let now = await at();
  assert(now.key === 'c:3003' && /^DM: /.test(now.what) && !now.checked, `two down ${JSON.stringify(now)}`);
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  now = await at();
  assert(now.key === 'c:3002' && !now.checked && await page.locator('[data-key="c:3003"] .check').isChecked(), `Space ticks, arrows only move ${JSON.stringify(now)}`);
  await page.keyboard.press('ArrowRight');
  assert((await at()).what === 'Shield Alice ✿', `right to the shield ${JSON.stringify(await at())}`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('End');
  now = await at();
  // Friends with a closed DM wait in a fold (D43): End reaches it, Right opens it.
  assert(now.key === 'fold:friends' && now.expanded === 'false' && now.clear, `End: the friends' fold ${JSON.stringify(now)}`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('End');
  now = await at();
  assert(now.key === 'u:2005' && now.clear, `End: the last friend ${JSON.stringify(now)}`);
  await page.keyboard.press('Home');
  now = await at();
  assert(now.what === 'Shield Bardo' && now.clear, `Home ${JSON.stringify(now)}`);
  // Leaving and coming back lands where you were.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert((await at()).key === 'c:3004', `back to the same row ${JSON.stringify(await at())}`);
  // Servers: the select-all box comes first, Right opens the server and goes in, Left comes out.
  assert(await page.locator('.guild-bar').first().evaluate((b) => b.firstElementChild.classList.contains('guild-all')), 'select-all first in the DOM');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  now = await at();
  assert(now.what === 'All channels in ✿ Cozy Corner', `server stop ${JSON.stringify(now)}`);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  now = await at();
  assert(now.expanded === 'true', `opened ${JSON.stringify(now)}`);
  await page.waitForSelector('[data-key="c:5001"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  now = await at();
  assert(now.key === 'c:5002', `into the channels ${JSON.stringify(now)}`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  now = await at();
  assert(now.expanded === 'false', `folded ${JSON.stringify(now)}`);
  assert(await page.locator('.row .check:checked').count() === 1, 'moving never ticked anything');
  await context.close();
});

await test('T168 a shield toggled from the keyboard keeps focus on that person', async () => {
  {
    const { page, context } = await boot('/channels/4001/5001');
    await page.click('.tab[data-tab="batch"]');
    await page.waitForSelector('[data-key="c:3003"]');
    await page.locator('[data-key="c:3003"] .check').focus();
    await page.keyboard.press('ArrowRight');
    const focused = () => inPanel(page, (r) => r.activeElement && { user: r.activeElement.dataset.userId, pressed: r.activeElement.getAttribute('aria-pressed'), immune: !!r.activeElement.closest('.row-immune') });
    await page.keyboard.press('Enter');
    let f = await focused();
    assert(f && f.user === '2003' && f.pressed === 'true' && f.immune, `after shielding ${JSON.stringify(f)}`);
    await page.keyboard.press('Space');
    f = await focused();
    assert(f && f.user === '2003' && f.pressed === 'false' && !f.immune, `after removing the shield ${JSON.stringify(f)}`);
    await context.close();
  }
  {
    const { page, context } = await boot('/channels/@me/3002');
    await page.locator('[data-role="target-tools"] .shield-btn').focus();
    await page.keyboard.press('Enter');
    const f = await inPanel(page, (r) => r.activeElement && { tools: !!r.activeElement.closest('[data-role="target-tools"]'), pressed: r.activeElement.getAttribute('aria-pressed') });
    assert(f && f.tools && f.pressed === 'true', `card shield ${JSON.stringify(f)}`);
    await context.close();
  }
});

await test('T169 one word per idea: shield and immune, and "#" only for text channels', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await pickBatch(page, ['c:5001']);
  const words = () => inPanel(page, (r) => [...r.querySelectorAll('.shield-btn')].map((b) => `${b.getAttribute('aria-label')} | ${b.title} | ${b.getAttribute('aria-pressed')}`));
  const before = (await words()).map(unmarked);
  assert(before.includes('Shield Alice ✿ | Shield this DM~ never purged | false') && before.includes('Shield Bardo | Immune ♡ tap to remove the shield | true'), `shields ${JSON.stringify(before)}`);
  assert(!before.some((w) => /protect/i.test(w)), `no "protect" ${JSON.stringify(before)}`);
  const labels = (await inPanel(page, (r) => ['5001', '5003', '5004'].map((id) => r.querySelector(`[data-key="c:${id}"] .check`).getAttribute('aria-label')))).map(unmarked);
  assert(JSON.stringify(labels) === JSON.stringify(['#general (✿ Cozy Corner)', 'announcements (✿ Cozy Corner)', 'Voice Lounge (✿ Cozy Corner)']), `channel labels ${JSON.stringify(labels)}`);
  await context.close();
});

// ── 4.2 foundation: one vocabulary, shared helpers, the test worlds ──

// What a person reads on the panel: every rendered word outside the screen-reader text and the log.
// ring marks the count's own label, the one place the ring's battle cry 'ready for purge' stays.
const panelWords = (page) => inPanel(page, (r) => {
  const words = [];
  const walk = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const el = walk.currentNode.parentElement;
    const said = walk.currentNode.textContent.trim();
    if (!said || !el || el.closest('.sr, .term, style') || !el.checkVisibility({ checkVisibilityCSS: true })) continue;
    words.push({ said, ring: !!el.closest('[data-role="count-label"]') });
  }
  return words;
});

// Every status line the footer shows, however briefly (waits, 'Chat 2 of 4', a count's progress).
const noteLines = (page) => inPanel(page, (r) => {
  const text = r.querySelector('[data-role="status-text"]');
  window.__lines = [text.textContent];
  new MutationObserver(() => { if (window.__lines.at(-1) !== text.textContent) window.__lines.push(text.textContent); })
    .observe(text, { childList: true, subtree: true, characterData: true });
});
const linesSeen = (page) => page.evaluate(() => window.__lines || []);

// Count, not Scan; Purify is the action. Purge stays only where it is wit (the moods, the terminal,
// 'messages purged') and on the ring's label.
const OLD_WORDS = [/\bscan(s|ned|ning)?\b/i, /to purge~/i, /Nevermind/i, /Purify many chats/i, /counts them first/i, /\bPurging\b/];
function sayOnlyNewWords(said, where) {
  for (const re of OLD_WORDS) assert(!re.test(said), `${where}: "${said.match(re)?.[0]}" in "${said}"`);
}
async function oneVocabulary(page, where) {
  const words = await panelWords(page);
  const all = words.map((w) => w.said).join(' | ');
  sayOnlyNewWords(all, where);
  const off = words.filter((w) => !w.ring && /ready for purge/i.test(w.said));
  assert(!off.length, `${where}: 'ready for purge' away from the ring: ${JSON.stringify(off)}`);
  return all;
}

await test('T170 one word for each thing: Count, Purify and Pick, in every state a person sees', async () => {
  const count = (page) => inPanel(page, (r) => Number(r.querySelector('[data-role="count"]').textContent.replace(/\D/g, '')));
  const atLeast = (page, n) => page.waitForFunction((k) => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent.replace(/\D/g, '')) >= k, n, { timeout: 20000 });
  const lines = [];
  // This chat from the first run to the finish (00-09), a tap on the hold (e14) and a Stop (e13).
  {
    const { page, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 120, firstRun: true });
    await noteLines(page);
    await page.locator('[data-role="welcome"]').waitFor({ state: 'visible' });
    const welcome = await oneVocabulary(page, '00 welcome');
    assert(/Clear your side of any chat in two steps:/.test(welcome) && /Pick many chats/.test(welcome), `welcome ${welcome}`);
    await page.click('[data-act="welcome-ok"]');
    await page.locator('[data-role="welcome"]').waitFor({ state: 'hidden' });
    const idle = await oneVocabulary(page, '01 idle');
    assert(/\| Count \|/.test(idle) && /Purify asks before anything goes/.test(idle), `idle ${idle}`);
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    const counted = await oneVocabulary(page, '02 counted');
    assert(/Count again/.test(counted) && /about \d+s to purify~/.test(counted), `counted ${counted}`);
    assert(await text(page, '[data-role="count-label"]') === 'ready for purge', 'the ring keeps its battle cry');
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    assert(/Never mind~/.test(await oneVocabulary(page, '03 the dialog')), 'Never mind, in two words');
    await page.click('[data-act="confirm"]'); // a tap teaches the hold
    await oneVocabulary(page, 'e14 a tap');
    const box = await page.locator('[data-act="confirm"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await oneVocabulary(page, '04 holding');
    await page.waitForTimeout(700);
    await page.mouse.up();
    await atLeast(page, 3);
    assert(/Purifying/.test(await oneVocabulary(page, '05 purifying')), 'the running eyebrow says Purifying');
    await page.click('[data-act="pause"]');
    await untilStatus(page, /^Resume picks up right here~$/);
    await oneVocabulary(page, '06 paused');
    await page.click('[data-act="resume"]');
    await waitEnd(page);
    await oneVocabulary(page, '07 done');
    await goTo(page, '/channels/4001/5002');
    await nameIs(page, 'art-share');
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await atLeast(page, 2);
    await page.click('[data-act="stop"]');
    await waitEnd(page);
    await oneVocabulary(page, 'e13 stopped');
    assert(await count(page) < 10, 'stopped before the end');
    await page.click('[data-act="minimize"]');
    sayOnlyNewWords(await page.locator('.orb').getAttribute('title'), '09 the orb');
    lines.push(...await linesSeen(page));
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  // Many chats: nothing picked, picked (10, 16), counted (11), the dialog (12), running (13), done (14).
  {
    const { page, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 60 });
    await noteLines(page);
    await page.click('.tab[data-tab="batch"]');
    await page.waitForSelector('[data-key="c:3003"]');
    assert(/pick any DMs or channels below~/.test(await oneVocabulary(page, 'Many chats, nothing picked')), 'pick, not tick');
    await pickBatch(page, ['c:3003', 'c:3002', 'u:2004', 'c:5002', 'c:5007']);
    assert(/\| Count \|/.test(await oneVocabulary(page, '10 picked')), 'Many chats counts with Count');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^Counted~/, 15000);
    await oneVocabulary(page, '11 counted');
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await oneVocabulary(page, '12 the dialog');
    await holdConfirm(page);
    await atLeast(page, 2);
    await oneVocabulary(page, '13 purifying');
    await waitEnd(page, 60000);
    await oneVocabulary(page, '14 done');
    lines.push(...await linesSeen(page));
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  // A tour: immune (15), a group DM (e09), no access (e03, e04) and no chat open (17).
  {
    const { page, pageErrors, context } = await boot('/channels/@me/3001');
    await noteLines(page);
    await oneVocabulary(page, '15 immune');
    await goTo(page, '/channels/@me/3004');
    await page.waitForFunction(() => /Alice/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]').textContent), null, { timeout: 4000 });
    await oneVocabulary(page, 'e09 a group DM');
    await goTo(page, '/channels/4001/5007');
    await nameIs(page, 'mod-only');
    await oneVocabulary(page, 'e03 no access');
    await page.click('[data-act="purify"]');
    await untilStatus(page, /^No access here$/);
    await oneVocabulary(page, 'e04 no access, after Purify');
    await goTo(page, '/channels/@me');
    await nameIs(page, 'No chat open');
    assert(/Pick many chats/.test(await oneVocabulary(page, '17 no chat open')), 'the tab switch is Pick, not Purify');
    lines.push(...await linesSeen(page));
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  // A DM counted (e10), purified to the end (e11), with reduced motion (e15).
  {
    const { page, pageErrors, context } = await boot('/channels/@me/3002', { reducedMotion: 'reduce' });
    await noteLines(page);
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    await oneVocabulary(page, 'e10 a DM, counted');
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await oneVocabulary(page, 'e11 e15 a DM, done, reduced motion');
    lines.push(...await linesSeen(page));
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  // Logged out (e01), a rate limit's wait (e02), a short window's strip (e05, e06), a deep index (e08).
  for (const [where, path, opts, act] of [
    ['e01 logged out', '/channels/4001/5001', { badToken: true }, async (page) => { await page.click('[data-act="scan"]'); await untilStatus(page, /^Login not working$/); }],
    ['e02 a rate limit', '/channels/4001/5002', { rateLimitEvery: 3 }, async (page) => { await page.click('[data-act="purify"]'); await holdConfirm(page); await waitEnd(page); }],
    ['e05 e06 a short window', '/channels/4001/5001', { viewport: { width: 720, height: 450 } }, async (page) => { await oneVocabulary(page, 'e05 strip'); await page.click('[data-act="scan"]'); await untilStatus(page, /found/); }],
    ['e08 still indexing', '/channels/4001/5004', { deepIndex: ['5004'], indexingOnce: ['5004'] }, async (page) => {
      await page.click('[data-act="scan"]');
      await heroAt(page, 'indexing/icon', 6000);
      assert(/count again in a minute/.test(await text(page, '[data-role="readout-line"]')), `indexing readout ${await text(page, '[data-role="readout-line"]')}`);
    }],
  ]) {
    const { page, pageErrors, context } = await boot(path, opts);
    await noteLines(page);
    await act(page);
    await oneVocabulary(page, where);
    lines.push(...await linesSeen(page));
    assert(pageErrors.length === 0, `${where}: page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  for (const line of lines) sayOnlyNewWords(line, 'a footer line');
  assert(lines.some((l) => /^Taking a breather~/.test(l)) && lines.some((l) => /^Counting 1 of 5/.test(l)) && lines.some((l) => /^Chat 1 of 4/.test(l)), `the footer lines seen: ${JSON.stringify([...new Set(lines)])}`);
});

await test('T171 shared helpers: honest durations, Latin digits, a dot that never starts a line, an English panel, a spoken prefix', async () => {
  {
    const { page, pageErrors, context } = await bootProbe('/channels/4001/5001', ['formatDuration', 'setStatus']);
    const said = await page.evaluate(() => [59.5, 3570, 7199, 72500, 0.2, 59, 60, 3599, 4950].map((s) => window.__dp.formatDuration(s)));
    assert(JSON.stringify(said) === JSON.stringify(['1 min', '1h', '2h', '20h 9m', '1s', '59s', '1 min', '1h', '1h 23m']), `durations ${JSON.stringify(said)}`);
    assert(await page.evaluate(() => document.querySelector('#dopa-purifier-host').getAttribute('lang')) === 'en', 'the panel tells screen readers it speaks English');
    // sr: said first, never shown, gone with the next line.
    await page.evaluate(() => window.__dp.setStatus('Done in 3s', 'success', { flair: '♡', sr: 'All clean. ' }));
    const st = await inPanel(page, (r) => {
      const s = r.querySelector('[data-role="status"]');
      const said = s.querySelectorAll('.sr');
      return { n: said.length, first: s.firstElementChild === said[0], sr: said[0] && said[0].textContent, shown: r.querySelector('[data-role="status-text"]').textContent, title: s.title };
    });
    assert(st.n === 1 && st.first && st.sr === 'All clean. ' && st.shown === 'Done in 3s ♡' && st.title === 'Done in 3s', `sr ${JSON.stringify(st)}`);
    const spoken = await page.locator('[data-role="status"]').ariaSnapshot();
    assert(/All clean\. Done in 3s/.test(spoken) && !spoken.includes('♡'), `screen readers hear: ${spoken}`);
    await page.evaluate(() => window.__dp.setStatus('Ready to purify~', 'info'));
    assert(await inPanel(page, (r) => r.querySelectorAll('[data-role="status"] .sr').length) === 0, 'the next line drops the spoken prefix');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  // An Arabic Discord: grouping follows the language, the digits stay 0-9 like the words around them.
  {
    const { page, context } = await boot('/channels/4001/5001', { locale: 'ar-EG' });
    assert(await page.evaluate(() => navigator.language) === 'ar-EG', 'the browser speaks Arabic');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    assert(await text(page, '[data-role="count"]') === '40' && await text(page, '[data-role="purify-count"]') === '40', `count ${await text(page, '[data-role="count"]')}`);
    assert((await heard(page)).startsWith('40 messages found'), `status ${await status(page)}`);
    await context.close();
  }
  // 50,000 of yours at the shipped pace, in a narrow window: the footer wraps, never before a dot.
  {
    const { page, context } = await bootWith(source, '/channels/4001/5001', { world: buildWorld({ bulk: { 5001: 49960 } }), viewport: { width: 360, height: 740 } });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/, 15000);
    assert(await heard(page) === "50,000 messages found. Counted~ press Purify when you're ready" && await text(page, '[data-role="readout-line"]') === 'about 20h 9m to purify~', `status ${await heard(page)}`);
    const starts = await inPanel(page, (r) => {
      const out = [];
      let top = null;
      const walk = document.createTreeWalker(r.querySelector('[data-role="status-text"]'), NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const n = walk.currentNode;
        for (let i = 0; i < n.length; i++) {
          if (/\s/.test(n.data[i])) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const box = range.getClientRects()[0];
          if (box && (top === null || box.top > top + 2)) { out.push(n.data[i]); top = box.top; }
        }
      }
      return out;
    });
    assert(starts.length >= 1 && !starts.includes('·'), `the footer's lines start with ${JSON.stringify(starts)}`);
    await context.close();
  }
});

await test('T251 the audit\'s worlds live in the repo: crowds, a big #general, names at Discord\'s limits', async () => {
  const dms = (w) => Object.values(w.channels).filter((c) => c.type === 1 || c.type === 3).length;
  const friends = (w) => w.relationships.filter((r) => r.type === 1).length;
  const heavy = buildWorld({ crowd: 'heavy' });
  assert(dms(heavy) === 604 && friends(heavy) === 404 && heavy.guilds.length === 102
    && Object.values(heavy.channels).filter((c) => Number(c.guild_id) >= 90000).length === 3000, 'heavy: 600 DMs, 400 friends, 100 servers of 30 channels');
  const nodes = buildWorld({ crowd: 'nodes' });
  assert(dms(nodes) === 604 && friends(nodes) === 404 && nodes.guilds.length === 2 && mine(nodes, '3002').length === mine(buildWorld(), '3002').length + 200, 'nodes: 600 DMs, 400 friends, 200 more with Alice');
  const len = (s) => [...s].length;
  const long = buildWorld({ names: 'long' });
  assert(len(long.guilds[0].name) === 100 && len(long.channels['5001'].name) === 100 && len(long.channels['3004'].name) === 100
    && len(long.me.username) === 32 && len(long.users.alice.username) === 32 && len(long.users.alice.global_name) === 32, 'long names sit at Discord\'s limits');
  let unknown = '';
  try { buildWorld({ crowd: 'huge' }); } catch (e) { unknown = e.message; }
  assert(/no crowd 'huge'/.test(unknown), `an unknown world says so: ${unknown}`);
  // The scale world draws 806 rows in the DM list.
  {
    const { page, pageErrors, context } = await boot('/channels/4001/5001', { world: buildWorld({ crowd: 'scale' }) });
    await page.click('.tab[data-tab="batch"]');
    await page.waitForFunction(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      return r.querySelectorAll('[data-role="dm-list"] .row').length >= 806 && r.querySelectorAll('.guild').length >= 152;
    }, null, { timeout: 30000 });
    const drawn = await inPanel(page, (r) => ({ rows: r.querySelectorAll('[data-role="dm-list"] .row').length, servers: r.querySelectorAll('.guild').length }));
    assert(drawn.rows === 806 && drawn.servers === 152, `scale world ${JSON.stringify(drawn)}`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  // The edge lens's big #general: 3,040 of yours, counted the way a person would.
  {
    const { page, context } = await boot('/channels/4001/5001', { world: buildWorld({ bulk: { 5001: 3000 } }) });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/, 8000);
    assert((await heard(page)).startsWith('3,040 messages found'), `status ${await status(page)}`);
    await context.close();
  }
  // Every name at its limit draws, in This chat and in Many chats.
  {
    const world = buildWorld({ names: 'extreme' });
    const { page, pageErrors, context } = await boot('/channels/4001/5001', { world });
    assert(await text(page, '[data-role="target-name"]') === world.channels['5001'].name && await text(page, '[data-role="target-context"]') === world.guilds[0].name, 'the long channel and server names');
    await pickBatch(page, ['c:3003', 'c:3002', 'c:3004']);
    const names = (await inPanel(page, (r) => ['c:3003', 'c:3002', 'c:3004'].map((k) => r.querySelector(`[data-key="${k}"] .row-name`).textContent))).map(unmarked);
    assert(names[0] === world.users.mallory.global_name && names[1] === world.users.alice.global_name && names[2] === world.channels['3004'].name, `rows ${JSON.stringify(names)}`);
    assert(await text(page, '[data-role="tab-badge"]') === '3', 'all three picked');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T252 switches for the tests to come: Discord\'s light theme, offline, a 5xx outage, a message sent now', async () => {
  {
    const { page, context } = await boot('/channels/4001/5001', { light: true });
    const shell = await page.evaluate(() => ({ html: document.documentElement.className, light: matchMedia('(prefers-color-scheme: light)').matches, bg: getComputedStyle(document.body).backgroundColor }));
    assert(shell.html === 'theme-light' && shell.light && shell.bg === 'rgb(255, 255, 255)', `light theme ${JSON.stringify(shell)}`);
    await context.close();
  }
  // The connection drops while counting again: the count waits calmly and lands once it is back.
  {
    const { page, cfg, stats, context } = await boot('/channels/4001/5002');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^10 messages found/);
    cfg.offline = true;
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^Connection hiccup~ retrying in \ds$/, 4000);
    assert(stats.refused >= 1 && await tone(page) === 'calm', `offline: ${stats.refused} refused, tone ${await tone(page)}`);
    cfg.offline = false;
    await untilStatus(page, /^10 messages found/, 8000);
    await context.close();
  }
  // Discord answers 502 to deletes for a moment: the run waits it out and nothing fails.
  {
    const { page, cfg, stats, world, context } = await bootPaced('/channels/4001/5002', { deleteMs: 60 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 2);
    cfg.serverError = 502;
    await untilStatus(page, /^Discord is busy~ retrying in \ds$/, 4000);
    const refused = stats.refused;
    cfg.serverError = 0;
    await waitEnd(page, 15000);
    assert(refused >= 1 && mine(world, '5002').length === 0 && /^All clean~/.test(await text(page, '[data-role="readout-line"]')), `502: ${refused} refused, ${mine(world, '5002').length} left, ${await text(page, '[data-role="readout-line"]')}`);
    await context.close();
  }
  // You send a message mid-test: newer than any run confirmed before it, and Discord finds it.
  {
    const { page, world, context } = await boot('/channels/4001/5002');
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^10 messages found/);
    const pageMs = await page.evaluate(() => Date.now());
    const now = (BigInt(pageMs) - 1420070400000n) << 22n;
    // The mock stamps with this process's clock, which can trail Chromium's by a millisecond on
    // Windows: send once it has passed the page's reading, as a message sent after a cut-off is.
    while (Date.now() <= pageMs) await new Promise((r) => setTimeout(r, 1));
    const [sent] = addMine(world, '5002');
    assert(BigInt(sent.id) > now && world.messages['5002'].every((m) => m === sent || BigInt(m.id) < BigInt(sent.id)), `sent ${sent.id}, now ${now}`);
    assert(world.channels['5002'].last_message_id === sent.id, 'the chat\'s newest message is the one just sent');
    await page.click('[data-act="scan"]'); // Count again
    await untilStatus(page, /^11 messages found/);
    await context.close();
  }
});

await test('T253 tests skip Discord\'s long waits: a fake clock, and a timing patch that names its keys', async () => {
  const timed = withTiming(source, { requestTimeoutMs: 1500 });
  assert(/const TIMING = \{ deleteDelayMs: 20, searchDelayMs: 10, requestTimeoutMs: 1500, waitUnitMs: 1000 \}/.test(timed), 'the patch sets each key it names');
  let missed = '';
  try { withTiming(source, { retryStepMs: 10 }); } catch (e) { missed = e.message; }
  assert(/no retryStepMs/.test(missed), `a key the build doesn't have is an error: ${missed}`);
  assert(withTiming(source, false) === source, 'fast: false keeps the build\'s own pace');
  // Offline for 15 s of the page's time in the middle of #general, skipped with the clock.
  const { page, cfg, stats, world, pageErrors, context } = await boot('/channels/4001/5001', { clock: true });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 5);
  const t0 = Date.now();
  const pageT0 = await page.evaluate(() => Date.now());
  // The n-th wait the run logs, and how long it asked for.
  const nthWait = (n) => page.waitForFunction((k) => {
    const waits = [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.term-body .line-msg')]
      .map((l) => /^Connection hiccup~ retrying in (\d+)s$/.exec(l.textContent)).filter(Boolean);
    return waits.length >= k && Number(waits[k - 1][1]);
  }, n, { timeout: 4000 }).then((h) => h.jsonValue());
  cfg.offline = true;
  let away = 0;
  for (let n = 1; away < 15000; n++) {
    const s = await nthWait(n);
    away += s * 1000;
    if (away >= 15000) cfg.offline = false; // back online during this wait
    await page.clock.fastForward(s * 1000);
  }
  await waitEnd(page, 10000);
  const skipped = (await page.evaluate(() => Date.now())) - pageT0;
  assert(skipped >= 15000 && Date.now() - t0 < 10000, `the page lived ${skipped} ms in ${Date.now() - t0} ms of real time`);
  assert(stats.refused >= 3 && mine(world, '5001').length === 0 && /^All clean~/.test(await text(page, '[data-role="readout-line"]')),
    `after the drop: ${stats.refused} refused, ${mine(world, '5001').length} left, ${await text(page, '[data-role="readout-line"]')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// Milliseconds flake on shared CI runners: npm test checks what a heavy account costs in structure
// (requests, nodes, what a tick touches), and test/perf.mjs logs the clocks.
await test('T254 a heavy account costs structure, not time: one request per list, none per tick, a few nodes per row', async () => {
  const { page, stats, pageErrors, context } = await boot('/channels/4001/5001', { world: buildWorld({ crowd: 'scale' }) });
  const t0 = stats.log.length;
  await page.click('.tab[data-tab="batch"]');
  await page.waitForFunction(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    return r.querySelectorAll('[data-role="dm-list"] .row').length >= 806 && r.querySelectorAll('.guild').length >= 152;
  }, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const asked = stats.log.slice(t0).map((l) => l.replace(/\?.*$/, '').replace('/api/v9', ''));
  assert(asked.length <= 3 && asked.every((a) => /^GET \/users\/@me\/(channels|relationships|guilds)$/.test(a)), `opening Many chats asked ${JSON.stringify(asked)}`);
  const nodes = await inPanel(page, (r) => {
    const per = (sel) => { const els = [...r.querySelectorAll(sel)]; return els.reduce((sum, el) => sum + el.querySelectorAll('*').length + 1, 0) / els.length; };
    return { row: per('[data-role="dm-list"] .row'), server: per('.guild'), all: r.querySelectorAll('*').length };
  });
  assert(nodes.row <= 16 && nodes.server <= 16, `nodes a row ${nodes.row.toFixed(1)}, a server ${nodes.server.toFixed(1)} (${nodes.all} in all)`);
  const t1 = stats.log.length;
  for (let i = 0; i < 5; i++) {
    await inPanel(page, (r, k) => r.querySelectorAll('[data-role="dm-list"] .row .check')[10 + k].click(), i);
    assert(await text(page, '[data-role="tab-badge"]') === String(i + 1), `after tick ${i + 1} the badge says ${await text(page, '[data-role="tab-badge"]')}`);
  }
  assert(stats.log.length === t1, `ticking asked Discord ${JSON.stringify(stats.log.slice(t1))}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// ── Run safety and lifecycle (WP-F): the dialog asks about the chat on screen, the panel follows you and
// rests while minimised, one purge at a time, outages are waited out, a reload keeps its place, a
// verdict lasts its visit, the panel boots at idle, and what you send after confirming is never touched ──

const countNow = (page) => page.evaluate(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent.replace(/\D/g, '')) || 0);
const untilCount = (page, n, timeout = 15000) => page.waitForFunction((k) => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent.replace(/\D/g, '')) >= k, n, { timeout });
const badge = (page) => inPanel(page, (r) => { const b = r.querySelector('[data-role="tab-badge"]'); return b.hidden ? '' : b.textContent; });
const ticked = (page, keys) => inPanel(page, (r, ks) => ks.map((k) => !!r.querySelector(`[data-key="${k}"] .check`)?.checked), keys);
const storedJournal = (page) => page.evaluate(() => {
  const f = document.createElement('iframe');
  document.body.appendChild(f);
  try { return JSON.parse(f.contentWindow.localStorage.getItem('dopa-purifier:journal')); } finally { f.remove(); }
});
const plantJournal = (page, j) => page.evaluate((v) => localStorage.setItem('dopa-purifier:journal', JSON.stringify(v)), j);
const HOUR = 3600 * 1000;

// Reload the page and boot the same build again, as the userscript manager would.
async function reboot(page, src = source, fast = true) {
  await page.reload();
  await injectUserscript(page, src, { fast });
  await settled(page);
}

// Two Discord tabs in one browser profile: one storage, one set of Web Locks, one account.
async function sharedProfile() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((t) => {
    if (window.top !== window || localStorage.getItem('token')) return;
    localStorage.setItem('token', JSON.stringify(t));
    localStorage.setItem('dopa-purifier:prefs', JSON.stringify({ welcomed: true }));
  }, TOKEN);
  const world = buildWorld();
  const open = async (path, src = source) => {
    const page = await context.newPage();
    const mock = await installMockDiscord(page, { world, latencyMs: 20 });
    await page.goto('https://discord.com' + path);
    await injectUserscript(page, src, { fast: false });
    await settled(page);
    return { page, ...mock };
  };
  return { context, world, open };
}

// Lives through `away` ms of the page's time with Discord out of reach: each wait the run logs (matched
// by `line`, whose first group is its seconds) is skipped with the clock, and `up` brings Discord back
// during the last one.
async function sitOut(page, { away, line, down, up }) {
  const nth = (n) => page.waitForFunction(([k, src]) => {
    const re = new RegExp(src);
    const waits = [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.term-body .line-msg')]
      .map((l) => re.exec(l.textContent)).filter(Boolean);
    return waits.length >= k && Number(waits[k - 1][1]);
  }, [n, line.source], { timeout: 4000 }).then((h) => h.jsonValue());
  down();
  const said = [];
  for (let gone = 0, n = 1; gone < away; n++) {
    const s = await nth(n);
    said.push(s);
    gone += s * 1000;
    if (gone >= away) up();
    await page.clock.fastForward(s * 1000);
  }
  return said;
}

await test('T172 a click away while Purify counts never brings up a dialog for the chat left behind', async () => {
  for (let i = 1; i <= 6; i++) {
    const { page, stats, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 250 });
    await page.click('[data-act="purify"]');
    await page.waitForTimeout(80);
    await page.click('a[href="/channels/4001/5002"]'); // Discord's own pushState, no popstate
    const opened = await page.evaluate(() => new Promise((resolve) => {
      const layer = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.modal-layer');
      const t0 = performance.now();
      const look = () => (!layer.hidden ? resolve(true) : performance.now() - t0 > 2500 ? resolve(false) : requestAnimationFrame(look));
      look();
    }));
    assert(!opened, `run ${i}: a dialog opened after the click away`);
    assert(stats.deleteAttempts === 0, `run ${i}: ${stats.deleteAttempts} DELETEs`);
    assert(await text(page, '[data-role="target-name"]') === 'art-share', `run ${i}: the card follows to art-share`);
    assert(pageErrors.length === 0, `run ${i}: page errors ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T173 moving to another chat closes This chat\'s dialog as Never mind would; Many chats\' stays', async () => {
  {
    const { page, stats, pageErrors, context } = await boot('/channels/4001/5001');
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    // Mid-hold, even: the hold is let go, and nothing goes.
    const btn = await page.locator('[data-act="confirm"]').boundingBox();
    await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await goTo(page, '/channels/4001/5002');
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.modal-layer').dataset.open === 'false', null, { timeout: 1000 });
    await page.waitForTimeout(900); // past the hold's 850 ms
    await page.mouse.up();
    await nameIs(page, 'art-share');
    await untilStatus(page, /^Moved chats~ nothing purged$/);
    assert(await tone(page) === 'calm', `tone ${await tone(page)}`);
    await page.waitForTimeout(600);
    assert(!(await isOpen(page)) && stats.deleteAttempts === 0, `dialog ${await isOpen(page)}, ${stats.deleteAttempts} DELETEs`);
    assert(await focusedAct(page) === 'purify', `focus went back to Purify: ${await focusedAct(page)}`);
    assert(await statusText(page) === 'Moved chats~ nothing purged', `the note stays once the new chat is read: ${await statusText(page)}`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    // Many chats' dialog lists its chats by name: it isn't about the chat on screen, so it stays.
    const { page, stats, context } = await boot('/channels/4001/5001');
    await pickBatch(page, ['c:3003']);
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await goTo(page, '/channels/4001/5002');
    await page.waitForTimeout(800);
    assert(await isOpen(page), 'the Many chats dialog closed on a chat switch');
    assert(stats.deleteAttempts === 0, 'nothing deleted');
    await context.close();
  }
});

await test('T174 a chat switch shows the new chat at once: a dim, never "finding this chat…", and no stray Purify', async () => {
  const { page, stats, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 100 });
  await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    window.__seen = { lookup: 0, dimmed: 0, named: 0 };
    const t0 = performance.now();
    const look = () => {
      if (r.querySelector('.hero').dataset.state === 'lookup' || r.querySelector('[data-role="target-name"]').textContent === 'finding this chat…') window.__seen.lookup++;
      if (r.querySelector('[data-role="layer"]').hasAttribute('data-switching')) window.__seen.dimmed++;
      if (!window.__seen.named && window.__clicked && r.querySelector('[data-role="target-name"]').textContent === 'art-share') window.__seen.named = performance.now() - window.__clicked;
      if (performance.now() - t0 < 2500) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  const s0 = stats.searches;
  const purify = await page.locator('[data-act="purify"]').boundingBox();
  const link = await page.locator('a[href="/channels/4001/5002"]').boundingBox();
  await page.mouse.move(link.x + 10, link.y + link.height / 2);
  await page.evaluate(() => { window.__clicked = performance.now(); });
  await page.mouse.click(link.x + 10, link.y + link.height / 2);
  // A Purify click 50 ms into the switch lands on a card that isn't ready yet: it does nothing.
  await page.waitForTimeout(50);
  await page.mouse.click(purify.x + purify.width / 2, purify.y + purify.height / 2);
  await page.waitForTimeout(2600);
  const seen = await page.evaluate(() => window.__seen);
  assert(seen.named > 0 && seen.named < 400, `the card named art-share after ${Math.round(seen.named)} ms`);
  assert(seen.lookup === 0, `"finding this chat…" showed in ${seen.lookup} frames`);
  assert(seen.dimmed > 0, 'the last chat never dimmed while the new one was read');
  assert(!(await isOpen(page)) && stats.searches === s0, `the early click opened a dialog (${await isOpen(page)}) or searched (${stats.searches - s0})`);
  assert(await inPanel(page, (r) => !r.querySelector('[data-role="layer"]').hasAttribute('data-switching')), 'the dim lifts once the chat is read');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T175 minimised, the panel asks Discord nothing as you move between chats, and catches up when it opens', async () => {
  const { page, stats, pageErrors, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="minimize"]');
  await page.locator('.orb').waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
  const l0 = stats.log.length;
  for (const p of ['/channels/4001/5002', '/channels/@me/3002', '/channels/4001/5003']) {
    await goTo(page, p);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  const asked = stats.log.slice(l0);
  assert(asked.length === 0, `minimised, it asked ${JSON.stringify(asked)}`);
  await page.click('.orb');
  await nameIs(page, 'announcements');
  const s0 = stats.searches;
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 4000 });
  assert(await text(page, '.pill-name') === 'announcements' && /all 5 of your messages/.test(await text(page, '.modal-lead')), `the dialog asks about ${await text(page, '.pill-name')}: ${await text(page, '.modal-lead')}`);
  assert(stats.searches - s0 === 1, `Purify counted with ${stats.searches - s0} searches`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T176 one purge at a time: another tab says so, asks Discord nothing, and still counts', async () => {
  const paced = withTiming(source, { deleteDelayMs: 150 });
  const { context, open } = await sharedProfile();
  const a = await open('/channels/4001/5001', paced);
  const b = await open('/channels/4001/5002', paced);
  // B's dialog is up before A starts; A's run wins, and B's hold starts nothing.
  await b.page.click('[data-act="purify"]');
  await b.page.waitForSelector('.modal-layer[data-open="true"]');
  await a.page.click('[data-act="purify"]');
  await holdConfirm(a.page);
  await untilCount(a.page, 2);
  const b0 = { searches: b.stats.searches, deletes: b.stats.deleteAttempts };
  await holdConfirm(b.page);
  const line = 'Purifying in another Discord tab~ one at a time keeps your account safe';
  await untilStatus(b.page, new RegExp(`^${line}$`));
  assert(await tone(b.page) === 'calm' && await focusedAct(b.page) === 'purify', `B after its hold: ${await tone(b.page)}, focus ${await focusedAct(b.page)}`);
  await b.page.waitForTimeout(500);
  assert(b.stats.deleteAttempts === b0.deletes && await inPanel(b.page, (r) => r.querySelector('[data-role="layer"]').dataset.run) === 'idle', 'B started a run');
  // Purify again in B: no count, no dialog, the same line.
  await b.page.click('[data-act="scan"]'); // Count stays free: it is only a look
  await untilStatus(b.page, /^10 messages found/);
  const s1 = b.stats.searches;
  await b.page.click('[data-act="purify"]');
  await untilStatus(b.page, new RegExp(`^${line}$`));
  await b.page.waitForTimeout(400);
  assert(!(await isOpen(b.page)) && b.stats.searches === s1 && b.stats.deleteAttempts === b0.deletes, `B asked ${b.stats.searches - s1} searches or opened a dialog`);
  // It claims only what it knows: another tab of this browser, nothing about other browsers or devices.
  assert(!/browser|device|app|window|anywhere|computer/i.test(line), 'the line overclaims');
  // Once A is done, B purifies.
  await a.page.click('[data-act="stop"]');
  await waitEnd(a.page, 5000);
  await b.page.click('[data-act="purify"]');
  await b.page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 3000 });
  assert(/all 10 of your messages/.test(await text(b.page, '.modal-lead')), `B's dialog: ${await text(b.page, '.modal-lead')}`);
  await context.close();
});

await test('T177 a BetterDiscord update waits for the purge to finish, then asks again', async () => {
  const plugin = withTiming(fs.readFileSync(PLUGIN, 'utf8'), { deleteDelayMs: 120 });
  const newer = plugin.replace(/(@version\s+)\S+/, (_, head) => `${head}99.0.0`);
  const env = await openDiscord(browser, '/channels/4001/5002');
  const { page, world } = env;
  await page.evaluate(({ code, newer }) => {
    const log = window.__bdLog = { modals: [], writes: [], toasts: [] };
    const parts = (v) => v.split('.').map(Number);
    window.BdApi = {
      Net: { fetch: async () => new Response(newer, { status: 200 }) },
      Utils: { semverCompare(current, remote) {
        const [x, y] = [parts(current), parts(remote)];
        for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] > x[i] ? 1 : -1;
        return 0;
      } },
      UI: {
        showConfirmationModal(title, content, options) { log.modals.push(content); window.__bdConfirm = options.onConfirm; },
        showToast(text) { log.toasts.push(text); },
      },
      Plugins: { folder: '/bd/plugins' },
    };
    window.__bdDisk = code;
    const fsStub = { readFileSync: () => window.__bdDisk, writeFileSync(file, data) { log.writes.push(file); window.__bdDisk = data; } };
    const require = (m) => ({ fs: fsStub, path: { join: (...p) => p.join('/') } })[m];
    const module = { exports: {} };
    new Function('require', 'module', 'exports', code)(require, module, module.exports);
    window.__bd = new module.exports({ name: 'DopasPurifier', filename: 'DopasPurifier.plugin.js' });
    window.__bd.start();
  }, { code: plugin, newer });
  await settled(page);
  await page.waitForFunction(() => window.__bdLog.modals.length === 1);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilCount(page, 2);
  await page.evaluate(() => window.__bdConfirm()); // Update, mid-purge
  let log = await page.evaluate(() => window.__bdLog);
  assert(log.writes.length === 0 && log.toasts.join() === 'Updating once purifying is done~ ♡' && log.modals.length === 1, `mid-purge: ${JSON.stringify(log)}`);
  await waitEnd(page);
  await page.waitForFunction(() => window.__bdLog.modals.length === 2, null, { timeout: 3000 });
  log = await page.evaluate(() => window.__bdLog);
  assert(log.modals[1] === 'All done purifying~ v99.0.0 is ready. Update now? ♡' && log.writes.length === 0, `after the purge: ${JSON.stringify(log.modals)}`);
  assert(mine(world, '5002').length === 0 && /^All clean~/.test(await text(page, '[data-role="readout-line"]')), 'the purge finished and its verdict is on screen');
  await page.evaluate(() => window.__bdConfirm()); // idle now: Update writes as it always has
  log = await page.evaluate(() => window.__bdLog);
  assert(log.writes.length === 1 && log.writes[0] === '/bd/plugins/DopasPurifier.plugin.js', `idle update wrote ${JSON.stringify(log.writes)}`);
  assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
  await env.context.close();
});

await test('T178 a 75 s drop mid-#general is waited out: all clean, nothing failed or skipped', async () => {
  const { page, cfg, stats, world, pageErrors, context } = await boot('/channels/4001/5001', { clock: true });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilCount(page, 5);
  const said = await sitOut(page, { away: 75000, line: /^Connection hiccup~ retrying in (\d+)s$/, down: () => { cfg.offline = true; }, up: () => { cfg.offline = false; } });
  assert(said.join() === '2,4,8,30,30,30', `the run waited ${said.join(', ')} s`);
  await waitEnd(page, 15000);
  assert(stats.refused >= 6 && mine(world, '5001').length === 0, `${stats.refused} refused, ${mine(world, '5001').length} left`);
  assert(/^All clean~/.test(await text(page, '[data-role="readout-line"]')), `verdict ${await text(page, '[data-role="readout-line"]')}`);
  assert(await text(page, '[data-role="tf-failed"]') === '000' && !/skipped|wouldn't go/.test(await status(page)), `footer ${await status(page)}`);
  const took = /^Done in (\d+)s/.exec(await status(page));
  assert(took && Number(took[1]) < 60, `the time leaves the outage out: ${await status(page)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T179 Discord answering 502 for 30 s is waited out: nothing counts as failed', async () => {
  const { page, cfg, world, pageErrors, context } = await boot('/channels/4001/5001', { clock: true });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilCount(page, 3);
  const said = await sitOut(page, { away: 30000, line: /^Discord is busy~ retrying in (\d+)s$/, down: () => { cfg.serverError = 502; }, up: () => { cfg.serverError = 0; } });
  assert(said.join() === '2,4,8,30', `the run waited ${said.join(', ')} s`);
  await waitEnd(page, 15000);
  assert(mine(world, '5001').length === 0 && await text(page, '[data-role="tf-failed"]') === '000', `${mine(world, '5001').length} left, failed ${await text(page, '[data-role="tf-failed"]')}`);
  assert(/^All clean~/.test(await text(page, '[data-role="readout-line"]')) && !/FAILED/.test(await logText(page)), 'no crimson failures for Discord\'s outage');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T180 back online, the run carries on at once; offline it says so calmly, with no countdown', async () => {
  const { page, cfg, world, pageErrors, context } = await boot('/channels/4001/5001', { clock: true });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilCount(page, 5);
  const offlineLines = () => inPanel(page, (r) => [...r.querySelectorAll('.term-body .line-msg')].filter((l) => /^Offline~/.test(l.textContent)).length);
  cfg.offline = true;
  await context.setOffline(true);
  await untilStatus(page, /^Connection hiccup~ retrying in 2s$/, 4000); // a blip first
  await page.clock.fastForward(2000);
  await untilStatus(page, /^Connection hiccup~ retrying in 4s$/, 4000);
  await page.clock.fastForward(4000);
  await untilStatus(page, /^Offline~ purifying carries on once you're back$/, 4000); // the third miss: the browser knows
  assert(await tone(page) === 'calm', `offline tone ${await tone(page)}`);
  await page.waitForTimeout(1200);
  assert(await statusText(page) === "Offline~ purifying carries on once you're back", `no countdown: ${await statusText(page)}`);
  await page.clock.fastForward(9000); // 15 s gone: into the 30 s wait
  for (let i = 0; i < 40 && (await offlineLines()) < 2; i++) await page.waitForTimeout(50);
  assert(await offlineLines() >= 2, 'the run is sitting in its 30 s wait');
  const t0 = Date.now();
  cfg.offline = false;
  await context.setOffline(false); // the browser says "online": the wait ends there
  await waitEnd(page, 3000).catch(() => { throw new Error('the run waited out its 30 s instead of carrying on when the browser came back'); });
  assert(Date.now() - t0 < 3000 && mine(world, '5001').length === 0, `finished ${Date.now() - t0} ms after online, ${mine(world, '5001').length} left`);
  assert(/^All clean~/.test(await text(page, '[data-role="readout-line"]')), `verdict ${await text(page, '[data-role="readout-line"]')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T181 a batch offline for 75 s in chat 2 skips nothing: chats 2 and 3 finish', async () => {
  const { page, cfg, world, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 120, clock: true });
  await pickBatch(page, ['c:3004', 'c:3003', 'c:5002']);
  await inPanel(page, (r) => {
    window.__crossed = 0;
    new MutationObserver(() => { if (r.querySelector('.run-pill-error')) window.__crossed++; }).observe(r.querySelector('.body'), { subtree: true, childList: true });
  });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilStatus(page, /^Chat 2 of 3/, 10000);
  await untilCount(page, 5);
  await sitOut(page, { away: 75000, line: /^Connection hiccup~ retrying in (\d+)s$/, down: () => { cfg.offline = true; }, up: () => { cfg.offline = false; } });
  await waitEnd(page, 20000);
  const pills = await inPanel(page, (r) => ['c:3004', 'c:3003', 'c:5002'].map((k) => r.querySelector(`[data-key="${k}"]`).dataset.state));
  assert(pills.join() === 'done,done,done', `rows ${pills}`);
  assert(await page.evaluate(() => window.__crossed) === 0, 'a chat was marked ✗ while offline');
  assert(mine(world, '3003').length === 0 && mine(world, '5002').length === 0, 'chats 2 and 3 purged');
  assert(!/skipped/.test(await status(page)), `footer ${await status(page)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T182 a DELETE Discord keeps failing ends the run, not the chat, and a later Purify finishes it', async () => {
  const { page, cfg, stats, world, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 20, timing: { waitUnitMs: 2 } });
  await pickBatch(page, ['c:5002', 'c:3003']);
  cfg.serverError = 500;
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 10000);
  assert(stats.refused === 8, `one message tried ${stats.refused} times (once, then after each of the 7 waits)`);
  assert(!stats.log.some((l) => /\/channels\/3003\//.test(l)), 'the run went on to the next chat');
  assert(await status(page) === 'Discord is having a moment' && await tone(page) === 'error', `footer ${await status(page)} (${await tone(page)})`);
  assert(await text(page, '[data-role="hero-sub"]') === 'Discord is busy~ press Purify in a minute' && await text(page, '[data-role="readout-line"]') === 'Discord is having a moment~ try again in a minute', `verdict ${await text(page, '[data-role="hero-sub"]')}`);
  assert(await text(page, '[data-role="tf-failed"]') === '000' && /STOPPED · Discord is having a moment/.test(await logText(page)), 'Discord\'s trouble is no failure of yours');
  const rows = await inPanel(page, (r) => ['c:5002', 'c:3003'].map((k) => r.querySelector(`[data-key="${k}"]`).dataset.state));
  assert(rows.join() === 'stopped,stopped' && (await ticked(page, ['c:5002', 'c:3003'])).every(Boolean), `rows ${rows}, both still ticked`);
  cfg.serverError = 0;
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await holdConfirm(page);
  await waitEnd(page, 15000);
  assert(mine(world, '5002').length === 0 && mine(world, '3003').length === 0, 'the next Purify finished both');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T183 waits read as minutes past a minute; offline and searching have no countdown', async () => {
  const { page, pageErrors, context } = await bootProbe('/channels/4001/5001', ['waitText', 'showWait']);
  const said = await page.evaluate(() => [
    { kind: 'rate', seconds: 120 }, { kind: 'rate', seconds: 59 }, { kind: 'rate', seconds: 60 }, { kind: 'network', seconds: 30 },
    { kind: 'server', seconds: 300 }, { kind: 'index', seconds: 2 }, { kind: 'offline', seconds: 30 },
  ].map((w) => window.__dp.waitText(w)));
  assert(JSON.stringify(said) === JSON.stringify([
    'Taking a breather~ back in about 2 min', 'Taking a breather~ back in 59s', 'Taking a breather~ back in about 1 min', 'Connection hiccup~ retrying in 30s',
    'Discord is busy~ retrying in about 5 min', 'Discord is still searching~ hang on…', "Offline~ purifying carries on once you're back",
  ]), JSON.stringify(said));
  await page.evaluate(() => window.__dp.showWait({ kind: 'rate', seconds: 120 }));
  const shown = await statusParts(page);
  assert(shown.words === 'Taking a breather~ back in about 2 min' && shown.flair === ' 🦇' && shown.tone === 'calm', JSON.stringify(shown));
  await page.evaluate(() => window.__dp.showWait({ kind: 'offline', seconds: 30 }));
  await page.waitForTimeout(1300);
  const off = await statusParts(page);
  assert(off.words === "Offline~ purifying carries on once you're back" && !off.flair && off.tone === 'calm', `offline ${JSON.stringify(off)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T184 a reload during "Chat 2 of 3" keeps the place: chats 2 and 3 stay ticked, and nothing starts', async () => {
  const paced = withTiming(source, { deleteDelayMs: 150 });
  const { page, stats, world, pageErrors, context } = await bootWith(paced, '/channels/4001/5001');
  await pickBatch(page, ['c:3004', 'c:3002', 'c:3003']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilStatus(page, /^Chat 2 of 3/, 10000);
  await untilCount(page, 5);
  // The journal holds ids, never a name or a message.
  const j = await storedJournal(page);
  assert(j && j.mode === 'batch' && j.state === 'running' && j.user === '1000' && JSON.stringify(j.keys) === '["c:3002","c:3003"]', `journal ${JSON.stringify(j)}`);
  assert(Object.keys(j).sort().join() === 'at,guilds,keys,mode,state,user,v' && !/Alice|Carol|mallory|message/i.test(JSON.stringify(j)), `journal keeps more than ids: ${JSON.stringify(j)}`);
  await reboot(page, paced, false);
  const l0 = stats.log.length;
  const d0 = stats.deleteAttempts;
  await untilStatus(page, /^2 chats left from last time~ Purify selected finishes them$/, 5000);
  assert(await tone(page) === 'info', `tone ${await tone(page)}`);
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="tab-badge"]').textContent === '2', null, { timeout: 5000 });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  const picks = await ticked(page, ['c:3004', 'c:3002', 'c:3003']);
  assert(picks.join() === 'false,true,true', `ticks after the reload ${picks}`);
  assert(mine(world, '3004').every((m) => m.type !== 0), 'chat 1 finished before the reload (its system message stays)');
  await page.waitForTimeout(500);
  const asked = stats.log.slice(l0).filter((l) => /messages\/search|^DELETE/.test(l));
  assert(!asked.length && stats.deleteAttempts === d0, `before any press it sent ${JSON.stringify(asked)}`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(await text(page, '[data-role="modal-title"]') === 'Purify 2 chats?' && await page.locator('.modal-item').count() === 2, `dialog ${await text(page, '[data-role="modal-title"]')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T185 a journal from another account restores nothing, and goes', async () => {
  const env = await openDiscord(browser, '/channels/4001/5001');
  await plantJournal(env.page, { v: 1, user: '1001', mode: 'batch', at: Date.now() - HOUR, state: 'running', keys: ['c:3002', 'c:3003'], guilds: [] });
  await injectUserscript(env.page, source);
  await settled(env.page);
  await env.page.waitForTimeout(800);
  assert(await statusText(env.page) === 'Ready to purify~ ✨' && await badge(env.page) === '', `footer ${await statusText(env.page)}, badge ${await badge(env.page)}`);
  assert(await storedJournal(env.page) === null, 'the other account\'s journal is still there');
  assert(!env.stats.log.some((l) => /relationships|\/users\/@me\/channels/.test(l)), 'lists loaded for nothing');
  await env.context.close();
});

await test('T186 a journal over a day old restores nothing', async () => {
  for (const age of [8 * 24 * HOUR, 25 * HOUR]) {
    const env = await openDiscord(browser, '/channels/4001/5001');
    await plantJournal(env.page, { v: 1, user: '1000', mode: 'batch', at: Date.now() - age, state: 'running', keys: ['c:3002', 'c:3003'], guilds: [] });
    await injectUserscript(env.page, source);
    await settled(env.page);
    await env.page.waitForTimeout(800);
    assert(await statusText(env.page) === 'Ready to purify~ ✨' && await badge(env.page) === '', `${age / HOUR} h: footer ${await statusText(env.page)}, badge ${await badge(env.page)}`);
    assert(await storedJournal(env.page) === null, `${age / HOUR} h: the old journal stayed`);
    await env.context.close();
  }
});

await test('T187 a tab opened while another purges shows nothing left from last time', async () => {
  const paced = withTiming(source, { deleteDelayMs: 150 });
  for (const mode of ['batch', 'current']) {
    const { context, open } = await sharedProfile();
    const a = await open('/channels/4001/5001', paced);
    if (mode === 'batch') await pickBatch(a.page, ['c:3002', 'c:3003']);
    await a.page.click('[data-act="purify"]');
    await holdConfirm(a.page);
    await untilCount(a.page, 2);
    const b = await open(mode === 'batch' ? '/channels/4001/5002' : '/channels/4001/5001', paced);
    await b.page.waitForTimeout(1000);
    assert(await statusText(b.page) === 'Ready to purify~ ✨' && await badge(b.page) === '', `${mode}: B says ${await statusText(b.page)}, badge ${await badge(b.page)}`);
    assert((await storedJournal(b.page))?.state === 'running', `${mode}: A's journal was touched`);
    await a.page.click('[data-act="stop"]');
    await waitEnd(a.page, 5000);
    await context.close();
  }
});

await test('T188 a reload mid-#general says where to pick up, and Purify counts what is left first', async () => {
  const paced = withTiming(source, { deleteDelayMs: 150 });
  {
    // No index lag, so the count after the reload is exactly what is left.
    const { page, stats, world, pageErrors, context } = await bootWith(paced, '/channels/4001/5001', { indexLag: 0 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await untilCount(page, 5);
    const j = await storedJournal(page);
    assert(j && j.mode === 'current' && j.chat.id === '5001' && Object.keys(j).sort().join() === 'at,chat,mode,state,user,v', `journal ${JSON.stringify(j)}`);
    await reboot(page, paced, false);
    await untilStatus(page, /^Cut short last time~ Purify picks up the rest$/, 5000);
    assert(await tone(page) === 'info' && await heroIs(page) === 'unscanned/icon', `${await tone(page)}, ring ${await heroIs(page)}`);
    const left = mine(world, '5001').length;
    const s0 = stats.searches;
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    assert(await text(page, '.modal-lead') === `This will delete all ${left} of your messages, threads included, in` && stats.searches - s0 === 1, `counted first: ${await text(page, '.modal-lead')}`);
    await page.click('[data-act="cancel"]');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    // Opened on another chat: the note says where, and says it again on arriving there.
    const env = await openDiscord(browser, '/channels/4001/5002');
    await plantJournal(env.page, { v: 1, user: '1000', mode: 'current', at: Date.now() - HOUR, state: 'running', chat: { id: '5001' } });
    await injectUserscript(env.page, source);
    await settled(env.page);
    await untilStatus(env.page, /^Cut short last time in a chat~ open it and press Purify$/, 5000);
    await goTo(env.page, '/channels/4001/5001');
    await nameIs(env.page, 'general');
    await untilStatus(env.page, /^Cut short last time~ Purify picks up the rest$/);
    await goTo(env.page, '/channels/4001/5002');
    await nameIs(env.page, 'art-share');
    await untilStatus(env.page, /^Ready to purify~/);
    await env.context.close();
  }
});

await test('T189 back on a chat purged clean, new messages show: it counts again instead of resting on "all clean"', async () => {
  const { page, world, pageErrors, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(/^All clean~/.test(await text(page, '[data-role="readout-line"]')) && await page.locator('[data-act="purify"]').isDisabled(), 'a clean finish rests');
  addMine(world, '5002', 3);
  await goTo(page, '/channels/4001/5001');
  await nameIs(page, 'general');
  await goTo(page, '/channels/4001/5002');
  await nameIs(page, 'art-share');
  await page.waitForTimeout(200);
  assert(await heroIs(page) === 'unscanned/icon', `the ring after coming back: ${await heroIs(page)}`);
  assert(await page.locator('[data-act="purify"]').isEnabled() && await statusText(page) === 'Ready to purify~ ✨', `Purify ${await page.locator('[data-act="purify"]').isEnabled()}, footer ${await statusText(page)}`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(await text(page, '.modal-lead') === 'This will delete all 3 of your messages, threads included, in', `dialog ${await text(page, '.modal-lead')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T190 the panel boots once Discord is idle, reads storage once, and fades in placed', async () => {
  for (const motion of ['no-preference', 'reduce']) {
    const env = await openDiscord(browser, '/channels/4001/5001', { reducedMotion: motion });
    const { page } = env;
    await page.evaluate(() => {
      window.__frames = [];
      window.__iframes = 0;
      const add = Node.prototype.appendChild;
      Node.prototype.appendChild = function (n) { if (n && n.tagName === 'IFRAME' && !window.__booted) window.__iframes++; return add.call(this, n); };
      const log = console.log;
      console.log = (...a) => { if (/ready~/.test(String(a[0]))) window.__booted = true; return log.apply(console, a); };
      new MutationObserver((list, obs) => {
        const host = document.querySelector('#dopa-purifier-host');
        if (!host) return;
        obs.disconnect();
        requestAnimationFrame(() => {
          const panel = host.shadowRoot.querySelector('.panel');
          const a = panel.getAnimations()[0];
          window.__frames.push({ opacity: Number(getComputedStyle(panel).opacity), moves: !!a && a.effect.getKeyframes().some((k) => k.transform && k.transform !== 'none') });
        });
      }).observe(document.body, { childList: true });
    });
    // The script returns before the panel exists: boot waits for an idle moment.
    const early = await page.evaluate((src) => { (0, eval)(src); return !!document.querySelector('#dopa-purifier-host'); }, withTiming(source));
    assert(!early, `${motion}: the panel booted inside the script's own task`);
    await page.waitForSelector('#dopa-purifier-host', { state: 'attached', timeout: 5000 });
    await settled(page);
    const seen = await page.evaluate(() => ({ frames: window.__frames, iframes: window.__iframes }));
    assert(seen.frames.length === 1 && seen.frames[0].opacity < 1, `${motion}: first frame ${JSON.stringify(seen.frames)}`);
    assert(seen.frames[0].moves === (motion === 'no-preference'), `${motion}: the entrance ${seen.frames[0].moves ? 'moves' : 'only fades'}`);
    assert(seen.iframes === 2, `${motion}: boot opened ${seen.iframes} storage frames (prefs, shields and journal in one; the login token in the other)`);
    assert(env.pageErrors.length === 0, `${motion}: page errors: ${env.pageErrors.join('; ')}`);
    await env.context.close();
  }
  // A BetterDiscord stop() right after start() leaves nothing behind, and never boots later.
  const env = await openDiscord(browser, '/channels/4001/5001');
  const plugin = fs.readFileSync(PLUGIN, 'utf8');
  await env.page.evaluate((code) => {
    const module = { exports: {} };
    new Function('module', 'exports', code)(module, module.exports);
    const bd = new module.exports();
    bd.start();
    bd.stop();
  }, plugin);
  await env.page.waitForTimeout(1600);
  assert(await env.page.evaluate(() => !document.querySelector('#dopa-purifier-host') && !window.__dopaPurifier), 'a stopped plugin still booted');
  assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
  await env.context.close();
});

await test('T255 a purge never touches what you send after you confirm', async () => {
  {
    const { page, stats, world, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 60 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^40 messages found/);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await untilCount(page, 3);
    const [sent] = addMine(world, '5001', 1, { content: () => 'sent while purifying' });
    await waitEnd(page);
    assert(world.messages['5001'].some((m) => m.id === sent.id) && !stats.deletes.includes(sent.id), 'the message sent mid-run was deleted');
    assert(await text(page, '[data-role="pct"]') === '40 of 40' && await countNow(page) === 40, `finish ${await text(page, '[data-role="pct"]')}`);
    assert(mine(world, '5001').length === 1 && /SUMMARY: 40 purged, 0 failed(?!, )/.test(await logText(page)), 'the summary counts it as neither gone nor skipped');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    // A DM's history walk sees the new message too, and leaves it.
    const { page, stats, world, context } = await bootPaced('/channels/4001/5001', { deleteMs: 60 });
    await pickBatch(page, ['c:3003']);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await untilCount(page, 2);
    const [sent] = addMine(world, '3003', 1);
    await waitEnd(page);
    assert(!stats.deletes.includes(sent.id) && mine(world, '3003').length === 1, 'the new DM message was deleted');
    assert(await text(page, '[data-key="c:3003"] .run-pill') === 'purged 7', `row ${await text(page, '[data-key="c:3003"] .run-pill')}`);
    await context.close();
  }
});

await test('T287 the cut-off is Discord\'s clock: a PC a minute fast spares what you send, an hour slow still takes what you sent', async () => {
  {
    // The PC is a minute fast: a message sent mid-run is still newer than the cut-off, and stays.
    const { page, stats, world, context } = await bootPaced('/channels/4001/5001', { deleteMs: 60, serverDate: true, pageClockMs: 60000 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^40 messages found/);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await untilCount(page, 3);
    const [sent] = addMine(world, '5001', 1, { content: () => 'sent while purifying' });
    await waitEnd(page);
    assert(!stats.deletes.includes(sent.id) && mine(world, '5001').length === 1, 'a fast PC clock purged the message sent mid-run');
    assert(await text(page, '[data-role="pct"]') === '40 of 40', `fast finish ${await text(page, '[data-role="pct"]')}`);
    await context.close();
  }
  {
    // The PC is an hour slow, and three of yours went out ten minutes ago: they go with the rest.
    const world = buildWorld();
    addMine(world, '5001', 3, { at: Date.now() - 10 * 60000 });
    const { page, stats, context } = await bootPaced('/channels/4001/5001', { world, deleteMs: 60, serverDate: true, pageClockMs: -3600000 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^43 messages found/);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    assert(stats.deletes.length === 43 && mine(world, '5001').length === 0, `a slow PC clock left ${mine(world, '5001').length} of yours`);
    assert(/^All clean~/.test(await text(page, '[data-role="readout-line"]')) && await text(page, '[data-role="pct"]') === '43 of 43', `slow finish ${await text(page, '[data-role="pct"]')}`);
    await context.close();
  }
});

await test('T256 a deliberate Stop brings back only the ticks; the panel going away reads as cut short', async () => {
  const paced = withTiming(source, { deleteDelayMs: 150 });
  {
    const { page, context } = await bootWith(paced, '/channels/4001/5001');
    await pickBatch(page, ['c:3002', 'c:3003']);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await untilCount(page, 3);
    await page.click('[data-act="stop"]');
    await waitEnd(page, 5000);
    assert((await storedJournal(page))?.state === 'stopped', `journal after Stop ${JSON.stringify(await storedJournal(page))}`);
    await reboot(page, paced, false);
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="tab-badge"]').textContent === '2', null, { timeout: 5000 });
    await page.waitForTimeout(300);
    assert(await statusText(page) === 'Ready to purify~ ✨', `a Stop nudges: ${await statusText(page)}`);
    // Unticking them all lets the journal go.
    await page.click('.tab[data-tab="batch"]');
    await page.click('[data-act="dm-none"]');
    assert(await storedJournal(page) === null, 'the journal outlived every restored tick');
    await context.close();
  }
  {
    const { page, context } = await bootWith(paced, '/channels/4001/5001');
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await untilCount(page, 3);
    await page.click('[data-act="stop"]');
    await waitEnd(page, 5000);
    assert(await storedJournal(page) === null, 'This chat\'s Stop left a journal');
    await reboot(page, paced, false);
    await page.waitForTimeout(800);
    assert(await statusText(page) === 'Ready to purify~ ✨', `This chat after a Stop: ${await statusText(page)}`);
    await context.close();
  }
  {
    // BetterDiscord reloading the plugin mid-purge (an update, a disable) is not a Stop.
    const plugin = withTiming(fs.readFileSync(PLUGIN, 'utf8'), { deleteDelayMs: 150 });
    const env = await openDiscord(browser, '/channels/4001/5001');
    const { page } = env;
    await page.evaluate((code) => {
      const module = { exports: {} };
      new Function('module', 'exports', code)(module, module.exports);
      window.__bd = new module.exports();
      window.__bd.start();
    }, plugin);
    await settled(page);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await untilCount(page, 3);
    await page.evaluate(() => window.__bd.stop());
    await page.waitForTimeout(500);
    assert((await storedJournal(page))?.state === 'running', `journal after the plugin went: ${JSON.stringify(await storedJournal(page))}`);
    await page.evaluate(() => window.__bd.start());
    await settled(page);
    await untilStatus(page, /^Cut short last time~ Purify picks up the rest$/, 5000);
    assert(env.pageErrors.length === 0, `page errors: ${env.pageErrors.join('; ')}`);
    await env.context.close();
  }
});

await test('T257 the journal keeps ids only and lasts a day', async () => {
  const env = await openDiscord(browser, '/channels/4001/5001');
  await plantJournal(env.page, { v: 1, user: '1000', mode: 'batch', at: Date.now() - 23 * HOUR, state: 'running', keys: ['c:3002', 'c:5002'], guilds: ['4001'] });
  await injectUserscript(env.page, source);
  await settled(env.page);
  await untilStatus(env.page, /^2 chats left from last time~ Purify selected finishes them$/, 5000);
  // The server holding a restored channel opens by itself, so that tick is in view.
  await env.page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="tab-badge"]').textContent === '2', null, { timeout: 5000 });
  await env.page.click('.tab[data-tab="batch"]');
  assert((await ticked(env.page, ['c:3002', 'c:5002'])).every(Boolean), 'restored ticks');
  assert(await env.page.locator('.guild[data-guild-id="4001"] .guild-head[aria-expanded="true"]').count() === 1, 'the server with a restored channel is open');
  await env.context.close();
});

await test('T258 a verdict lasts its visit even when you move while minimised, and Count\'s "all clear" stays', async () => {
  {
    const { page, pageErrors, context } = await boot('/channels/4001/5002');
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await page.click('[data-act="minimize"]');
    await page.locator('.orb').waitFor({ state: 'visible' });
    await goTo(page, '/channels/4001/5001');
    await page.waitForTimeout(300);
    await goTo(page, '/channels/4001/5002');
    await page.waitForTimeout(300);
    await page.click('.orb');
    await page.waitForTimeout(600);
    assert(await heroIs(page) === 'unscanned/icon' && await page.locator('[data-act="purify"]').isEnabled(), `back on art-share: ${await heroIs(page)}`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    // Count's own "all clear" isn't a verdict a visit can stale: browsing past it keeps it.
    const { page, context } = await boot('/channels/4001/5001');
    await pickBatch(page, ['c:5004']);
    await page.click('[data-act="scan"]');
    await untilStatus(page, /^All clear~/);
    assert(await heroIs(page) === 'clear/count', `after Count ${await heroIs(page)}`);
    await goTo(page, '/channels/4001/5004');
    await page.waitForTimeout(500);
    await goTo(page, '/channels/4001/5001');
    await page.waitForTimeout(500);
    assert(await heroIs(page) === 'clear/count' && /all clear/.test(await text(page, '[data-key="c:5004"] .row-meta')), `after visiting it: ${await heroIs(page)}`);
    await context.close();
  }
});

await test('T259 a 429 that names no wait backs off further from the third, up to 10 minutes, and resets', async () => {
  const { page, pageErrors, context } = await bootPaced('/channels/4001/5002', { deleteMs: 20, timing: { waitUnitMs: 1 }, probe: ['on'] });
  let n = 0;
  await page.route(/\/api\/v9\/channels\/5002\/messages\/\d+$/, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    n++;
    // Ten bare 429s for the first message, then one more for the third.
    if (n <= 10 || n === 13) return route.fulfill({ status: 429, contentType: 'text/html', body: '<html>slow down</html>' });
    return route.fallback();
  });
  await page.evaluate(() => { window.__waits = []; window.__dp.on('wait', (w) => window.__waits.push(w.seconds)); });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 20000);
  const waits = await page.evaluate(() => window.__waits);
  assert(waits.join() === '5,5,10,20,40,80,160,320,600,600,5', `waits ${waits.join(', ')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// ---- WP-I (4.2) ----
// Confirm, sound and motion (D45-D50, amendments I1-I2).

const R = "document.querySelector('#dopa-purifier-host').shadowRoot";

// The page's audio, instrumented: every context that decodes, every decode, every source started and
// ended, every gain and every ramp. short: play only the last `short` seconds of each source, so a test
// sees the sound end without waiting out its 6.6 s (the file is untouched; this only seeks into it).
const instrumentAudio = (page, { short = 0 } = {}) => page.evaluate((cut) => {
  const a = { made: [], decodes: [], starts: [], ended: 0, ramps: [], gains: [], short: cut };
  window.__audio = a;
  const proto = BaseAudioContext.prototype;
  const decode = proto.decodeAudioData;
  proto.decodeAudioData = function (...args) { a.decodes.push(performance.now()); if (!a.made.includes(this)) a.made.push(this); return decode.apply(this, args); };
  const gain = proto.createGain;
  proto.createGain = function (...args) { const g = gain.apply(this, args); a.gains.push(g); return g; };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0) {
    a.starts.push({ at: performance.now(), state: this.context.state });
    this.addEventListener('ended', () => { a.ended++; });
    return a.short ? start.call(this, when, Math.max(0, this.buffer.duration - a.short)) : start.call(this, when);
  };
  const ramp = AudioParam.prototype.linearRampToValueAtTime;
  AudioParam.prototype.linearRampToValueAtTime = function (value, end) {
    a.ramps.push({ value, from: a.made[0] ? a.made[0].currentTime : 0, end });
    return ramp.call(this, value, end);
  };
}, short);
const audio = (page) => page.evaluate(() => {
  const a = window.__audio;
  return { contexts: a.made.length, state: a.made[0] ? a.made[0].state : 'none', decodes: a.decodes, starts: a.starts, ended: a.ended, ramps: a.ramps,
    gain: a.gains.length ? a.gains[a.gains.length - 1].gain.value : null };
});
const pressAt = (page) => page.evaluate((src) => new Promise((done) => {
  eval(src).querySelector('[data-act="confirm"]').addEventListener('pointerdown', () => done(performance.now()), { once: true });
}), R);
const beatsOn = (page, sel) => inPanel(page, (r, s) => r.querySelector(s).getAnimations().map((a) => a.effect.getTiming().delay), sel);
const confettiCount = (page) => inPanel(page, (r) => r.querySelectorAll('.confetti').length);
const setHidden = (page, hidden) => page.evaluate((v) => {
  if (!window.__hiddenPatched) {
    window.__hiddenPatched = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !!window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
  }
  window.__hidden = v;
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);
// The shipped pace (about 1.45 s a message), so the dialog's estimate is the real one.
const realPace = () => withTiming(source, { deleteDelayMs: 1200 });

await test('T219 a long purge says how long it takes and to keep Discord open, at the moment you commit', async () => {
  const { page, context } = await bootWith(realPace(), '/channels/4001/5001', { world: buildWorld({ bulk: { 5001: 3000 } }) });
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/, 8000);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const line = await text(page, '.modal-time');
  assert(line === "About 1h 14m · keep Discord open~ messages you send now aren't touched", `the line: ${line}`);
  const order = await inPanel(page, (r) => [...r.querySelector('[data-role="modal-text"]').children].map((el) => el.className.split(' ')[0]).join());
  assert(order === 'modal-lead,pill,modal-who,modal-time,modal-warn', `where it sits: ${order}`);
  const described = await page.locator('.modal').getAttribute('aria-describedby');
  assert(described === 'dp-modal-lead dp-modal-pill dp-modal-who dp-modal-time dp-modal-warn', `described by ${described}`);
  await page.click('[data-act="cancel"]');
  // A short purge (#art-share's 10, under 2 minutes) has no such line, and isn't described by one.
  await goTo(page, '/channels/4001/5002');
  await nameIs(page, 'art-share');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(await page.locator('.modal-time').count() === 0 && !/dp-modal-time/.test(await page.locator('.modal').getAttribute('aria-describedby')), 'a short purge says nothing of time');
  await page.click('[data-act="cancel"]');
  // Many chats: a friend with no DM yet can't be counted first, so the time is a floor.
  await pickBatch(page, ['c:5001', 'u:2004']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(/^About 1h 14m\+ · keep Discord open~/.test(await text(page, '.modal-time')), `Many chats: ${await text(page, '.modal-time')}`);
  await context.close();
  // At 200 % zoom on a laptop every part of the longest dialog stays on screen (D5).
  for (const viewport of [{ width: 683, height: 384 }, { width: 640, height: 360 }]) {
    const env = await bootWith(realPace(), '/channels/4001/5001', { world: buildWorld({ bulk: { 5001: 3000 } }), viewport });
    await env.page.click('[data-act="scan"]');
    await untilStatus(env.page, /found/, 8000);
    await env.page.click('[data-act="purify"]');
    await env.page.waitForSelector('.modal-layer[data-open="true"]');
    await env.page.waitForTimeout(400);
    for (const sel of ['.modal-title', '.modal-time', '[data-act="cancel"]', '[data-act="confirm"]', '#dp-modal-hint']) {
      const b = await env.page.locator(sel).boundingBox();
      assert(b.y >= 0 && b.y + b.height <= viewport.height && b.x >= 0 && b.x + b.width <= viewport.width, `${viewport.width}×${viewport.height}: ${sel} at ${JSON.stringify(b)}`);
    }
    await env.context.close();
  }
});

await test('T220 the sound is primed while the dialog is read: the commit only starts it, and Never mind leaves it asleep', async () => {
  const { page, context } = await boot('/channels/4001/5002');
  await instrumentAudio(page);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const opened = await page.evaluate(() => performance.now());
  await page.waitForFunction(() => window.__audio.made.length && window.__audio.made[0].state === 'suspended', null, { timeout: 3000 });
  let a = await audio(page);
  assert(a.contexts === 1 && a.decodes.length === 1 && a.decodes[0] - opened < 400 && !a.starts.length, `primed and asleep before the hold ${JSON.stringify({ ...a, opened })}`);
  // Never mind: still asleep, nothing played.
  await page.click('[data-act="cancel"]');
  await page.waitForTimeout(300);
  a = await audio(page);
  assert(a.state === 'suspended' && !a.starts.length, `after Never mind ${JSON.stringify(a)}`);
  // The hold's commit makes no context and decodes nothing: it only starts the primed sound.
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const pressed = pressAt(page);
  await holdConfirm(page);
  await page.waitForFunction(() => window.__audio.starts.length === 1, null, { timeout: 3000 });
  a = await audio(page);
  const down = await pressed;
  assert(a.contexts === 1 && a.decodes.length === 1 && a.decodes[0] < down, `the commit did audio work ${JSON.stringify(a)}`);
  assert(a.starts[0].at - down >= 850 && a.state === 'running', `the sound starts at the commit, awake ${JSON.stringify(a.starts)} ${a.state}`);
  await waitEnd(page);
  // Muted, the dialog primes nothing.
  await page.click('[data-act="mute"]');
  await goTo(page, '/channels/4001/5001');
  await nameIs(page, 'general');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.waitForTimeout(400);
  assert((await audio(page)).decodes.length === 1, 'muted, the dialog decoded again');
  await page.click('[data-act="cancel"]');
  await context.close();
});

await test('T221 the audio engine sleeps once the sound ends, and a second Purify plays its sound in full', async () => {
  {
    const { page, context } = await boot('/channels/4001/5002');
    await instrumentAudio(page, { short: 0.3 });
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => window.__audio.ended === 1, null, { timeout: 5000 });
    await page.waitForFunction(() => window.__audio.made[0].state === 'suspended', null, { timeout: 2000 });
    await waitEnd(page);
    assert((await audio(page)).state === 'suspended', 'the engine woke again by itself');
    await context.close();
  }
  {
    // The whole 6.6 s sound: a second purge within it takes over, and is heard from its start.
    const { page, context } = await boot('/channels/4001/5002');
    await instrumentAudio(page);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await waitEnd(page);
    await goTo(page, '/channels/4001/5001');
    await nameIs(page, 'general');
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => window.__audio.starts.length === 2, null, { timeout: 5000 });
    let a = await audio(page);
    assert(a.starts[1].at - a.starts[0].at < 6000 && a.state === 'running', `the second sound ${JSON.stringify(a.starts)} ${a.state}`);
    await page.waitForTimeout(300);
    a = await audio(page);
    assert(a.ended === 1 && a.state === 'running', `the first gave way and the second plays ${JSON.stringify(a)}`);
    await page.waitForTimeout(800);
    assert((await audio(page)).ended === 1, 'the second sound was cut short');
    await waitEnd(page);
    await context.close();
  }
});

await test('T222 Mute or Stop during the sound hushes it at once, with a fade of 30 ms or less', async () => {
  for (const act of ['mute', 'stop']) {
    const { page, context } = await bootPaced('/channels/4001/5001', { deleteMs: 150 });
    await instrumentAudio(page);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => window.__audio.starts.length === 1, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    assert((await audio(page)).gain > 0.5, `${act}: playing at 0.6`);
    await page.click(`[data-act="${act}"]`);
    await page.waitForTimeout(300);
    const a = await audio(page);
    assert(a.ended === 1 && a.gain < 0.02, `${act}: still sounding 300 ms later ${JSON.stringify(a)}`);
    const fade = a.ramps.find((r) => r.value === 0);
    assert(fade && fade.end - fade.from <= 0.031, `${act}: the fade ${JSON.stringify(a.ramps)}`);
    await page.waitForFunction(() => window.__audio.made[0].state === 'suspended', null, { timeout: 2000 });
    if (act === 'mute') await page.click('[data-act="stop"]');
    await waitEnd(page);
    await context.close();
  }
});

await test('T223 a quick tap reads as a tap: "Keep holding~" waits until it is a hold', async () => {
  const { page, stats, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.waitForTimeout(400);
  await page.evaluate((src) => {
    window.__labels = [];
    const label = eval(src).querySelector('[data-role="confirm-label"]');
    new MutationObserver(() => window.__labels.push(label.textContent)).observe(label, { childList: true, subtree: true, characterData: true });
  }, R);
  const c = await page.locator('[data-act="confirm"]').boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(90);
  await page.mouse.up();
  await page.waitForTimeout(400);
  // What a person sees change (a press rewrites the resting words as they were, which isn't a change).
  const changes = (said) => said.filter((t, i) => t !== (i ? said[i - 1] : 'Hold to purify ✨'));
  const seen = changes(await page.evaluate(() => window.__labels));
  assert(JSON.stringify(seen) === JSON.stringify(['Hold it down~ ♡']), `a 90 ms tap showed ${JSON.stringify(seen)}`);
  await page.waitForTimeout(1500);
  // A real hold says so from a quarter second on, while the fill has moved since the press.
  await page.evaluate(() => { window.__labels = []; });
  await holdConfirm(page);
  const held = changes(await page.evaluate(() => window.__labels));
  assert(held[0] === 'Keep holding~' && held.includes('Purifying~ ♡'), `a hold showed ${JSON.stringify(held)}`);
  await waitEnd(page);
  assert(stats.deletes.length === 10, 'the hold purged');
  await context.close();
});

await test('T224 a name with stacked marks stays inside its pill, clear of "deleting as"', async () => {
  const { page, context } = await boot('/channels/@me/3003', { world: buildWorld({ names: 'zalgo' }) });
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const pill = await inPanel(page, (r) => {
    const p = r.querySelector('.pill').getBoundingClientRect();
    const w = r.querySelector('.modal-who').getBoundingClientRect();
    const cs = getComputedStyle(r.querySelector('.pill'));
    return { overlap: p.bottom > w.top && p.top < w.bottom, overflow: cs.overflow, margin: cs.overflowClipMargin, name: r.querySelector('.pill-name').textContent.length };
  });
  assert(!pill.overlap && pill.overflow === 'clip' && pill.margin === '2px' && pill.name > 20, `pill ${JSON.stringify(pill)}`);
  await context.close();
});

await test('T225 the This chat lead names the reach: threads in a channel, posts in a forum, nothing more in a DM', async () => {
  const world = buildWorld();
  world.channels['5002'].type = 15; // a forum
  const { page, context } = await boot('/channels/4001/5003', { world });
  const lead = async (where, name) => {
    await goTo(page, where);
    await nameIs(page, name);
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    const said = await text(page, '.modal-lead');
    await page.click('[data-act="cancel"]');
    return said;
  };
  let said = await lead('/channels/4001/5003', 'announcements');
  assert(said === 'This will delete all 5 of your messages, threads included, in', `an announcement channel: ${said}`);
  said = await lead('/channels/4001/5002', 'art-share');
  assert(said === 'This will delete all 10 of your messages, posts included, in', `a forum: ${said}`);
  said = await lead('/channels/@me/3002', 'Alice ✿');
  assert(said === 'This will delete all 31 of your messages in', `a DM: ${said}`);
  await context.close();
});

await test('T226 a run that ends while minimised plays its finish when you open it: verdict, sticker and confetti', async () => {
  const { page, context } = await bootPaced('/channels/4001/5002', { deleteMs: 120 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.click('[data-act="minimize"]');
  await waitEnd(page);
  await page.waitForTimeout(200);
  assert(await confettiCount(page) === 0 && (await beatsOn(page, '[data-role="sticker"]')).length === 0, 'the beats played unseen');
  await page.click('.orb');
  await page.waitForFunction((src) => eval(src).querySelector('[data-role="sticker"]').getAnimations().length > 0, R, { timeout: 2000 });
  const beats = { line: await beatsOn(page, '[data-role="readout-line"]'), sticker: await beatsOn(page, '[data-role="sticker"]'), confetti: await confettiCount(page),
    unfolding: await inPanel(page, (r) => r.querySelector('.panel').getAnimations().length) };
  assert(beats.line.join() === '60' && beats.sticker.join() === '380' && beats.confetti > 0 && beats.unfolding === 0, `after the unfold ${JSON.stringify(beats)}`);
  await context.close();
});

await test('T227 a run that ends in a hidden tab plays its finish once, when you come back', async () => {
  const { page, context } = await bootPaced('/channels/4001/5002', { deleteMs: 120 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await setHidden(page, true);
  await waitEnd(page);
  await page.waitForTimeout(200);
  assert(await confettiCount(page) === 0 && (await beatsOn(page, '[data-role="readout-line"]')).length === 0, 'the beats played in a hidden tab');
  await setHidden(page, false);
  const first = { line: await beatsOn(page, '[data-role="readout-line"]'), confetti: await confettiCount(page) };
  assert(first.line.join() === '60' && first.confetti > 0, `on coming back ${JSON.stringify(first)}`);
  await setHidden(page, true);
  await setHidden(page, false);
  assert((await beatsOn(page, '[data-role="readout-line"]')).length === 1, 'the beats played twice');
  await context.close();
});

await test('T228 a Many chats finish throws nothing into hidden places: no confetti, no drops, no squash; its line fades in once', async () => {
  const { page, context } = await bootPaced('/channels/4001/5001', { deleteMs: 60 });
  await pickBatch(page, ['c:5002']);
  await page.evaluate((src) => {
    const r = eval(src);
    window.__fx = { drops: 0, confetti: 0, squash: 0 };
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) {
        if (n.classList && n.classList.contains('drop')) window.__fx.drops++;
        if (n.classList && n.classList.contains('confetti')) window.__fx.confetti++;
      }
    }).observe(r, { childList: true, subtree: true });
    const w = r.querySelector('[data-role="wobble"]');
    const look = () => { if (w.style.transform) window.__fx.squash++; if (!window.__fx.stop) requestAnimationFrame(look); };
    look();
  }, R);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  await page.waitForTimeout(150);
  const fx = await page.evaluate(() => { window.__fx.stop = true; return window.__fx; });
  const sub = await beatsOn(page, '[data-role="hero-sub"]');
  assert(fx.drops === 0 && fx.confetti === 0 && fx.squash === 0, `Many chats' finish ${JSON.stringify(fx)}`);
  assert(sub.join() === '60', `the strip's line ${JSON.stringify(sub)}`);
  await context.close();
});

await test('T229 a This chat finish belongs to its chat: nothing over another chat, the beats once you are back', async () => {
  const { page, context } = await bootPaced('/channels/4001/5002', { deleteMs: 120 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await goTo(page, '/channels/4001/5001');
  await nameIs(page, 'general');
  await waitEnd(page);
  await page.waitForTimeout(200);
  assert(await confettiCount(page) === 0, 'confetti over #general');
  await goTo(page, '/channels/4001/5002');
  await nameIs(page, 'art-share');
  await page.waitForFunction((src) => eval(src).querySelector('[data-role="layer"]').dataset.hero === 'done', R, { timeout: 3000 });
  const beats = { line: await beatsOn(page, '[data-role="readout-line"]'), confetti: await confettiCount(page) };
  assert(beats.line.join() === '60' && beats.confetti > 0, `back on #art-share ${JSON.stringify(beats)}`);
  await context.close();
});

await test('T230 a kill animates only what the compositor plays, and This chat\'s footer holds still', async () => {
  const { page, context } = await bootPaced('/channels/4001/5001', { deleteMs: 60 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilCount(page, 3);
  await page.waitForTimeout(350); // the run's start (the avatar's dot turning rose) has played out
  const seen = await page.evaluate((src) => new Promise((done) => {
    const r = eval(src);
    const props = new Set();
    let footer = 0;
    let dot = 0;
    const t0 = performance.now();
    const look = () => {
      for (const a of r.getAnimations()) {
        for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) props.add(p);
        if (a.effect.target === r.querySelector('[data-role="status-text"]')) footer++;
        if (a.effect.pseudoElement === '::after' && a.effect.target.classList.contains('live-dot')) dot++;
      }
      if (performance.now() - t0 < 900) requestAnimationFrame(look); else done({ props: [...props].sort(), footer, dot });
    };
    look();
  }), R);
  assert(seen.props.every((p) => p === 'transform' || p === 'opacity'), `a kill animates ${seen.props}`);
  assert(seen.footer === 0 && seen.dot > 0, `footer ${seen.footer}, live dot pings ${seen.dot}`);
  await waitEnd(page);
  await context.close();
});

await test('T231 a pause is still: the sweep fades out where it stands and nothing loops; Resume brings it back', async () => {
  const { page, context } = await bootPaced('/channels/4001/5001', { deleteMs: 120 });
  await pickBatch(page, ['c:5002', 'c:3002']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilCount(page, 2);
  assert(await inPanel(page, (r) => r.querySelector('.dial').classList.contains('is-spinning')), 'a run with no known end spins');
  await page.click('[data-act="pause"]');
  await page.waitForTimeout(300);
  const paused = await inPanel(page, (r) => ({
    opacity: getComputedStyle(r.querySelector('.sweep circle')).opacity,
    loops: r.getAnimations().filter((a) => a.effect.getTiming().iterations === Infinity && a.playState === 'running').map((a) => `${a.animationName || 'waapi'}@${a.effect.target.getAttribute('class')}`),
  }));
  assert(paused.opacity === '0' && paused.loops.length === 0, `paused ${JSON.stringify(paused)}`);
  await page.click('[data-act="resume"]');
  await page.waitForTimeout(300);
  const back = await inPanel(page, (r) => ({ opacity: getComputedStyle(r.querySelector('.sweep circle')).opacity, sweep: r.querySelector('.sweep').getAnimations().map((a) => a.playState).join() }));
  assert(back.opacity === '1' && back.sweep === 'running', `resumed ${JSON.stringify(back)}`);
  await page.click('[data-act="stop"]');
  await waitEnd(page);
  await context.close();
});

await test('T232 Many chats at rest keeps nothing on a loop: Bardo\'s sheen plays twice and rests', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.waitForTimeout(400);
  const loops = await inPanel(page, (r) => r.getAnimations().filter((a) => a.effect.getComputedTiming().endTime === Infinity).map((a) => `${a.animationName || 'waapi'}@${a.effect.target.getAttribute('class')}`));
  const sheen = await inPanel(page, (r) => r.getAnimations().filter((a) => a.animationName === 'dp-sheen').map((a) => a.effect.getTiming().iterations));
  assert(loops.length === 0, `at rest ${JSON.stringify(loops)}`);
  assert(sheen.length > 0 && sheen.every((n) => n === 2), `the sheen ${JSON.stringify(sheen)}`);
  await context.close();
});

await test('T233 a drag held still levels out gently while still held, with no jump', async () => {
  const { page, context } = await boot('/channels/4001/5002');
  const head = await page.locator('.titles').boundingBox();
  await page.mouse.move(head.x + 40, head.y + 8);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(head.x + 40 - i * 60, head.y + 8 + i * 4); await page.waitForTimeout(16); }
  const turns = await wobbleTurn(page, 500); // the hand holds still for half a second
  await page.mouse.up();
  const peak = Math.max(...turns.map(Math.abs));
  const jumps = turns.slice(1).map((t, i) => Math.abs(t - turns[i]));
  assert(peak > 0.3, `the drag tilted ${peak}`);
  assert(turns.slice(-3).every((t) => Math.abs(t) < 0.05), `still tilted while held: ${turns.slice(-5).map((t) => t.toFixed(2))}`);
  assert(Math.max(...jumps) <= 0.5, `a jump of ${Math.max(...jumps).toFixed(2)}° in ${turns.map((t) => t.toFixed(2))}`);
  await context.close();
});

await test('T234 confetti stays above the verdict', async () => {
  const { page, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  await page.click('[data-act="purify"]');
  const watch = page.evaluate((src) => new Promise((done) => {
    const r = eval(src);
    let pieces = 0;
    let over = 0;
    let t0 = 0;
    const look = () => {
      const bits = r.querySelectorAll('.confetti');
      if (bits.length && !t0) t0 = performance.now();
      if (t0) {
        // What shows of each piece: its box inside the burst's clip.
        const clip = r.querySelector('[data-role="burst"]').getBoundingClientRect();
        const line = r.querySelector('[data-role="readout-line"]').getBoundingClientRect();
        for (const c of bits) {
          const b = c.getBoundingClientRect();
          const top = Math.max(b.top, clip.top);
          const bottom = Math.min(b.bottom, clip.bottom);
          const left = Math.max(b.left, clip.left);
          const right = Math.min(b.right, clip.right);
          pieces++;
          if (bottom > top && right > left && bottom > line.top && top < line.bottom && right > line.left && left < line.right) over++;
        }
      }
      if (!t0 || performance.now() - t0 < 1500) requestAnimationFrame(look); else done({ pieces, over });
    };
    look();
    setTimeout(() => done({ pieces, over, timeout: true }), 15000);
  }), R);
  await holdConfirm(page);
  const seen = await watch;
  assert(seen.pieces > 0 && seen.over === 0, `confetti over the verdict ${JSON.stringify(seen)}`);
  await context.close();
});

await test('T235 a count lands gently: the number and the arc fade up once', async () => {
  const { page, context } = await boot('/channels/4001/5002', { latencyMs: 30 });
  await page.evaluate((src) => {
    const r = eval(src);
    window.__landed = [];
    for (const sel of ['.hero-core', '.g-track']) {
      const el = r.querySelector(sel);
      const own = el.animate.bind(el);
      el.animate = (frames, opts) => { window.__landed.push({ sel, frames: frames.map((f) => Object.keys(f).join()).join('|'), ms: opts.duration }); return own(frames, opts); };
    }
  }, R);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/);
  const landed = await page.evaluate(() => window.__landed);
  assert(JSON.stringify(landed) === JSON.stringify([{ sel: '.hero-core', frames: 'opacity|opacity', ms: 220 }, { sel: '.g-track', frames: 'opacity|opacity', ms: 320 }]), `landing ${JSON.stringify(landed)}`);
  await context.close();
});

await test('T236 a poke mid-run leaves Pause and Stop where they are; Dopa still squashes', async () => {
  const { page, context } = await bootPaced('/channels/4001/5001', { deleteMs: 120 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilCount(page, 2);
  const moved = await page.evaluate((src) => new Promise((done) => {
    const r = eval(src);
    const stop = r.querySelector('[data-act="stop"]');
    const at = stop.getBoundingClientRect();
    let worst = 0;
    r.querySelector('[data-act="poke"]').click();
    const squash = r.querySelector('.avatar img').getAnimations().length;
    const t0 = performance.now();
    const look = () => {
      const b = stop.getBoundingClientRect();
      worst = Math.max(worst, Math.abs(b.left - at.left), Math.abs(b.top - at.top));
      if (performance.now() - t0 < 600) requestAnimationFrame(look); else done({ worst, squash });
    };
    look();
  }), R);
  assert(moved.worst <= 0.5 && moved.squash === 1, `a poke mid-run ${JSON.stringify(moved)}`);
  await page.click('[data-act="stop"]');
  await waitEnd(page);
  await context.close();
});

await test('T237 a tab switch glides the panel\'s height: the footer moves one way over many frames', async () => {
  const { page, context } = await boot('/channels/4001/5002');
  for (const to of ['batch', 'current']) {
    const tops = await page.evaluate(([src, tab]) => new Promise((done) => {
      const r = eval(src);
      const out = [];
      r.querySelector(`.tab[data-tab="${tab}"]`).click();
      const t0 = performance.now();
      const look = () => { out.push(r.querySelector('.foot').getBoundingClientRect().top); if (performance.now() - t0 < 400) requestAnimationFrame(look); else done(out); };
      look();
    }), [R, to]);
    const steps = tops.slice(1).map((t, i) => t - tops[i]).filter((d) => Math.abs(d) > 0.01);
    const oneWay = steps.every((d) => Math.sign(d) === Math.sign(steps[0]));
    assert(steps.length >= 8 && oneWay, `to ${to}: ${steps.length} steps, one way ${oneWay}: ${tops.map((t) => t.toFixed(0))}`);
    await page.waitForTimeout(300);
  }
  await context.close();
  // A heavy account's list (1,006 rows) is too much to lay out every frame: opening it cuts, closing it glides.
  const heavy = await boot('/channels/4001/5001', { world: buildWorld({ crowd: 'nodes' }) });
  await heavy.page.click('.tab[data-tab="batch"]');
  await heavy.page.waitForFunction((src) => eval(src).querySelectorAll('[data-role="dm-list"] .row').length >= 1006, R, { timeout: 60000 });
  await heavy.page.click('.tab[data-tab="current"]');
  await heavy.page.waitForTimeout(400);
  const glides = (tab) => inPanel(heavy.page, (r, t) => { r.querySelector(`.tab[data-tab="${t}"]`).click(); return r.querySelector('.panel').getAnimations().length; }, tab);
  const opening = await glides('batch');
  await heavy.page.waitForTimeout(400);
  const closing = await glides('current');
  assert(opening === 0 && closing === 1, `1,006 rows: opening glides ${opening}, closing ${closing}`);
  await heavy.context.close();
});

await test('T275 the commitment line tells the truth about what you send meanwhile, within the voice\'s limits (I2)', async () => {
  const { page, context } = await bootWith(realPace(), '/channels/4001/5001', { world: buildWorld({ bulk: { 5001: 3000 } }) });
  await page.click('[data-act="scan"]');
  await untilStatus(page, /found/, 8000);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const words = await inPanel(page, (r) => r.querySelector('.modal').innerText);
  assert(/messages you send now aren't touched/.test(words), 'the line names what a run leaves alone');
  const tildes = (words.match(/~/g) || []).length;
  const hearts = (words.match(/♡/g) || []).length;
  const princess = (words.match(/princess/gi) || []).length;
  assert(tildes <= 3 && hearts <= 2 && princess <= 1, `the dialog says ${tildes} tildes, ${hearts} hearts, ${princess} princesses`);
  await context.close();
});

await test('T276 the start sound ships byte for byte as assets/delete.mp3 (I1)', async () => {
  const asset = fs.readFileSync(path.join(here, '../assets/delete.mp3'));
  const m = /DELETE_SOUND = 'data:audio\/mpeg;base64,([A-Za-z0-9+/=]+)'/.exec(source);
  assert(m, 'the build embeds the sound');
  assert(Buffer.from(m[1], 'base64').equals(asset), 'the embedded sound differs from assets/delete.mp3');
});

// ---- WP-H (4.2) ----
// Many chats: every number agrees, big accounts stay smooth, rows stay still, friends fold away, and
// the small ring reads clean.

// What the footer said, in order (its words only).
const recordStatus = (page) => page.evaluate(() => {
  const el = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
  window.__said = [];
  new MutationObserver(() => window.__said.push(el.textContent.replace(/ /g, ' '))).observe(el, { childList: true, subtree: true, characterData: true });
});
const dialogNow = (page) => inPanel(page, (r) => ({
  title: r.querySelector('[data-role="modal-title"]').textContent,
  lead: [...r.querySelector('.modal-lead').childNodes].filter((n) => !(n.nodeType === 1 && n.classList.contains('sr'))).map((n) => n.textContent).join('').replace(/ /g, ' '),
  heard: [...r.querySelector('.modal-lead').childNodes].filter((n) => !(n.nodeType === 1 && n.getAttribute('aria-hidden') === 'true')).map((n) => n.textContent).join(''),
  label: r.querySelector('.modal-list').getAttribute('aria-label'),
  items: [...r.querySelectorAll('.modal-list > .modal-item')].map((el) => ({
    name: el.querySelector('.modal-item-name').textContent.replace(/ /g, ' '),
    meta: el.querySelector('.modal-item-meta').textContent, server: el.classList.contains('modal-server'),
  })),
}));
const activeClass = (page) => page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.activeElement.className);

await test('T206 Many chats counts what will really be purified: badge, strip, dialog and run agree', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  const asked = [];
  page.on('request', (r) => { if (/messages\/search|\/messages\?/.test(r.url())) asked.push(r.url()); });
  // The pictures' pick, plus #Voice Lounge, which holds none of mine.
  await pickBatch(page, ['c:3003', 'c:3002', 'u:2004', 'c:5002', 'c:5004', 'c:5007']);
  assert(await text(page, '[data-role="tab-badge"]') === '6' && await page.locator('[data-role="purify-count"]').isHidden(), 'six ticked, no chip on Purify');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  const after = await inPanel(page, (r) => ({
    mod: r.querySelector('[data-key="c:5007"]').dataset.state, modTicked: r.querySelector('[data-key="c:5007"] .check').checked,
    modMeta: r.querySelector('[data-key="c:5007"] .row-meta').textContent, clearTicked: r.querySelector('[data-key="c:5004"] .check').checked,
    badge: r.querySelector('[data-role="tab-badge"]').textContent, sub: r.querySelector('[data-role="hero-sub"]').textContent.replace(/ /g, ' '),
    chip: r.querySelector('[data-role="purify-count"]').hidden, unit: r.querySelector('[data-role="purify-unit"]').textContent,
  }));
  assert(after.mod === 'error' && !after.modTicked && after.modMeta === '✗ no access', `no access unticks at Count ${JSON.stringify(after)}`);
  assert(after.clearTicked && after.badge === '5' && after.chip && after.unit === '', `all clear stays ticked, the badge counts ticks ${JSON.stringify(after)}`);
  assert(/^4 chats · 1 closed DM · 1 all clear · about \d+s\+$/.test(after.sub), `the strip counts the chats that go: ${after.sub}`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const d = await dialogNow(page);
  const going = d.items.filter((i) => i.meta !== 'left out' && !/^skipped/.test(i.meta));
  assert(d.title === 'Purify 4 chats?' && going.length === 4, `title and lines agree ${JSON.stringify(d)}`);
  assert(d.items.at(-1).name === '1 chat with nothing of yours' && d.items.at(-1).meta === 'left out', `the all-clear chat is named as left out ${JSON.stringify(d.items)}`);
  assert(d.label === '4 chats to purify, 1 left out', `list label ${d.label}`);
  assert(d.lead === 'This will delete 48 of your messages, plus all of yours in 1 chat not counted yet, threads included:' && d.heard.endsWith('included.'), `lead ${JSON.stringify(d)}`);
  await recordStatus(page);
  const from = asked.length;
  await holdConfirm(page);
  await waitEnd(page, 40000);
  const said = await page.evaluate(() => window.__said);
  assert(said.some((s) => /^Starting on 4 chats~/.test(s)), `starting line ${said.slice(0, 3)}`);
  const chats = [...new Set(said.filter((s) => /^Chat \d/.test(s)).map((s) => s.slice(0, 11)))];
  assert(chats.join() === 'Chat 1 of 4,Chat 2 of 4,Chat 3 of 4,Chat 4 of 4', `chat lines ${chats}`);
  const stray = asked.slice(from).filter((u) => /channel_id=500[47]\b|channels\/500[47]\//.test(u));
  assert(stray.length === 0, `searched chats that sat out: ${stray.join(', ')}`);
  const end = await batchSnapshot(page, ['c:5004', 'c:5007']);
  assert(end.ticked.length === 0 && end.badge === '', `a clean chat that rode along unticks at the end ${JSON.stringify(end)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T207 when every picked chat is all clear, the strip says so, Purify rests and the ticks stay', async () => {
  const world = buildWorld();
  for (const id of ['5002', '5003', '5103']) world.messages[id] = [];
  const { page, context } = await boot('/channels/4001/5001', { world });
  await pickBatch(page, ['c:5002', 'c:5003', 'c:5004']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /All clear~/, 15000);
  const r = await inPanel(page, (root) => ({
    sub: root.querySelector('[data-role="hero-sub"]').textContent.replace(/ /g, ' '),
    disabled: root.querySelector('[data-act="purify"]').disabled, clean: root.querySelector('[data-act="purify"]').classList.contains('is-clean'),
    ticked: root.querySelectorAll('.row .check:checked').length, badge: root.querySelector('[data-role="tab-badge"]').textContent,
  }));
  assert(r.sub === '3 chats · all clear ✨' && r.disabled && r.clean && r.ticked === 3 && r.badge === '3', `all clear ${JSON.stringify(r)}`);
  await context.close();
});

// Its 100 ms budget lives in test/perf.mjs; here, its shape.
await test('T208 a whole server ticked is one line in the dialog (heavy account)', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { world: buildWorld({ crowd: 'heavy' }) });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.guild').length >= 102, null, { timeout: 30000 });
  await page.locator('.guild-all').nth(2).click(); // Server 0: 30 channels, 25 of them text
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="tab-badge"]').textContent === '25', null, { timeout: 15000 });
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const d = await dialogNow(page);
  assert(d.title === 'Purify 25 chats?' && d.items.length === 1 && d.items[0].server, `one line ${JSON.stringify(d)}`);
  assert(d.items[0].name === 'Server 0 ☾ · 25 channels' && d.items[0].meta === 'not counted', `the line ${JSON.stringify(d.items[0])}`);
  const names = await page.locator('.modal-server summary').getAttribute('title');
  assert(names.split(', ').length === 25 && names.startsWith('#channel-1, '), `its title names every channel: ${names}`);
  await page.click('[data-act="cancel"]');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// The time budget for a tick lives in test/perf.mjs; here, what a tick touches.
await test('T209 a tick on a big account touches only what it changes, and every number keeps up', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { world: buildWorld({ crowd: 'scale' }) });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForFunction(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    return r.querySelectorAll('[data-role="dm-list"] .row').length >= 806 && r.querySelectorAll('.guild').length >= 152;
  }, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    for (const head of [...r.querySelectorAll('.guild-head')].slice(0, 40)) { head.click(); await new Promise((done) => setTimeout(done, 20)); }
  });
  await page.waitForFunction(() => [...document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('.guild-channels:not([hidden])')]
    .every((list) => list.querySelector('.row') && !list.querySelector('.list-empty')), null, { timeout: 60000 });
  const ticks = await page.evaluate(async () => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    let calls = 0;
    const undo = [];
    for (const proto of [DocumentFragment.prototype, Element.prototype]) {
      for (const m of ['querySelector', 'querySelectorAll']) {
        const f = proto[m];
        proto[m] = function (...a) { calls++; return f.apply(this, a); };
        undo.push(() => { proto[m] = f; });
      }
    }
    const out = [];
    const boxes = [...r.querySelectorAll('[data-role="dm-list"] .row .check')].slice(20, 25);
    for (const [i, box] of boxes.entries()) {
      calls = 0;
      box.click();
      out.push({ calls, badge: r.querySelector('[data-role="tab-badge"]').textContent, want: String(i + 1) });
      await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    }
    r.querySelector('.guild-all .check').click(); // Cozy Corner: 5 channels
    await new Promise((done) => setTimeout(done, 50));
    out.push({ calls: 0, badge: r.querySelector('[data-role="tab-badge"]').textContent, want: '10' });
    for (const u of undo) u();
    return out;
  });
  for (const t of ticks) assert(t.badge === t.want, `the badge keeps up ${JSON.stringify(ticks)}`);
  assert(Math.max(...ticks.slice(0, 5).map((t) => t.calls)) <= 40, `lookups per tick ${ticks.map((t) => t.calls)}`);
  // The panel's own elements stay the live ones after a refresh, a tab switch and a dialog.
  await page.click('[data-act="dm-refresh"]');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelectorAll('[data-role="dm-list"] .row').length >= 806, null, { timeout: 60000 });
  await page.click('.tab[data-tab="current"]');
  await page.click('.tab[data-tab="batch"]');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.click('[data-act="cancel"]');
  await page.waitForTimeout(300);
  await page.locator('[data-role="dm-list"] .row .check').nth(30).evaluate((b) => b.click());
  const now = await inPanel(page, (r) => ({ badge: r.querySelector('[data-role="tab-badge"]').textContent, sub: r.querySelector('[data-role="hero-sub"]').textContent }));
  assert(now.badge === '11' && /^11 chats/.test(now.sub), `after a refresh, a tab switch and a dialog ${JSON.stringify(now)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
  // And after the welcome.
  const env = await boot('/channels/4001/5001', { firstRun: true });
  await env.page.click('[data-act="welcome-batch"]');
  await env.page.waitForSelector('[data-key="c:3003"]');
  await env.page.click('[data-key="c:3003"]');
  assert(await text(env.page, '[data-role="tab-badge"]') === '1' && /^1 chat/.test(spaced(await text(env.page, '[data-role="hero-sub"]'))), 'after the welcome');
  await env.context.close();
});

await test('T210 rows stay still through a run, and a running row is heard as "purifying 5 of 7"', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 20 });
  await pickBatch(page, ['c:3003', 'c:3002', 'c:5002']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const head = r.querySelector('#dp-server-title').closest('.section-head');
    const body = r.querySelector('[data-role="body"]');
    const heard = (n) => (n.nodeType === 3 ? n.textContent : n.getAttribute('aria-hidden') === 'true' ? '' : [...n.childNodes].map(heard).join(''));
    window.__still = { tops: [], hs: [], said: [] };
    let started = false;
    const look = () => {
      const s = window.__still;
      const run = r.querySelector('[data-role="layer"]').dataset.run;
      if (run !== 'idle') started = true;
      if (started) {
        s.tops.push(head.getBoundingClientRect().top + body.scrollTop);
        for (const k of ['c:3003', 'c:3002', 'c:5002']) s.hs.push(`${k}:${Math.round(r.querySelector(`[data-key="${k}"]`).getBoundingClientRect().height)}`);
        const live = r.querySelector('[data-key="c:3003"][data-state="running"] .check');
        if (live) s.said.push(live.getAttribute('aria-describedby').split(' ').map((id) => heard(r.getElementById(id))).join('').trim());
      }
      if (!started || run !== 'idle') requestAnimationFrame(look);
    };
    look();
  });
  await holdConfirm(page);
  await waitEnd(page, 40000);
  const s = await page.evaluate(() => window.__still);
  const heights = [...new Set(s.hs)].sort();
  assert(heights.join() === 'c:3002:38,c:3003:38,c:5002:32', `row heights ${heights}`);
  assert(Math.max(...s.tops) - Math.min(...s.tops) < 1, `the Servers header moved ${Math.max(...s.tops) - Math.min(...s.tops)}px`);
  const said = [...new Set(s.said)];
  assert(said.length && said.every((t) => /^purifying \d of 7$/.test(t)) && said.some((t) => /^purifying [1-6] of 7$/.test(t)), `heard ${said}`); // sampled per frame, so any step mid-run
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T211 a long username stays on one line and ends before the count', async () => {
  const { page, context } = await boot('/channels/4001/5001', { world: buildWorld({ names: 'long' }) });
  await pickBatch(page, ['c:3002']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  const r = await inPanel(page, (root) => {
    const row = root.querySelector('[data-key="c:3002"]');
    return { h: Math.round(row.getBoundingClientRect().height), sub: row.querySelector('.row-sub').getBoundingClientRect().right,
      meta: row.querySelector('.row-meta').getBoundingClientRect().left, title: row.title, text: row.querySelector('.row-meta').textContent };
  });
  assert(r.h === 38 && r.sub <= r.meta && r.text === '31 msgs', `long name row ${JSON.stringify(r)}`);
  assert(r.title === 'Alice the Magnificent Wanderer ✿ @alice_the_magnificent_wanderer_x', `hover says it all: ${r.title}`);
  // A friend's sub-line leads with the word that explains it.
  await openFriends(page);
  assert(spaced(await text(page, '[data-key="u:2004"] .row-sub')) === 'friend · @bob', 'friend sub-line');
  await context.close();
});

await test('T212 a friend DM opened and found empty reads "all clear ✓", quietly', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await pickBatch(page, ['u:2004']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 20000);
  const r = await inPanel(page, (root) => {
    const row = [...root.querySelectorAll('[data-role="dm-list"] .row')].find((el) => el.querySelector('.row-name').textContent === 'Bob');
    const clear = row.querySelector('.meta-clear');
    return { state: row.dataset.state, meta: row.querySelector('.row-meta').textContent, ink: clear && getComputedStyle(clear).color,
      t3: getComputedStyle(row).getPropertyValue('--t3').trim() };
  });
  assert(r.state === 'done' && r.meta === 'all clear ✓', `Bob ${JSON.stringify(r)}`);
  const probe = await page.evaluate((c) => { const d = document.createElement('i'); d.style.color = c; document.body.append(d); const v = getComputedStyle(d).color; d.remove(); return v; }, r.t3);
  assert(r.ink === probe, `muted ${JSON.stringify(r)} vs ${probe}`);
  await context.close();
});

await test('T213 a press on a half-shown server line opens it where it is; arrows still bring lines into view', async () => {
  const { page, context } = await boot('/channels/4001/5001', { world: longWorld(), viewport: { width: 1100, height: 760 } });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('.guild-head');
  // The DMs land after the servers and push them down: measure once they are drawn.
  await page.waitForSelector('[data-key="c:3002"]');
  // Cozy Corner's line just peeking in at the bottom of the panel.
  const peek = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const body = r.querySelector('[data-role="body"]');
    const head = r.querySelector('.guild-head');
    body.scrollTop += head.getBoundingClientRect().top - (body.getBoundingClientRect().bottom - 14);
    const box = head.getBoundingClientRect();
    return { x: box.left + 80, y: box.top + 6, scrollTop: body.scrollTop };
  });
  await page.mouse.click(peek.x, peek.y);
  await page.waitForTimeout(250);
  const after = await inPanel(page, (r) => ({ open: r.querySelector('.guild-head').getAttribute('aria-expanded'), scrollTop: r.querySelector('[data-role="body"]').scrollTop }));
  assert(after.open === 'true' && Math.abs(after.scrollTop - peek.scrollTop) < 1, `press ${JSON.stringify({ peek, after })}`);
  await page.evaluate(() => { document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="body"]').scrollTop = 0; });
  await page.locator('[data-key="c:3002"] .check').focus();
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowDown');
  const seen = await inPanel(page, (r) => {
    const line = r.activeElement.closest('.row, .guild-bar, .fold-bar').getBoundingClientRect();
    const body = r.querySelector('[data-role="body"]').getBoundingClientRect();
    return { top: line.top, bottom: line.bottom, strip: r.querySelector('.hero').getBoundingClientRect().bottom, end: body.bottom, scrolled: r.querySelector('[data-role="body"]').scrollTop };
  });
  assert(seen.scrolled > 0 && seen.top >= seen.strip - 1 && seen.bottom <= seen.end + 1, `the focused line is in view ${JSON.stringify(seen)}`);
  await context.close();
});

await test('T214 shields show at rest; Bardo\'s undo shield waits for hover', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"]');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  const o = await inPanel(page, (r) => ({
    dm: getComputedStyle(r.querySelector('[data-key="c:3002"] .shield-btn')).opacity,
    bardo: getComputedStyle(r.querySelector('.row-immune .shield-btn')).opacity,
  }));
  assert(o.dm === '0.7' && o.bardo === '0', `opacity at rest ${JSON.stringify(o)}`);
  await context.close();
});

await test('T215 friends with a closed DM fold away, open by key or search, and never hide a pick', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('.fold-head');
  const fold = () => inPanel(page, (r) => ({
    open: r.querySelector('.fold-head').getAttribute('aria-expanded'), rows: r.querySelector('.fold-rows').hidden ? 'hidden' : 'shown',
    meta: r.querySelector('[data-role="fold-meta"]').textContent.replace(/ /g, ' '), last: r.querySelector('[data-role="dm-list"]').lastElementChild.className,
    note: r.querySelector('.fold-note').textContent, title: r.querySelector('.fold-head .guild-name').textContent,
    picked: [...r.querySelectorAll('.row .check:checked')].map((b) => b.closest('.row').dataset.key).sort().join(),
  }));
  let f = await fold();
  assert(f.open === 'false' && f.rows === 'hidden' && f.meta === '2 friends' && f.last === 'fold' && f.title === 'Friends with a closed DM', `starts folded ${JSON.stringify(f)}`);
  assert(f.note === 'Purifying one opens the DM for a moment, then closes it again~', `note ${f.note}`);
  await page.click('[data-act="dm-all"]');
  f = await fold();
  assert(f.picked === 'c:3002,c:3003,c:3004' && f.open === 'false', `All ticks open DMs only ${JSON.stringify(f)}`);
  await page.click('[data-act="dm-none"]');
  // The keyboard: End reaches the fold, Right opens it, Left comes back out and folds it.
  await page.locator('[data-key="c:3002"] .check').focus();
  await page.keyboard.press('End');
  assert(await activeClass(page) === 'fold-head', 'End lands on the fold');
  await page.keyboard.press('ArrowRight');
  assert((await fold()).open === 'true', 'Right opens it');
  await page.keyboard.press('ArrowDown');
  assert(await page.evaluate(() => document.querySelector('#dopa-purifier-host').shadowRoot.activeElement.closest('.row').dataset.key) === 'u:2004', 'Down walks in');
  await page.keyboard.press('ArrowLeft');
  assert(await activeClass(page) === 'fold-head', 'Left comes back out');
  await page.keyboard.press('ArrowLeft');
  assert((await fold()).open === 'false', 'Left folds it');
  // A search finds a friend inside, and clearing it puts the fold back.
  await page.fill('[data-role="filter"]', 'carol');
  await frame(page);
  assert((await fold()).open === 'true' && await page.locator('[data-key="u:2005"]').isVisible() && await page.locator('[data-key="u:2004"]').isHidden(), 'the search opens it on Carol');
  await page.fill('[data-role="filter"]', '');
  await frame(page);
  assert((await fold()).open === 'false', 'cleared, it folds again');
  // A pick inside keeps it open, and says so.
  await openFriends(page);
  await page.click('[data-key="u:2004"]');
  await page.click('.fold-head');
  f = await fold();
  assert(f.open === 'true' && f.meta === '2 friends · 1 picked', `a pick keeps it open ${JSON.stringify(f)}`);
  await page.click('[data-key="u:2004"]');
  f = await fold();
  assert(f.open === 'false' && f.meta === '2 friends', `unticked, it folds as asked ${JSON.stringify(f)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
  // A friend picked last time and brought back by the journal opens the fold too.
  const env = await openDiscord(browser, '/channels/4001/5001');
  await plantJournal(env.page, { v: 1, user: '1000', mode: 'batch', at: Date.now(), state: 'stopped', keys: ['u:2005'], guilds: [] });
  await injectUserscript(env.page, source);
  await settled(env.page);
  await env.page.click('.tab[data-tab="batch"]');
  await env.page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-key="u:2005"] .check')?.checked, null, { timeout: 8000 });
  const back = await inPanel(env.page, (r) => ({ open: r.querySelector('.fold-head').getAttribute('aria-expanded'), meta: r.querySelector('[data-role="fold-meta"]').textContent.replace(/ /g, ' ') }));
  assert(back.open === 'true' && back.meta === '2 friends · 1 picked', `restored pick ${JSON.stringify(back)}`);
  await env.context.close();
});

await test('T216 a DM search that finds nothing says how to bring a closed DM back', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('.guild');
  await page.fill('[data-role="filter"]', 'zed');
  await frame(page);
  const said = await inPanel(page, (r) => ['dm-list', 'server-list'].map((l) => (r.querySelector(`[data-role="${l}"] [data-role="no-match"]`) || {}).textContent));
  assert(unmarked(said[0]) === 'No DMs match “zed”~ closed it? Open it in Discord, then press ↻' && unmarked(said[1]) === 'No chats match “zed”~', `no match ${JSON.stringify(said)}`);
  await context.close();
});

await test('T217 a closed DM opened to purify is closed again, and the log says so', async () => {
  const world = buildWorld();
  world.channels['3005'] = { id: '3005', type: 1, recipients: [world.users.bob], closed: true };
  addMine(world, '3005', 3, { at: Date.now() - 60000 });
  const { page, stats, pageErrors, context } = await boot('/channels/4001/5001', { world });
  await pickBatch(page, ['u:2004']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 20000);
  assert(mine(world, '3005').length === 0 && stats.deletes.length === 3, `purged ${stats.deletes.length}`);
  assert(stats.opened.join() === '3005' && stats.closed.join() === '3005', `opened ${stats.opened}, closed ${stats.closed}`);
  assert(/closed the DM with Bob again/.test(await page.locator('[data-role="term-body"]').textContent()), 'the log says so');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T218 the small ring in Many chats reads clean: no notches, a visible track, a face inside', async () => {
  // At 2x the track's 2.6 px stroke has pixels it fully covers, so the sample reads the colour itself.
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 10, dpr: 2 });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400); // the tab's fade has played
  const face = () => inPanel(page, (r) => {
    const g = r.querySelector('.gauge').getBoundingClientRect();
    const f = r.querySelector('[data-role="hero-face"]').getBoundingClientRect();
    return { is: `${r.querySelector('.hero').dataset.state}/${r.querySelector('.hero').dataset.face}`, icon: r.querySelector('[data-role="hero-face"]').dataset.icon,
      inside: f.width > 0 && Math.abs((f.left + f.right) / 2 - (g.left + g.right) / 2) < 1.5 && Math.abs((f.top + f.bottom) / 2 - (g.top + g.bottom) / 2) < 1.5 };
  });
  let f = await face();
  assert(f.is === 'none/icon' && f.icon === 'sparkle' && f.inside, `nothing picked ${JSON.stringify(f)}`);
  // The empty track, sampled: its brightest pixel on the left of the ring against the strip's corner.
  const png = (await page.locator('.gauge').screenshot()).toString('base64');
  const ratio = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const at = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
    const lum = (rgb) => rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const k = img.width / 44;
    let best = 0;
    let px = null;
    for (let x = Math.floor(1 * k); x <= Math.ceil(6 * k); x++) for (let y = Math.floor(19 * k); y <= Math.ceil(25 * k); y++) if (lum(at(x, y)) > best) { best = lum(at(x, y)); px = [x, y, ...at(x, y)]; }
    return { ratio: (best + 0.05) / (lum(at(0, 0)) + 0.05), px, bg: at(0, 0), w: img.width };
  }, png);
  assert(ratio.ratio >= 1.6, `the empty track at ${ratio.ratio.toFixed(2)}:1 ${JSON.stringify(ratio)}`);
  await page.click('[data-key="c:3003"]');
  f = await face();
  assert(f.is === 'unscanned/icon' && f.icon === 'scan' && f.inside, `picked, not counted ${JSON.stringify(f)}`);
  // Counted (7, few enough for notches in the big ring) and purged: the strip stays an arc throughout.
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  await page.evaluate(() => {
    const dial = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.dial');
    window.__beaded = dial.classList.contains('is-beaded');
    new MutationObserver(() => { if (dial.classList.contains('is-beaded')) window.__beaded = true; }).observe(dial, { attributes: true });
  });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 20000);
  await page.waitForTimeout(300);
  assert(!(await page.evaluate(() => window.__beaded)), 'the strip drew notches');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
  // The big ring in This chat keeps them.
  const env = await boot('/channels/4001/5002');
  await env.page.click('[data-act="scan"]');
  await env.page.waitForFunction(() => /^Counted~/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  assert(await env.page.locator('.dial.is-beaded').count() === 1, 'This chat keeps its notches');
  await env.context.close();
});

await test('T269 Many chats names what goes: "in 1 chat", never "this chat", and a server line names its channels', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  await pickBatch(page, ['c:3003']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Counted~/, 15000);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  let d = await dialogNow(page);
  assert(d.title === 'Purify 1 chat?' && d.lead === 'This will delete all 7 of your messages in 1 chat:' && d.label === '1 chat to purify', `one chat ${JSON.stringify(d)}`);
  await page.click('[data-act="cancel"]');
  await page.click('[data-act="dm-none"]');
  await page.locator('.guild-all').first().click();
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="tab-badge"]').textContent === '5');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  d = await dialogNow(page);
  assert(d.items.length === 1 && d.items[0].name === '✿ Cozy Corner · 5 channels' && d.items[0].meta === 'not counted', `one server line ${JSON.stringify(d.items)}`);
  assert(d.lead === 'This will delete all your messages in these 5 chats, threads included:', `lead ${d.lead}`);
  const names = '#general, #art-share, announcements, Voice Lounge, #mod-only';
  assert(await page.locator('.modal-server summary').getAttribute('title') === names, `its title names the channels: ${await page.locator('.modal-server summary').getAttribute('title')}`);
  assert(await page.locator('.modal-server-names').isHidden(), 'folded at first');
  await page.click('.modal-server summary');
  assert(await page.locator('.modal-server-names').isVisible() && await text(page, '.modal-server-names') === names, 'opened, it names them');
  await page.click('[data-act="cancel"]');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// ---- WP-G (4.2) ----
// Words and endings: each ending says what happened once, the footer names what's next (and screen
// readers still hear the verdict), no access is calm, Discord's indexing is 'still searching'.

// The footer's line without its bidi isolates, its .sr, and the panel's visible words (no .sr).
const plainWords = (s) => s.replace(/[⁨⁩]/g, '');
const srNow = (page) => page.evaluate(() => {
  const sr = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status"] > .sr');
  return sr ? sr.textContent.replace(/ /g, ' ') : '';
});
const seenText = (page) => page.evaluate(() => {
  const r = document.querySelector('#dopa-purifier-host').shadowRoot;
  const out = [];
  const walk = document.createTreeWalker(r.querySelector('.panel'), NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (!el.closest('.sr') && el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) out.push(n.nodeValue);
  }
  return out.join(' ').replace(/ /g, ' ');
});
const times = (s, re) => (s.match(re) || []).length;

await test('T191 a clean finish: the footer is "Done in Ns" with ♡ and no "failed", and 40 of 40 stays', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /40 messages found/);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  const done = await statusParts(page);
  assert(/^Done in \d+s$/.test(done.words) && done.flair === ' ♡' && done.tone === 'success', `footer ${JSON.stringify(done)}`);
  assert(await srNow(page) === 'All clean. ', `heard ${await srNow(page)}`);
  assert(await text(page, '[data-role="pct"]') === '40 of 40', `finish line ${await text(page, '[data-role="pct"]')}`);
  assert(/^All clean~ nothing left of you here/.test(await text(page, '[data-role="readout-line"]')), 'verdict');
  assert(!/failed/.test(await seenText(page)), 'no "failed" anywhere');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T192 a finish with failures says how many couldn\'t be purged, once, and where the reasons are', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  const failing = new Set();
  await page.route(/\/api\/v9\/channels\/5001\/messages\/\d+$/, (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = route.request().url().split('/').pop();
    if (failing.size < 5) failing.add(id);
    return failing.has(id) ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'Invalid Form Body', code: 50035 }) }) : route.fallback();
  });
  await page.click('[data-act="scan"]');
  await untilStatus(page, /40 messages found/);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(await text(page, '[data-role="readout-line"]') === "5 messages couldn't be purged", `verdict "${await text(page, '[data-role="readout-line"]')}"`);
  const done = await statusParts(page);
  assert(/^Done in \d+s · reasons in Logs$/.test(done.words) && done.tone === 'warn' && !done.flair, `footer ${JSON.stringify(done)}`);
  assert((await srNow(page)).startsWith("5 couldn't be purged."), `heard ${await srNow(page)}`);
  assert(await text(page, '[data-role="pct"]') === '35 of 40', `finish line ${await text(page, '[data-role="pct"]')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T193 Stop says how many of yours are still here, and "stopped" at most twice', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('[data-act="scan"]');
  await untilStatus(page, /40 messages found/);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 4);
  await page.click('[data-act="stop"]');
  await waitEnd(page, 5000);
  const left = 40 - await count(page);
  assert(await text(page, '[data-role="readout-line"]') === `Stopped~ ${left} of yours still here`, `verdict "${await text(page, '[data-role="readout-line"]')}"`);
  const done = await statusParts(page);
  assert(done.words === 'Purify picks up the rest~' && done.tone === 'calm', `footer ${JSON.stringify(done)}`);
  assert(await srNow(page) === `${left} of yours still here. `, `heard ${await srNow(page)}`);
  const seen = await seenText(page);
  assert(times(seen, /stopped/gi) <= 2, `"stopped" ${times(seen, /stopped/gi)} times: ${seen}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T194 This chat on a channel Discord is still searching ends calmly, never "chat skipped"', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5002', { deepIndex: ['5002'] });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(await text(page, '[data-role="readout-line"]') === 'Discord may find older ones later~', `verdict "${await text(page, '[data-role="readout-line"]')}"`);
  const done = await statusParts(page);
  assert(done.words === 'Purify again later to catch them~' && done.tone === 'calm', `footer ${JSON.stringify(done)}`);
  assert(await text(page, '[data-role="mood"]') === 'almost there, princess~', `mood ${await text(page, '[data-role="mood"]')}`);
  const seen = await seenText(page);
  assert(!/chat skipped|fought back/i.test(seen), `said ${seen}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T195 a DM purged clean says the call notice stays, and the log names it', async () => {
  const { page, pageErrors, context } = await boot('/channels/@me/3002');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(await text(page, '[data-role="readout-line"]') === "All clean~ only Discord's call notices stay ✨", `verdict "${await text(page, '[data-role="readout-line"]')}"`);
  assert(/kept a call notice — Discord doesn't let anyone delete those/.test(await logText(page)), 'the log names what stayed');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

// An ending from the engine, as the end handler receives it (only the fields it reads).
const endAs = (page, p, runKey = 'c:5001') => page.evaluate(([p, key]) => {
  window.__dp.state.runKey = key;
  window.__dp.state.runMode = key === 'batch' ? 'batch' : 'current';
  window.__dp.state.runTargets = key === 'batch' ? [] : [{ channelId: key.slice(2), name: '#general' }];
  window.__dp.emit('end', { deleted: 3, failed: 0, gone: 0, total: 10, partial: false, skipped: 0, elapsedMs: 3000, failures: [], problems: [], shielded: [], ...p });
}, [p, runKey]);

await test('T196 in a short window every error ending keeps its next step on the strip\'s one line', async () => {
  const { page, pageErrors, context } = await bootProbe('/channels/4001/5001', ['emit', 'state'], { viewport: { width: 1093, height: 500 } });
  const endings = {
    captcha: { error: 'Discord wants a human check — take a break before trying again', errorStatus: 400, errorCode: 'captcha' },
    network: { error: 'Network unreachable', errorStatus: 0 },
    'logged-out': { error: '401: Unauthorized', errorStatus: 401 },
    server: { error: 'HTTP 502', errorStatus: 502 },
    switched: { error: 'You switched Discord accounts mid-purge', errorStatus: 0 },
    indexing: { problems: [{ target: { channelId: '5001', name: '#general' }, reason: 'Discord is still indexing older messages — run it again later' }] },
  };
  for (const [why, p] of Object.entries(endings)) {
    await endAs(page, p);
    await heroAt(page, 'done/count');
    const sub = await page.evaluate(() => { const s = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="hero-sub"]'); return { text: s.textContent, fits: s.scrollWidth <= s.clientWidth, shown: s.checkVisibility() }; });
    assert(sub.shown && sub.fits, `${why}: the strip cuts "${sub.text}"`);
    assert(why === 'switched' || why === 'indexing' || /Purify/.test(sub.text), `${why}: no next step in "${sub.text}"`);
  }
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T197 a run that finishes while another chat is open names its chat until you go back', async () => {
  const { page, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 40 });
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await goTo(page, '/channels/4001/5002');
  await nameIs(page, 'art-share');
  await waitEnd(page, 20000);
  const away = await statusParts(page);
  assert(plainWords(away.words) === 'Done~ #general is all clean · 40 messages purged' && away.tone === 'success', `footer ${JSON.stringify(away)}`);
  assert(await heroIs(page) !== 'done/count', 'art-share shows its own ring');
  await goTo(page, '/channels/4001/5003');
  await nameIs(page, 'announcements');
  await page.waitForTimeout(300);
  assert(plainWords((await statusParts(page)).words) === plainWords(away.words), `kept: ${(await statusParts(page)).words}`);
  await goTo(page, '/channels/4001/5001');
  await nameIs(page, 'general');
  await heroAt(page, 'done/count');
  await statusMatches(page, /^Done in \d+s ♡$/, 3000);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T198 no access is a calm fact: two crimson marks, the chat kind, and a truthful line', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5007');
  await page.click('[data-act="purify"]');
  await untilStatus(page, /^No access here$/);
  const marks = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    return {
      label: getComputedStyle(r.querySelector('[data-role="count-label"]')).color,
      readout: getComputedStyle(r.querySelector('[data-role="readout-line"]')).color,
      eyebrow: getComputedStyle(r.querySelector('[data-role="eyebrow"]')).color,
      dot: getComputedStyle(r.querySelector('.status-dot')).backgroundColor,
    };
  });
  const crimson = Object.values(marks).filter((c) => c === 'rgb(255, 128, 144)' || c === 'rgb(227, 32, 63)').length; // --crim-300, or the error dot's
  assert(crimson === 2 && marks.label === 'rgb(255, 128, 144)', `crimson marks ${JSON.stringify(marks)}`);
  assert(await text(page, '[data-role="eyebrow-text"]') === 'Server channel', `eyebrow ${await text(page, '[data-role="eyebrow-text"]')}`);
  assert(/can't reach your messages/.test(await text(page, '[data-role="readout-line"]')), `readout ${await text(page, '[data-role="readout-line"]')}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T199 a batch that skips only a chat you can\'t read is a clean finish that names it calmly', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  await pickBatch(page, ['c:5007', 'c:5002']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 15000);
  assert(await text(page, '[data-role="hero-sub"]') === "Purged 10 messages~ skipped 1 chat you can't read ✨", `verdict "${await text(page, '[data-role="hero-sub"]')}"`);
  const done = await statusParts(page);
  assert(/^Done in \d+s · skipped #mod-only$/.test(plainWords(done.words)) && done.tone === 'success' && done.flair === ' ♡', `footer ${JSON.stringify(done)}`);
  assert(await srNow(page) === "Purged 10 messages~ skipped 1 chat you can't read. ", `heard ${await srNow(page)}`);
  assert(await text(page, '[data-role="mood"]') === 'one door stayed locked~', `mood ${await text(page, '[data-role="mood"]')}`);
  assert(await page.locator('[data-role="readout"]').getAttribute('data-tone') === 'cheer', 'the rose verdict of a clean finish');
  const log = await logText(page);
  assert(/skipped \(no access\): #mod-only/.test(log) && !/NEEDS ANOTHER LOOK/.test(log), 'the log notes the locked chat calmly');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T200 Discord still searching: one plain phrase, a next step, and no alarm', async () => {
  {
    const { page, pageErrors, context } = await boot('/channels/4001/5001', { deepIndex: ['5001'] });
    await page.click('[data-act="scan"]');
    await heroAt(page, 'partial/count', 6000);
    assert(await text(page, '[data-role="readout-line"]') === 'Discord may find older ones later~', `readout ${await text(page, '[data-role="readout-line"]')}`);
    const st = await statusParts(page);
    assert(st.words === 'Purify now, then once more later for the rest' && st.tone === 'info', `footer ${JSON.stringify(st)}`);
    assert(await srNow(page) === '40 messages found so far. ', `heard ${await srNow(page)}`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    const { page, pageErrors, context } = await boot('/channels/4001/5004', { deepIndex: ['5004'], indexingOnce: ['5004'], viewport: { width: 1280, height: 600 } });
    await page.click('[data-act="scan"]');
    await heroAt(page, 'indexing/icon', 6000);
    assert(await text(page, '[data-role="count-label"]') === 'still searching', `label ${await text(page, '[data-role="count-label"]')}`);
    const st = await statusParts(page);
    assert(st.words === 'Discord is still searching~ count again in a minute' && st.tone === 'calm', `footer ${JSON.stringify(st)}`);
    const c = await ringClearance(page);
    assert(c.label >= 5, `the label clears the arc ${JSON.stringify(c)}`);
    assert(!/indexing/i.test(await seenText(page)), 'Discord\'s word stays in the log');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T201 the footer names the next step: numbers, "immune" and "paused" said at most twice', async () => {
  {
    const { page, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 150 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /40 messages found/);
    assert(await srNow(page) === '40 messages found. ', `heard ${await srNow(page)}`);
    assert((await statusParts(page)).words === "Counted~ press Purify when you're ready", `footer ${await status(page)}`);
    const counted = await seenText(page);
    assert(times(counted, /\b40\b/g) <= 2, `"40" ${times(counted, /\b40\b/g)} times: ${counted}`);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 2);
    await page.click('[data-act="pause"]');
    await untilStatus(page, /^Resume picks up right here~$/);
    assert(await text(page, '[data-role="eyebrow-text"]') === 'Paused', `eyebrow ${await text(page, '[data-role="eyebrow-text"]')}`);
    const paused = await seenText(page);
    assert(times(paused, /paused/gi) <= 2, `"paused" ${times(paused, /paused/gi)} times: ${paused}`);
    await page.click('[data-act="stop"]');
    await waitEnd(page);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    const { page, pageErrors, context } = await boot('/channels/@me/3001');
    await untilStatus(page, /^Open another chat to purify~$/);
    assert(await srNow(page) === '⁨Bardo⁩ is immune. ', `heard ${await srNow(page)}`);
    assert(/Bardo & Dopa made the purifier/.test(await text(page, '[data-role="readout-line"]')), `readout ${await text(page, '[data-role="readout-line"]')}`);
    assert(await text(page, '[data-role="eyebrow-text"]') === 'Direct message', `eyebrow ${await text(page, '[data-role="eyebrow-text"]')}`);
    const immune = await seenText(page);
    assert(times(immune, /immune/gi) <= 2, `"immune" ${times(immune, /immune/gi)} times: ${immune}`);
    assert(await page.locator('.target .shield-btn').getAttribute('title') === 'Immune ♡ tap to remove the shield', 'the shield says tap, like the readout');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T202 error lines a person can act on: the login, a human check, a shield that didn\'t save', async () => {
  {
    const { page, context } = await boot('/channels/4001/5001', { badToken: true });
    await untilStatus(page, /^Login not working$/, 6000);
    assert(await text(page, '[data-role="readout-line"]') === "Couldn't use your Discord login~ reload Discord and try again", `readout ${await text(page, '[data-role="readout-line"]')}`);
    await context.close();
  }
  {
    const { page, pageErrors, context } = await bootProbe('/channels/4001/5001', ['emit', 'state']);
    await endAs(page, { error: 'Discord wants a human check — take a break before trying again', errorStatus: 400, errorCode: 'captcha' });
    await heroAt(page, 'done/count');
    assert(await text(page, '[data-role="readout-line"]') === "Discord wants to check you're human~ take a break, then press Purify to finish", `readout ${await text(page, '[data-role="readout-line"]')}`);
    assert(await text(page, '[data-role="mood"]') === 'taking a break, princess~', `mood ${await text(page, '[data-role="mood"]')}`);
    assert((await statusParts(page)).words === 'Discord wants a human check', `footer ${await status(page)}`);
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
  {
    const { page, pageErrors, context } = await boot('/channels/@me/3002', { world: buildWorld({ names: 'long' }) });
    // Discord's storage full to the brim: the shield can't be saved.
    await page.evaluate(() => {
      for (const size of [1e6, 1e5, 1e4, 1e3, 100, 10, 1]) {
        try { for (let i = 0; ; i++) localStorage.setItem(`fill-${size}-${i}`, 'x'.repeat(size)); } catch {}
      }
    });
    await page.click('.target .shield-btn');
    await untilStatus(page, /^Couldn't save~/);
    assert(plainWords(await status(page)) === "Couldn't save~ Alice the Magnificent Wanderer ✿ isn't immune yet", `footer ${await status(page)}`);
    const fit = await page.evaluate(() => {
      const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
      return { whole: t.scrollHeight <= t.clientHeight + 1, lines: Math.round(t.clientHeight / 16) };
    });
    assert(fit.whole && fit.lines <= 2, `the line is cut short ${JSON.stringify(fit)}`);
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('fill-')) localStorage.removeItem(k); });
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T203 while purifying, the footer never shows a message, and comes back after a wait', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5002', { latencyMs: 20 });
  let n = 0;
  await page.route(/\/api\/v9\/channels\/5002\/messages\/\d+$/, (route) => (route.request().method() !== 'DELETE' || ++n !== 3 ? route.fallback()
    : route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'You are being rate limited.', retry_after: 1, global: false }) })));
  await noteLines(page);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await untilStatus(page, /^Taking a breather~/, 6000);
  await untilStatus(page, /^Purifying~ you can minimise me/, 6000);
  await waitEnd(page);
  const lines = await linesSeen(page);
  assert(lines.some((l) => /^Purifying~ you can minimise me/.test(l)), `lines ${JSON.stringify(lines)}`);
  assert(!lines.some((l) => /Deleted|"|chatter|message #/.test(l)), `a message reached the footer: ${JSON.stringify(lines)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T204 in a batch a 100-character name never hides the progress', async () => {
  const { page, pageErrors, context } = await bootPaced('/channels/@me', { deleteMs: 120, world: buildWorld({ names: 'long' }) });
  await pickBatch(page, ['c:5001']);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /^Counted~/, 8000);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => / 4 of 40 /.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent.replace(/ /g, ' ')), null, { timeout: 10000 });
  const r = await page.evaluate(() => {
    const t = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
    const node = t.firstChild;
    const at = node.nodeValue.indexOf('of 40');
    const range = document.createRange();
    range.setStart(node, Math.max(0, at - 3));
    range.setEnd(node, at + 5);
    const a = range.getBoundingClientRect(), b = t.getBoundingClientRect();
    return { text: node.nodeValue, inside: a.right <= b.right + 0.5 && a.left >= b.left - 0.5 && a.bottom <= b.bottom + 0.5 };
  });
  assert(r.inside && /^Chat 1 of 1 · \d+ of 40 · /.test(r.text.replace(/ /g, ' ')), `progress ${JSON.stringify(r)}`);
  await page.click('[data-act="stop"]');
  await waitEnd(page);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T205 This chat during a batch names the chat being purified, and the one on screen', async () => {
  const { page, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 150 });
  await pickBatch(page, ['c:3002', 'c:3004']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.click('.tab[data-tab="current"]');
  await page.waitForFunction(() => /^Purifying · chat 1 of 2$/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="eyebrow-text"]').textContent.replace(/ /g, ' ')), null, { timeout: 4000 });
  const card = await page.evaluate(() => {
    const r = document.querySelector('#dopa-purifier-host').shadowRoot;
    const viewing = r.querySelector('[data-role="target-viewing"]');
    return { name: r.querySelector('[data-role="target-name"]').textContent, viewing: viewing.hidden ? '' : viewing.textContent };
  });
  assert(card.name !== 'general' && /Alice|Carol|group/i.test(card.name), `the card names ${JSON.stringify(card)}`);
  assert(card.viewing === 'viewing general', `viewing ${JSON.stringify(card)}`);
  await page.click('[data-act="stop"]');
  await waitEnd(page, 10000);
  assert(await text(page, '[data-role="target-name"]') === 'general', 'after the run the card is the chat on screen again');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T263 people updating from 4.1 keep their shields and see what changed, once', async () => {
  const blob = { x: 120, y: 90, open: true, muted: false, tab: 'current', welcomed: true, protectedIds: ['2002'], released: [] };
  const { page, pageErrors, context } = await boot('/channels/@me/3003', { prefs: blob });
  assert(await page.locator('[data-role="welcome"]').isHidden(), 'no welcome for someone updating');
  const note = await statusParts(page);
  assert(note.words === 'New look~ Purify counts first, then you hold to confirm' && note.flair === ' ♡', `note ${JSON.stringify(note)}`);
  await goTo(page, '/channels/@me/3004');
  await page.waitForFunction(() => /Ready to purify/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), null, { timeout: 4000 });
  await page.waitForTimeout(400); // the prefs save settles
  await reboot(page);
  assert(!/New look/.test(await status(page)), `shown again after a reload: ${await status(page)}`);
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3002"].row-immune');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dopa-purifier:prefs')));
  assert(stored.protectedIds.includes('2002') && stored.x === 120 && typeof stored.seenVersion === 'string', `prefs ${JSON.stringify(stored)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T264 a batch where only a chat you can\'t read was picked purges nothing, and says so plainly', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  await pickBatch(page, ['c:5007']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 15000);
  assert(await text(page, '[data-role="hero-sub"]') === "Nothing purged~ 1 chat you can't read", `verdict "${await text(page, '[data-role="hero-sub"]')}"`);
  assert(await text(page, '[data-role="mood"]') === 'one door stayed locked~', `mood ${await text(page, '[data-role="mood"]')}`);
  assert((await statusParts(page)).tone === 'warn', 'nothing purged needs the person');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T265 Many chats says Purifying again~ on resume, and its numbers lead each line', async () => {
  const { page, pageErrors, context } = await bootPaced('/channels/4001/5001', { deleteMs: 120 });
  await pickBatch(page, ['c:3002']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 2);
  await page.click('[data-act="pause"]');
  await untilStatus(page, /^Resume picks up right here~$/);
  await page.click('[data-act="resume"]');
  const again = await statusParts(page);
  assert(again.words === 'Purifying again~' && again.flair === ' ✨' && again.tone === 'info', `resumed ${JSON.stringify(again)}`);
  await page.waitForFunction(() => /^Chat 1 of 1 · \d+ of \d+ · /.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent.replace(/ /g, ' ')), null, { timeout: 4000 });
  await page.click('[data-act="stop"]');
  await waitEnd(page);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T266 a group DM purged clean says Discord\'s own notices stay, and the log names the kind', async () => {
  const { page, pageErrors, context } = await boot('/channels/@me/3004');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(await text(page, '[data-role="readout-line"]') === "All clean~ only Discord's own notices stay ✨", `verdict "${await text(page, '[data-role="readout-line"]')}"`);
  assert(/kept a member-added notice — Discord doesn't let anyone delete those/.test(await logText(page)), 'the log names what stayed');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T267 a batch Discord is still searching ends calmly with when to come back', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001', { deepIndex: ['5002'] });
  await pickBatch(page, ['c:5002']);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page, 15000);
  assert(await text(page, '[data-role="hero-sub"]') === 'Discord may find older ones later~', `verdict "${await text(page, '[data-role="hero-sub"]')}"`);
  const done = await statusParts(page);
  assert(done.words === '1 chat needs another go later~ Discord is still searching' && done.tone === 'calm', `footer ${JSON.stringify(done)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
