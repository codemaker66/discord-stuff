// Capture every visible state of the v4 UI in the mock Discord for visual review.
// node shots.mjs <userscript.js> <outDir> [dpr] [--showcase]   (--showcase: friendly names, for docs/img)
// Runs at the shipped pace, so every ETA and rate on screen is one a friend will really see
// (tools/marketing.py turns these into docs/img and checks pace.json first). Takes a few minutes.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { openDiscord, injectUserscript } from './mock.mjs';

const SHOWCASE = process.argv.includes('--showcase');
const [SRC, OUT, DPR = '2'] = process.argv.slice(2).filter((a) => a !== '--showcase');
fs.mkdirSync(OUT, { recursive: true });
const source = fs.readFileSync(SRC, 'utf8');
// Each key on its own, so a new TIMING field (or a reorder) can't make this miss.
const timing = (/const TIMING = \{([^}]*)\}/.exec(source) || [])[1];
const paceOf = (key) => {
  const m = timing && new RegExp(`\\b${key}:\\s*(\\d+)`).exec(timing);
  if (!m) throw new Error(`${SRC}: no ${key} in const TIMING`);
  return Number(m[1]);
};
fs.writeFileSync(`${OUT}/pace.json`, JSON.stringify({ deleteDelayMs: paceOf('deleteDelayMs'), searchDelayMs: paceOf('searchDelayMs') }));
const browser = await chromium.launch();
const sr = "document.querySelector('#dopa-purifier-host').shadowRoot";

async function boot(path, opts = {}) {
  const env = await openDiscord(browser, path, { dpr: Number(DPR), showcase: SHOWCASE, ...opts });
  // Presentation only: soften the mock chat behind the panel (its test strings contain literal tags).
  await env.page.addStyleTag({ content: '.chat .txt, .chat .who { color: transparent !important; text-shadow: 0 0 7px rgba(219,222,225,.55); } .chat .ts { display: none; }' });
  await env.page.addScriptTag({ content: source });
  await env.page.waitForSelector('[data-role="layer"]', { state: 'attached' });
  await env.page.waitForFunction(`${sr}.querySelector('[data-role="target-name"]').textContent !== 'detecting…'`);
  await env.page.waitForTimeout(700);
  return env;
}
// Where the panel sits in each picture (device pixels), so tools/marketing.py can lift it out cleanly.
const panels = { dpr: Number(DPR), boxes: {} };
async function shot(page, name, clip) {
  await page.screenshot({ path: `${OUT}/${name}.png`, ...(clip ? { clip } : {}) });
  const b = await page.locator('.panel').boundingBox();
  const at = clip || { x: 0, y: 0 };
  if (b) panels.boxes[name] = [b.x - at.x, b.y - at.y, b.x - at.x + b.width, b.y - at.y + b.height].map((v) => Math.round(v * panels.dpr));
}
async function panelClip(page, pad = 40, extra = {}) {
  const b = await page.locator('.panel').boundingBox();
  const t = await page.locator('.term').isVisible() ? await page.locator('.term').boundingBox() : null;
  let x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
  if (t) { x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y); x1 = Math.max(x1, t.x + t.width); y1 = Math.max(y1, t.y + t.height); }
  return { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), width: Math.min(x1 - x0 + pad * 2, 1440), height: Math.min(y1 - y0 + pad * 2, 900 - Math.max(0, y0 - pad)), ...extra };
}
async function hold(page, ms) {
  const box = await page.locator('[data-act="confirm"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
}

// 0 first run: the welcome card
{
  const { page, context } = await boot('/channels/4001/5001', { firstRun: true });
  await page.waitForSelector('[data-role="welcome"]');
  await page.waitForTimeout(400);
  await shot(page, '00-welcome', await panelClip(page));
  await context.close();
}
// 1 idle, before scan
{
  const { page, context } = await boot('/channels/4001/5001');
  await shot(page, '01-idle', await panelClip(page));
  await page.click('[data-act="scan"]');
  await page.waitForFunction(`/found/.test(${sr}.querySelector('[data-role="status-text"]').textContent)`);
  await page.waitForTimeout(500);
  await shot(page, '02-scanned', await panelClip(page));
  await page.click('[data-act="purify"]');
  await page.waitForTimeout(450);
  await shot(page, '03-confirm');
  await hold(page, 480);
  await shot(page, '04-confirm-holding');
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForFunction(`Number(${sr}.querySelector('[data-role="count"]').textContent) >= 14`, null, { timeout: 60000 });
  await page.click('[data-act="logs"]');
  await page.waitForTimeout(500);
  await shot(page, '05-purging-logs', await panelClip(page));
  await page.click('[data-act="pause"]');
  await page.waitForTimeout(400);
  await shot(page, '06-paused', await panelClip(page));
  await page.click('[data-act="resume"]');
  await page.click('[data-act="logs"]');
  await page.waitForFunction(`${sr}.querySelector('[data-role="layer"]').dataset.run === 'idle'`, null, { timeout: 120000 });
  await page.waitForTimeout(350);
  await shot(page, '07-done-celebrate', await panelClip(page, 90));
  await page.waitForTimeout(2200);
  await shot(page, '08-done-settled', await panelClip(page));
  await page.click('[data-act="minimize"]');
  await page.waitForTimeout(500);
  const orb = await page.locator('.orb').boundingBox();
  await shot(page, '09-orb', { x: orb.x - 60, y: orb.y - 40, width: orb.width + 120, height: orb.height + 80 });
  await context.close();
}
// batch states
{
  const { page, context } = await boot('/channels/4001/5001');
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('[data-key="c:3003"]');
  await page.click('[data-key="c:3003"]');
  await page.click('[data-key="c:3002"]');
  await page.click('[data-key="u:2004"]');
  await page.locator('.guild-head').first().click();
  await page.waitForSelector('[data-key="c:5002"]');
  await page.click('[data-key="c:5002"]');
  await page.click('[data-key="c:5007"]');
  await page.waitForTimeout(400);
  await shot(page, '10-batch-selected', await panelClip(page));
  await page.click('[data-act="scan"]');
  await page.waitForFunction(`/Scan done/.test(${sr}.querySelector('[data-role="status-text"]').textContent)`, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  await shot(page, '11-batch-scanned', await panelClip(page));
  await page.click('[data-act="purify"]');
  await page.waitForTimeout(450);
  await shot(page, '12-batch-confirm');
  await hold(page, 1100);
  await page.mouse.up();
  await page.waitForFunction(`Number(${sr}.querySelector('[data-role="count"]').textContent) >= 10`, null, { timeout: 60000 });
  await shot(page, '13-batch-running', await panelClip(page));
  await page.waitForFunction(`${sr}.querySelector('[data-role="layer"]').dataset.run === 'idle'`, null, { timeout: 240000 });
  await page.waitForTimeout(2500);
  await shot(page, '14-batch-done', await panelClip(page));
  await context.close();
}
// immune + small viewport + reduced motion
{
  const { page, context } = await boot('/channels/@me/3001');
  await shot(page, '15-immune', await panelClip(page));
  await context.close();
}
{
  const { page, context } = await boot('/channels/4001/5001', { viewport: { width: 1280, height: 720 } });
  await page.click('.tab[data-tab="batch"]');
  await page.waitForSelector('.guild');
  await page.locator('.guild-head').first().click();
  await page.waitForTimeout(600);
  await shot(page, '16-batch-720');
  await context.close();
}
{
  const { page, context } = await boot('/channels/@me');
  await shot(page, '17-no-channel', await panelClip(page));
  await context.close();
}
fs.writeFileSync(`${OUT}/panels.json`, JSON.stringify(panels));
await browser.close();
console.log('shots in', OUT);
