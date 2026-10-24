// Install-page checks: browser-specific steps, "installed ✓" detection, sharing, layout.
// node test/site.mjs [outDir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
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
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0',
};
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;

const browser = await chromium.launch();
const results = [];
const assert = (c, m) => { if (!c) throw new Error(`assertion failed: ${m}`); };

async function open({ ua, viewport = { width: 1440, height: 900 }, withScript = null, permissions = [] } = {}) {
  const context = await browser.newContext({ userAgent: ua, viewport, deviceScaleFactor: 2, permissions });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(`${HOME}**`, (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace('/discord-stuff/', '') || 'index.html';
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
  if (only && !only.some((o) => name.startsWith(o))) return;
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

// A userscript manager the test can switch on later: the purifier runs here only once localStorage
// 'test:tm' names a version, the way Tampermonkey runs nothing until "Allow User Scripts" is on.
async function withManager(page) {
  const old = userscript.replace(/const VERSION = '[^']+';/, "const VERSION = '4.0.0';");
  await page.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({ status: 204 })); // the manager takes the .user.js
  await page.addInitScript(({ current, older }) => {
    document.addEventListener('DOMContentLoaded', () => {
      const v = localStorage.getItem('test:tm');
      if (v) new Function(v === 'old' ? older : current)();
    });
  }, { current: userscript, older: old });
}
// Playwright pages always say "visible", so act out going to the manager's tab and coming back.
async function comeBack(page) {
  await page.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    }
  }).catch(() => {}); // a reload can cut the evaluation short
  await page.waitForTimeout(900);
  await page.waitForLoadState('load');
}
const awaitFlag = (page) => page.evaluate(() => sessionStorage.getItem('dopa-await'));

await test('S9 phones see "use your computer" first, not desktop steps', async () => {
  for (const key of ['iphone', 'android']) {
    const { page, context, errors } = await open({ ua: UA[key], viewport: { width: 390, height: 844 } });
    const note = page.locator('[data-role="mobile-note"]');
    assert(await note.isVisible(), `${key}: phone note shown`);
    assert(!(await page.locator('.steps').isVisible()) && !(await page.locator('.picker').isVisible()), `${key}: computer steps tucked away`);
    await page.click('[data-role="hero-cta"]');
    await page.waitForTimeout(900);
    const box = await note.boundingBox();
    assert(box.y >= 0 && box.y + 120 < 844, `${key}: note on screen after "Get it free" (top ${Math.round(box.y)}px)`);
    await page.evaluate(() => { navigator.share = async (data) => { window.__shared = data; }; });
    await page.click('[data-act="send-link"]');
    assert((await page.evaluate(() => window.__shared && window.__shared.url)) === HOME, `${key}: "Send me this link" shares the page`);
    await page.click('[data-act="show-steps"]');
    assert(await page.locator('.steps').isVisible() && await page.locator('.picker').isVisible(), `${key}: steps on request`);
    assert(!(await page.locator('[data-act="show-steps"]').isVisible()), `${key}: button goes once used`);
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  // Firefox for Android really can run it: the note still leads, and the steps stay open.
  const { page, context } = await open({ ua: UA.firefoxAndroid, viewport: { width: 390, height: 844 } });
  assert(await page.locator('[data-role="mobile-note"]').isVisible() && await page.locator('.steps').isVisible(), 'firefox android: note and steps');
  assert((await page.locator('[data-role="mobile-note"]').boundingBox()).y < (await page.locator('.picker').boundingBox()).y, 'note before the steps');
  assert(!(await page.locator('[data-act="show-steps"]').isVisible()), 'nothing to unfold');
  await context.close();
});

await test('S10 coming back after Install keeps checking until the latest version says hello', async () => {
  // Install pressed before "Allow User Scripts": the first return finds nothing, the one after the switch ticks.
  {
    const { page, context, errors } = await open({ ua: UA.chrome });
    await withManager(page);
    let loads = 0;
    page.on('load', () => loads++);
    await page.click('[data-role="install-link"]');
    await comeBack(page);
    assert(loads === 1 && await page.locator('[data-role="installed"]').isHidden(), `first return: reloaded, nothing yet (${loads} loads)`);
    await page.evaluate(() => localStorage.setItem('test:tm', 'latest'));
    await comeBack(page);
    assert(loads === 2, `second return reloads too (${loads} loads)`);
    await page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
    assert((await page.locator('[data-role="installed-text"]').textContent()).includes(`Installed — v${latest}`), 'ticked');
    assert((await awaitFlag(page)) === null, 'done waiting');
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  // "Update now" from an older copy (the manager leaves this tab in place): coming back shows the new one.
  {
    const { page, context } = await open({ ua: UA.firefox });
    await withManager(page);
    await page.evaluate(() => localStorage.setItem('test:tm', 'old'));
    await page.reload();
    await page.waitForSelector('.installed.is-update', { timeout: 3000 });
    await page.click('[data-role="installed-action"]');
    await page.evaluate(() => localStorage.setItem('test:tm', 'latest'));
    await comeBack(page);
    await page.waitForFunction((v) => document.querySelector('[data-role="installed-text"]').textContent.includes(`Installed — v${v}`), latest, { timeout: 3000 });
    assert(!(await page.locator('.installed').evaluate((el) => el.classList.contains('is-update'))), 'no longer "is out"');
    await context.close();
  }
  // A few reloads at most, then returning to the tab just leaves it be.
  {
    const { page, context } = await open({ ua: UA.chrome });
    await withManager(page);
    let loads = 0;
    page.on('load', () => loads++);
    await page.click('[data-role="install-link"]');
    for (let i = 0; i < 5; i++) await comeBack(page);
    assert(loads === 3, `reloads capped (${loads})`);
    await context.close();
  }
});

await test('S11 nothing running after Install: the page says so and what usually fixes it', async () => {
  // A manager took the script but can't run it yet (Allow User Scripts off).
  {
    const { page, context, errors } = await open({ ua: UA.chrome });
    const help = page.locator('[data-role="install-help"]');
    assert(await help.count() === 1, 'a place in step 3 to say so');
    assert((await help.getAttribute('role')) === 'status' && (await help.getAttribute('aria-live')) === 'polite', 'a live region from the start');
    assert((await help.textContent()) === '', 'quiet until needed');
    await withManager(page);
    await page.click('[data-role="install-link"]');
    await comeBack(page);
    await page.waitForFunction(() => /can't see the Purifier/.test(document.querySelector('[data-role="install-help"]').textContent), null, { timeout: 4000 });
    assert(/Allow User Scripts/.test(await help.textContent()), 'points at step 2');
    assert(await page.locator('.step.is-done').count() === 0, 'nothing ticked');
    await page.evaluate(() => localStorage.setItem('test:tm', 'latest'));
    await comeBack(page);
    await page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
    assert((await help.textContent()) === '', 'hint gone once installed');
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  // No manager at all: the tab shows the script as text, and Back brings the hint.
  {
    const { page, context } = await open({ ua: UA.firefox });
    await page.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: userscript.slice(0, 4000) }));
    await page.click('[data-role="install-link"]');
    await page.waitForURL(/raw\.githubusercontent\.com/);
    await page.goBack();
    await page.waitForFunction(() => /can't see the Purifier/.test(document.querySelector('[data-role="install-help"]').textContent), null, { timeout: 5000 });
    assert(!/Allow User Scripts/.test(await page.locator('[data-role="install-help"]').textContent()), 'Firefox has no step 2 to point at');
    await context.close();
  }
});

await test('S12 update help names controls that exist (Tampermonkey and BetterDiscord)', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const faq = await page.locator('details', { hasText: 'How do updates work?' }).textContent();
  assert(/Utilities → Check for userscript updates/.test(faq), faq);
  assert(!/Dashboard → Check for updates/.test(faq), 'no made-up Dashboard button');
  assert(/BetterDiscord/.test(faq), 'BetterDiscord updates explained');
  assert(/Update/.test(await page.locator('.panel', { hasText: 'Already on BetterDiscord?' }).textContent()), 'BetterDiscord panel says updates are offered');
  await context.close();
});

await test('S13 Safari is told the manager costs $2.99 and where it is free', async () => {
  const { page, context } = await open({ ua: UA.safari });
  const note = await page.locator('[data-role="manager-note"]').textContent();
  assert(/\$2\.99/.test(note) && /Chrome, Edge or Firefox/.test(note), note);
  assert(/\$2\.99/.test(await page.locator('[data-role="manager-link"]').textContent()), 'price on the button');
  for (const line of [await page.locator('.meta').textContent(), await page.locator('#install .sub').textContent()]) {
    assert(!/Safari/.test(line) || /Safari[^·.]*\$2\.99|\$2\.99 on Safari/.test(line), `Safari counted as free: ${line}`);
  }
  await page.click('.chip[data-browser="chrome"]');
  assert(/^Free/.test(await page.locator('[data-role="manager-note"]').textContent()), 'Chrome is free');
  await context.close();
});

await test('S14 each store\'s button is named as it really reads', async () => {
  const { page, context } = await open({ ua: UA.edge });
  const edge = await page.locator('[data-role="manager-note"]').textContent();
  assert(/Click Get on the page that opens, then Add extension/.test(edge) && !/Add to Edge/.test(edge), edge);
  await page.click('.chip[data-browser="chrome"]');
  assert(/Click Add to Chrome on the page/.test(await page.locator('[data-role="manager-note"]').textContent()), 'Chrome unchanged');
  await context.close();
});

// The pictures show ETAs and rates, so they must be taken at the pace the purifier ships with:
// tools/marketing.py refuses other shots and stamps the pace into every picture it makes.
await test('S15 page pictures and the link preview were taken at the shipped pace', async () => {
  const timing = /const TIMING = \{ deleteDelayMs: (\d+), searchDelayMs: (\d+) \};/.exec(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8'));
  const stamp = `dopa-pace: deleteDelayMs=${timing[1]} searchDelayMs=${timing[2]}`;
  const pictures = ['og.png', 'purging.webp', 'scanned.webp', 'confirm.webp', 'batch.webp', 'immune.webp', 'welcome.webp', 'done.webp'];
  const unstamped = pictures.filter((f) => !fs.readFileSync(path.join(root, 'docs/img', f)).includes(stamp));
  assert(unstamped.length === 0, `not taken at ${stamp}: ${unstamped.join(', ')}`);
  assert(!/\.replace\(\/[^/]*DelayMs/.test(fs.readFileSync(path.join(here, 'shots.mjs'), 'utf8')), 'shots.mjs leaves the pacing alone');
});

await test('S16 build and check work from a folder with a space in its name', async () => {
  const base = path.join(OUT, 'space test');
  fs.rmSync(base, { recursive: true, force: true });
  const repo = path.join(base, 'My Projects', 'discord-stuff');
  for (const p of ['package.json', 'tools', 'src', 'assets', 'docs/index.html']) fs.cpSync(path.join(root, p), path.join(repo, p), { recursive: true });
  const run = (...args) => spawnSync(process.execPath, [path.join(repo, 'tools/build.mjs'), ...args], { encoding: 'utf8' });
  const build = run();
  assert(build.status === 0, `build: ${build.stderr.split('\n')[0]}`);
  assert(fs.existsSync(path.join(repo, 'dist/dopas-discord-purifier.user.js')), 'built inside the spaced folder');
  const check = run('--check');
  assert(check.status === 0, `check: ${check.stderr.split('\n')[0]}`);
  // and no tool or test turns a file URL into a path by hand (breaks on Windows too)
  for (const dir of ['tools', 'test']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.mjs'))) {
      assert(!/new URL\(import\.meta\.url\)\.pathname/.test(fs.readFileSync(path.join(root, dir, f), 'utf8')), `${dir}/${f} uses URL.pathname as a path`);
    }
  }
  fs.rmSync(base, { recursive: true, force: true });
});

await test('S17 the page says to hold the red button, not Purify', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  assert(/then Purify, and hold the red button/.test(await page.locator('[data-step="open"]').textContent()), 'step 4');
  assert(!/hold Purify/i.test(await page.locator('body').textContent()), 'no "hold Purify" anywhere');
  await context.close();
});

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
