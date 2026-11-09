#!/usr/bin/env node
// The desktop release's Vencord: official Vencord at the pin in desktop/vencord.json, with the
// purifier (dist/vencord/dopasPurifier/) inside as a userplugin, built standalone so that a
// friend's Vencord updater follows this repository's releases instead of Vendicated's.
//
//   node desktop/build-vencord.mjs --hash <7-char sha> --remote <owner/repo> --work <dir> --out <dir>
//       [--pnpm-dirs <dir>]   keep pnpm's store, cache and state in <dir> (default: pnpm's own)
//     Fetches Vencord at the pinned commit into --work (shallow, reused when already there),
//     builds it with VENCORD_REMOTE=<remote> and VENCORD_HASH=<hash>, and writes the release's
//     Vencord files, build.json and SHA256SUMS.txt into --out.
//
//   node desktop/build-vencord.mjs --follow [--write]
//     Finds the commit official Vencord users update to (the hash ending the name of
//     Vendicated/Vencord's latest release, the DevBuild) and compares it with the pin.
//     --write moves the pin there. On GitHub Actions it also sets the step outputs
//     moved, ref, label and previous.
//
// Node 22, no npm dependencies. pnpm is always the exact version in Vencord's packageManager,
// run through npx, because plain pnpm/corepack may be a different major (or unable to start it).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const pinFile = path.join(here, 'vencord.json');
const pluginDir = path.join(root, 'dist', 'vencord', 'dopasPurifier');
// What Vencord's updater (src/main/updater/http.ts) downloads from a release: every asset whose
// name starts with one of these, so the .map and .LEGAL.txt siblings ride along.
const VENCORD_FILES = ['patcher.js', 'preload.js', 'renderer.js', 'renderer.css'];
const WORK_MARKER = 'dopas-purifier-work';

const fail = (msg) => {
  console.error(`\nbuild-vencord: ${msg}`);
  process.exit(1);
};

const { values: args } = parseArgs({
  options: {
    hash: { type: 'string' },
    remote: { type: 'string' },
    work: { type: 'string' },
    out: { type: 'string' },
    'pnpm-dirs': { type: 'string' },
    follow: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (args.help) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l) => l.startsWith('// Node 22'))).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pin = readJson(pinFile);
if (!/^[\w.-]+\/[\w.-]+$/.test(pin.vencord?.repo ?? '')) fail('desktop/vencord.json: vencord.repo is not owner/name');
if (!/^[0-9a-f]{40}$/.test(pin.vencord?.ref ?? '')) fail('desktop/vencord.json: vencord.ref must be a full 40-char commit sha');

// ---------------------------------------------------------------------------------------------
// --follow: what official Vencord users get today, and whether the pin has to move.

async function github(endpoint, { allow404 = false } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const res = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dopas-purifier-desktop-build',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (allow404 && (res.status === 404 || res.status === 422)) return null;
  if (!res.ok) fail(`GET ${endpoint}: ${res.status} ${res.statusText}\n${(await res.text()).slice(0, 400)}`);
  return res.json();
}

// Official installs update from releases/latest of Vendicated/Vencord and take the build hash
// from the last word of its name ("DevBuild 383409e"). Vencord rebuilds that release on every
// push to its main that touches the source, so "what official users get" is that hash, not the
// newest tag. The label is the package.json version at that commit, plus the short hash when
// the commit is not that version's tag itself.
async function officialBuild(repo) {
  const latest = await github(`/repos/${repo}/releases/latest`);
  const short = String(latest.name ?? '').trim().split(' ').pop();
  if (!/^[0-9a-f]{7,40}$/.test(short)) fail(`${repo}'s latest release is named "${latest.name}": no build hash at the end`);
  const commit = await github(`/repos/${repo}/commits/${short}`);
  const ref = commit.sha;
  if (!ref?.startsWith(short)) fail(`${repo}: commit ${short} resolved to ${ref}`);
  const pkgFile = await github(`/repos/${repo}/contents/package.json?ref=${ref}`);
  const version = JSON.parse(Buffer.from(pkgFile.content, 'base64').toString('utf8')).version;
  const tag = await github(`/repos/${repo}/commits/v${version}`, { allow404: true });
  const label = tag?.sha === ref ? `v${version}` : `v${version}+${ref.slice(0, 7)}`;
  return { ref, label, release: latest.name, tag: `v${version}`, tagSha: tag?.sha ?? null };
}

async function follow() {
  const { repo } = pin.vencord;
  const now = await officialBuild(repo);
  const moved = now.ref !== pin.vencord.ref;
  console.log(`Official Vencord users get: ${repo} "${now.release}" = ${now.ref} (${now.label})`);
  console.log(`Tag ${now.tag}: ${now.tagSha ?? 'not found'}`);
  console.log(`Pinned: ${pin.vencord.ref} (${pin.vencord.label})`);
  console.log(moved ? `The pin is behind: it moves to ${now.label}.` : 'The pin is current.');
  const previous = pin.vencord.label;
  if (moved && args.write) {
    pin.vencord.ref = now.ref;
    pin.vencord.label = now.label;
    fs.writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`Wrote ${path.relative(root, pinFile).replaceAll('\\', '/')}.`);
  }
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `moved=${moved}\nref=${now.ref}\nlabel=${now.label}\nprevious=${previous}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// The build.

function quote(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

// npx is a .cmd shim on Windows, which only starts through a shell; git never needs one.
function run(cmd, cmdArgs, { cwd, env, capture = false } = {}) {
  const line = [cmd, ...cmdArgs].map(quote).join(' ');
  const shell = process.platform === 'win32' && cmd !== 'git';
  const opts = {
    cwd, env: env ?? process.env, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  };
  if (!capture) console.log(`\n> ${line}${cwd ? `   (in ${cwd})` : ''}`);
  const r = shell ? spawnSync(line, { ...opts, shell: true }) : spawnSync(cmd, cmdArgs, opts);
  if (r.error) fail(`${line}: ${r.error.message}`);
  if (r.status !== 0) fail(`${line} exited with ${r.status}${capture ? `\n${r.stderr}` : ''}`);
  return capture ? r.stdout.trim() : '';
}
const git = (cwd, ...a) => run('git', a, { cwd, capture: true });

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const kb = (n) => `${(n / 1024).toFixed(1)} KB`.padStart(10);

function prepareWork(work, { repo, ref }) {
  const url = `https://github.com/${repo}.git`;
  const marker = path.join(work, '.git', WORK_MARKER);
  if (fs.existsSync(work) && fs.readdirSync(work).length && !fs.existsSync(marker)) {
    fail(`refusing to use ${work}: it is not empty and was not made by this script.\n` +
      'Pick an empty or new --work directory (it gets reset to the pin on every build).');
  }
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(work, { recursive: true });
    git(work, 'init', '-q');
    fs.writeFileSync(marker, 'Vencord work tree for desktop/build-vencord.mjs; reset on every build.\n');
    git(work, 'remote', 'add', 'origin', url);
  } else {
    git(work, 'remote', 'set-url', 'origin', url);
  }
  const head = spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { cwd: work, encoding: 'utf8' }).stdout.trim();
  if (head === ref) {
    console.log(`Reusing ${work}: already at ${ref}.`);
  } else {
    console.log(`Fetching ${repo} at ${ref} into ${work} (shallow)...`);
    run('git', ['fetch', '-q', '--depth', '1', '--no-tags', 'origin', ref], { cwd: work });
  }
  // The tree is ours: put tracked files back exactly as the pin has them and drop stray
  // untracked ones (node_modules, dist and src/userplugins are in Vencord's .gitignore and stay).
  git(work, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', '--detach', ref);
  git(work, 'reset', '-q', '--hard', ref);
  git(work, 'clean', '-q', '-fd');
  const got = git(work, 'rev-parse', 'HEAD');
  if (got !== ref) fail(`${work} is at ${got}, not ${ref}`);
}

async function build() {
  const started = Date.now();
  for (const k of ['hash', 'remote', 'work', 'out']) if (!args[k]) fail(`--${k} is required (see --help)`);
  const { hash, remote } = args;
  if (!/^[0-9a-f]{7}$/.test(hash)) fail(`--hash must be exactly 7 lowercase hex characters (got "${hash}"): ` +
    'Vencord compares it with the last word of the release name');
  if (!/^[\w.-]+\/[\w.-]+$/.test(remote)) fail(`--remote must be owner/repo (got "${remote}")`);
  const work = path.resolve(args.work);
  const out = path.resolve(args.out);
  const rel = path.relative(work, out);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) fail('--out must not be --work or inside it');

  const pkg = readJson(path.join(root, 'package.json'));
  const pluginEntry = path.join(pluginDir, 'index.js');
  if (!fs.existsSync(pluginEntry)) fail(`${pluginEntry} is missing: run npm run build first`);
  if (!fs.readFileSync(pluginEntry, 'utf8').includes('name: "DopasPurifier"')) fail(`${pluginEntry} does not define DopasPurifier`);

  console.log(`Vencord ${pin.vencord.label} (${pin.vencord.repo}@${pin.vencord.ref})`);
  console.log(`  + Dopa's Discord Purifier ${pkg.version} as src/userplugins/dopasPurifier/`);
  console.log(`  updates from ${remote}, build hash ${hash}`);

  prepareWork(work, pin.vencord);

  // Exactly one userplugin: ours, fresh from dist/.
  const userplugins = path.join(work, 'src', 'userplugins');
  fs.rmSync(userplugins, { recursive: true, force: true });
  fs.cpSync(pluginDir, path.join(userplugins, 'dopasPurifier'), { recursive: true });

  const vpkg = readJson(path.join(work, 'package.json'));
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)/.exec(vpkg.packageManager ?? '')?.[1];
  if (!pnpmVersion) fail(`Vencord's package.json has packageManager "${vpkg.packageManager}", not pnpm@x.y.z`);
  const pnpm = (...a) => ['--yes', `pnpm@${pnpmVersion}`, ...a];

  const env = { ...process.env };
  const installFlags = [];
  if (args['pnpm-dirs']) {
    const d = path.resolve(args['pnpm-dirs']);
    const dirs = { store: path.join(d, 'store'), cache: path.join(d, 'cache'), state: path.join(d, 'state') };
    for (const p of Object.values(dirs)) fs.mkdirSync(p, { recursive: true });
    // pnpm 12 takes --store-dir and --state-dir as flags and the cache dir from pnpm_config_*.
    // On Linux and macOS the XDG dirs move its lock folders too; on Windows it still drops one
    // empty lock file in %LOCALAPPDATA%\pnpm-store-operation-locks (it asks Windows for that folder).
    installFlags.push('--store-dir', dirs.store, '--state-dir', dirs.state);
    env.pnpm_config_store_dir = dirs.store;
    env.pnpm_config_cache_dir = dirs.cache;
    env.pnpm_config_state_dir = dirs.state;
    env.XDG_DATA_HOME = path.join(d, 'xdg-data');
    env.XDG_CACHE_HOME = path.join(d, 'xdg-cache');
    env.XDG_STATE_HOME = path.join(d, 'xdg-state');
  }
  run('npx', pnpm('install', '--frozen-lockfile', ...installFlags), { cwd: work, env });

  fs.rmSync(path.join(work, 'dist'), { recursive: true, force: true });
  run('npx', pnpm('buildStandalone'), { cwd: work, env: { ...env, VENCORD_REMOTE: remote, VENCORD_HASH: hash } });

  // Fail loudly unless the build is ours: the plugin inside, our remote and hash in the updater.
  const dist = path.join(work, 'dist');
  const text = (f) => fs.readFileSync(path.join(dist, f), 'utf8');
  for (const f of VENCORD_FILES) if (!fs.existsSync(path.join(dist, f))) fail(`the build made no dist/${f}`);
  if (!text('renderer.js').includes('DopasPurifier')) fail('dist/renderer.js does not contain DopasPurifier: the userplugin was not built in');
  if (!text('patcher.js').includes(`"${remote}"`)) fail(`dist/patcher.js does not carry the remote ${remote}`);
  if (!text('patcher.js').includes(`"${hash}"`)) fail(`dist/patcher.js does not carry the hash ${hash}`);

  fs.mkdirSync(out, { recursive: true });
  const ours = (name) => VENCORD_FILES.some((p) => name.startsWith(p)) || name === 'build.json' || name === 'SHA256SUMS.txt';
  for (const name of fs.readdirSync(out)) if (ours(name)) fs.rmSync(path.join(out, name), { force: true });
  const files = fs.readdirSync(dist, { withFileTypes: true })
    .filter((e) => e.isFile() && VENCORD_FILES.some((p) => e.name.startsWith(p)))
    .map((e) => e.name).sort();
  for (const name of files) fs.copyFileSync(path.join(dist, name), path.join(out, name));

  const buildInfo = { purifier: pkg.version, vencord: pin.vencord.label, hash, builtAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, 'build.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
  const assets = [...files, 'build.json'].sort();
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), assets.map((n) => `${sha256(path.join(out, n))}  ${n}\n`).join(''));

  console.log(`\nBuilt in ${((Date.now() - started) / 1000).toFixed(0)} s with pnpm ${pnpmVersion}: ${out}`);
  for (const name of [...assets, 'SHA256SUMS.txt']) console.log(`  ${kb(fs.statSync(path.join(out, name)).size)}  ${name}`);
  console.log(`  renderer.js has DopasPurifier; patcher.js updates from ${remote} and reports build ${hash}.`);
  console.log(`  build.json: ${JSON.stringify(buildInfo)}`);
}

// Last, so the helpers above (const arrows) exist before either mode runs.
if (args.follow) await follow();
else await build();
