// Install-page checks: browser-specific steps, "installed ✓" detection, sharing, layout.
// node test/site.mjs [outDir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const root = path.join(here, '..');
const OUT = process.argv[2] || path.join(here, 'out/site');
fs.mkdirSync(OUT, { recursive: true });
const HOME = 'https://codemaker66.github.io/discord-stuff/';
const userscript = fs.readFileSync(path.join(root, 'dist/dopas-discord-purifier.user.js'), 'utf8');
const latest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
};

const browser = await chromium.launch();
const results = [];
const assert = (c, m) => { if (!c) throw new Error(`assertion failed: ${m}`); };

async function open({ ua, viewport = { width: 1440, height: 900 }, withScript = null, permissions = [] } = {}) {
  const context = await browser.newContext({ userAgent: ua, viewport, deviceScaleFactor: 2, permissions });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(`${HOME}**`, (route) => {
    const rel = new URL(route.request().url()).pathname.replace('/discord-stuff/', '') || 'index.html';
    const file = path.join(root, 'docs', rel === '' ? 'index.html' : rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'missing' });
    const type = { '.html': 'text/html', '.webp': 'image/webp', '.png': 'image/png', '.js': 'text/javascript' }[path.extname(file)] || 'application/octet-stream';
    return route.fulfill({ status: 200, contentType: type, body: fs.readFileSync(file) });
  });
  if (withScript) await page.addInitScript((src) => { document.addEventListener('DOMContentLoaded', () => { new Function(src)(); }); }, withScript);
  await page.goto(HOME);
  await page.waitForTimeout(400);
  return { context, page, errors };
}

async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`✓ ${name}`); }
  catch (err) { results.push({ name, ok: false, error: String(err) }); console.log(`✗ ${name}\n    ${err.message}`); }
}

for (const [key, expect] of Object.entries({
  chrome: { allow: true, store: 'chromewebstore.google.com', ext: 'chrome://extensions' },
  edge: { allow: true, store: 'microsoftedge.microsoft.com', ext: 'edge://extensions' },
  opera: { allow: true, store: 'addons.opera.com', ext: 'opera://extensions' },
  firefox: { allow: false, store: 'addons.mozilla.org' },
  safari: { allow: false, store: 'apps.apple.com' },
})) {
  await test(`S1 ${key}: detected, right store, right steps`, async () => {
    const { page, context, errors } = await open({ ua: UA[key] });
    assert(await page.locator(`.chip[data-browser="${key}"][aria-pressed="true"]`).count() === 1, 'browser detected');
    const store = await page.locator('[data-role="manager-link"]').getAttribute('href');
    assert(store.includes(expect.store), `store ${store}`);
    assert((await page.locator('[data-step="allow"]').isVisible()) === expect.allow, 'allow-scripts step visibility');
    if (expect.ext) assert((await page.locator('[data-role="ext-url"]').textContent()) === expect.ext, 'extensions url');
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  });
}

await test('S2 install link is the auto-updating raw URL of the built script', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const href = await page.locator('[data-role="install-link"]').getAttribute('href');
  assert(href.endsWith('/main/dist/dopas-discord-purifier.user.js'), href);
  const header = userscript.slice(0, userscript.indexOf('==/UserScript=='));
  assert(header.includes(`@updateURL    ${href}`) && header.includes(`@downloadURL  ${href}`), 'script updates from the same URL');
  assert((await page.locator('[data-role="latest"]').textContent()) === latest, 'page shows latest version');
  await context.close();
});

await test('S3 with the script installed the page ticks itself off', async () => {
  const { page, context, errors } = await open({ ua: UA.chrome, withScript: userscript });
  await page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
  assert(/Installed — v/.test(await page.locator('[data-role="installed-text"]').textContent()), 'installed text');
  assert(await page.locator('.step.is-done').count() === 3, 'steps ticked');
  assert((await page.locator('[data-role="hero-cta"]').getAttribute('href')) === 'https://discord.com/app', 'hero CTA opens Discord');
  assert(await page.evaluate(() => !document.querySelector('#dopa-purifier-host')), 'no panel on the page');
  assert(errors.length === 0, errors.join('; '));
  await page.screenshot({ path: `${OUT}/installed.png` });
  await context.close();
});

await test('S4 an older installed version is offered the update', async () => {
  const old = userscript.replace(/const VERSION = '[^']+';/, "const VERSION = '4.0.0';");
  const { page, context } = await open({ ua: UA.firefox, withScript: old });
  await page.waitForSelector('.installed.is-update', { timeout: 3000 });
  assert(/is out/.test(await page.locator('[data-role="installed-text"]').textContent()), 'update text');
  await context.close();
});

await test('S5 share copies the page link', async () => {
  const { page, context } = await open({ ua: UA.chrome, permissions: ['clipboard-read', 'clipboard-write'] });
  await page.locator('[data-act="share"]').first().click();
  await page.waitForTimeout(200);
  assert((await page.evaluate(() => navigator.clipboard.readText())) === HOME, 'clipboard');
  await context.close();
});

await test('S6 every local asset and download exists', async () => {
  const html = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="((?:img|downloads)\/[^"]+)"/g)].map((m) => m[1]);
  const missing = refs.filter((r) => !fs.existsSync(path.join(root, 'docs', r)));
  assert(refs.length > 5 && missing.length === 0, `missing: ${missing}`);
});

await test('S7 layout: no horizontal scroll on phone, desktop and laptop', async () => {
  for (const [w, h, name] of [[390, 844, 'phone'], [1440, 900, 'desktop'], [1024, 768, 'laptop']]) {
    const { page, context } = await open({ ua: w < 500 ? UA.iphone : UA.chrome, viewport: { width: w, height: h } });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `${name} overflows by ${overflow}px`);
    if (w < 500) assert(await page.locator('[data-role="mobile-note"]').isVisible(), 'mobile note on phones');
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    await context.close();
  }
});

await test('S8 feature shots keep their 4:5 frame and fill their card', async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const { page, context } = await open({ ua: UA.chrome, viewport: { width: w, height: h } });
    const boxes = await page.$$eval('.feature', (cards) => cards.map((card) => {
      const img = card.querySelector('img').getBoundingClientRect();
      return { card: card.getBoundingClientRect().width, w: img.width, h: img.height };
    }));
    assert(boxes.length === 4, 'four features');
    for (const b of boxes) {
      assert(Math.abs(b.h / b.w - 1.25) < 0.02, `${w}px: image is ${b.w}×${b.h}, not 4:5`);
      assert(b.card - b.w <= 30, `${w}px: image ${b.w}px wide in a ${b.card}px card`);
    }
    await context.close();
  }
});

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
