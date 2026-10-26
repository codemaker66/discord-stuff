// End-to-end behaviour tests for the v4 purifier against the stateful mock Discord.
// node e2e.mjs <userscript.js> [outDir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDiscord, injectUserscript, installMockDiscord, buildWorld, TOKEN } from './mock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(process.argv[2] || path.join(here, '../dist/dopas-discord-purifier.user.js'));
const PLUGIN = path.join(path.dirname(SRC), 'DopasPurifier.plugin.js');
const OUT = process.argv[3] || path.join(here, 'out/e2e');
fs.mkdirSync(OUT, { recursive: true });
const source = fs.readFileSync(SRC, 'utf8');
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const browser = await chromium.launch();
const results = [];

async function test(name, fn) {
  if (only && !only.some((o) => name.startsWith(o))) return;
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
  await env.page.waitForFunction(() => {
    const el = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]');
    return el && el.textContent !== 'finding this chat…';
  }, null, { timeout: 8000 });
  return env;
}

const text = (page, sel) => page.locator(sel).first().textContent();
const count = async (page) => Number((await text(page, '[data-role="count"]')).replace(/\D/g, '')) || 0;
const status = (page) => text(page, '[data-role="status-text"]');

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
  await page.waitForFunction(() => /found|clear/i.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  assert(stats.searches - before === 1, `scan used ${stats.searches - before} searches`);
  assert((await status(page)).startsWith('40 messages found'), `status: ${await status(page)}`);
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
  assert(/^Done in .* · 0 failed/.test(await status(page)), `final status ${await status(page)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await page.screenshot({ path: `${OUT}/t1-done.png` });
  await context.close();
});

await test('T2 DM: search count, history purge, call message skipped not failed', async () => {
  const { page, stats, world, pageErrors, context } = await boot('/channels/@me/3002');
  assert((await text(page, '[data-role="target-name"]')) === 'Alice ✿', 'dm name uses display name');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found|clear/i.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  assert((await status(page)).startsWith('31 messages found'), `scan status ${await status(page)}`);
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  const left = mine(world, '3002');
  assert(left.length === 1 && left[0].type === 3, `left: ${JSON.stringify(left.map((m) => m.type))}`);
  assert(stats.deletes.length === 31, `deleted ${stats.deletes.length}`);
  const logText = await page.locator('[data-role="term-body"]').textContent();
  assert(/skipped a system message/.test(logText), 'skip logged');
  assert(!/FAILED/.test(logText), 'no failures');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T3 protected DM is immune in current tab', async () => {
  const { page, stats, context } = await boot('/channels/@me/3001');
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'purify disabled');
  assert(await page.locator('[data-act="scan"]').isDisabled(), 'scan disabled');
  assert((await text(page, '[data-role="eyebrow"]')).includes('Immune'), 'immune eyebrow');
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
  await page.click('[data-key="u:2004"]');
  await page.locator('.guild-head').first().click();
  await page.waitForSelector('[data-key="c:5002"]');
  await page.click('[data-key="c:5002"]');
  await page.click('[data-key="c:5007"]');
  assert((await text(page, '[data-role="purify-count"]')) === '4', `count chip ${await text(page, '[data-role="purify-count"]')}`);
  assert((await text(page, '[data-role="tab-badge"]')) === '4', 'tab badge');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /Scan done/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), null, { timeout: 15000 });
  assert(stats.opened.length === 0, 'scanning never opens a DM');
  assert(/no DM yet/.test(await page.locator('[data-key="u:2004"]').textContent()), 'friend row says it has no DM yet');
  const readyTag = await page.locator('[data-key="c:3003"] .row-tag').textContent();
  assert(/READY FOR PURGE/.test(readyTag), `ready tag ${readyTag}`);
  await page.screenshot({ path: `${OUT}/t5-scanned.png` });
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  assert(await page.locator('.modal-item').count() === 4, 'modal lists 4');
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
  assert(/skipped/.test(await status(page)), `skipped channel is reported, not "all clean": ${await status(page)}`);
  assert(await page.locator('.confetti').count() === 0, 'no confetti for a run with a skipped channel');
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
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), null, { timeout: 10000 });
  assert((await status(page)).startsWith('40 messages found'), await status(page));
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
  assert((await status(page)).startsWith('Paused~'), await status(page));
  await page.screenshot({ path: `${OUT}/t8-paused.png` });
  await page.click('[data-act="resume"]');
  await page.waitForFunction((n) => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= n + 3, a);
  await page.click('[data-act="stop"]');
  await waitEnd(page, 5000);
  const stoppedAt = stats.deletes.length;
  await page.waitForTimeout(500);
  assert(stats.deletes.length === stoppedAt, 'no deletes after stop');
  assert(stoppedAt < 40 && mine(world, '5001').length === 40 - stoppedAt, 'partial');
  assert(/^Stopped~/.test(await status(page)), await status(page));
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
  assert(disabled || /logged out/i.test(st), `status ${st}`);
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
  assert(!(await page.locator('.panel').isVisible()), 'panel hidden');
  await waitEnd(page);
  assert(mine(world, '5002').length === 0, 'run completed while minimised');
  assert(await page.locator('.orb[data-live="done"]').count() === 1, 'orb shows the finished run');
  await page.click('.orb');
  await page.waitForTimeout(500);
  assert(await page.locator('.panel').isVisible(), 'restored');
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
  await page.waitForSelector('[data-key="u:2004"]');
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
  assert(beaded === 1, 'ring is notched for 31 messages');
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  await context.close();
});

await test('T16 thread replies found by a parent-channel search are deleted in their thread', async () => {
  const { page, stats, world, context } = await boot('/channels/4001/5003');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  assert((await status(page)).startsWith('5 messages found'), await status(page));
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
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  assert((await status(page)).startsWith('40 messages found'), await status(page));
  await page.evaluate(() => localStorage.setItem('token', JSON.stringify('mock-token.b')));
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found|Switched Discord accounts/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  await page.waitForTimeout(300);
  if (!/5 messages found/.test(await status(page))) {
    await page.click('[data-act="scan"]');
    await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  }
  assert(/5 messages found/.test(await status(page)), `second account count: ${await status(page)}`);
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

await test('T18 current channel without access ends with a problem, not "all clean"', async () => {
  const { page, world, context } = await boot('/channels/4001/5007');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  await waitEnd(page);
  assert(mine(world, '5007').length === 5, 'nothing deleted');
  const st = await status(page);
  assert(!/All clean|All clear/.test(st), `status ${st}`);
  assert(!/All clean|All clear/.test(await text(page, '[data-role="readout-line"]')), 'readout not all clean');
  assert(await page.locator('.confetti').count() === 0, 'no confetti');
  await context.close();
});

await test('T19 "All" skips friends without a DM', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="u:2004"]');
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
  assert(/another go|problems/.test(st), `status ${st}`);
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
  assert(/switched Discord accounts/.test(await status(page)), `status ${await status(page)}`);
  assert(mine(world, '5001').length > 0, 'run stopped before finishing');
  assert(firstDelete >= 0, 'had deletes');
  await context.close();
});

await test('T28 a run that ends badly while minimised does not show a happy orb', async () => {
  const { page, context } = await boot('/channels/4001/5007', { latencyMs: 400 });
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
  assert(/finishes/.test(await text(page, '[data-role="dm-list"]')), 'placeholder while running');
  await waitEnd(page);
  await page.waitForSelector('[data-key="c:3002"]', { timeout: 4000 });
  await page.waitForSelector('.guild', { timeout: 4000 });
  await context.close();
});

await test('T30 after Stop the cached count matches what is left', async () => {
  const { page, world, context } = await boot('/channels/4001/5001', { latencyMs: 30 });
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
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
    await page.waitForFunction(() => /indexing/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
    assert(/10 messages found so far/.test(await status(page)), `status: ${await status(page)}`);
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
    await page.waitForFunction(() => /indexing/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
    assert(!/All clear/.test(await text(page, '.panel')), 'no "All clear" while indexing');
    assert(!(await page.locator('[data-act="purify"]').isDisabled()), 'purify still offered at 0 found');
    // Batch: the row says it's still indexing instead of "no messages found".
    await page.click('.tab[data-tab="batch"]');
    await page.locator('.guild-head').first().click();
    await page.waitForSelector('[data-key="c:5002"]');
    await page.click('[data-key="c:5002"]');
    await page.click('[data-act="scan"]');
    await page.waitForFunction(() => /Scan done/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
    assert(await page.locator('[data-key="c:5002"][data-state="indexing"]').count() === 1, 'row marked indexing');
    assert(/still indexing/.test(await status(page)), `batch status: ${await status(page)}`);
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
    await page.waitForSelector('[data-key="u:2004"]');
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

// Like any native button, sliding off the hold button (here onto "Nevermind~") lets go of it.
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
      const cdp = await context.newCDPSession(page);
      const at = ([x, y]) => [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from) });
      await page.waitForTimeout(150);
      for (let i = 1; i <= 5; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at([from[0] + ((to[0] - from[0]) * i) / 5, from[1]]) });
        await page.waitForTimeout(20);
      }
      await page.waitForTimeout(1000);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await page.waitForTimeout(500);
    assert(stats.deletes.length === 0, `${input}: ${stats.deletes.length} deleted after sliding onto Nevermind`);
    assert(await dialogOpen(page), `${input}: dialog still open`);
    await holdConfirm(page); // a real hold still works afterwards
    await waitEnd(page);
    assert(stats.deletes.length === 10, `${input}: hold after the slide-off deleted ${stats.deletes.length}`);
    await context.close();
  }
});

// Screen readers, voice control and switches activate with a bare click (detail 0) and can't hold.
await test('T41 assistive tech confirms with two presses; mouse clicks and keys still need the hold', async () => {
  const { page, stats, context } = await boot('/channels/4001/5002');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const ax = nodes.find((x) => x.role && x.role.value === 'button' && /purify/i.test((x.name && x.name.value) || '') && !/Nevermind/.test(x.name.value));
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
  await page.waitForTimeout(5300);
  assert(/^Hold to purify/.test(await label()), `the first press expires: ${await label()}`);
  await press();
  assert(await dialogOpen(page) && stats.deletes.length === 0, 'one press after expiry only arms again');
  await press();
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
  for (const [what, btn] of [['row', row], ['card', card]]) {
    assert(await btn.isDisabled(), `${what} shield disabled mid-purge`);
    assert(/Stop the purge/.test(await btn.getAttribute('title')), `${what} title: ${await btn.getAttribute('title')}`);
  }
  await page.click('[data-act="resume"]');
  await waitEnd(page);
  assert(mine(world, '3002').length === 1, 'the confirmed DM was purged (only the call message stays)');
  assert(await row.isEnabled(), 'row shield usable after the run');
  assert(/^Protect/.test(await row.getAttribute('title')), `title after: ${await row.getAttribute('title')}`);
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
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="scan-label"]').textContent === 'Cancel scan');
  await page.click('[data-role="target-tools"] .shield-btn');
  assert((await scanLabel()) === 'Cancel scan', 'shielded while the scan was still running');
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="scan-label"]').textContent !== 'Cancel scan', null, { timeout: 15000 });
  assert(/is immune~/.test(await status(page)) && !/found/.test(await status(page)), `status: ${await status(page)}`);
  assert(await tone(page) === 'immune', 'immune tone');
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'purify stays off');
  await context.close();
});

// Purify asks Discord who you are before its dialog; a Scan pressed meanwhile must not run under it.
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
  await page.click('[data-act="scan"]');
  await page.waitForTimeout(1900); // Purify's question has been answered; the scan hasn't
  assert((await text(page, '[data-role="scan-label"]')) === 'Cancel scan', 'scan still running');
  assert(!(await dialogOpen(page)), 'no dialog over a running scan');
  await page.waitForFunction(() => /found/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), null, { timeout: 15000 });
  slow = false;
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
  let lead = await text(page, '.modal-lead');
  assert(!/\b0\+/.test(lead) && /^Purging all your messages in 3\schats \(not\scounted\syet\):$/.test(lead), `nothing counted: ${lead}`);
  assert((await text(page, '.modal-lead b')) === 'all', 'the bold word is "all"');
  await page.click('[data-act="cancel"]');
  // One chat counted, two not: the known number, plus all of yours in the rest.
  await page.click('[data-act="dm-none"]');
  await page.click('[data-key="c:3003"]');
  await page.click('[data-act="scan"]');
  await page.waitForFunction(() => /Scan done/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
  await page.click('[data-act="dm-all"]');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]');
  lead = await text(page, '.modal-lead');
  assert(/^Purging 7 found \+ all of yours in 2\suncounted\schats:$/.test(lead), `partly counted: ${lead}`);
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
  await env.page.waitForFunction(() => {
    const el = document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]');
    return el && el.textContent !== 'finding this chat…';
  }, null, { timeout: 8000 });
  return env;
}

async function pickBatch(page, keys) {
  await page.click('.tab[data-tab="batch"]');
  if (keys.some((k) => /^c:5/.test(k))) await page.locator('.guild-head').first().click();
  for (const k of keys) {
    await page.waitForSelector(`[data-key="${k}"]`);
    await page.click(`[data-key="${k}"]`);
  }
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

const untilStatus = (page, re, timeout = 3000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), re.source, { timeout });

// fetch() used to get no signal: a request that never answers trapped Cancel scan and Stop.
await test('T50 Cancel scan and Stop end a hung search at once', async () => {
  const { page, context } = await boot('/channels/4001/5001');
  const hold = await holdRequests(page, /\/messages\/search/, { once: false });
  await page.click('[data-act="scan"]');
  while (hold.held < 1) await page.waitForTimeout(10);
  await page.click('[data-act="scan"]'); // Cancel scan
  await untilStatus(page, /Scan cancelled/, 1500).catch(() => { throw new Error('Cancel scan stuck on a hung search'); });
  assert((await text(page, '[data-role="scan-label"]')) === 'Scan', 'scan button is back');
  await page.click('[data-act="purify"]');
  await holdConfirm(page);
  while (hold.held < 2) await page.waitForTimeout(10); // the run's count search hangs too
  await page.click('[data-act="stop"]');
  await waitEnd(page, 1500).catch(() => { throw new Error('Stop stuck on a hung search'); });
  assert(/^Stopped~/.test(await status(page)), `status ${await status(page)}`);
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
      assert(/^Stopped~/.test(await status(page)), `status ${await status(page)}`);
    } else {
      await waitEnd(page, 10000).catch(() => { throw new Error('run never got past the hung DELETE'); });
      assert(mine(world, '5002').length === 0, `${mine(world, '5002').length} left`);
      const log = await page.locator('[data-role="term-body"]').textContent();
      assert(/Connection hiccup/.test(log), 'the retry wait was shown');
      assert(/^Done in .* · 0 failed/.test(await status(page)), `status ${await status(page)}`);
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
    assert(/^Paused~/.test(await status(page)), `${label}: status ${await status(page)}`);
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
    assert(/^Stopped~/.test(await status(page)), `a: status ${await status(page)}`);
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
    await untilStatus(page, /Scan done/);
    await page.click('[data-act="purify"]');
    await holdConfirm(page);
    await page.waitForFunction(() => Number(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="count"]').textContent) >= 20);
    const mid = await hero(page);
    assert(/^\d+ of 40$/.test(mid.pct) && /left|double-checking/.test(mid.eta), `mid-run ${JSON.stringify(mid)}`);
    await waitEnd(page);
    const end = await hero(page);
    assert(end.pct === '40 of 40', `end ${JSON.stringify(end)}`);
    assert(/^1 chat skipped · no access · see Logs$/.test(await status(page)), `status ${await status(page)}`);
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
    assert(/^Done~ 13 wouldn't go/.test(await status(page)), `run ${runNo}: status ${await status(page)}`);
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
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="purify-count"]').textContent === '5');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Scan done/, 8000);
  const gaps = searches.slice(1).map((t, i) => t - searches[i]);
  assert(searches.length === 5 && Math.min(...gaps) >= 370, `${searches.length} searches, gaps ${gaps}`);
  const n = searches.length;
  await page.click('[data-act="scan"]');
  while (searches.length === n) await page.waitForTimeout(5);
  await page.waitForTimeout(50); // now in the pause before the next chat
  await page.click('[data-act="scan"]'); // Cancel scan
  await untilStatus(page, /Scan cancelled/, 1000);
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
    return { text: el.textContent, title: el.title, shown: el.offsetWidth > 0, whole: el.scrollWidth <= el.clientWidth,
      past: Math.round(el.getBoundingClientRect().right - root.querySelector('[data-role="shell"]').getBoundingClientRect().right),
      sideways: body.scrollWidth - body.clientWidth, ellipsis: getComputedStyle(el).textOverflow === 'ellipsis' };
  });
  // Every line stays inside the panel; a line that can't fit ends in an ellipsis and hovers in full.
  const check = async (when, expected, { fits = true } = {}) => {
    const s = await strip();
    assert(s.shown && s.past <= 0 && s.sideways <= 0, `${when}: "${s.text}" runs ${s.past}px past the panel (body ${s.sideways}px sideways)`);
    assert(fits ? s.whole : s.ellipsis, `${when}: "${s.text}" ${fits ? 'is cut short' : 'has no ellipsis'}`);
    assert(s.text === expected && s.title === expected, `${when}: "${s.text}" (title "${s.title}")`);
  };
  await pickBatch(page, ['u:2004']);
  await check('Bob alone', '1 chat selected · 1 friend at purge');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /counted as they're purged/);
  const said = await page.evaluate(() => {
    const el = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
    return { text: el.textContent, whole: el.scrollWidth <= el.clientWidth };
  });
  assert(said.text === "Closed DMs are counted as they're purged~ ♡" && said.whole, `status "${said.text}"${said.whole ? '' : ' is cut short'}`);
  await page.click('[data-key="c:3002"]');
  await check('before scan', '2 chats selected · 1 need a scan · 1 friend at purge', { fits: false });
  for (let i = 0; i < 2; i++) {
    await page.click('[data-act="scan"]');
    await untilStatus(page, /Scan done/);
    await check(`after scan ${i + 1}`, '2 chats selected · 31 found · 1 friend at purge');
  }
  await page.click('[data-key="c:3003"]');
  await page.click('[data-key="u:2005"]');
  await check('four chats', '4 chats selected · 31 found · 1 need a scan · 2 friends at purge', { fits: false });
  assert(stats.opened.length === 0, 'scanning opened no DM');
  await context.close();
});

const nameIs = (page, name) => page.waitForFunction((n) => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]').textContent === n, name, { timeout: 4000 });
const statusMatches = (page, re, timeout = 8000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), re.source, { timeout });

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
  assert((await text(page, '[data-role="scan-label"]')) === 'Scan', 'Try again is Scan again');
  await page.click('[data-act="scan"]');
  await statusMatches(page, /found/);
  assert((await status(page)).startsWith('10 messages found'), await status(page));
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
  await page.waitForFunction(() => /log in/.test(document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="server-list"]')?.textContent || ''));
  assert(/log in/.test(await text(page, '[data-role="dm-list"]')), 'DM list says why it is empty');
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
  await statusMatches(page, /Scan done/);
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
await test('T65 "no messages found" and the filter placeholder are readable', async () => {
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
  assert((await meta.textContent()) === 'no messages found', `meta ${await meta.textContent()}`);
  const clean = await contrast(meta, null);
  assert(clean.ratio >= 4.5, `"no messages found" at ${clean.ratio.toFixed(2)}:1 ${JSON.stringify(clean)}`);
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
  assert(await b.page.locator('[data-role="eyebrow"]').first().textContent() === 'Immune', 'tab B shows the chat as immune');
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
  await page.waitForSelector('[data-key="u:2004"]');
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
    assert((await status(page)) === 'Stopped to be safe~ you switched Discord accounts', `${tab}: status ${await status(page)}`);
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
    await page.waitForFunction(() => /Scan cancelled/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), null, { timeout: 2000 });
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
  await page.waitForFunction(() => /so far/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
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
  await page.waitForFunction(() => /Scan done/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
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
async function bootProbe(path, names, opts = {}) {
  const hook = 'return { start: () => whenAppReady(boot), destroy };';
  assert(source.includes(hook), 'the build still ends its closure the way the probe expects');
  const env = await openDiscord(browser, path, opts);
  await injectUserscript(env.page, source.replace(hook, `window.__dp = { ${names.join(', ')} };\n  ${hook}`));
  await env.page.waitForFunction(() => {
    const el = document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]');
    return el && el.textContent !== 'finding this chat…';
  }, null, { timeout: 8000 });
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
    assert(p.line === "You can't read this channel, so there's nothing here to purge", `no-access line ${p.line}`);
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
  await page.evaluate(() => window.__dp.setStatus('Scan cancelled~', 'info'));
  assert((await statusNow()).flair === null && (await statusNow()).text === 'Scan cancelled~', 'no flair, no span');

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
  const head = await page.locator('[data-role="drag"]').boundingBox();
  await page.mouse.move(head.x + 120, head.y + 20);
  await page.mouse.down();
  await page.mouse.move(head.x + 120, head.y + 120, { steps: 4 });
  await page.mouse.move(head.x + 120, head.y + 220, { steps: 4 });
  assert(await fit() === 'full', `mid-drag ${await fit()}`);
  await page.mouse.up();
  assert(await fit() === 'strip', `after the drop ${await fit()}`);
  await page.mouse.move(head.x + 120, head.y + 220);
  await page.mouse.down();
  await page.mouse.move(head.x + 120, head.y + 20, { steps: 6 });
  await page.mouse.up();
  assert(await fit() === 'full', `dragged home ${await fit()}`);

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
  assert(await heroIs(page) === 'none/label', `nothing picked ${await heroIs(page)}`);
  await page.click('[data-key="c:3003"]');
  assert(await heroIs(page) === 'unscanned/label', `picked, not counted ${await heroIs(page)}`);
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
  return { words: t.firstChild ? t.firstChild.nodeValue : '', flair: flair ? flair.textContent : '', tone: s.dataset.tone, glyph: getComputedStyle(r.querySelector('.status-dot'), '::before').content };
});
// Discord's own wording (codes, HTTP statuses, raw messages) belongs in the log only.
const RAW = /\(code|HTTP|Unauthorized|Missing Access|Service Unavailable|Network unreachable/;

await test('T140 a chat Discord won\'t open says so plainly, keeps Purify off, and Try again reads it again', async () => {
  {
    const env = await openDiscord(browser, '/channels/4001/5001', { badToken: true });
    await injectUserscript(env.page, source);
    const { page } = env;
    await untilStatus(page, /^Logged out of Discord$/, 6000);
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
    assert(card.state === 'blocked' && card.eyebrow === 'No access' && card.color === 'rgb(255, 128, 144)', `card ${JSON.stringify(card)}`);
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
    assert(await text(page, '[data-role="eyebrow-text"]') === 'Server channel' && await text(page, '[data-role="scan-label"]') === 'Scan again', 'the card and Scan are themselves again');
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
    await context.close();
  }
});

await test('T141 a count that fails says why in plain words: still indexing, offline, Discord down', async () => {
  // request()'s backoff waits seconds; here it waits milliseconds, so the cases take no time.
  const quick = source.replace('const seconds = 2 ** networkFails;', 'const seconds = 0.01;').replace('const seconds = 2 ** serverFails;', 'const seconds = 0.01;');
  assert(quick.split('const seconds = 0.01;').length === 3, 'the build still backs off the way this test expects');
  const json = (status, body) => (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const cases = [
    ['still indexing', json(202, { message: 'Index not yet available. Try again later', code: 110000, retry_after: 0.01 }), 'Discord is still indexing'],
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
    captcha: { status: 400, body: { captcha_key: ['captcha-required'], captcha_sitekey: 'x' }, short: 'Discord wants a captcha', line: 'Discord wants a captcha~ solve it in Discord, then press Purify to finish' },
    'logged out': { status: 401, body: { message: '401: Unauthorized', code: 0 }, short: 'Logged out of Discord', line: "You're logged out of Discord~ log in, then press Purify to finish" },
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
  assert(welcome.lead === 'Two steps and your messages are gone:' && welcome.steps === 2 && welcome.more === 'Purify many chats', `welcome ${JSON.stringify(welcome)}`);
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
    return `${r.querySelector('[data-role="eyebrow-text"]').textContent}|${r.querySelector('[data-role="target-name"]').textContent}|${ico.querySelector('svg') ? 'svg' : ico.textContent}`;
  });
  assert(await kind() === 'Server channel|general|#', `server channel: ${await kind()}`);
  for (const [path, want] of [['/channels/@me/3002', 'Direct message|Alice ✿|@'], ['/channels/@me/3004', 'Group DM|Alice ✿, Carol|svg'], ['/channels/@me', 'This chat|No chat open|✦']]) {
    await page.evaluate((p) => history.pushState({}, '', p), path);
    await page.waitForFunction((w) => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      const ico = r.querySelector('[data-role="target-ico"]');
      return `${r.querySelector('[data-role="eyebrow-text"]').textContent}|${r.querySelector('[data-role="target-name"]').textContent}|${ico.querySelector('svg') ? 'svg' : ico.textContent}` === w;
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
  assert(said.includes('Chat 1 of 2 · \u2068Alice ✿\u2069') && said.includes('Chat 2 of 2 · \u2068Alice ✿, Carol\u2069'), `chats: ${said.filter((x) => /^Chat \d of 2 · [^·]+$/.test(x))}`);
  assert(said.includes('Chat 1 of 2 · \u2068Alice ✿\u2069 · 1 of 31') && said.includes('Chat 2 of 2 · \u2068Alice ✿, Carol\u2069 · 3 of 3'), `per kill: ${said.filter((x) => / of \d+$/.test(x)).slice(0, 3)}`);
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
  assert(none.length === 1 && none[0].act === 'go-batch' && none[0].text === 'Purify many chats' && none[0].h === 40, `footer with no chat ${JSON.stringify(none)}`);
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
    assert(/^Done in \d+s · 0 failed$/.test(done.words) && done.flair === ' ♡' && done.tone === 'success', `footer ${JSON.stringify(done)}`);
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
    assert(/^All clear~ nothing to purge here/.test(await text(page, '[data-role="hero-sub"]')), `verdict "${await text(page, '[data-role="hero-sub"]')}"`);
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
    assert(/^Stopped at \d+ of 40~$/.test(await text(page, '[data-role="readout-line"]')), `verdict "${await text(page, '[data-role="readout-line"]')}"`);
    const done = await statusParts(page);
    assert(done.words === 'Stopped~ Purify picks up the rest' && done.tone === 'calm', `footer ${JSON.stringify(done)}`);
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
  assert(await text(page, '[data-role="readout-line"]') === "Purged 2 · 13 wouldn't go", `verdict "${await text(page, '[data-role="readout-line"]')}"`);
  const done = await statusParts(page);
  assert(done.words === "Done~ 13 wouldn't go · reasons in Logs" && done.tone === 'warn' && !done.flair, `footer ${JSON.stringify(done)}`);
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
  assert(/^Stopped to be safe~ you switched accounts · \d+ messages? purged( as @princess\.dopa)?$/.test(verdict), `verdict "${verdict}"`);
  assert(await heroIs(page) === 'done/count', `the verdict stays on screen: ${await heroIs(page)}`);
  const said = await statusParts(page);
  assert(said.words === 'Stopped to be safe~ you switched Discord accounts' && said.tone === 'warn', `footer ${JSON.stringify(said)}`);
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
  assert(/^Paused~ \d+ purged so far$/.test(paused.words) && paused.tone === 'calm' && paused.glyph === '""', `paused ${JSON.stringify(paused)}`);
  await page.click('[data-act="resume"]');
  const again = await statusParts(page);
  assert(again.words === 'Purging again~' && again.flair === ' ✨' && again.tone === 'info', `resumed ${JSON.stringify(again)}`);
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
  assert(found.flair === ' ✨' && !/\p{Extended_Pictographic}/u.test(await page.locator('[data-role="status"]').ariaSnapshot()), `found ${JSON.stringify(found)}`);
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
      "Couldn't save~ Alice ✿ is not immune (Discord's storage is full or blocked)",
      'Discord wants a captcha~ solve it in Discord, then press Purify to finish',
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
  await untilStatus(page, /^Scan done~/);
  const done = await statusParts(page);
  assert(done.words === 'Scan done~ 10 messages · 1 chat skipped · no access' && done.tone === 'warn', `scan verdict ${JSON.stringify(done)}`);
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

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
