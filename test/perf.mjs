// Timing budgets: measured on this machine, logged, never gating.
// Shared CI runners are too noisy for absolute milliseconds, so npm test asserts what a change costs
// in structure (requests, nodes, what a tick touches) and this script keeps the clocks. It always
// exits 0. Each budget names the decision it guards; ✗ marks one over budget, ? one that couldn't run.
//   node test/perf.mjs [userscript.js] [--only=T209,T230]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDiscord, injectUserscript, buildWorld } from './mock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const SRC = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(here, '../dist/dopas-discord-purifier.user.js'));
const source = fs.readFileSync(SRC, 'utf8');
const only = (args.find((a) => a.startsWith('--only=')) || '').slice('--only='.length).split(',').filter(Boolean);
const SR = "document.querySelector('#dopa-purifier-host').shadowRoot";
const results = [];

function budget(name, value, limit, unit = 'ms') {
  const ok = value <= limit;
  results.push({ name, value, limit, unit, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}: ${value} ${unit} (budget ${limit} ${unit})`);
}

async function measure(name, fn) {
  if (only.length && !only.some((o) => name.startsWith(o))) return;
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    results.push({ name, error: String((err && err.message) || err).split('\n')[0] });
    console.log(`? ${name}: couldn't measure (${results.at(-1).error})`);
  }
  console.log(`  ${name} took ${Math.round((Date.now() - t0) / 1000)} s`);
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Math.round(x * 10) / 10;

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.log(`? no browser to measure with (${String(err.message).split('\n')[0]})`);
  process.exit(0);
}

async function boot(where, opts = {}, fast = true) {
  const env = await openDiscord(browser, where, opts);
  await injectUserscript(env.page, source, { fast });
  await env.page.waitForFunction(`${SR}.querySelector('[data-role="target-name"]').textContent !== 'finding this chat…'`, null, { timeout: 15000 });
  return env;
}

async function hold(page, ms = 1100) {
  const btn = page.locator('[data-act="confirm"]');
  await btn.waitFor({ state: 'visible' });
  const box = await btn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.mouse.move(10, 10);
}

async function taskSeconds(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'TaskDuration').value;
}

const purged = (page) => page.evaluate(`Number(${SR}.querySelector('[data-role="tf-purged"]').textContent)`);
const longTasks = () => {
  window.__long = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask' });
};

// D41 (T209): with 806 rows and 40 servers open, a tick and a server's select-all stay under a frame's worth.
await measure('T209 Many chats with 806 rows and 40 servers open', async () => {
  const { page, context } = await boot('/channels/4001/5001', { world: buildWorld({ crowd: 'scale' }) });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForFunction(`${SR}.querySelectorAll('[data-role="dm-list"] .row').length >= 806 && ${SR}.querySelectorAll('.guild').length >= 152`, null, { timeout: 60000 });
  await page.evaluate(async (sr) => {
    const r = eval(sr);
    for (const head of [...r.querySelectorAll('.guild-head')].slice(0, 40)) { head.click(); await new Promise((done) => setTimeout(done, 30)); }
  }, SR);
  await page.waitForFunction(`[...${SR}.querySelectorAll('.guild-channels:not([hidden])')].every((list) => list.querySelector('.row') && !list.querySelector('.list-empty'))`, null, { timeout: 60000 });
  const ticks = await page.evaluate(async (sr) => {
    const boxes = [...eval(sr).querySelectorAll('[data-role="dm-list"] .row .check')].slice(20, 25);
    const out = [];
    for (const box of boxes) {
      const t0 = performance.now();
      box.click();
      out.push(performance.now() - t0);
      await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));
    }
    return out;
  }, SR);
  budget('T209 a tick, median of 5 (D41)', round(median(ticks)), 50);
  // Its handler awaits the server's channels (already loaded), so time it to the end of that task.
  const all = await page.evaluate(async (sr) => {
    const box = eval(sr).querySelector('.guild-all .check');
    const t0 = performance.now();
    box.click();
    await new Promise((done) => setTimeout(done, 0));
    return performance.now() - t0;
  }, SR);
  budget('T209 a server\'s select-all (D41)', round(all), 50);
  await context.close();
});

// D46 (T220): the hold never stutters, on fresh pages with the sound on.
await measure('T220 the hold on 8 fresh pages', async () => {
  let worstHold = 0;
  let worstOpen = 0;
  for (let i = 0; i < 8; i++) {
    const { page, context } = await boot('/channels/4001/5002');
    await page.evaluate(longTasks);
    await page.evaluate((sr) => {
      const r = eval(sr);
      new MutationObserver(() => { if (r.querySelector('.modal-layer').dataset.open === 'true' && !window.__opened) window.__opened = performance.now(); })
        .observe(r.querySelector('.modal-layer'), { attributes: true });
      document.addEventListener('pointerdown', () => { window.__down = performance.now(); }, true);
    }, SR);
    await page.click('[data-act="purify"]');
    await page.waitForSelector('.modal-layer[data-open="true"]');
    await hold(page);
    await page.waitForTimeout(800);
    const seen = await page.evaluate(() => ({ long: window.__long, opened: window.__opened, down: window.__down }));
    const within = (from, ms) => Math.max(0, ...seen.long.filter((t) => t.at + t.ms > from && t.at < from + ms).map((t) => t.ms));
    worstHold = Math.max(worstHold, within(seen.down, 1000));
    worstOpen = Math.max(worstOpen, within(seen.opened, 200));
    await context.close();
  }
  budget('T220 longest task in the hold\'s first second (D46)', round(worstHold), 50);
  budget('T220 longest task as the dialog opens (D46)', round(worstOpen), 50);
});

// D49 (T230): what one kill costs the main thread at the shipped pace, open and minimised.
await measure('T230 a kill in #general at the shipped pace', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 30 }, false);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 15000 });
  await hold(page);
  await page.waitForTimeout(2000);
  for (const [where, limit] of [['open', 30], ['minimised', 6]]) {
    if (where === 'minimised') { await page.click('[data-act="minimize"]'); await page.waitForTimeout(800); }
    const k0 = await purged(page);
    const s0 = await taskSeconds(cdp);
    await page.waitForTimeout(12000);
    const kills = (await purged(page)) - k0;
    budget(`T230 main thread per kill, ${where} (D49)`, round(((await taskSeconds(cdp)) - s0) * 1000 / Math.max(1, kills)), limit);
  }
  await context.close();
});

// D49 (T230): the same with a heavy account's lists drawn: 1,006 rows, the audit's 14,778-node world.
await measure('T230 a kill in Many chats with 1,006 rows drawn', async () => {
  const { page, context } = await boot('/channels/4001/5001', { latencyMs: 30, world: buildWorld({ crowd: 'nodes' }) }, false);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForFunction(`${SR}.querySelectorAll('[data-role="dm-list"] .row').length >= 1006`, null, { timeout: 60000 });
  await page.evaluate(`${SR}.querySelector('[data-key="c:3002"] .check').click()`);
  await page.click('[data-act="purify"]');
  await page.waitForSelector('.modal-layer[data-open="true"]', { timeout: 15000 });
  await hold(page);
  await page.waitForTimeout(4000);
  const k0 = await purged(page);
  const s0 = await taskSeconds(cdp);
  await page.waitForTimeout(15000);
  const kills = (await purged(page)) - k0;
  budget('T230 main thread per kill, 1,006 rows (D49)', round(((await taskSeconds(cdp)) - s0) * 1000 / Math.max(1, kills)), 200);
  await context.close();
});

// D50 (T237): a tab switch on the 14,778-node world drops no frame.
await measure('T237 a tab switch with 1,006 rows', async () => {
  const { page, context } = await boot('/channels/4001/5001', { world: buildWorld({ crowd: 'nodes' }) });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForFunction(`${SR}.querySelectorAll('[data-role="dm-list"] .row').length >= 1006`, null, { timeout: 60000 });
  await page.click('.tab[data-tab="current"]');
  await page.waitForTimeout(600);
  let worst = 0;
  for (const tab of ['batch', 'current', 'batch']) {
    const gaps = await page.evaluate(([sr, to]) => new Promise((done) => {
      const out = [];
      let last = performance.now();
      const t0 = last;
      eval(sr).querySelector(`.tab[data-tab="${to}"]`).click();
      const frame = (now) => { out.push(now - last); last = now; if (now - t0 < 500) requestAnimationFrame(frame); else done(out); };
      requestAnimationFrame(frame);
    }), [SR, tab]);
    worst = Math.max(worst, ...gaps);
    await page.waitForTimeout(300);
  }
  budget('T237 longest frame in a tab switch (D50)', round(worst), 25);
  await context.close();
});

// D33 (T190): the userscript's boot never blocks Discord for long.
await measure('T190 boot', async () => {
  const { page, context } = await openDiscord(browser, '/channels/4001/5001');
  await page.evaluate(longTasks);
  await injectUserscript(page, source);
  await page.waitForFunction(`${SR}.querySelector('[data-role="target-name"]').textContent !== 'finding this chat…'`, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const long = await page.evaluate(() => window.__long.map((t) => t.ms));
  budget('T190 longest task while booting (D33)', round(Math.max(0, ...long)), 100);
  await context.close();
});

await browser.close();
const over = results.filter((r) => r.ok === false).length;
const failed = results.filter((r) => r.error).length;
console.log(`\n${results.length - over - failed} within budget, ${over} over, ${failed} not measured (logged only; this never fails a build)`);
process.exit(0);
