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
    return el && el.textContent !== 'detecting…';
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
  assert(/^Stopped!/.test(await status(page)), `status ${await status(page)}`);
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
      assert(/^Stopped!/.test(await status(page)), `status ${await status(page)}`);
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
    assert(/^Stopped!/.test(await status(page)), `a: status ${await status(page)}`);
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
    assert(/1 chat needs another go/.test(await status(page)), `status ${await status(page)}`);
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
  // Every line stays inside the panel and fits whole; a longer one would end in an ellipsis and hover in full.
  const check = async (when, expected) => {
    const s = await strip();
    assert(s.shown && s.past <= 0 && s.sideways <= 0, `${when}: "${s.text}" runs ${s.past}px past the panel (body ${s.sideways}px sideways)`);
    assert(s.whole && s.ellipsis, `${when}: "${s.text}" ${s.whole ? 'has no ellipsis to fall back on' : 'is cut short'}`);
    assert(s.text === expected && s.title === expected, `${when}: "${s.text}" (title "${s.title}")`);
  };
  await pickBatch(page, ['u:2004']);
  await check('Bob alone', '1 chat · 1 closed DM');
  await page.click('[data-act="scan"]');
  await untilStatus(page, /counted at purge/);
  const said = await page.evaluate(() => {
    const el = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]');
    return { text: el.textContent, whole: el.scrollWidth <= el.clientWidth };
  });
  assert(said.text === '1 friend counted at purge~ ♡' && said.whole, `status "${said.text}"${said.whole ? '' : ' is cut short'}`);
  await page.click('[data-key="c:3002"]');
  await check('before scan', '2 chats · 1 to scan · 1 closed DM');
  for (let i = 0; i < 2; i++) {
    await page.click('[data-act="scan"]');
    await untilStatus(page, /Scan done/);
    await check(`after scan ${i + 1}`, '2 chats · 1 closed DM');
  }
  await page.click('[data-key="c:3003"]');
  await page.click('[data-key="u:2005"]');
  await check('four chats', '4 chats · 1 to scan · 2 closed DMs');
  assert(stats.opened.length === 0, 'scanning opened no DM');
  await context.close();
});

const nameIs = (page, name) => page.waitForFunction((n) => document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="target-name"]').textContent === n, name, { timeout: 4000 });
const statusMatches = (page, re, timeout = 8000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('[data-role="status-text"]').textContent), re.source, { timeout });

// Any failed lookup of the open chat ends the same way; a 5xx blip that outlasts request()'s
// retries is the usual cause (one 403 here keeps the test fast). Retry is the user's, never a poll's.
await test('T60 a failed channel lookup offers Retry, and Retry recovers', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  let lookups = 0;
  await page.route('https://discord.com/api/v9/channels/5002', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (++lookups > 1) return route.fallback();
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'Missing Access', code: 50001 }) });
  });
  await page.click('a[href="/channels/4001/5002"]');
  await statusMatches(page, /Couldn't read this channel/);
  await page.waitForTimeout(1500);
  assert(lookups === 1, `looked the channel up again by itself (${lookups})`);
  assert(await page.locator('[data-act="scan"]').isEnabled(), 'Scan is usable after a failed lookup');
  assert((await text(page, '[data-role="scan-label"]')) === 'Retry', `scan label ${await text(page, '[data-role="scan-label"]')}`);
  assert(await page.locator('[data-act="purify"]').isDisabled(), 'no purging an unread chat');
  await page.click('[data-act="scan"]');
  await nameIs(page, 'art-share');
  assert(lookups === 2, `retry looked it up once (${lookups})`);
  assert((await status(page)) === 'Ready to purify~ ✨', `status after retry: ${await status(page)}`);
  assert((await text(page, '[data-role="scan-label"]')) === 'Scan', 'Retry is Scan again');
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
  await page.waitForFunction(() => /logged in/.test(document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="server-list"]')?.textContent || ''));
  assert(/logged in/.test(await text(page, '[data-role="dm-list"]')), 'DM list says why it is empty');
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
    assert(!(await page.locator('[data-role="welcome"]').isVisible()), 'dismissed');
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
    await page.waitForFunction(() => document.querySelector('#dopa-purifier-host')?.shadowRoot.querySelector('[data-role="target-name"]')?.textContent !== 'detecting…');
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
    assert(/switched Discord accounts/.test(await status(page)), `${tab}: status ${await status(page)}`);
    assert(await page.locator('[data-role="status"]').getAttribute('data-tone') === 'error', `${tab}: error tone`);
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
    return el && el.textContent !== 'detecting…';
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
  await untilStatus(page, /Scan error/);
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
    line: line.textContent,
    heard: heard(line),
    sub: r.querySelector('[data-role="hero-sub"]').textContent,
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
    stickerClear = { arc: Math.round(min), right: Math.round(body.right - s.right), top: Math.round(s.top - body.top) };
  }
  return { label: inside(r.querySelector('.count-label')), count: count.getClientRects().length ? inside(ink) : null, countWidth: Math.round(cb.width), ring: Math.round(g.width), stickerClear };
});

await test('T100 before a run the ring says how many of yours it found, never "0 messages purged"', async () => {
  const { page, pageErrors, context } = await boot('/channels/4001/5001');
  const seen = [];
  const look = async () => { const r = await ringNow(page); seen.push(r); return r; };
  let r = await look();
  assert(r.is === 'unscanned/icon' && r.icon === 'scan' && r.count === null && r.label === 'not counted yet', `uncounted ${JSON.stringify(r)}`);
  assert(r.line === 'Purify counts them first ♡' && r.heard === 'Purify counts them first' && r.pct === '', `uncounted line ${JSON.stringify(r)}`);
  const search = await holdRequests(page, /\/messages\/search/);
  await page.click('[data-act="scan"]');
  await heldBy(search);
  r = await look();
  assert(r.is === 'counting/icon' && r.label === 'counting…' && r.line === '', `counting ${JSON.stringify(r)}`);
  search.release();
  await untilStatus(page, /found/);
  r = await look();
  assert(r.is === 'ready/count' && r.count === '40' && r.label === 'ready for purge' && r.daggers === 0, `counted ${JSON.stringify(r)}`);
  assert(/^about \d+s to purge~$/.test(r.line) && r.pct === '', `counted line ${JSON.stringify(r)}`);
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
    else assert(r.count === null && r.label === 'no access' && r.labelColor === 'rgb(255, 128, 144)' && r.line === "You can't read this channel, so there's nothing here to purge", `blocked ${JSON.stringify(r)}`);
  }
  await goTo(page, '/channels/@me/3001');
  await heroAt(page, 'immune/icon');
  r = await look();
  assert(r.icon === 'shield' && r.label === 'immune' && r.labelColor === 'rgb(247, 203, 110)', `immune ${JSON.stringify(r)}`);
  assert(r.line === 'Immune from the start ♡ nothing here gets purged' && r.heard === 'Immune from the start nothing here gets purged', `immune line ${JSON.stringify(r)}`);
  assert(await text(page, '[data-role="mood"]') === "this one's immune~", `mood ${await text(page, '[data-role="mood"]')}`);
  // A shield you set yourself says how to undo it.
  await goTo(page, '/channels/@me/3002');
  await heroAt(page, 'unscanned/icon');
  await page.click('[data-role="target-tools"] .shield-btn');
  await heroAt(page, 'immune/icon');
  r = await look();
  assert(r.line === 'Immune ♡ tap the shield to undo', `your shield ${JSON.stringify(r)}`);
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
  assert(r.is === 'none/label' && r.label === 'nothing picked yet' && r.sub === 'tick any DMs or channels below~', `nothing picked ${JSON.stringify(r)}`);
  assert(r.labelLines === 1, `the strip's label wraps ${JSON.stringify(r)}`);
  for (const k of ['c:3003', 'c:3002', 'u:2004']) await page.click(`[data-key="${k}"]`);
  r = await ringNow(page);
  assert(r.is === 'unscanned/label' && r.label === 'not counted yet' && r.sub === '3 chats · 2 to scan · 1 closed DM', `picked ${JSON.stringify(r)}`);
  assert(r.labelLines === 1, `the strip's label wraps ${JSON.stringify(r)}`);
  await page.click('[data-act="scan"]');
  await untilStatus(page, /Scan done/, 8000);
  r = await ringNow(page);
  assert(r.is === 'ready/count' && r.count === '38' && r.label === 'ready for purge' && r.daggers === 2, `counted ${JSON.stringify(r)}`);
  assert(r.sub === '3 chats · 1 closed DM', `counted, with a closed DM ${JSON.stringify(r)}`);
  await page.click('[data-key="u:2004"]');
  r = await ringNow(page);
  assert(/^2 chats · about \d+s to purge~$/.test(r.sub), `ready ${JSON.stringify(r)}`);
  await page.locator('.guild-head').first().click();
  await page.waitForSelector('[data-key="c:5002"]');
  await page.click('[data-key="c:5002"]');
  r = await ringNow(page);
  assert(r.is === 'partial/count' && r.count === '38' && r.label === 'found so far' && r.daggers === 0 && r.sub === '3 chats · 1 to scan', `partly counted ${JSON.stringify(r)}`);
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
    return { height: root.querySelector('.hero').offsetHeight, readout: getComputedStyle(root.querySelector('[data-role="readout"]')).display, sub: root.querySelector('[data-role="hero-sub"]').textContent, fail: fail && getComputedStyle(fail).color };
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
  assert(paused === '0.78', `paused stats opacity ${paused}`);
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
      assert(r.count === '40' && r.label === 'ready for purge' && r.daggers === 2 && /^about \d+s to purge~$/.test(r.sub), `${where} strip ${JSON.stringify(r)}`);
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
    assert((await looping(page)).join() === 'dp-breathe@hero-face,dp-sweep@g-sweep', `counting: ${await looping(page)}`);
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
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    confirming = true;
    await holdConfirm(page);
    await heldBy(search);
    assert((await looping(page)).join() === 'dp-sweep@g-sweep', `unknown total: ${await looping(page)}`);
    // The sweep's path is the arc itself, so it never crosses the open bottom where "3 of 31+" sits.
    const offArc = await page.evaluate(() => {
      const p = document.querySelector('#dopa-purifier-host').shadowRoot.querySelector('.g-sweep');
      const len = p.getTotalLength();
      const out = [];
      for (let i = 0; i <= 100; i++) {
        const pt = p.getPointAtLength((len * i) / 100);
        const deg = (Math.atan2(pt.y - 100, pt.x - 100) * 180) / Math.PI;
        if (Math.abs(Math.hypot(pt.x - 100, pt.y - 100) - 84) > 0.5 || (deg > 45.5 && deg < 134.5)) out.push([pt.x.toFixed(1), pt.y.toFixed(1)]);
      }
      return out;
    });
    assert(offArc.length === 0, `sweep leaves the arc at ${JSON.stringify(offArc)}`);
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
    assert((await looping(page)).join() === 'dp-sweep@g-sweep', `last look: ${await looping(page)}`);
    look.release();
    await waitEnd(page);
    await context.close();
  }
  {
    // Reduced motion: no sweep at all, only the track breathing (opacity), never a frozen fake arc.
    const { page, context } = await boot('/channels/@me/3002', { reducedMotion: 'reduce' });
    let confirming = false;
    const search = await holdRequests(page, /\/messages\/search/, { match: () => confirming });
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    confirming = true;
    await holdConfirm(page);
    await heldBy(search);
    const rm = await page.evaluate(() => {
      const r = document.querySelector('#dopa-purifier-host').shadowRoot;
      return { sweep: getComputedStyle(r.querySelector('.g-sweep')).display, track: getComputedStyle(r.querySelector('.g-track')).animationName };
    });
    assert(rm.sweep === 'none' && rm.track === 'dp-breathe', `reduced motion ${JSON.stringify(rm)}`);
    search.release();
    await waitEnd(page);
    await context.close();
  }
});

// A build at a steadier pace, with the named closure bindings on window.__dp.
async function bootPaced(path, { deleteMs, probe = [], ...opts }) {
  const hook = 'return { start: () => whenAppReady(boot), destroy };';
  const src = source.replace(/deleteDelayMs:\s*\d+/, `deleteDelayMs: ${deleteMs}`).replace(/searchDelayMs:\s*\d+/, 'searchDelayMs: 10')
    .replace(hook, `window.__dp = { ${probe.join(', ')} };\n  ${hook}`);
  return bootWith(src, path, opts);
}

await test('T105 pace and time left are honest from the first kill; big counts fit; the orb says how it is going', async () => {
  {
    const { page, context } = await bootPaced('/channels/4001/5002', { deleteMs: 150 });
    await page.click('[data-act="scan"]');
    await untilStatus(page, /found/);
    const preview = (await ringNow(page)).line;
    assert(preview === 'about 4s to purge~', `preview ${preview}`);
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
    assert((await orb()).title === 'Paused~ click to open', `paused orb ${JSON.stringify(await orb())}`);
    await page.click('.orb');
    await page.waitForSelector('[data-role="shell"]:not([hidden])');
    await page.click('[data-act="resume"]');
    await page.click('[data-act="minimize"]');
    await page.waitForSelector('[data-role="shell"][hidden]', { state: 'attached' });
    const live = await orb();
    assert(/^Purging~ \d+ of 40$/.test(live.title) && /^Open Dopa's Purifier — purging, \d+ of 40$/.test(live.label), `running orb ${JSON.stringify(live)}`);
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

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
