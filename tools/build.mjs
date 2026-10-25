// Build everything from src/ + assets/:
//   dist/dopas-discord-purifier.user.js  (Tampermonkey / Violentmonkey userscript)
//   dist/DopasPurifier.plugin.js         (BetterDiscord plugin for the desktop app)
//   docs/                                (the install page, stamped with the version)
// node tools/build.mjs            → writes dist/
// node tools/build.mjs --check    → exits 1 if dist/ or docs/ is out of date (CI runs this)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cfg = pkg.purifier;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const b64 = (p) => fs.readFileSync(path.join(root, p)).toString('base64');

const assets = {
  emote: `data:image/webp;base64,${b64('assets/emote.webp')}`,
  icon: `data:image/webp;base64,${b64('assets/icon.webp')}`,
  sound: `data:audio/mpeg;base64,${b64('assets/delete.mp3')}`,
};

const core = read('src/main.js')
  .replace('/*@@CSS@@*/', () => JSON.stringify(read('src/styles.css')))
  .replace('/*@@ENGINE@@*/', () => read('src/engine.js'))
  .replace('/*@@UI@@*/', () => read('src/ui.js'))
  .replace("'@@EMOTE@@'", () => `'${assets.emote}'`)
  .replace("'@@SOUND@@'", () => `'${assets.sound}'`);

const fill = (template) => template
  .replace('/*@@CORE@@*/', () => core)
  .replaceAll('@@VERSION@@', pkg.version)
  .replaceAll('@@HOMEPAGE@@', cfg.homepage)
  .replaceAll('@@REPO@@', cfg.repo)
  .replaceAll('@@ISSUES@@', `${cfg.repo}/issues`)
  .replaceAll('@@INSTALL_URL@@', `${cfg.raw}/dist/dopas-discord-purifier.user.js`)
  .replaceAll('@@PLUGIN_URL@@', `${cfg.raw}/dist/DopasPurifier.plugin.js`)
  .replaceAll('@@ICON@@', assets.icon);

const plugin = fill(read('src/betterdiscord.js'));
const site = read('docs/index.html').replace(/data-latest="[^"]*"/, `data-latest="${pkg.version}"`);

const outputs = {
  'dist/dopas-discord-purifier.user.js': fill(read('src/userscript.js')),
  'dist/DopasPurifier.plugin.js': plugin,
  // The install page (GitHub Pages serves docs/) knows the latest version and hosts the
  // plugin same-origin so its download link really downloads.
  'docs/index.html': site,
  'docs/downloads/DopasPurifier.plugin.js': plugin,
};

const check = process.argv.includes('--check');
let stale = false;
for (const [file, content] of Object.entries(outputs)) {
  if (/@@[A-Z_]+@@/.test(content)) throw new Error(`${file}: unfilled placeholder ${content.match(/@@[A-Z_]+@@/)[0]}`);
  const target = path.join(root, file);
  if (check) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== content) { console.error(`${file} is out of date — run npm run build`); stale = true; }
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`built ${file} (${(content.length / 1024).toFixed(1)} KB)`);
}
if (stale) process.exit(1);
