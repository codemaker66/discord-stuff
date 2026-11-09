// Screenshots every mock scenario of the installer UI at 1x and 2x.
//   node preview.mjs            -> screens/<scenario>@1x.png, screens/<scenario>@2x.png
//   node preview.mjs fresh done -> just those scenarios
// Serves ui/ over HTTP; ui/mock-tauri.js stands in for the Rust backend.
// Fails if a page logs an error or a scenario never reaches its screen.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.join(here, 'ui');
const outDir = path.join(here, 'screens');

// actions: the [data-action] buttons to click in order; screen: where it must end up;
// ready: an extra selector to wait for before the shot.
const SCENARIOS = [
  { name: 'fresh', screen: 'welcome' },
  { name: 'installing', actions: ['install'], screen: 'installing', ready: '.step[data-step="patch:stable"][data-state="active"]' },
  { name: 'done', actions: ['install'], screen: 'done' },
  { name: 'already', screen: 'already' },
  { name: 'uninstall-choice', scenario: 'already', actions: ['show-uninstall'], screen: 'already', ready: '#uninstall-box:not([hidden])' },
  { name: 'uninstalling', actions: ['show-uninstall', 'uninstall-remove'], screen: 'installing', ready: '.step[data-step^="unpatch:"][data-state="active"]' },
  { name: 'uninstalled', actions: ['show-uninstall', 'uninstall-remove'], screen: 'uninstalled' },
  { name: 'error-offline', actions: ['install'], screen: 'error' },
  { name: 'error-checksum', actions: ['install'], screen: 'error' },
  { name: 'error-cli', actions: ['install'], screen: 'error' },
  { name: 'no-discord', screen: 'no-discord' },
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
    const file = path.normalize(path.join(uiDir, rel));
    if (!file.startsWith(uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const wanted = process.argv.slice(2);
const list = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.name)) : SCENARIOS;
if (!list.length) {
  console.error(`No such scenario. Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const problems = [];
try {
  for (const scale of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 960, height: 600 }, deviceScaleFactor: scale, colorScheme: 'dark' });
    for (const s of list) {
      const page = await context.newPage();
      page.on('pageerror', (e) => problems.push(`${s.name}@${scale}x: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${s.name}@${scale}x console: ${m.text()}`); });
      await page.goto(`${base}/index.html?scenario=${s.scenario || s.name}&speed=4`);
      await page.waitForSelector('#app:not([data-screen="loading"])', { timeout: 10000 });
      await page.evaluate(() => document.fonts.ready);
      for (const a of s.actions || []) {
        await page.click(`[data-action="${a}"]:visible`);
      }
      try {
        await page.waitForSelector(`#app[data-screen="${s.screen}"]`, { timeout: 15000 });
        if (s.ready) await page.waitForSelector(s.ready, { timeout: 15000 });
      } catch {
        problems.push(`${s.name}@${scale}x never reached ${s.screen}${s.ready ? ` / ${s.ready}` : ''}`);
      }
      await page.waitForTimeout(450); // let the screen's entry animation settle
      const file = path.join(outDir, `${s.name}@${scale}x.png`);
      await page.screenshot({ path: file });
      console.log(`${path.relative(here, file)}  (${await page.evaluate(() => document.querySelector('#app').dataset.screen)})`);
      await page.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`\n${list.length * 2} screenshots in ${path.relative(process.cwd(), outDir) || '.'}`);
