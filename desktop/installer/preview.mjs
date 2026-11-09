// Screenshots every mock scenario of the installer UI, checks it, and lays the shots out on a contact sheet.
//   node preview.mjs                 -> screens/<name>@1x.png, @2x.png, screens/contact-sheet.png, screens/audit.txt
//   node preview.mjs fresh done      -> just those scenarios
//   SCALES=1,1.25,1.5,2 node preview.mjs fresh   -> other Windows display scales
//   REDUCED=1 node preview.mjs                   -> with prefers-reduced-motion: reduce
// Serves ui/; ui/mock-tauri.js stands in for the Rust backend. Every shot waits for the screen's motion to
// settle (finite animations and the ring's fill). At 1x it also audits the page:
//   clipped text  any text cut off by its own box or a clipping ancestor (fails the run)
//   contrast      each text's colour against the pixels behind it, WCAG 2 (fails under 4.5:1, 3:1 for large text)
// Fails if a page logs an error, a scenario never reaches its screen, or an audit finds a problem.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, 'ui');
const outDir = path.join(here, 'screens');

// steps: [data-action] names to click, { click: selector } or { key: 'Tab' }; screen: where it must end up;
// ready: an extra selector to wait for; scenario: the mock scenario when it differs from the name;
// intro: play the intro; at: take the shot this many ms after the screen is reached instead of settling.
const SCENARIOS = [
  { name: 'intro', scenario: 'fresh', intro: true, screen: 'welcome', at: 640, fromLoad: true },
  { name: 'loading', screen: 'loading' },
  { name: 'fresh', screen: 'welcome' },
  { name: 'many', screen: 'welcome' },
  { name: 'custom-picked', scenario: 'fresh', steps: [{ click: '.install[data-branch="canary"]' }], screen: 'welcome', ready: '.install[data-branch="canary"].selected' },
  { name: 'about', scenario: 'fresh', steps: ['show-about'], screen: 'welcome', ready: '#about-sheet:not([hidden])' },
  { name: 'no-release', screen: 'welcome' },
  { name: 'keyboard-card', scenario: 'fresh', steps: [{ key: 'Tab' }], screen: 'welcome', ready: '.install:has(.install-box:focus-visible)' },
  { name: 'keyboard-install', scenario: 'fresh', steps: [{ key: 'Tab' }, { key: 'Tab' }, { key: 'Tab' }, { key: 'Tab' }], screen: 'welcome', ready: '#install-btn:focus-visible' },
  { name: 'offline', scenario: 'error-offline', screen: 'welcome' },
  { name: 'installing', steps: ['install'], screen: 'installing', ready: '.step[data-step="patch:stable"][data-state="active"]' },
  { name: 'log-open', scenario: 'installing', steps: ['install', 'toggle-log'], screen: 'installing', ready: '#log:not([hidden])' },
  { name: 'done', steps: ['install'], screen: 'done' },
  { name: 'done-burst', scenario: 'done', steps: ['install'], screen: 'done', at: 560 },
  { name: 'already', screen: 'already' },
  { name: 'up-to-date', screen: 'already' },
  { name: 'choose-apps', scenario: 'up-to-date', steps: ['show-welcome'], screen: 'welcome' },
  { name: 'uninstall-choice', scenario: 'already', steps: ['show-uninstall'], screen: 'already', ready: '#uninstall-box:not([hidden])' },
  { name: 'uninstalling', steps: ['show-uninstall', 'uninstall-remove'], screen: 'installing', ready: '.step[data-step^="unpatch:"][data-state="active"]' },
  { name: 'uninstalled', steps: ['show-uninstall', 'uninstall-remove'], screen: 'uninstalled' },
  { name: 'uninstalled-keep', scenario: 'uninstalled', steps: ['show-uninstall', 'uninstall-keep'], screen: 'uninstalled' },
  { name: 'no-discord', screen: 'no-discord' },
  { name: 'error-offline', steps: ['install'], screen: 'error' },
  { name: 'error-checksum', steps: ['install'], screen: 'error' },
  { name: 'error-cli', steps: ['install'], screen: 'error' },
  { name: 'error-busy', steps: ['install'], screen: 'error' },
  { name: 'error-io', steps: ['install'], screen: 'error' },
  { name: 'error-no-release', steps: ['install'], screen: 'error' },
  { name: 'error-internal', steps: ['install'], screen: 'error' },
  { name: 'error-detect', screen: 'error' },
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const root = rel.startsWith('/screens/') ? here : uiDir;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Waits until every finite animation has finished and the ring has stopped filling.
async function settle(page) {
  await page.waitForFunction(() => !document.querySelector('#app[data-tween]')
    && document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity), null, { timeout: 8000, polling: 50 });
  await page.waitForTimeout(80);
}

// Clipped text: text cut by its own box (ellipsis, clamp) or by any ancestor that clips.
async function auditClipping(page) {
  return page.evaluate(() => {
    const found = [];
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const clips = (cs) => (v) => v !== 'visible';
    const skip = (el) => el.closest('.backdrop, .wm-shine, .sprite, .sr, [aria-hidden="true"] .ico');
    const all = document.querySelectorAll('#app *');
    for (const el of all) {
      if (skip(el) || !visible(el)) continue;
      const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (!texts.length) continue;
      const cs = getComputedStyle(el);
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} "${el.textContent.trim().slice(0, 40)}"`;
      if (clips(cs)(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) found.push(`${name}: wider than its box`);
      if (clips(cs)(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) found.push(`${name}: taller than its box`);
      const range = document.createRange();
      for (const t of texts) {
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) {
          if (r.width < 1) continue;
          if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) found.push(`${name}: outside the window`);
          for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const acs = getComputedStyle(a);
            if (acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
            const scrolls = /auto|scroll/.test(acs.overflowX + acs.overflowY);
            const b = a.getBoundingClientRect();
            if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) {
              found.push(`${name}: ${scrolls ? 'scrolled out of' : 'clipped by'} ${a.tagName.toLowerCase()}.${[...a.classList].join('.')}`);
            }
            break;
          }
        }
      }
    }
    return [...new Set(found)];
  });
}

// Contrast: hide all text, photograph what's behind it, then compare each text colour with the
// median of the pixels under it (text alpha composited over that).
async function auditContrast(page) {
  const items = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#app *')) {
      // [inert]: the screen under an open sheet, covered by it.
      if (el.closest('.backdrop, .wm-word, .wm-shine, .sprite, .sr, [inert]') || !el.getClientRects().length) continue;
      const texts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
      if (!texts.length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      let op = 1;
      for (let a = el; a; a = a.parentElement) op *= Number(getComputedStyle(a).opacity);
      if (op < 0.98) continue; // still fading: not a resting state
      const disabled = Boolean(el.closest('button:disabled'));
      const range = document.createRange();
      range.selectNodeContents(texts[0]);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      out.push({
        name: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} "${el.textContent.trim().slice(0, 32)}"`,
        color: cs.color, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), disabled,
        rect: [r.left, r.top, r.width, r.height],
      });
    }
    return out;
  });
  const hide = await page.addStyleTag({ content: '* { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }' });
  await page.waitForTimeout(30);
  const bg = (await page.screenshot()).toString('base64');
  await hide.evaluate((n) => n.remove());
  return page.evaluate(async ({ bg, items }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${bg}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const lum = ([r, gg, b]) => 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
    const parse = (s) => { const m = s.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
    const res = [];
    for (const it of items) {
      const [x, y, w, h] = it.rect.map(Math.round);
      const data = g.getImageData(Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h)).data;
      const ch = [[], [], []];
      for (let i = 0; i < data.length; i += 4) { ch[0].push(data[i]); ch[1].push(data[i + 1]); ch[2].push(data[i + 2]); }
      const med = ch.map((a) => a.sort((p, q) => p - q)[a.length >> 1]);
      const [r, gg, b, a] = parse(it.color);
      const fg = [r * a + med[0] * (1 - a), gg * a + med[1] * (1 - a), b * a + med[2] * (1 - a)];
      const L1 = lum(fg); const L2 = lum(med);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = it.size >= 24 || (it.size >= 18.66 && it.weight >= 700);
      res.push({ ...it, ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5 });
    }
    return res;
  }, { bg, items });
}

async function contactSheet(browser, base, names) {
  const cells = (scale) => names.filter((n) => fs.existsSync(path.join(outDir, `${n}@${scale}x.png`)))
    .map((n) => `<figure><img src="/screens/${n}@${scale}x.png"><figcaption>${n} <i>@${scale}x</i></figcaption></figure>`).join('');
  fs.writeFileSync(path.join(outDir, 'contact-sheet.html'), `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:28px;background:#1a1a1d;font:600 15px/1.2 system-ui;color:#ddd}
    h1{font-size:20px;margin:0 0 6px} h2{font-size:15px;margin:26px 0 12px;color:#aaa}
    .g{display:grid;grid-template-columns:repeat(4,480px);gap:18px 16px}
    figure{margin:0} img{display:block;width:480px;height:300px;border-radius:6px;box-shadow:0 0 0 1px #333}
    figcaption{margin-top:6px} i{color:#888;font-style:normal;font-weight:500}
  </style><h1>DopasPurifierSetup: every scenario</h1><h2>1x</h2><div class="g">${cells(1)}</div><h2>2x (shown at half size)</h2><div class="g">${cells(2)}</div>`);
  const page = await browser.newPage({ viewport: { width: 2000, height: 800 }, deviceScaleFactor: 1 });
  await page.goto(`${base}/screens/contact-sheet.html`, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  const out = path.join(outDir, 'contact-sheet.png');
  await page.screenshot({ path: out, fullPage: true });
  await page.close();
  return out;
}

const wanted = process.argv.slice(2);
const list = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.name)) : SCENARIOS;
if (!list.length) {
  console.error(`No such scenario. Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}
const scales = (process.env.SCALES || '1,2').split(',').map(Number).filter((n) => n > 0);

fs.mkdirSync(outDir, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const problems = [];
const report = [];
try {
  for (const scale of scales) {
    const context = await browser.newContext({
      viewport: { width: 960, height: 600 }, deviceScaleFactor: scale, colorScheme: 'dark',
      reducedMotion: process.env.REDUCED ? 'reduce' : 'no-preference',
    });
    for (const s of list) {
      const page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`${s.name}@${scale}x: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${s.name}@${scale}x console: ${m.text()}`); });
      const t0 = Date.now();
      await page.goto(`${base}/index.html?scenario=${s.scenario || s.name}&speed=4${s.intro ? '' : '&intro=0'}`);
      await page.evaluate(() => document.fonts.ready);
      if (s.fromLoad) {
        await page.waitForTimeout(Math.max(0, s.at - (Date.now() - t0)));
      } else {
        if (s.screen !== 'loading') await page.waitForSelector('#app:not([data-screen="loading"])', { timeout: 10000 });
        await settle(page).catch(() => {});
        for (const step of s.steps || []) {
          if (step.key) await page.keyboard.press(step.key);
          else await page.click(typeof step === 'string' ? `[data-action="${step}"]:visible` : step.click);
          await page.waitForTimeout(60);
        }
        try {
          await page.waitForSelector(`#app[data-screen="${s.screen}"]`, { timeout: 15000 });
          if (s.ready) await page.waitForSelector(s.ready, { timeout: 15000 });
        } catch {
          problems.push(`${s.name}@${scale}x never reached ${s.screen}${s.ready ? ` / ${s.ready}` : ''}`);
        }
        if (s.at) await page.waitForTimeout(s.at);
        else await settle(page).catch(() => problems.push(`${s.name}@${scale}x never settled`));
      }
      const tag = `${s.name}@${scale}x`;
      const file = path.join(outDir, `${tag}.png`);
      await page.screenshot({ path: file });
      console.log(`${path.relative(here, file)}  (${await page.evaluate(() => document.querySelector('#app').dataset.screen)})`);
      if (scale === 1 && !s.at && !s.fromLoad) {
        const clipped = await auditClipping(page);
        for (const c of clipped) (c.includes('scrolled out of') ? report : problems).push(`${tag} ${c.includes('scrolled out of') ? 'scrolls' : 'CLIPPED'}: ${c}`);
        const contrast = await auditContrast(page);
        const low = contrast.filter((c) => !c.disabled && c.ratio < c.need);
        const weakest = contrast.filter((c) => !c.disabled).sort((x, y) => x.ratio - y.ratio)[0];
        report.push(`${tag} contrast: ${contrast.length} texts, lowest ${weakest ? `${weakest.ratio.toFixed(2)}:1 ${weakest.name}` : 'n/a'}`);
        for (const c of low) problems.push(`${tag} LOW CONTRAST ${c.ratio}:1 (needs ${c.need}) ${c.name}`);
      }
      await page.close();
    }
    await context.close();
  }
  if (!wanted.length || process.env.SHEET) {
    const sheet = await contactSheet(browser, base, list.map((s) => s.name));
    console.log(`\ncontact sheet: ${sheet}`);
  }
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(outDir, 'audit.txt'), `${[...report, '', ...problems].join('\n')}\n`);
if (report.length) console.log(`\n${report.join('\n')}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`\n${list.length * scales.length} screenshots in ${path.relative(process.cwd(), outDir) || '.'}`);
