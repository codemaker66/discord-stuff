// Builds the release DopasPurifierSetup.exe (no MSI/NSIS bundle) and copies it
// to dist-exe/. Respects CARGO_TARGET_DIR when it is set.
//   npm run build:exe
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeName = 'DopasPurifierSetup.exe';

const r = spawnSync('npx', ['tauri', 'build', '--no-bundle'], { cwd: root, stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.error(`tauri build failed (exit ${r.status})`);
  process.exit(r.status || 1);
}

const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(root, 'src-tauri', 'target');
const built = path.join(targetDir, 'release', exeName);
if (!fs.existsSync(built)) {
  console.error(`Expected ${built} after the build, but it is not there.`);
  process.exit(1);
}

const outDir = path.join(root, 'dist-exe');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, exeName);
fs.copyFileSync(built, out);
const bytes = fs.readFileSync(out);
const sha = createHash('sha256').update(bytes).digest('hex');
console.log(`\n${path.relative(process.cwd(), out)}  ${bytes.length} bytes (${(bytes.length / 1048576).toFixed(2)} MiB)\nsha256 ${sha}`);
