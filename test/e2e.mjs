// End-to-end behaviour tests for the v4 purifier against the stateful mock Discord.
// node e2e.mjs <userscript.js> [outDir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { openDiscord, injectUserscript, installMockDiscord, buildWorld, TOKEN } from './mock.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
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
    return el && el.textContent !== 'detecting…';
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
  assert((await text(page, '[data-role="readout-line"]')).startsWith('All clean! Purged 40 messages'), 'hero verdict');
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
  assert(/another go|problems/.test(await status(page)), `skipped channel is reported, not "all clean": ${await status(page)}`);
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
  assert((await status(page)).startsWith('Stopped!'), await status(page));
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
  assert(disabled || /401|Unauthorized|token/i.test(st), `status ${st}`);
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
  await page.reload();
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
  await page.waitForFunction(() => /found|New account/.test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent));
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
  assert(!(await page.locator('[data-role="welcome"]').isVisible()), 'dismissed');
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
  await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]').textContent !== 'detecting…');
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
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent !== 'detecting…');
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
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent !== 'detecting…');
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
  // After a reload the page agrees with what it said.
  await page.reload();
  await injectUserscript(page, source);
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

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
