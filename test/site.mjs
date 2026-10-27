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

async function open({ ua, viewport = { width: 1440, height: 900 }, withScript = null, permissions = [], init = null } = {}) {
  const context = await browser.newContext({ userAgent: ua, viewport, deviceScaleFactor: 2, permissions });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (init) await page.addInitScript(init);
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

// Brave sends Chrome's user agent and says who it is through navigator.brave.
const BRAVE = () => Object.defineProperty(Navigator.prototype, 'brave', { configurable: true, get: () => ({ isBrave: () => Promise.resolve(true) }) });
// The ?id= form opens Tampermonkey's own details page, where "Allow User Scripts" lives.
const EXT = {
  chrome: 'chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo',
  edge: 'edge://extensions/?id=iikmkjmpaadaobahmlepeloendndfphd',
  brave: 'brave://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo',
  opera: 'opera://extensions',
};
for (const [key, expect] of Object.entries({
  chrome: { allow: true, store: 'chromewebstore.google.com', ext: EXT.chrome },
  edge: { allow: true, store: 'microsoftedge.microsoft.com', ext: EXT.edge },
  opera: { allow: true, store: 'addons.opera.com', ext: EXT.opera },
  brave: { allow: true, store: 'chromewebstore.google.com', ext: EXT.brave, ua: UA.chrome, init: BRAVE },
  firefox: { allow: false, store: 'addons.mozilla.org' },
  safari: { allow: false, store: 'apps.apple.com' },
})) {
  await test(`S1 ${key}: detected, right store, right steps`, async () => {
    const { page, context, errors } = await open({ ua: expect.ua || UA[key], init: expect.init });
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
  // The good news is said in step 3 too, the done steps put their buttons away, and step 4 is the one to press.
  assert((await page.locator('[data-role="install-help"]').textContent()) === `Installed ✓ v${latest} — you're all set, princess~`, 'step 3 says it is installed');
  for (const act of await page.locator('.step.is-done > .act').all()) assert(!(await act.isVisible()), 'a done step still shows its button');
  assert(await page.locator('[data-step="open"].is-next [data-role="open-link"].btn-primary').count() === 1, 'step 4 is next, its button primary');
  assert(await page.locator('.setup .btn-primary:visible').count() === 1, 'one primary button in the steps');
  // The Install button is put away once installed, so the update answer cannot send people to it.
  assert(!/click Install above again/.test(await page.locator('details', { hasText: 'How do updates work?' }).textContent()), 'the update answer names a button that is hidden');
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
  // Only the steps before it are done: step 3 becomes the update, and says so.
  assert(await page.locator('[data-step="manager"].is-done').count() === 1, 'step 1 ticked');
  assert(await page.locator('[data-step="install"].is-done').count() === 0, 'step 3 not ticked');
  const link = page.locator('[data-role="install-link"]');
  assert(await link.isVisible() && (await link.textContent()) === 'Update now' && /btn-primary/.test(await link.getAttribute('class')), 'step 3 reads Update now, primary');
  assert((await page.locator('[data-role="install-help"]').textContent()) === `You have v4.0.0 — v${latest} is out. Press Update now ✨`, 'step 3 hint');
  assert(await page.locator('[data-step="open"].is-next').count() === 0, 'step 4 waits');
  const faq = await page.locator('details', { hasText: 'How do updates work?' }).textContent();
  assert(!/click Install above again/.test(faq) && /this page says so and shows Update now/.test(faq), 'the update answer names the button the page shows');
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
    await page.evaluate(() => { navigator.share = async (data) => { window.__shared = data; }; });
    await page.click('[data-act="send-link"]');
    assert((await page.evaluate(() => window.__shared && window.__shared.url)) === HOME, `${key}: "Send it to my computer" in the note shares the page`);
    await page.click('[data-act="show-steps"]');
    assert(await page.locator('.steps').isVisible() && await page.locator('.picker').isVisible(), `${key}: steps on request`);
    assert(!(await page.locator('[data-act="show-steps"]').isVisible()), `${key}: button goes once used`);
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  // Firefox for Android really can run it: the note still leads, the steps stay open, and "Get it free" goes there.
  const { page, context } = await open({ ua: UA.firefoxAndroid, viewport: { width: 390, height: 844 } });
  assert(await page.locator('[data-role="mobile-note"]').isVisible() && await page.locator('.steps').isVisible(), 'firefox android: note and steps');
  assert((await page.locator('[data-role="mobile-note"]').boundingBox()).y < (await page.locator('.picker').boundingBox()).y, 'note before the steps');
  assert(!(await page.locator('[data-act="show-steps"]').isVisible()), 'nothing to unfold');
  assert((await page.locator('[data-role="hero-cta"]').textContent()).trim() === 'Get it free', 'firefox android keeps "Get it free"');
  await page.click('[data-role="hero-cta"]');
  await page.waitForTimeout(900);
  const box = await page.locator('[data-role="mobile-note"]').boundingBox();
  assert(box.y >= 0 && box.y + 120 < 844, `note on screen after "Get it free" (top ${Math.round(box.y)}px)`);
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
    assert(/^Installed ✓/.test(await help.textContent()), `the hint turns into "Installed ✓": ${await help.textContent()}`);
    assert(!/can't see the Purifier/.test(await help.textContent()), 'the worry is gone once installed');
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
  const timing = (/const TIMING = \{([^}]*)\}/.exec(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8')) || [])[1];
  assert(timing, 'src/main.js has a const TIMING block');
  const [del, search] = ['deleteDelayMs', 'searchDelayMs'].map((key) => (new RegExp(`\\b${key}:\\s*(\\d+)`).exec(timing) || [])[1]);
  assert(del && search, `deleteDelayMs and searchDelayMs in TIMING: ${timing}`);
  const stamp = `dopa-pace: deleteDelayMs=${del} searchDelayMs=${search}`;
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
  assert(/press Purify, check the count, then hold the red button/.test(await page.locator('[data-step="open"]').textContent()), 'step 4');
  assert(!/hold Purify/i.test(await page.locator('body').textContent()), 'no "hold Purify" anywhere');
  await context.close();
});

// The button hides itself once used; focus must follow into the steps, not drop to <body>.
await test('S18 phones: "Show the computer steps" hands focus to the steps it opens', async () => {
  for (const key of ['iphone', 'android']) {
    const { page, context, errors } = await open({ ua: UA[key], viewport: { width: 390, height: 844 } });
    const button = page.locator('[data-act="show-steps"]');
    assert((await button.getAttribute('aria-expanded')) === 'false', `${key}: button says the steps are collapsed`);
    const controls = (await button.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    assert(controls.length > 0, `${key}: button names what it controls`);
    for (const id of controls) {
      assert(await page.locator(`.setup > #${id}:is(.picker, .steps)`).count() === 1, `${key}: aria-controls "${id}" is the picker or the steps`);
    }
    await button.focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('.steps').isVisible(), `${key}: steps shown`);
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el.tagName, text: el.textContent.trim().slice(0, 40), inside: !!el.closest('.setup > .picker, .setup > .steps') };
    });
    assert(focus.inside, `${key}: focus fell to <${focus.tag.toLowerCase()}> "${focus.text}", not into the steps`);
    // The page scrolls smoothly, so give the focus scroll a moment to land.
    const onScreen = await page.waitForFunction(() => {
      const r = document.activeElement.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    }, null, { timeout: 2000 }).then(() => true, () => false);
    assert(onScreen, `${key}: focused "${focus.text}" is scrolled into view`);
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
});

// Speed claims follow the shipped pacing the way the panel's own estimate does (src/ui.js estimateSeconds).
await test('S19 every speed claim on the page and in the README matches the panel\'s estimate', async () => {
  const timing = (/const TIMING = \{([^}]*)\}/.exec(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8')) || [])[1] || '';
  const del = Number((/\bdeleteDelayMs:\s*(\d+)/.exec(timing) || [])[1]);
  const extra = Number((/estimateSeconds\s*=[^;]*TIMING\.deleteDelayMs\s*\+\s*(\d+)/.exec(fs.readFileSync(path.join(root, 'src/ui.js'), 'utf8')) || [])[1]);
  assert(del > 0 && extra >= 0, `pace from source (deleteDelayMs ${del}, +${extra} ms)`);
  const perMessage = (del + extra) / 1000;
  const { page, context } = await open({ ua: UA.chrome });
  const sources = { page: await page.locator('body').textContent(), README: fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ') };
  await context.close();
  let claims = 0;
  for (const [where, text] of Object.entries(sources)) {
    assert(!/\b(?:a|one) message (?:a|per) second|\ba second (?:per|a) message/i.test(text), `${where} still says a message a second`);
    for (const [, n] of text.matchAll(/about (\d+) messages a minute/gi)) {
      claims++;
      assert(Math.abs(Number(n) - 60 / perMessage) / (60 / perMessage) < 0.15, `${where}: "${n} a minute", the panel estimates ${(60 / perMessage).toFixed(1)}`);
    }
    for (const [, n, min] of text.matchAll(/([\d,]+) messages take around (\d+) minutes/gi)) {
      claims++;
      const panel = Math.ceil((Number(n.replace(/,/g, '')) * perMessage) / 60); // formatDuration rounds minutes up
      assert(Number(min) === panel, `${where}: ${n} messages in ${min} min, the panel says ~${panel} min`);
    }
  }
  assert(claims >= 3, `found ${claims} speed claims to check`);
});

await test('S20 the safety answer says what reaches GitHub (and nothing claims Discord only)', async () => {
  const plugin = fs.readFileSync(path.join(root, 'src/betterdiscord.js'), 'utf8');
  assert(/BdApi\.Net\.fetch\(PLUGIN_URL\)/.test(plugin) && /@@PLUGIN_URL@@/.test(plugin), 'the plugin checks its own GitHub file for updates');
  const { page, context } = await open({ ua: UA.chrome });
  const faq = await page.locator('details', { hasText: 'Is it safe?' }).textContent();
  await context.close();
  assert(/BetterDiscord plugin also asks GitHub once each time it starts/.test(faq), `plugin's update check named: ${faq}`);
  assert(/Tampermonkey itself fetches new versions of it from GitHub/.test(faq), 'Tampermonkey\'s own update check named');
  for (const [where, text] of [['page', faq], ['README', fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ')]]) {
    assert(!/It talks to Discord and nothing else|and talks to Discord and nothing else/.test(text), `${where} says it talks only to Discord`);
    assert(/No servers of ours, no tracking/.test(text), `${where}: no servers, no tracking`);
  }
});

// Bring an element to 100px from the top at once (the page scrolls smoothly), so a screenshot clip
// around it stays inside the viewport, which Playwright trims clips to.
const bringUp = (locator) => locator.evaluate((el) => {
  document.documentElement.style.scrollBehavior = 'auto';
  scrollTo(0, scrollY + el.getBoundingClientRect().top - 100);
});
// What the page really drew in a clip of the screen, as RGBA rows (CSS px unless scale is 'device').
async function pixels(page, clip, scale = 'css') {
  const png = await page.screenshot({ clip, scale });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
    g.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, data: Array.from(g.getImageData(0, 0, bmp.width, bmp.height).data) };
  }, png.toString('base64'));
}
const px = (img, x, y) => img.data.slice((y * img.w + x) * 4, (y * img.w + x) * 4 + 3);

// The page and the README teach today's panel in its own words (D57, D25).
await test('S21 the page and README teach the panel as it is now', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const body = await page.locator('body').textContent();
  const summaries = await page.locator('details > summary').allTextContents();
  await context.close();
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  for (const [where, text] of [['page', body.replace(/\s+/g, ' ')], ['README', readme]]) {
    for (const old of ['press Scan', 'Scan in a second', 'their chat is immune, forever', 'Bardo is shielded', 'purge them', 'Batch:']) {
      assert(!text.includes(old), `${where} still says "${old}"`);
    }
    assert(text.includes('Bardo & Dopa are shielded from the start'), `${where} names both shields`);
  }
  for (const q of ['Will the other person know?', 'Can it find a DM I closed long ago?', 'Can I get deleted messages back?']) {
    assert(summaries.includes(q), `the FAQ asks "${q}"`);
  }
  assert(/Shields cover one-to-one DMs, not group chats/.test(body) && /Discord's own notices \(calls, people added to a group, renames\) can't be deleted by anyone/.test(body), 'what shields and Discord\'s notices cover');
});

await test('S22 FAQ questions are read without a trailing "plus"', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const names = nodes.filter((n) => !n.ignored && n.role && n.role.value === 'DisclosureTriangle').map((n) => (n.name && n.name.value || '').trim());
  const questions = (await page.locator('details > summary').allTextContents()).map((s) => s.trim());
  await context.close();
  assert(names.length === questions.length && names.length >= 9, `${names.length} questions in the tree, ${questions.length} on the page`);
  for (const name of names) assert(!/\+$/.test(name) && questions.includes(name), `read as "${name}"`);
});

await test('S23 the first screen says why to trust it, and asks nothing else', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const trust = page.locator('.hero .meta .trust');
  assert(/^Only your own messages · nothing leaves Discord · open source$/.test((await trust.textContent()).trim()), await trust.textContent());
  const link = trust.locator('a[href="https://github.com/codemaker66/discord-stuff"]');
  const box = await link.boundingBox();
  assert(await link.isVisible() && box.y + box.height <= 900, `open-source link above the fold (bottom ${box && Math.round(box.y + box.height)}px)`);
  assert(await page.locator('.hero [data-act="share"]').count() === 0, 'no hero share button');
  assert(await page.locator('.hero .meta').evaluate((m) => !/Chrome|Firefox|Safari/.test(m.textContent)), 'the browser list lives in the steps, not the hero');
  assert((await page.locator('[data-role="hero-cta"]').textContent()).trim() === 'Get it free', 'desktop keeps "Get it free"');
  assert((await page.locator('[data-role="latest"]').textContent()) === latest, 'version still shown');
  await context.close();
});

await test('S24 phones: the first button sends the link to a computer', async () => {
  for (const key of ['iphone', 'android']) {
    const { page, context, errors } = await open({ ua: UA[key], viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const cta = page.locator('[data-role="hero-cta"]');
    assert((await cta.textContent()).trim() === 'Send it to my computer' && (await cta.getAttribute('role')) === 'button', `${key}: hero CTA`);
    assert(/free · set up on a computer, two minutes ♡/.test(await page.locator('.hero .meta').textContent()), `${key}: the hero says a computer is needed`);
    const box = await cta.boundingBox();
    assert(box.y + box.height <= 844, `${key}: on the first screen`);
    await page.evaluate(() => { navigator.share = async (data) => { window.__shared = data; }; });
    await cta.click();
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => window.__shared && window.__shared.url)) === HOME, `${key}: shares the page`);
    assert((await page.evaluate(() => location.hash)) === '', `${key}: and stays put`);
    await page.evaluate(() => { window.__shared = null; });
    await cta.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    assert((await page.evaluate(() => window.__shared && window.__shared.url)) === HOME, `${key}: Space presses it like a button`);
    // Held Space is one press, like a button; and cancelling the share sheet says nothing.
    await page.evaluate(() => { window.__calls = 0; navigator.share = async () => { window.__calls++; }; });
    await cta.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    await page.waitForTimeout(200);
    assert((await page.evaluate(() => window.__calls)) === 1, `${key}: held Space shares once (${await page.evaluate(() => window.__calls)})`);
    await page.evaluate(() => { document.querySelector('[data-role="toast"]').textContent = ''; navigator.share = async () => { throw new DOMException('cancelled', 'AbortError'); }; });
    await cta.click();
    await page.waitForTimeout(300);
    assert((await page.locator('[data-role="toast"]').textContent()) === '', `${key}: cancelling the share sheet is not "Link copied"`);
    // No share sheet: copy the link and say where to open it.
    await page.evaluate(() => { navigator.share = undefined; });
    await cta.click();
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => navigator.clipboard.readText())) === HOME, `${key}: copies without a share sheet`);
    assert((await page.locator('[data-role="toast"]').textContent()) === 'Link copied~ open it on your computer ♡', `${key}: toast`);
    // Opening the computer steps keeps one pink button: the note's, since nothing in them can be done from a phone.
    await page.click('[data-act="show-steps"]');
    assert(await page.locator('.setup .btn-primary:visible').count() === 1, `${key}: one primary button in the setup`);
    assert(await page.locator('[data-act="send-link"]').evaluate((el) => el.classList.contains('btn-primary')), `${key}: and it is "Send it to my computer"`);
    const android = page.locator('[data-role="android-only"]');
    assert((await android.isVisible()) === (key === 'android'), `${key}: Firefox-for-Android line ${key === 'android' ? 'shown' : 'hidden'}`);
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  const { page, context } = await open({ ua: UA.firefoxAndroid, viewport: { width: 390, height: 844 } });
  assert(await page.locator('[data-role="android-only"]').isVisible(), 'Firefox for Android sees its line');
  assert(!/set up on a computer/.test(await page.locator('.hero .meta').textContent()), 'and isn\'t sent to a computer');
  await context.close();
});

await test('S25 iPads (Safari says "Mac") are pointed to a computer, Macs are not', async () => {
  const TOUCH = () => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { configurable: true, get: () => 5 });
  {
    const { page, context, errors } = await open({ ua: UA.safari, viewport: { width: 820, height: 1180 }, init: TOUCH });
    assert(await page.locator('[data-role="mobile-note"]').isVisible(), 'note shown');
    assert(/^On an iPad, princess\? ♡ Discord's iPad app can't wear the Purifier/.test(await page.locator('[data-role="mobile-lead"]').textContent()), 'iPad words');
    assert(!(await page.locator('.steps').isVisible()) && await page.locator('[data-act="show-steps"]').isVisible(), 'steps tucked away');
    assert((await page.locator('[data-role="hero-cta"]').textContent()).trim() === 'Send it to my computer', 'send it to a computer');
    assert(!(await page.locator('[data-role="android-only"]').isVisible()), 'no Android line');
    await page.click('[data-act="show-steps"]');
    assert(await page.locator('.steps').isVisible(), 'steps on request');
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  const { page, context } = await open({ ua: UA.safari });
  assert(await page.evaluate(() => navigator.maxTouchPoints) === 0, 'a Mac without touch');
  assert(!(await page.locator('[data-role="mobile-note"]').isVisible()) && await page.locator('.steps').isVisible(), 'Mac Safari keeps its steps');
  assert((await page.locator('[data-role="hero-cta"]').textContent()).trim() === 'Get it free', 'and "Get it free"');
  await context.close();
});

await test('S26 step 2 is a paste and a switch, the warning is announced, one primary at a time', async () => {
  const { page, context, errors } = await open({ ua: UA.chrome, permissions: ['clipboard-read', 'clipboard-write'] });
  const step = page.locator('[data-step="allow"]');
  assert(await step.locator('ol, ul').count() === 0, 'no sub-list');
  assert(/^Chrome keeps scripts off until you say yes\. Paste this into a new tab, then flip the switch:$/.test((await step.locator('p').first().textContent()).trim()), 'lead');
  assert((await step.locator('[data-role="ext-url"]').textContent()) === EXT.chrome && await step.locator('[data-act="copy-ext"]').isVisible(), 'the link to paste, with Copy');
  assert(await step.locator('.fallback').isVisible() && /No switch there\? Turn on Developer mode on that page instead\./.test(await step.locator('.fallback').textContent()), 'fallback always shown');
  const words = (await step.locator('h3 + p, .fallback').allTextContents()).join(' ').split(/\s+/).filter(Boolean).length;
  assert(words <= 30, `${words} words`);
  await step.locator('[data-act="copy-ext"]').click();
  await page.waitForTimeout(200);
  assert((await page.evaluate(() => navigator.clipboard.readText())) === EXT.chrome, 'Copy writes the link');
  assert((await page.locator('[data-role="toast"]').textContent()) === 'Copied — paste it into a new tab ♡', 'toast');
  const note = () => page.locator('[data-role="manager-note"]').textContent();
  assert((await note()).includes('Click Add to Chrome on the page that opens, then Add extension. Chrome will warn it can “read and change” websites: every helper like this gets that warning. The Purifier itself only works inside Discord ♡'), await note());
  const classes = async () => [await page.locator('[data-role="manager-link"]').getAttribute('class'), await page.locator('[data-role="install-link"]').getAttribute('class')];
  let [manager, install] = await classes();
  assert(/btn-primary/.test(manager) && /btn-quiet/.test(install), `first visit: step 1 primary, Install quiet (${manager} | ${install})`);
  assert(await page.locator('.setup .btn-primary:visible').count() === 1, 'one primary');
  await page.click('.chip[data-browser="safari"]');
  [manager, install] = await classes();
  assert(/btn-quiet/.test(manager) && /btn-primary/.test(install), 'Safari: the paid app is never the pink button');
  for (const [key, lead] of [['edge', 'Paste this into a new tab, then flip the switch:'], ['brave', 'Paste this into a new tab, then flip the switch:'], ['opera', "Paste this into a new tab, open Tampermonkey's Details, then flip the switch:"]]) {
    await page.click(`.chip[data-browser="${key}"]`);
    assert((await step.locator('[data-role="ext-url"]').textContent()) === EXT[key], `${key} link`);
    assert((await step.locator('[data-role="allow-how"]').textContent()) === lead, `${key} lead`);
    assert(/will warn it can “read and change” websites/.test(await note()), `${key} warned`);
    assert(/btn-primary/.test((await classes())[0]), `${key}: step 1 primary again`);
  }
  await page.click('.chip[data-browser="firefox"]');
  assert(!/will warn/.test(await note()), 'Firefox has no such warning to announce');
  assert(errors.length === 0, errors.join('; '));
  await context.close();
});

await test('S27 back from Install, step 4 comes into view (focus stays put)', async () => {
  const { page, context, errors } = await open({ ua: UA.chrome, viewport: { width: 1366, height: 768 } });
  await withManager(page);
  await page.click('[data-role="hero-cta"]'); // "Get it free" → #install, where people press Install
  await page.waitForTimeout(900);
  const inView = () => page.locator('[data-step="open"]').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  assert(!(await inView()), 'step 4 starts below the fold');
  await page.click('[data-role="install-link"]');
  await page.evaluate(() => localStorage.setItem('test:tm', 'latest'));
  await comeBack(page);
  await page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
  const shown = await page.waitForFunction(() => {
    const r = document.querySelector('[data-step="open"]').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }, null, { timeout: 2500 }).then(() => true, () => false);
  assert(shown, `step 4 in view after the return (scrollY ${await page.evaluate(() => scrollY)})`);
  assert(await page.locator('[data-role="install-help"]').evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 'the "Installed ✓" line too');
  assert(await page.evaluate(() => document.activeElement === document.body), 'focus not moved');
  assert((await awaitFlag(page)) === null, 'done waiting');
  assert(errors.length === 0, errors.join('; '));
  await context.close();
  // A plain visit with it installed doesn't scroll anywhere.
  const plain = await open({ ua: UA.chrome, viewport: { width: 1366, height: 768 }, withScript: userscript });
  await plain.page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
  await plain.page.waitForTimeout(700);
  assert((await plain.page.evaluate(() => scrollY)) === 0, 'plain visit stays at the top');
  await plain.context.close();
  // Updating from the banner at the top: it is still on screen on the way back, so the page stays there.
  const top = await open({ ua: UA.chrome, viewport: { width: 1366, height: 768 } });
  await withManager(top.page);
  await top.page.evaluate(() => localStorage.setItem('test:tm', 'old'));
  await top.page.reload();
  await top.page.waitForSelector('.installed.is-update', { timeout: 3000 });
  assert((await top.page.evaluate(() => scrollY)) === 0, 'outdated visit starts at the top');
  await top.page.click('[data-role="installed-action"]');
  await top.page.evaluate(() => localStorage.setItem('test:tm', 'latest'));
  await comeBack(top.page);
  await top.page.waitForSelector('[data-role="installed"]:not([hidden]):not(.is-update)', { timeout: 3000 });
  await top.page.waitForTimeout(1200);
  assert((await top.page.evaluate(() => scrollY)) === 0, `updating from the banner leaves the page where it is (scrollY ${await top.page.evaluate(() => scrollY)})`);
  await top.context.close();
});

// Step numbers are measured where they are drawn: the rose circle's rows in a screenshot.
await test('S28 the page reflows at 320px and each step number sits beside its heading', async () => {
  for (const [ua, name] of [[UA.chrome, 'desktop at 400%'], [UA.android, 'Android, steps shown']]) {
    const { page, context } = await open({ ua, viewport: { width: 320, height: 640 } });
    if (await page.locator('[data-act="show-steps"]').isVisible()) await page.click('[data-act="show-steps"]');
    assert(await page.locator('[data-step="allow"]').isVisible(), `${name}: step 2 (the widest) shown`);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert(m.sw === 320 && m.cw === 320, `${name}: page ${m.sw}px wide in 320`);
    await context.close();
  }
  for (const [w, h, ua] of [[1366, 768, UA.chrome], [390, 844, UA.firefox]]) {
    const { page, context } = await open({ ua, viewport: { width: w, height: h } });
    for (const li of await page.locator('.step:visible').all()) {
      await bringUp(li);
      const geo = await li.evaluate((el) => {
        const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const h3 = el.querySelector('h3');
        return { x: r.left + parseFloat(cs.paddingLeft), y: r.top - 16, w: parseFloat(getComputedStyle(el, '::before').width), h: r.height + 32,
          line: h3.getBoundingClientRect().top + parseFloat(getComputedStyle(h3).lineHeight) / 2, step: el.dataset.step };
      });
      const img = await pixels(page, { x: geo.x, y: geo.y, width: geo.w, height: geo.h }, 'device');
      const dpr = img.w / geo.w; const col = Math.round(img.w * 0.2); // left of the digit, inside the circle
      const rose = []; // the first run of rose rows is the circle (a pink button may sit lower in the card)
      for (let y = 0; y < img.h; y++) {
        const [r, g, b] = px(img, col, y);
        if (r > 220 && g > 130 && g < 190 && b > 160) { if (rose.length && y - rose[rose.length - 1] > 1) break; rose.push(y); }
      }
      assert(rose.length > 20, `${w}px ${geo.step}: circle not found`);
      const centre = geo.y + (rose[0] + rose[rose.length - 1] + 1) / 2 / dpr;
      assert(Math.abs(centre - geo.line) <= 2, `${w}px ${geo.step}: number centre ${centre.toFixed(1)} vs heading line ${geo.line.toFixed(1)}`);
    }
    await context.close();
  }
});

await test('S29 forced colours keep the chosen browser, every button edge and every step circle', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  await page.emulateMedia({ forcedColors: 'active' });
  await bringUp(page.locator('.picker'));
  await page.waitForTimeout(400); // the chips' colour transition
  const fills = [];
  for (const chip of await page.locator('.chip').all()) {
    const b = await chip.boundingBox();
    const img = await pixels(page, { x: b.x + 4, y: b.y + b.height / 2 - 2, width: 4, height: 4 });
    fills.push({ pressed: (await chip.getAttribute('aria-pressed')) === 'true', rgb: px(img, 2, 2).join(',') });
  }
  const pressed = fills.filter((f) => f.pressed);
  assert(pressed.length === 1 && fills.filter((f) => !f.pressed).every((f) => f.rgb !== pressed[0].rgb), `pressed chip looks like the rest: ${JSON.stringify(fills)}`);
  for (const el of await page.locator('.btn:visible, .chip:visible, .copy:visible').all()) {
    const b = await el.evaluate((e) => { const s = getComputedStyle(e); return { w: parseFloat(s.borderTopWidth), style: s.borderTopStyle, name: e.textContent.trim() }; });
    assert(b.w >= 1 && b.style === 'solid', `"${b.name}" has no edge`);
  }
  for (const li of await page.locator('.step:visible').all()) {
    assert(parseFloat(await li.evaluate((e) => getComputedStyle(e, '::before').borderTopWidth)) >= 2, 'step circle has an edge');
  }
  await context.close();
  // The chosen chip keeps its own fill, so its keyboard focus ring must stay visible on a light theme too.
  for (const scheme of ['light', 'dark']) {
    const fc = await open({ ua: UA.chrome });
    await fc.page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
    await bringUp(fc.page.locator('.picker'));
    await fc.page.focus('.chip[data-browser="edge"]');
    await fc.page.keyboard.press('Shift+Tab'); // back onto the pressed Chrome chip, by keyboard
    const ring = await fc.page.evaluate(() => {
      const el = document.activeElement; const s = getComputedStyle(el);
      return { chip: el.dataset.browser, pressed: el.getAttribute('aria-pressed'), visible: el.matches(':focus-visible'), outline: s.outlineColor, width: parseFloat(s.outlineWidth), canvas: getComputedStyle(document.body).backgroundColor };
    });
    assert(ring.chip === 'chrome' && ring.pressed === 'true' && ring.visible, `${scheme}: focus is on the pressed chip: ${JSON.stringify(ring)}`);
    assert(ring.width >= 2 && ring.outline !== 'rgb(239, 228, 255)' && ring.outline !== ring.canvas, `${scheme}: the focus ring shows against the page: ${JSON.stringify(ring)}`);
    await fc.context.close();
  }
});

// K1 (critic #2): two places at once means twice the pace Discord sees. The page says so plainly,
// and claims nothing about stopping it.
await test('S32 the FAQ says to purify from one place at a time', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const answer = await page.locator('details', { hasText: 'Could my account get in trouble?' }).textContent();
  const body = await page.locator('body').textContent();
  await context.close();
  assert(/Purify from one place at a time \(one tab or the app, not both\)/.test(answer), answer);
  assert(/about 40 messages a minute/.test(answer), 'next to the pace it protects');
  assert(!/(?:can't|cannot|won't) (?:run|purify) (?:in )?two|(?:stops|blocks|prevents) (?:a )?second/i.test(body), 'no promise that it stops a second place');
});

// K2 (Blake's Q2 call) and D25: Purify is the action, "purged" the result, Count the step.
await test('S33 the page and README use the panel\'s words: Purify, purged, Count', async () => {
  const html = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8').replace(/\b(?:src|href)="[^"]*"/g, ''); // file names aren't words
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\]\([^)]*\)|\b(?:src|href)="[^"]*"/g, '');
  for (const [where, text] of [['page', html], ['README', readme]]) {
    const purge = text.match(/\bpurg(?:e|es|ing)\b/gi);
    assert(!purge, `${where} uses purge as the action: ${purge}`);
    for (const m of text.matchAll(/\bscan\w*/gi)) {
      assert(/QR code/.test(text.slice(Math.max(0, m.index - 60), m.index)), `${where} still says "${m[0]}": …${text.slice(m.index - 40, m.index + 30)}…`);
    }
  }
  assert(/\*\*Purify\*\* any chat: it counts your messages first/.test(readme), 'README: Purify counts first');
  const { page, context } = await open({ ua: UA.chrome });
  assert(/Counting tells you the estimate up front/.test(await page.locator('details', { hasText: 'How long does it take?' }).textContent()), 'Counting, not a scan');
  assert(/That's why Purify counts first/.test(await page.locator('details', { hasText: 'Can I get deleted messages back?' }).textContent()), 'Purify counts first');
  await context.close();
});

// The '+' alt-text form (content: '+' / '') is newer than some browsers the page sells (critic #11): it must
// come after a plain '+', so an engine that can't parse it drops that line and keeps the marker.
await test('S34 the FAQ "+" keeps a plain fallback for browsers without alt text', async () => {
  const css = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');
  const rule = (/summary::after\s*\{([^}]*)\}/.exec(css) || [])[1] || '';
  const contents = [...rule.matchAll(/content:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert(contents.length === 2 && contents[0] === "'+'" && contents[1] === "'+' / ''", `summary::after content: ${contents.join(' | ')}`);
  const { page, context } = await open({ ua: UA.chrome });
  await bringUp(page.locator('details > summary').first());
  const box = await page.locator('details > summary').first().boundingBox();
  const img = await pixels(page, { x: box.x + box.width - 44, y: box.y, width: 40, height: box.height });
  let rose = 0; for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) { const [r, g, b] = px(img, x, y); if (r > 200 && b > 140 && g < 190) rose++; }
  await context.close();
  assert(rose > 10, `the "+" is still drawn (${rose} rose pixels)`);
});

// D64: what you send after you confirm is never purged, so the page can say chatting on is safe.
await test('S35 "keep chatting" comes with what makes it safe', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const answer = await page.locator('details', { hasText: 'How long does it take?' }).textContent();
  await context.close();
  assert(/keep chatting while it works; messages you send after you confirm aren't touched/.test(answer), answer);
  assert(/Keep Discord open until it's done/.test(answer), 'keep Discord open');
});

// D58: the four feature cards stack in one column on a phone and sit two by two on a tablet.
await test('S36 feature cards stack under 560px and pair up under 900px', async () => {
  for (const [w, columns] of [[390, 1], [700, 2], [1440, 4]]) {
    const { page, context } = await open({ ua: UA.chrome, viewport: { width: w, height: 900 } });
    const lefts = await page.$$eval('.feature', (cards) => cards.map((c) => Math.round(c.getBoundingClientRect().left)));
    assert(lefts.length === 4 && new Set(lefts).size === columns, `${w}px: expected ${columns} column(s) of feature cards, got ${new Set(lefts).size} (${lefts})`);
    await context.close();
  }
});

// D24: a live region speaks rarely. Coming back to the tab must not re-write "Installed ✓" for a screen reader to repeat.
await test('S37 step 3 says "Installed ✓" once, not on every return to the tab', async () => {
  const { page, context, errors } = await open({ ua: UA.chrome, withScript: userscript });
  await page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
  const help = page.locator('[data-role="install-help"]');
  assert(/^Installed ✓/.test(await help.textContent()), 'said once');
  await page.evaluate(() => {
    window.__spoke = 0;
    new MutationObserver((list) => { window.__spoke += list.length; }).observe(document.querySelector('[data-role="install-help"]'), { childList: true, characterData: true, subtree: true });
  });
  await comeBack(page);
  await comeBack(page);
  assert((await page.evaluate(() => window.__spoke)) === 0, `the live region was rewritten ${await page.evaluate(() => window.__spoke)} time(s) on tab returns`);
  assert(/^Installed ✓/.test(await help.textContent()), 'and still says it');
  assert(errors.length === 0, errors.join('; '));
  await context.close();
});

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
