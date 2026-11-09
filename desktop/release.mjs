#!/usr/bin/env node
// Publish a desktop release on GitHub: the Vencord build that desktop/build-vencord.mjs wrote
// into --out, plus the installer.
//
//   node desktop/release.mjs --out <dir> --exe <path to DopasPurifierSetup.exe>
//       [--repo <owner/repo>]   default: $GITHUB_REPOSITORY, else package.json's purifier.repo
//       [--target <full sha>]   the commit to tag; default: HEAD when it is the build's hash
//       [--notes <file>]        default: desktop/RELEASE_NOTES.md
//       [--dry-run]             print the gh command and the rendered notes; change nothing
//
// Tag desktop-v<version>-<hash>, title "Dopa's Discord Purifier <version> for the Discord app ·
// Vencord <label> · <hash>". The title must END with the hash: a friend's Vencord updater
// (src/main/updater/http.ts) reads releases/latest, takes the last word of its name as the
// build hash and updates when it differs from its own. SHA256SUMS.txt is recomputed over every
// asset, the installer included. A real run needs the gh CLI, signed in. A commit that the latest
// desktop release already contains is not released (exit 0): see release-order.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { releaseOrder } from './release-order.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const VENCORD_FILES = ['patcher.js', 'preload.js', 'renderer.js', 'renderer.css'];
const EXE_NAME = 'DopasPurifierSetup.exe';
const PLACEHOLDERS = ['VERSION', 'VENCORD', 'HASH', 'DATE'];

const fail = (msg) => {
  console.error(`\nrelease: ${msg}`);
  process.exit(1);
};

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    exe: { type: 'string' },
    repo: { type: 'string' },
    target: { type: 'string' },
    notes: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});
if (args.help) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('// Tag desktop'))).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const dry = args['dry-run'];
// A dry run reports what a real run would refuse, and carries on.
const problem = (msg) => (dry ? console.warn(`! ${msg}`) : fail(msg));

for (const k of ['out', 'exe']) if (!args[k]) fail(`--${k} is required (see --help)`);
const out = path.resolve(args.out);
const exe = path.resolve(args.exe);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
const capture = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: !r.error && r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr || r.error?.message || '').trim() };
};

// ---------------------------------------------------------------------------------------------
// What is being released.

const pkg = readJson(path.join(root, 'package.json'));
const pin = readJson(path.join(here, 'vencord.json'));
const repo = args.repo || process.env.GITHUB_REPOSITORY || pkg.purifier.repo.replace(/^https:\/\/github\.com\//, '');
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`--repo must be owner/repo (got "${repo}")`);

const buildFile = path.join(out, 'build.json');
if (!fs.existsSync(buildFile)) fail(`${buildFile} is missing: run desktop/build-vencord.mjs first`);
const build = readJson(buildFile);
const { purifier: version, vencord: label, hash } = build;
if (version !== pkg.version) fail(`${buildFile} is for purifier ${version}, but package.json is ${pkg.version}: rebuild`);
if (!/^[0-9a-f]{7}$/.test(hash ?? '')) fail(`build.json has hash "${hash}", not 7 hex characters`);
if (!label) fail('build.json has no vencord label');

for (const f of VENCORD_FILES) if (!fs.existsSync(path.join(out, f))) fail(`${path.join(out, f)} is missing`);
const patcher = fs.readFileSync(path.join(out, 'patcher.js'), 'utf8');
if (!patcher.includes(`"${hash}"`)) fail(`patcher.js was not built with hash ${hash}: friends would update in a loop`);
if (!patcher.includes(`"${repo}"`)) fail(`patcher.js updates from another repository than ${repo}`);
if (!fs.readFileSync(path.join(out, 'renderer.js'), 'utf8').includes('DopasPurifier')) fail('renderer.js has no DopasPurifier in it');

let target = args.target;
if (!target) {
  const head = capture('git', ['rev-parse', 'HEAD']);
  const byHash = capture('git', ['rev-parse', '-q', '--verify', `${hash}^{commit}`]);
  target = head.ok && head.out.startsWith(hash) ? head.out : byHash.ok ? byHash.out : '';
}
if (!/^[0-9a-f]{40}$/.test(target) || !target.startsWith(hash)) {
  problem(`no full commit sha for build ${hash} here: pass --target <sha>`);
  target = '';
}

const tag = `desktop-v${version}-${hash}`;
const title = `Dopa's Discord Purifier ${version} for the Discord app · Vencord ${label} · ${hash}`;
if (title.slice(title.lastIndexOf(' ') + 1) !== hash) fail('the release title does not end with the build hash');

// ---------------------------------------------------------------------------------------------
// Assets and checksums.

if (!fs.existsSync(exe)) problem(`${exe} is missing: build it with npm run build:exe in desktop/installer`);
else if (fs.readFileSync(exe).subarray(0, 2).toString('latin1') !== 'MZ') fail(`${exe} is not a Windows executable`);
const exeInOut = path.join(out, EXE_NAME);
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (!dry && !samePath(exe, exeInOut)) fs.copyFileSync(exe, exeInOut);

const vencordAssets = fs.readdirSync(out, { withFileTypes: true })
  .filter((e) => e.isFile() && VENCORD_FILES.some((p) => e.name.startsWith(p))).map((e) => e.name);
const assets = [...vencordAssets, 'build.json', EXE_NAME].sort();
const source = (name) => (name === EXE_NAME && dry ? exe : path.join(out, name));
const sums = assets.filter((n) => fs.existsSync(source(n))).map((n) => `${sha256(source(n))}  ${n}\n`).join('');
if (!dry) fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), sums);
const exeSum = /^([0-9a-f]{64}) {2}DopasPurifierSetup\.exe$/m.exec(sums)?.[1] ?? '(installer missing)';

// ---------------------------------------------------------------------------------------------
// Release notes: desktop/RELEASE_NOTES.md with its placeholders filled, plus a source footer
// (GPL-3.0: a modified Vencord is distributed, so every release names its exact source).

const notesTemplate = path.resolve(args.notes || path.join(here, 'RELEASE_NOTES.md'));
let template;
if (fs.existsSync(notesTemplate)) {
  template = fs.readFileSync(notesTemplate, 'utf8');
} else {
  console.warn(`! ${notesTemplate} is missing: using the short built-in release notes.`);
  template = [
    "## Dopa's Discord Purifier {{VERSION}} for the Discord app",
    '',
    `Download **${EXE_NAME}** below and run it. It sets up Vencord {{VENCORD}} with the purifier`,
    'built in, for the Discord apps on your PC, and keeps itself updated from this page.',
    '',
    'Build {{HASH}} · {{DATE}}',
    '',
  ].join('\n');
}
const values = { VERSION: version, VENCORD: label, HASH: hash, DATE: build.builtAt.slice(0, 10) };
let notes = template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (PLACEHOLDERS.includes(key) ? values[key] : m));
const unknown = [...new Set(notes.match(/\{\{[A-Z_]+\}\}/g) ?? [])];
if (unknown.length) fail(`${notesTemplate} has placeholders this script does not fill: ${unknown.join(', ')}`);
const vencordTree = `https://github.com/${pin.vencord.repo}/tree/${pin.vencord.ref}`;
const ourTree = `https://github.com/${repo}/tree/${target || hash}`;
notes = `${notes.trimEnd()}\n\n---\n\n<sub>Source: [${pin.vencord.repo}@${pin.vencord.ref.slice(0, 7)}](${vencordTree}) ` +
  `(Vencord ${label}, GPL-3.0-or-later) with the purifier from [${repo}@${hash}](${ourTree}) built in as a userplugin. ` +
  `SHA-256 of ${EXE_NAME}: \`${exeSum}\`. Every file's checksum is in SHA256SUMS.txt.</sub>\n`;
if (build.vencord !== pin.vencord.label) console.warn(`! build.json says Vencord ${build.vencord}, but desktop/vencord.json pins ${pin.vencord.label}`);
const notesFile = path.join(out, 'release-notes.md');
if (!dry) fs.writeFileSync(notesFile, notes);

// ---------------------------------------------------------------------------------------------
// Pre-flight on GitHub, then the release.

const ghArgs = ['release', 'create', tag, '--repo', repo, '--title', title, '--notes-file', notesFile,
  ...(target ? ['--target', target] : []), '--latest',
  ...assets.map((n) => path.join(out, n)), path.join(out, 'SHA256SUMS.txt')];

const gh = capture('gh', ['--version']);
if (!gh.ok) problem('the gh CLI is not available');
else {
  // Never put an older build back on top: a run that waited behind a newer release stops here.
  if (!target) console.warn('! no target commit, so the order against the latest release was not checked');
  else {
    const order = releaseOrder({ repo, target, api: (endpoint, jq) => capture('gh', ['api', endpoint, '--jq', jq]) });
    if (order.error) problem(`${order.error}: not releasing without knowing what is latest`);
    else if (order.release) console.log(`Order: ${order.reason}.`);
    else if (dry) console.warn(`! a real run would stop here and release nothing: ${order.reason}`);
    else {
      console.log(`\nrelease: not releasing ${tag}: ${order.reason}. Friends keep the newer build.`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Not released: ${tag}\n\n${order.reason}, so friends keep the newer build.\n`);
      }
      process.exit(0);
    }
  }
  const existing = capture('gh', ['release', 'view', tag, '--repo', repo, '--json', 'url', '--jq', '.url']);
  if (existing.ok) problem(`release ${tag} already exists: ${existing.out}`);
  const pushed = capture('gh', ['api', `repos/${repo}/commits/${hash}`, '--jq', '.sha']);
  if (!pushed.ok) problem(`commit ${hash} is not on github.com/${repo}: push it first (friends' updaters compare against it)`);
  else if (target && pushed.out !== target) problem(`${hash} on GitHub is ${pushed.out}, not ${target}`);
}

console.log(`\n${dry ? 'Would release' : 'Releasing'} ${tag} on ${repo}`);
console.log(`  title: ${title}`);
console.log(`  target: ${target || '(none found)'}`);
console.log(`  assets (${assets.length + 1}): ${[...assets, 'SHA256SUMS.txt'].join(', ')}`);
console.log(`\n$ gh ${ghArgs.map(quote).join(' ')}`);

if (dry) {
  console.log(`\n--- SHA256SUMS.txt ---\n${sums}--- release notes (from ${fs.existsSync(notesTemplate) ? notesTemplate : 'the built-in body'}) ---\n${notes}---`);
  console.log('\nDry run: nothing was written, uploaded or tagged.');
  process.exit(0);
}

const r = spawnSync('gh', ghArgs, { cwd: root, stdio: 'inherit' });
if (r.error || r.status !== 0) fail(`gh release create failed (${r.error?.message ?? `exit ${r.status}`})`);

const latest = capture('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.name']);
if (!latest.ok || latest.out !== title) console.warn(`! releases/latest is "${latest.out}", not this release: friends' updaters will not see it`);
const releaseUrl = `https://github.com/${repo}/releases/tag/${tag}`;
const friendsLink = `https://github.com/${repo}/releases/latest/download/${EXE_NAME}`;
console.log(`\nReleased: ${releaseUrl}`);
console.log(`Friends' link: ${friendsLink}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Released [${title}](${releaseUrl})\n\nFriends' link: ${friendsLink}\n`);
}
