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

// init runs before the page's own script (to stand in for navigator.share or a refused clipboard).
async function open({ ua, viewport = { width: 1440, height: 900 }, withScript = null, permissions = [], init = null, forcedColors = 'none', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ userAgent: ua, viewport, deviceScaleFactor: 2, permissions, forcedColors, reducedMotion });
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

// A test that can't run on this machine returns skip(why): it is reported, not counted as passing.
const SKIP = Symbol('skip');
const skip = (why) => ({ [SKIP]: why });
async function test(name, fn) {
  if (only && !only.some((o) => name.startsWith(o))) return;
  try {
    const r = await fn();
    if (r && r[SKIP]) { results.push({ name, skipped: r[SKIP] }); console.log(`– ${name}\n    skipped: ${r[SKIP]}`); return; }
    results.push({ name, ok: true }); console.log(`✓ ${name}`);
  } catch (err) { results.push({ name, ok: false, error: String(err) }); console.log(`✗ ${name}\n    ${err.message}`); }
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
    assert(await page.locator(`.chip[data-browser="${key}"][aria-checked="true"]`).count() === 1, 'browser detected');
    const store = await page.locator('[data-role="manager-link"]').getAttribute('href');
    assert(store.includes(expect.store), `store ${store}`);
    assert((await page.locator('[data-step="allow"]').isVisible()) === expect.allow, 'allow-scripts step visibility');
    if (expect.ext) assert((await page.locator('[data-role="ext-url"]').textContent()).startsWith(expect.ext), 'extensions url');
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
    await page.click('[data-role="hero-cta"]');
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
  assert(/then Purify, and hold the red button/.test(await page.locator('[data-step="open"]').textContent()), 'step 4');
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

const PHONE = { width: 390, height: 844 };
const visibleText = (page) => page.evaluate(() => document.body.innerText);
// Store tabs open from step 1; close them and come back the way a person would.
async function visitStore(page) {
  const popup = page.context().waitForEvent('page', { timeout: 3000 }).catch(() => null);
  await page.click('[data-role="manager-link"]');
  const store = await popup;
  if (store) await store.close();
  await comeBack(page);
}

await test('S30 phones: the rose button lands on the phone note, which says what to do there', async () => {
  for (const key of ['iphone', 'android']) {
    const { page, context, errors } = await open({ ua: UA[key], viewport: PHONE });
    const cta = page.locator('[data-role="hero-cta"]');
    assert((await cta.textContent()).trim() === 'Get it on your computer', `${key}: hero reads "${(await cta.textContent()).trim()}"`);
    assert((await cta.getAttribute('href')) === '#on-phone', `${key}: hero goes to ${await cta.getAttribute('href')}`);
    assert(await cta.locator('svg rect').count() === 1 && await page.locator('#on-phone > svg rect').count() === 1, `${key}: a laptop on both, not a download or a shield`);
    const note = await page.locator('#on-phone').textContent();
    assert(/On your phone, princess\? ♡ The Purifier lives in a computer's browser~/.test(note), `${key}: ${note}`);
    assert(/This link is already in your Discord chat — click it there on your computer/.test(note), `${key}: the easy path is named`);
    assert((await page.locator('[data-role="android-only"]').isVisible()) === (key === 'android'), `${key}: the Firefox-for-Android line shows only on Android`);
    assert(!/\$2\.99/.test(await visibleText(page)), `${key}: a price shows before Safari is chosen`);
    await cta.click();
    await page.waitForTimeout(900);
    const top = (await page.locator('#on-phone').boundingBox()).y;
    assert(top >= 20 && top <= 60, `${key}: the note's top sits ${Math.round(top)}px from the top after the tap`);
    await page.click('[data-act="show-steps"]');
    assert(await page.locator('.chip[data-browser="chrome"][aria-checked="true"]').count() === 1, `${key}: computer steps start on Chrome`);
    assert(/^Your computer's browser:/.test((await page.locator('.picker').textContent()).trim()), `${key}: the picker asks about the computer`);
    assert(!/\$2\.99/.test(await visibleText(page)), `${key}: no price on the Chrome steps`);
    await page.click('.chip[data-browser="safari"]');
    assert(/\$2\.99/.test(await visibleText(page)), `${key}: Safari's steps still name the price`);
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  // Firefox for Android can wear it: the note says how, with nothing to send and no button row left over.
  const { page, context } = await open({ ua: UA.firefoxAndroid, viewport: PHONE });
  const note = await page.locator('#on-phone').textContent();
  assert(/Firefox for Android can wear it ♡/.test(note) && /Follow the steps below, then open Discord with ⋮ → Desktop site switched on/.test(note), note);
  assert(!/can't wear/.test(note), 'no "can\'t" on the one phone that can');
  assert(!(await page.locator('[data-act="send-link"]').isVisible()) && !(await page.locator('[data-role="android-only"]').isVisible()), 'no Send button, no repeated Firefox line');
  assert((await page.locator('.note-act').evaluate((el) => getComputedStyle(el).display)) === 'none', 'the empty button row takes no space');
  assert(await page.locator('.chip[data-browser="firefox"][aria-checked="true"]').count() === 1, 'Firefox steps for Firefox');
  assert((await page.locator('[data-role="hero-cta"]').getAttribute('href')) === '#install', 'its hero goes to the steps');
  await context.close();
  // Closing the share sheet is a choice, not a failure: nothing is copied and nothing is said.
  {
    const { page, context } = await open({
      ua: UA.iphone, viewport: PHONE,
      init: () => {
        navigator.share = () => Promise.reject(new DOMException('Share canceled', 'AbortError'));
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } });
      },
    });
    await page.click('[data-act="send-link"]');
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => window.__copied === undefined), 'copied after the sheet was closed');
    assert((await page.locator('[data-role="toast"]').textContent()) === '' && await page.locator('.toast.show').count() === 0, 'a toast after the sheet was closed');
    await context.close();
  }
});

// Exactly one rose button among the steps, on the step this person is on.
const stepState = (page) => page.evaluate(() => ({
  primary: [...document.querySelectorAll('.steps .btn-primary')].map((b) => b.dataset.role),
  current: [...document.querySelectorAll('.step.is-current')].map((s) => s.dataset.step),
  done: [...document.querySelectorAll('.step.is-done')].map((s) => s.dataset.step),
}));
const roseAboveFold = (page) => page.evaluate(() => [...document.querySelectorAll('.btn-primary')]
  .filter((b) => b.offsetParent && b.getBoundingClientRect().top < innerHeight).map((b) => b.textContent.trim()));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await test('S31 one loud button, on the step you are on (fresh, store visited, installed, outdated)', async () => {
  {
    const { page, context, errors } = await open({ ua: UA.chrome });
    let s = await stepState(page);
    assert(same(s.primary, ['manager-link']) && same(s.current, ['manager']), `fresh: ${JSON.stringify(s)}`);
    await visitStore(page);
    s = await stepState(page);
    assert(same(s.primary, ['install-link']) && same(s.current, ['allow']) && s.done.length === 0, `store visited: ${JSON.stringify(s)}`);
    await page.reload();
    await page.waitForTimeout(300);
    assert(same((await stepState(page)).current, ['allow']), 'the step holds for the rest of the visit');
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  {
    const { page, context } = await open({ ua: UA.firefox });
    await visitStore(page);
    const s = await stepState(page);
    assert(same(s.primary, ['install-link']) && same(s.current, ['install']), `Firefox has no step 2: ${JSON.stringify(s)}`);
    await context.close();
  }
  {
    const { page, context } = await open({ ua: UA.safari });
    const s = await stepState(page);
    assert(s.primary.length === 0 && same(s.current, ['manager']), `Safari's paid helper is never the loud button: ${JSON.stringify(s)}`);
    await context.close();
  }
  // Installed: the banner says so first, the hero holds the one action, the steps fold away.
  {
    const { page, context, errors } = await open({ ua: UA.chrome, withScript: userscript });
    await page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
    assert(await page.locator('.lead + .installed + .cta').count() === 1, 'banner sits between the lead and the button');
    assert(await page.locator('[data-role="installed-action"]').count() === 0, 'no second Open Discord in the banner');
    assert(same(await roseAboveFold(page), ['Open Discord']), `rose above the fold: ${await roseAboveFold(page)}`);
    const cta = page.locator('[data-role="hero-cta"]');
    assert((await cta.getAttribute('target')) === '_blank' && /noopener/.test(await cta.getAttribute('rel')), 'Open Discord opens a new tab');
    assert(/Installed — v[\d.]+\. You're all set, princess~ Discord already open\? Reload it once\./.test(await page.locator('[data-role="installed-text"]').textContent()), 'installed copy');
    assert((await page.locator('.installed .tick').textContent()) === '✓', 'tick');
    assert((await page.title()) === "✓ Installed · Dopa's Discord Purifier", `title ${await page.title()}`);
    assert(/Installed — v/.test(await page.locator('[data-role="installed-live"]').textContent()), 'said to screen readers');
    const s = await stepState(page);
    assert(same(s.primary, ['open-link']) && same(s.current, ['open']) && same(s.done, ['manager', 'allow', 'install']), `steps: ${JSON.stringify(s)}`);
    assert(!(await page.locator('[data-role="manager-link"]').isVisible()) && !(await page.locator('[data-step="manager"] [data-role="manager-note"]').isVisible()), 'done steps fold to their heading');
    assert((await page.locator('[data-role="install-link"]').textContent()) === 'Reinstall', 'step 3 offers a quiet Reinstall');
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  {
    const old = userscript.replace(/const VERSION = '[^']+';/, "const VERSION = '4.0.0';");
    const { page, context } = await open({ ua: UA.chrome, withScript: old });
    await page.waitForSelector('.installed.is-update', { timeout: 3000 });
    assert(same(await roseAboveFold(page), ['Update now']), `rose above the fold: ${await roseAboveFold(page)}`);
    const text = await page.locator('[data-role="installed-text"]').textContent();
    assert(text === `v${latest} is out ✨ You have v4.0.0. Press Update now, then Update in Tampermonkey's tab, and reload Discord.`, text);
    assert((await page.locator('.installed .tick').textContent()) === '↑', 'an arrow, not a tick, for out of date');
    assert((await page.title()) === "↑ Update ready · Dopa's Discord Purifier", `title ${await page.title()}`);
    const s = await stepState(page);
    assert(same(s.primary, ['install-link']) && same(s.current, ['install']) && same(s.done, ['manager', 'allow']), `steps: ${JSON.stringify(s)}`);
    assert((await page.locator('[data-role="install-link"]').textContent()) === 'Update', 'step 3 says Update');
    await context.close();
  }
  // Nothing detected after Install: the steps the hint names glow with it.
  {
    const { page, context } = await open({ ua: UA.chrome });
    await withManager(page);
    await page.click('[data-role="install-link"]');
    await comeBack(page);
    await page.waitForFunction(() => /can't see the Purifier/.test(document.querySelector('[data-role="install-help"]').textContent), null, { timeout: 4000 });
    const hinted = await page.$$eval('.step.is-hint', (els) => els.map((e) => e.dataset.step));
    assert(same(hinted, ['manager', 'allow']), `hinted steps: ${hinted}`);
    await context.close();
  }
  // The headline sets in at most two lines at every desktop width, so "Set it up" starts above the fold.
  for (const [w, h] of [[1024, 768], [1280, 800], [1440, 900], [1920, 1080]]) {
    const { page, context } = await open({ ua: UA.chrome, viewport: { width: w, height: h } });
    const lines = await page.locator('h1').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    assert(lines >= 1 && lines <= 2, `${w}px: headline in ${lines} lines`);
    // Windows leads with the Discord app route (S41); the browser route's own fold check moved to S42.
    if (w === 1440) assert((await page.locator('#app').boundingBox()).y < h - 120, 'the Discord app route starts above the fold at 1440×900');
    await context.close();
  }
});

await test('S32 trust at first glance, step 2 as one paste, the link preview and the FAQ', async () => {
  const { page, context, errors } = await open({ ua: UA.chrome });
  assert(await page.locator('.cta + .trust + .meta').count() === 1, 'trust row between the buttons and the meta line');
  const trust = await page.$$eval('.trust li', (els) => els.map((li) => ({ text: li.textContent.trim(), top: Math.round(li.getBoundingClientRect().top) })));
  assert(same(trust.map((t) => t.text), ['Only your messages', 'Login stays in Discord', 'Free & open source']), JSON.stringify(trust));
  assert(new Set(trust.map((t) => t.top)).size === 1, 'trust row on one line at 1440');
  assert((await page.locator('.meta').textContent()).trim() === `v${latest} · two-minute setup on a computer · no sign-up`, await page.locator('.meta').textContent());
  assert((await page.locator('#install .sub').textContent()).trim() === 'The Purifier lives inside Discord in your browser, carried by Tampermonkey, a free helper extension. Set it up once — updates arrive by themselves.', 'setup intro');
  await page.click('.trust a[href="#faq-safe"]');
  await page.waitForTimeout(900);
  assert(await page.locator('#faq-safe').evaluate((d) => d.open && d.getBoundingClientRect().top >= -2 && d.getBoundingClientRect().top < innerHeight), '"Login stays in Discord" opens the safety answer');
  // The link preview: says what it is and that it's safe, without repeating the name.
  const meta = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('meta[property], meta[name]')].map((m) => [m.getAttribute('property') || m.name, m.content])));
  const blurb = 'Deletes only messages you sent, and only while you hold the button. Free, open source, and your login never leaves Discord ♡ Two-minute setup on a computer.';
  assert(meta['og:title'] === 'Wipe your Discord messages, gently ✨', meta['og:title']);
  assert(meta['og:description'] === blurb && meta.description === blurb, meta['og:description']);
  assert(/^Dopa's Discord Purifier, now in the Discord app/.test(meta['og:image:alt'] || '') && /\/img\/share-desktop\.png$/.test(meta['og:image'] || ''), 'og:image and its alt: the Discord-app share card');
  assert(meta['og:site_name'] === "Dopa's Discord Purifier" && meta['twitter:card'] === 'summary_large_image' && meta['theme-color'] === '#ff7aa9', 'site name, card and colour kept');
  // Step 2 on Chrome: copy the address, flip the switch; the Developer-mode fallback is fine print.
  const how = await page.$$eval('[data-step="allow"] .how li', (els) => els.filter((li) => li.offsetParent).map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  assert(how.length === 2 && /^Copy this, paste it into a new tab:/.test(how[0]) && /Allow User Scripts/.test(how[1]), JSON.stringify(how));
  assert(/^No such switch\? Turn on Developer mode, top right of that same page\.$/.test((await page.locator('[data-step="allow"] .fine').textContent()).trim()), 'fallback fine print');
  assert(await page.locator('[data-step="allow"] .linkbox [data-role="ext-url"] + [data-act="copy-ext"]').isVisible(), 'the address sits in a field with its Copy button');
  // FAQ: the plain reassurance first, the two missing questions, and a readable measure.
  const questions = await page.$$eval('summary', (els) => els.map((s) => s.textContent.trim()));
  const after = (q, next) => questions.indexOf(next) === questions.indexOf(q) + 1;
  assert(after('Can I undo a purge?', 'Does anyone get told?') && after('How do updates work?', 'How do I remove it?'), JSON.stringify(questions));
  assert(/^You never paste a token, a password or any code\./.test((await page.locator('#faq-safe p').first().textContent()).trim()), 'safety answer leads with no token');
  const help = await page.locator('details', { hasText: 'Nothing shows up' }).textContent();
  assert(/it's the Allow User Scripts step/.test(help) && !/step 2/.test(help), 'names the switch, not a step number that differs per browser');
  assert(/Tampermonkey icon → Dashboard/.test(await page.locator('details', { hasText: 'How do I remove it?' }).textContent()), 'how to remove it');
  assert((await page.locator('details > div').first().evaluate((d) => parseFloat(getComputedStyle(d).maxWidth))) === 760, 'FAQ answers keep a readable measure');
  assert((await page.locator('.feature h3').first().textContent()) === 'Know before you purge', 'feature card 1');
  assert(errors.length === 0, errors.join('; '));
  await context.close();
  // Opera's helper has no known details page, so its step 2 keeps the toolbar route.
  {
    const { page, context } = await open({ ua: UA.opera });
    const how = await page.$$eval('[data-step="allow"] .how li', (els) => els.filter((li) => li.offsetParent).map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
    assert(/^Right-click the Tampermonkey icon/.test(how[0]) && how.some((t) => /opera:\/\/extensions/.test(t)), JSON.stringify(how));
    await context.close();
  }
  // Safari is told the price once, where it decides.
  {
    const { page, context } = await open({ ua: UA.safari });
    assert(/· Safari's helper app costs \$2\.99$/.test((await page.locator('.meta').textContent()).trim()), 'Safari meta');
    assert(/On Safari it costs \$2\.99; Chrome, Edge and Firefox are free\.$/.test((await page.locator('#install .sub').textContent()).trim()), 'Safari intro');
    await context.close();
  }
});

await test('S33 copying says so on the button you pressed; a refused clipboard selects the link instead', async () => {
  {
    const { page, context } = await open({ ua: UA.chrome, permissions: ['clipboard-read', 'clipboard-write'] });
    assert((await page.locator('[data-role="share-url"]').textContent()) === 'codemaker66.github.io/discord-stuff', 'the link reads without its https://');
    const button = page.locator('.share [data-act="share"]');
    await button.click();
    await page.waitForTimeout(200);
    assert((await button.textContent()).trim() === 'Copied ✓', `share button says "${(await button.textContent()).trim()}"`);
    assert((await page.evaluate(() => navigator.clipboard.readText())) === HOME, 'the full link is copied');
    assert(await page.locator('.toast.show').count() === 0 && /Link copied/.test(await page.locator('[data-role="toast"]').textContent()), 'no toast over the page, but screen readers hear it');
    await page.waitForTimeout(1600);
    assert((await button.textContent()).trim() === 'Copy link', 'the label comes back');
    const hero = page.locator('.hero [data-act="share"]');
    await hero.click();
    await page.waitForTimeout(200);
    assert((await hero.locator('span').textContent()) === 'Copied ✓' && await hero.locator('svg').count() === 1, 'hero swaps only its words');
    await page.click('[data-act="copy-ext"]');
    await page.waitForTimeout(200);
    assert((await page.locator('[data-act="copy-ext"]').textContent()) === 'Copied ✓', 'extension address copy says so too');
    await context.close();
  }
  {
    const { page, context } = await open({ ua: UA.chrome, init: () => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
    } });
    await page.click('.hero [data-act="share"]');
    await page.waitForTimeout(400);
    assert((await page.evaluate(() => getSelection().toString())) === 'codemaker66.github.io/discord-stuff', 'the link is selected');
    assert(await page.locator('.toast.show').count() === 1 && (await page.locator('[data-role="toast"]').textContent()) === 'Link selected~ press Ctrl+C (⌘C on Mac) ♡', 'and the toast says what to press');
    const pasted = await page.evaluate(() => {
      const data = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return data.getData('text/plain');
    });
    assert(pasted === HOME, `Ctrl+C on the shown link copies ${pasted}, which Discord would not make a link`);
    await page.waitForTimeout(2800);
    assert(await page.locator('.toast.show').count() === 1, 'the toast stays long enough to act on');
    await page.waitForTimeout(1200);
    assert(await page.locator('.toast.show').count() === 0, 'then goes');
    await page.click('[data-act="copy-ext"]');
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => getSelection().toString())) === 'chrome://extensions', 'the address is selected');
    assert((await page.locator('[data-role="toast"]').textContent()) === 'Selected~ press Ctrl+C, then paste it in the address bar', 'address toast');
    await context.close();
  }
  // A phone that shares says Share; the link wraps instead of hiding its end.
  {
    const { page, context } = await open({ ua: UA.android, viewport: PHONE, init: () => { navigator.share = async () => {}; } });
    assert((await page.locator('.share [data-act="share"]').textContent()).trim() === 'Share link', 'share card on a phone');
    const url = await page.locator('[data-role="share-url"]').evaluate((el) => ({ full: el.scrollWidth <= el.clientWidth + 1, text: el.textContent }));
    assert(url.full, `link cut off at 390px: ${url.text}`);
    await context.close();
  }
});

// A step's number sits beside its heading's first line, however tall the step is.
const badgeOffsets = (page) => page.$$eval('.step', (steps) => steps.filter((s) => s.offsetParent).map((s) => {
  const cs = getComputedStyle(s); const b = getComputedStyle(s, '::before');
  const h = parseFloat(b.height); const mt = parseFloat(b.marginTop) || 0; const mb = parseFloat(b.marginBottom) || 0;
  const row = parseFloat(cs.gridTemplateRows);
  const align = ['auto', 'normal'].includes(b.alignSelf) ? cs.alignItems : b.alignSelf;
  const free = row - h - mt - mb;
  const badge = s.getBoundingClientRect().top + parseFloat(cs.paddingTop) + mt + (align === 'center' ? free / 2 : align === 'end' ? free : 0) + h / 2;
  const h3 = s.querySelector('h3'); const line = parseFloat(getComputedStyle(h3).lineHeight);
  return { step: s.dataset.step, off: Math.round(badge - (h3.getBoundingClientRect().top + line / 2)) };
}));

await test('S34 finish: aligned step numbers, 320px reflow, even desktop cards, the hero picture and icon', async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const { page, context } = await open({ ua: UA.chrome, viewport: { width: w, height: h } });
    const off = await badgeOffsets(page);
    assert(off.length === 4 && off.every((o) => Math.abs(o.off) <= 4), `${w}px: number vs heading ${JSON.stringify(off)}`);
    await context.close();
  }
  {
    const { page, context } = await open({ ua: UA.chrome, viewport: { width: 320, height: 640 } });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(overflow <= 0, `320px (400% zoom) scrolls sideways by ${overflow}px`);
    await context.close();
  }
  const { page, context } = await open({ ua: UA.chrome });
  const cards = await page.$$eval('.two .panel', (els) => els.map((p) => { const b = [...p.querySelectorAll('.btn')].pop(); return { last: p.lastElementChild === b, bottom: b && Math.round(b.getBoundingClientRect().bottom), text: b && b.textContent.trim(), href: b && b.getAttribute('href') }; }));
  assert(cards.length === 2 && cards.every((c) => c.last) && cards[0].bottom === cards[1].bottom, `desktop cards end on buttons at one line: ${JSON.stringify(cards)}`);
  assert(cards[0].text === 'Open Discord in the browser' && cards[0].href === 'https://discord.com/app', 'the easiest path has its button');
  assert(await page.locator('.two .panel a[href="downloads/DopasPurifier.plugin.js"]').count() === 1, 'the plugin is offered once');
  const img = page.locator('.shot img');
  assert((await img.getAttribute('fetchpriority')) === 'high' && (await img.getAttribute('decoding')) === 'async', 'hero picture loads first');
  assert((await img.evaluate((el) => getComputedStyle(el).boxShadow)) === 'none', 'the picture brings its own shadows, no ring or box around it');
  const icon = await page.locator('link[rel="icon"]').first().evaluate((l) => ({ href: l.getAttribute('href'), sizes: l.getAttribute('sizes') }));
  assert(icon.href === 'img/favicon-32.png' && icon.sizes === '32x32', `first icon ${JSON.stringify(icon)}`);
  assert(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--t4') === ''), 'no unused --t4');
  await page.locator('summary').first().focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert((await page.locator('summary').first().evaluate((el) => el.matches(':focus-visible') && getComputedStyle(el).borderTopLeftRadius)) === '16px', 'FAQ focus ring follows the card');
  await context.close();
});

await test('S35 the browser picker is one radio group: one tab stop, arrows choose', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  assert(await page.getByRole('radiogroup', { name: /Your browser/ }).count() === 1, 'a labelled radiogroup');
  const chips = await page.$$eval('.chip', (els) => els.map((c) => ({ role: c.getAttribute('role'), checked: c.getAttribute('aria-checked'), tab: c.tabIndex })));
  assert(chips.every((c) => c.role === 'radio') && chips.filter((c) => c.checked === 'true').length === 1, JSON.stringify(chips));
  assert(same(chips.map((c) => c.tab), [0, -1, -1, -1, -1, -1]), `one tab stop, on the chosen chip: ${chips.map((c) => c.tab)}`);
  const at = () => page.evaluate(() => ({ focus: document.activeElement.dataset.browser, checked: document.querySelector('.chip[aria-checked="true"]').dataset.browser, store: document.querySelector('[data-role="manager-link"]').href }));
  await page.locator('.chip[data-browser="chrome"]').focus();
  await page.keyboard.press('ArrowRight');
  let s = await at();
  assert(s.focus === 'edge' && s.checked === 'edge' && /microsoftedge/.test(s.store), `ArrowRight: ${JSON.stringify(s)}`);
  await page.keyboard.press('End');
  s = await at();
  assert(s.focus === 'safari' && s.checked === 'safari', `End: ${JSON.stringify(s)}`);
  await page.keyboard.press('ArrowRight');
  assert((await at()).checked === 'chrome', 'wraps around');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Home');
  s = await at();
  assert(s.focus === 'chrome' && s.checked === 'chrome', `Home: ${JSON.stringify(s)}`);
  assert(same(await page.$$eval('.chip', (els) => els.map((c) => c.tabIndex)), [0, -1, -1, -1, -1, -1]), 'the tab stop follows the choice');
  await context.close();
});

await test('S36 forced colours: the chosen browser, buttons and cards keep their edges', async () => {
  const { page, context } = await open({ ua: UA.chrome, forcedColors: 'active' });
  const look = await page.evaluate(() => {
    const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
    return {
      chosen: css('.chip[aria-checked="true"]', 'backgroundColor'), other: css('.chip[aria-checked="false"]', 'backgroundColor'),
      btn: css('.btn', 'borderTopStyle'), copy: css('.copy', 'borderTopStyle'), step: css('.step', 'borderTopStyle'),
      faq: css('details', 'borderTopStyle'), toggle: css('.toggle-mock i', 'borderTopStyle'),
    };
  });
  assert(look.chosen !== look.other, `chosen chip looks like the rest: ${look.chosen}`);
  for (const k of ['btn', 'copy', 'step', 'faq', 'toggle']) assert(look[k] === 'solid', `${k} has no edge: ${look[k]}`);
  await context.close();
});

await test('S37 reduced motion keeps the toast\'s fade and drops only movement', async () => {
  const { page, context } = await open({ ua: UA.chrome, reducedMotion: 'reduce', init: () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
  } });
  const props = await page.evaluate(() => ({ toast: getComputedStyle(document.querySelector('.toast')).transitionProperty, btn: getComputedStyle(document.querySelector('.btn')).transitionProperty }));
  assert(!/transform/.test(props.toast) && !/transform/.test(props.btn), `movement still transitions: ${JSON.stringify(props)}`);
  const samples = await page.evaluate(() => new Promise((resolve) => {
    const t = document.querySelector('.toast'); const seen = [];
    document.querySelector('.hero [data-act="share"]').click();
    const t0 = performance.now();
    (function frame() { seen.push(Number(getComputedStyle(t).opacity)); if (performance.now() - t0 < 400) requestAnimationFrame(frame); else resolve(seen); })();
  }));
  assert(samples.some((o) => o > 0.05 && o < 0.95), `the toast pops in with no fade: ${samples.map((o) => o.toFixed(2)).join(' ')}`);
  await context.close();
});

await test('S38 one name per idea on the page and in the README: open a chat, Purify, hold', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const step4 = (await page.locator('[data-step="open"]').textContent()).replace(/\s+/g, ' ');
  assert(/Already open\? Reload it once\. Look top-right for the panel, open any chat, then Purify, and hold the red button\. That's it~/.test(step4), step4);
  const faq = async (q) => (await page.locator('details', { hasText: q }).textContent()).replace(/\s+/g, ' ');
  assert(/That's why it counts first and asks you to hold the button\./.test(await faq('Can I undo a purge?')), 'undo answer');
  assert(/Bardo and Dopa are shielded from the start~ ♡ Shields cover one-to-one DMs, not group chats\./.test(await faq("Can it delete other people's messages?")), 'shield answer');
  assert(/press Install \(or Reinstall\) in step 3\./.test(await faq('How do updates work?')), 'updates answer names the button as it reads');
  assert((await page.locator('.feature p').nth(3).textContent()) === "Tap the shield on anyone's DM and it's never purged, until you say so.", 'shield card');
  // The drawn SmartScreen box and its FAQ quote Windows' own words, which aren't the shield's name.
  const text = (await page.locator('body').textContent()).replace(/protected your PC/g, '');
  for (const word of [/forever/i, /Current channel/i, /\bBatch\b/, /\bProtect/i]) assert(!word.test(text), `page still says ${word}`);
  await context.close();
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert(readme.includes('- **Open a chat, press Purify** — it counts your messages first, so the confirm says exactly how many.'), 'README leads with the flow');
  assert(readme.includes('- **Many chats**:') && !/\*\*Batch\*\*/.test(readme), 'README says Many chats');
  assert(readme.includes('Bardo and Dopa are shielded from the start ♡'), 'README names both shields');
});

// tools/marketing.py lifts the panel and the log window out of the shots (test/shots.mjs records both
// boxes). Run it on a stand-in shot set and check the hero picture matches the page's img size.
await test('S39 the hero picture and icon come out of tools/marketing.py the size the page says', async () => {
  const py = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' });
  if (py.status !== 0) return skip('needs python3 with Pillow, as tools/marketing.py does');
  const fonts = spawnSync('fc-match', ['-f', '%{file}', 'Inter:bold'], { encoding: 'utf8' });
  if (fonts.status !== 0 || !/Inter/.test(fonts.stdout)) return skip('needs the Inter font, as tools/marketing.py does');
  const shots = path.join(OUT, 'marketing-shots');
  const out = path.join(OUT, 'marketing-img');
  fs.rmSync(shots, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const timing = /const TIMING = \{([^}]*)\}/.exec(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8'))[1];
  const pace = Object.fromEntries(['deleteDelayMs', 'searchDelayMs'].map((k) => [k, Number(new RegExp(`\\b${k}:\\s*(\\d+)`).exec(timing)[1])]));
  fs.writeFileSync(path.join(shots, 'pace.json'), JSON.stringify(pace));
  // A grey "Discord" with a panel and a log window drawn on it, at 2x, the way shots.mjs leaves them.
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 860, height: 640 } });
  const p = await ctx.newPage();
  await p.setContent('<body style="margin:0;background:#313338"><div style="position:absolute;left:40px;top:40px;width:380px;height:440px;border-radius:16px;background:#0c0609"></div><div style="position:absolute;left:434px;top:40px;width:360px;height:536px;border-radius:20px;background:#1b0f16"></div></body>');
  const names = ['00-welcome', '02-scanned', '04-confirm-holding', '05-purging-logs', '08-done-settled', '11-batch-scanned', '15-immune'];
  for (const n of names) await p.screenshot({ path: path.join(shots, `${n}.png`) });
  await ctx.close();
  const boxes = Object.fromEntries(names.map((n) => [n, [868, 80, 1588, 1152]]));
  fs.writeFileSync(path.join(shots, 'panels.json'), JSON.stringify({ dpr: 2, boxes, terms: { '05-purging-logs': [80, 80, 840, 960] }, radius: { panel: 20, term: 16 } }));
  const shipped = fs.statSync(path.join(root, 'docs/img/purging.webp')).mtimeMs;
  const run = spawnSync('python3', [path.join(root, 'tools/marketing.py'), shots, out], { encoding: 'utf8' });
  assert(run.status === 0, `marketing.py: ${run.stderr || run.stdout}`);
  assert(fs.statSync(path.join(root, 'docs/img/purging.webp')).mtimeMs === shipped, 'docs/img left alone when given another folder');
  const { page, context } = await open({ ua: UA.chrome });
  const want = await page.locator('.shot img').evaluate((img) => ({ w: Number(img.getAttribute('width')), h: Number(img.getAttribute('height')) }));
  const look = (file) => page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode();
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return { w: img.naturalWidth, h: img.naturalHeight, corner: g.getImageData(0, 0, 1, 1).data[3] };
  }, `data:image/${path.extname(file).slice(1)};base64,${fs.readFileSync(file).toString('base64')}`);
  const hero = await look(path.join(out, 'purging.webp'));
  const icon = await look(path.join(out, 'favicon-32.png'));
  await context.close();
  assert(hero.w === want.w && hero.h === want.h, `purging.webp is ${hero.w}×${hero.h}, the page says ${want.w}×${want.h}`);
  assert(hero.corner === 0, 'the picture floats on the page: transparent around the windows');
  assert(icon.w === 32 && icon.h === 32 && icon.corner === 0, `favicon ${JSON.stringify(icon)}: 32 px with rounded, see-through corners`);
  const stamp = `dopa-pace: deleteDelayMs=${pace.deleteDelayMs} searchDelayMs=${pace.searchDelayMs}`;
  assert(fs.readFileSync(path.join(out, 'purging.webp')).includes(stamp), 'purging.webp carries the pace stamp');
  assert(fs.readFileSync(path.join(out, 'og.png')).includes(stamp), 'og.png carries the pace stamp');
  fs.rmSync(shots, { recursive: true, force: true });
});

// ── The Discord app route (Windows installer) ──
const APP_URL = 'https://github.com/codemaker66/discord-stuff/releases/latest/download/DopasPurifierSetup.exe';
// GitHub stands in for the release: the click downloads a file, as the real link does.
const fakeRelease = (page) => page.route('https://github.com/**', (route) => route.fulfill({
  status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=DopasPurifierSetup.exe' }, body: 'MZ',
}));
const appState = (page) => page.evaluate(() => ({
  current: [...document.querySelectorAll('[data-app-step].is-current')].map((li) => li.dataset.appStep),
  done: [...document.querySelectorAll('[data-app-step].is-done')].map((li) => li.dataset.appStep),
  loud: document.querySelector('[data-role="app-link"]').classList.contains('btn-primary'),
}));

await test('S40 the Discord app button: the stable link, a clear name, and an honest word on what it installs', async () => {
  const html = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');
  assert(html.includes('<!-- installer-shots -->'), 'a place kept for the installer pictures');
  assert(!/installer-(?:welcome|installing|done)\.webp/.test(html), 'installer pictures not referenced before they exist');
  const { page, context, errors } = await open({ ua: UA.chrome, viewport: { width: 1366, height: 768 } });
  const button = page.locator('#app').getByRole('link', { name: 'Get it for the Discord app', exact: true });
  assert(await button.count() === 1, 'one link named "Get it for the Discord app" in the app section');
  assert((await button.getAttribute('href')) === APP_URL, `href ${await button.getAttribute('href')}`);
  assert((await button.getAttribute('target')) === null, 'downloads in place, no blank tab');
  assert(/Windows 10\/11/.test(await page.locator('#app .app-meta').textContent()), 'says which Windows');
  const app = (await page.locator('#app').textContent()).replace(/\s+/g, ' ');
  assert(/Vencord, a popular Discord mod, with Dopa's Purifier built in/.test(app), 'what it installs');
  assert(/settings and plugins are kept/.test(app) && /Run the same app again and press Uninstall/.test(app), 'settings kept, uninstall from the same app');
  assert(/Honest note: client mods like Vencord are against Discord's terms, so like any tool of this kind it carries a small risk\. Use it at your own discretion\./.test(app), 'the honest terms line');
  const steps = await page.$$eval('[data-app-step]', (els) => els.map((li) => li.querySelector('b').textContent));
  assert(same(steps, ['Download', 'Run it', 'Discord reopens with the Purifier']), JSON.stringify(steps));
  const faq = (await page.locator('details', { hasText: 'How do I remove it?' }).textContent()).replace(/\s+/g, ' ');
  assert(/run DopasPurifierSetup\.exe again and press Uninstall/.test(faq), 'the FAQ says how to remove the app version');
  assert(/against Discord's terms too/.test(await page.locator('details', { hasText: 'Could my account get in trouble?' }).textContent()), 'the risk answer covers client mods');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert(readme.includes(APP_URL), 'README offers the stable link');
  assert(errors.length === 0, errors.join('; '));
  await context.close();
});

await test('S41 Windows visitors get the Discord app first, and the steps follow the download', async () => {
  for (const key of ['chrome', 'edge', 'firefox']) {
    const { page, context, errors } = await open({ ua: UA[key], viewport: { width: 1366, height: 768 } });
    const hero = page.locator('[data-role="hero-cta"]');
    assert((await hero.textContent()).trim() === 'Get it for the Discord app' && (await hero.getAttribute('href')) === APP_URL, `${key}: hero is the download`);
    const order = await page.evaluate(() => ({
      next: document.querySelector('header.hero').nextElementSibling.id,
      before: !!(document.querySelector('#app').compareDocumentPosition(document.querySelector('#install')) & Node.DOCUMENT_POSITION_FOLLOWING),
      rose: [...document.querySelectorAll('.btn-primary')].filter((b) => b.offsetParent).slice(0, 2).map((b) => b.dataset.role),
    }));
    assert(order.next === 'app' && order.before, `${key}: the app section comes straight after the hero: ${JSON.stringify(order)}`);
    assert(same(order.rose, ['hero-cta', 'app-link']), `${key}: the first rose buttons are the download: ${order.rose}`);
    assert(!(await page.locator('[data-role="app-other"]').isVisible()), `${key}: no "Windows only" note on Windows`);
    assert(await page.locator('[data-role="smartscreen"]').isVisible(), `${key}: the SmartScreen help shows`);
    assert((await page.locator('#app').boundingBox()).y < 768, `${key}: the app section starts on the first screen at 1366×768`);
    assert(same(await appState(page), { current: ['download'], done: [], loud: true }), `${key}: fresh ${JSON.stringify(await appState(page))}`);
    assert(await page.locator('#install .step').first().isVisible() && await page.locator('a[href="downloads/DopasPurifier.plugin.js"]').isVisible(), `${key}: browser and BetterDiscord routes stay reachable`);
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  // Pressed in the hero: it downloads, glides to the app section, and "Run it" is the step you're on.
  {
    const { page, context, errors } = await open({ ua: UA.chrome, viewport: { width: 1366, height: 768 } });
    await fakeRelease(page);
    const download = page.waitForEvent('download', { timeout: 5000 });
    await page.click('[data-role="hero-cta"]');
    assert((await download).suggestedFilename() === 'DopasPurifierSetup.exe', 'the installer downloads');
    await page.waitForTimeout(1200);
    assert(same(await appState(page), { current: ['run'], done: ['download'], loud: false }), `after download ${JSON.stringify(await appState(page))}`);
    assert((await page.locator('[data-role="app-link"]').textContent()).trim() === 'Download it again', 'the button quiets to Download it again');
    const top = (await page.locator('#app').boundingBox()).y;
    assert(Math.abs(top) < 80, `the app section glides into view (top ${Math.round(top)}px)`);
    await page.reload();
    await page.waitForTimeout(300);
    assert(same((await appState(page)).current, ['run']), 'the step holds for the rest of the visit');
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  // The Purifier already running in this browser: that route is theirs, so the app route stays quiet.
  {
    const { page, context } = await open({ ua: UA.chrome, withScript: userscript });
    await page.waitForSelector('[data-role="installed"]:not([hidden])', { timeout: 3000 });
    assert(same(await appState(page), { current: [], done: [], loud: false }), `installed: ${JSON.stringify(await appState(page))}`);
    await context.close();
  }
});

await test('S42 Mac, Linux and phones are told it is Windows only for now, with the browser route first', async () => {
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  for (const [name, ua] of [['safari', UA.safari], ['mac chrome', macChrome], ['linux', linux]]) {
    const { page, context, errors } = await open({ ua, viewport: { width: 1440, height: 900 } });
    const note = page.locator('[data-role="app-other"]');
    assert(await note.isVisible() && /^Windows only for now~ On a Mac or Linux, use Discord in your browser instead/.test((await note.textContent()).trim()), `${name}: ${await note.textContent()}`);
    const hero = page.locator('[data-role="hero-cta"]');
    assert((await hero.textContent()).trim() === 'Get it free' && (await hero.getAttribute('href')) === '#install', `${name}: hero leads to the browser setup`);
    assert(await page.evaluate(() => !!(document.querySelector('#install').compareDocumentPosition(document.querySelector('#app')) & Node.DOCUMENT_POSITION_FOLLOWING)), `${name}: the browser setup comes first`);
    assert((await page.locator('#install').boundingBox()).y < 900 - 120, `${name}: "Set it up" above the fold at 1440×900`);
    const link = page.locator('[data-role="app-link"]');
    assert(!(await link.evaluate((el) => el.classList.contains('btn-primary'))) && (await link.textContent()).trim() === 'Download for Windows' && (await link.getAttribute('href')) === APP_URL, `${name}: a quiet Windows download remains`);
    assert(!(await page.locator('[data-role="app-steps"]').isVisible()) && !(await page.locator('[data-role="smartscreen"]').isVisible()), `${name}: no Windows steps`);
    assert((await page.locator('#app-title').textContent()) === 'The Discord app version', `${name}: heading`);
    assert(errors.length === 0, errors.join('; '));
    await context.close();
  }
  for (const key of ['iphone', 'android']) {
    const { page, context } = await open({ ua: UA[key], viewport: PHONE });
    assert(/^Windows only for now~ Use the Discord app on a Windows PC\? Open this page there/.test((await page.locator('[data-role="app-other"]').textContent()).trim()), `${key}: phone note`);
    assert(!(await page.locator('[data-role="app-link"]').isVisible()), `${key}: no .exe offered to a phone`);
    await context.close();
  }
});

await test('S43 the drawn SmartScreen box reads as text to screen readers', async () => {
  const { page, context } = await open({ ua: UA.chrome });
  const fig = page.getByRole('figure', { name: /protected your PC.*More info, then Run anyway/ });
  assert(await fig.count() === 1, 'a figure named by its caption');
  const tree = await fig.ariaSnapshot();
  for (const words of ['Windows protected your PC', 'More info', 'Run anyway', "Don't run", 'App: DopasPurifierSetup.exe']) assert(tree.includes(words), `"${words}" missing from ${tree}`);
  assert(!/\b(?:button|link)\b/.test(tree), `a drawing, not controls: ${tree}`);
  const hidden = await fig.evaluate((el) => [...el.querySelectorAll('[aria-hidden="true"]')].filter((n) => n.textContent.trim()).length);
  assert(hidden === 0, 'no words hidden from screen readers');
  assert(await page.locator('.ss img, .ss svg').count() === 0, 'drawn with HTML and CSS, no logo or screenshot');
  await context.close();
});

await test('S44 the app route reflows at 320px with no sideways scroll', async () => {
  for (const [name, ua] of [['windows', UA.chrome], ['mac', UA.safari], ['iphone', UA.iphone]]) {
    const { page, context } = await open({ ua, viewport: { width: 320, height: 640 } });
    const r = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wide: [...document.querySelectorAll('#app *')].filter((el) => el.offsetParent && el.getBoundingClientRect().right > innerWidth + 0.5).map((el) => el.className || el.tagName).slice(0, 5),
    }));
    assert(r.overflow <= 0 && r.wide.length === 0, `${name}: ${JSON.stringify(r)}`);
    await context.close();
  }
});

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
const ran = results.filter((r) => !r.skipped);
const failed = ran.filter((r) => !r.ok);
const skipped = results.length - ran.length;
console.log(`\n${ran.length - failed.length}/${ran.length} passed${skipped ? ` · ${skipped} skipped` : ''}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
