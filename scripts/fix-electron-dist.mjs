// Repair Electron's `dist/` on systems where `electron`'s postinstall
// (extract-zip@2 + yauzl@2) silently fails to unzip the binary — notably
// Node ≥ 24 on Arch, where the extraction drops everything except `locales/`
// and leaves `dist/electron` missing. electron-vite then aborts with
// "Electron uninstall".
//
// We bypass the broken JS unzip entirely and use the system `unzip` binary,
// which extracts the cached zip correctly. Works for EVERY electron@* version
// present under node_modules/.pnpm (this monorepo pins two: desktop → 34,
// protolab → 35), so run it once after `pnpm i`.
//
//   node scripts/fix-electron-dist.mjs
//
// Idempotent: versions whose `dist/electron` already exists are skipped.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pnpmDir = join(repoRoot, 'node_modules', '.pnpm');
const cacheRoot = join(homedir(), '.cache', 'electron');

// Only linux is affected + supported here; the layout / zip name is per-OS.
if (process.platform !== 'linux') {
  console.log(`[fix-electron] platform ${process.platform} not linux — nothing to do`);
  process.exit(0);
}

const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

/** Every `electron@<ver>` package dir under .pnpm. */
function electronPackageDirs() {
  let entries = [];
  try {
    entries = readdirSync(pnpmDir);
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.startsWith('electron@')) continue;
    const modDir = join(pnpmDir, e, 'node_modules', 'electron');
    if (existsSync(join(modDir, 'package.json'))) out.push(modDir);
  }
  return out;
}

/** Read the pinned version from a package's own package.json. */
function versionOf(modDir) {
  try {
    return JSON.parse(readFileSync(join(modDir, 'package.json'), 'utf-8')).version;
  } catch {
    return null;
  }
}

/**
 * Find the cached zip for `version`. @electron/get keys its cache dir by a
 * sha256 of the download URL, so we can't guess the dir — scan them all for a
 * file named `electron-v<version>-linux-<arch>.zip`.
 */
function findCachedZip(version) {
  const wanted = `electron-v${version}-linux-${arch}.zip`;
  const direct = join(cacheRoot, wanted); // older flat layout
  if (existsSync(direct)) return direct;
  let dirs = [];
  try {
    dirs = readdirSync(cacheRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = join(cacheRoot, d, wanted);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Extract `zip` into `modDir/dist` via system unzip; fix up d.ts + path.txt. */
function repair(modDir, version, zip) {
  const dist = join(modDir, 'dist');
  rmSync(dist, { recursive: true, force: true });
  rmSync(join(modDir, 'path.txt'), { force: true });
  mkdirSync(dist, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', dist], { stdio: 'inherit' });

  // install.js hoists electron.d.ts out of dist/ up to the package root.
  const srcDts = join(dist, 'electron.d.ts');
  if (existsSync(srcDts)) renameSync(srcDts, join(modDir, 'electron.d.ts'));

  // path.txt tells the loader which file in dist/ is the executable.
  writeFileSync(join(modDir, 'path.txt'), 'electron');

  if (!existsSync(join(dist, 'electron'))) {
    throw new Error(`unzip finished but dist/electron still missing for ${version}`);
  }
}

const modDirs = electronPackageDirs();
if (modDirs.length === 0) {
  console.log('[fix-electron] no electron packages under .pnpm — nothing to do');
  process.exit(0);
}

let repaired = 0;
let failed = 0;
for (const modDir of modDirs) {
  const version = versionOf(modDir);
  if (!version) continue;
  if (existsSync(join(modDir, 'dist', 'electron'))) {
    // dist is fine — but a stray `echo electron > path.txt` leaves a trailing
    // newline that electron-vite feeds verbatim into spawn(), causing an
    // ENOENT on `…/electron\n`. Normalize it defensively.
    const pathFile = join(modDir, 'path.txt');
    const want = 'electron';
    if (!existsSync(pathFile) || readFileSync(pathFile, 'utf-8') !== want) {
      writeFileSync(pathFile, want);
      console.log(`[fix-electron] ${version} dist OK — normalized path.txt`);
    } else {
      console.log(`[fix-electron] ${version} already OK — skip`);
    }
    continue;
  }
  const zip = findCachedZip(version);
  if (!zip) {
    console.error(
      `[fix-electron] ${version}: no cached zip found under ${cacheRoot}. ` +
        `Run \`electron_config_cache= node <modDir>/install.js\` once to download it, then re-run.`,
    );
    failed++;
    continue;
  }
  try {
    repair(modDir, version, zip);
    console.log(`[fix-electron] ${version}: repaired from ${zip}`);
    repaired++;
  } catch (e) {
    console.error(`[fix-electron] ${version}: repair failed — ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

console.log(`[fix-electron] done — ${repaired} repaired, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
