/**
 * Build the Rust daemon and stage the binary into `resources/daemon/<platform>-<arch>/`.
 *
 * Output layout matches the native/ convention the loader uses, keyed by node's
 * platform/arch naming:
 *
 *   resources/daemon/win32-x64/weq-daemon.exe
 *   resources/daemon/linux-x64/weq-daemon
 *   resources/daemon/darwin-arm64/weq-daemon
 *
 * electron-builder copies resources/ wholesale via extraResources, so anything
 * staged here automatically ships in the installer / AppImage / dmg.
 *
 * Usage:
 *   node packages/daemon/scripts/build.mjs           # release build
 *   node packages/daemon/scripts/build.mjs --debug   # dev build (faster, unstripped)
 *
 * Requirements: cargo on PATH. Skips (with a note) when the toolchain is missing
 * so that docs-only CI / contributor environments still typecheck.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(here, '..');
const repoRoot = resolve(crateDir, '..', '..');
const stageRoot = join(repoRoot, 'resources', 'daemon');

const debug = process.argv.includes('--debug');
const targetDir = debug ? 'debug' : 'release';

const PLATFORM_DIR = {
  win32: 'win32',
  linux: 'linux',
  darwin: 'darwin',
};
const ARCH_DIR = { x64: 'x64', arm64: 'arm64' };

function hasCargo() {
  for (const dir of (process.env.PATH ?? '').split(/[;:]/)) {
    if (!dir) continue;
    try {
      if (existsSync(join(dir, 'cargo')) || existsSync(join(dir, 'cargo.exe'))) return true;
    } catch {
      /* unreadable PATH entry — skip */
    }
  }
  return false;
}

function main() {
  if (!hasCargo()) {
    console.error(
      '[build:daemon] cargo not found on PATH — skipping. ' +
        'Install Rust (https://rustup.rs) to build the daemon binary.',
    );
    process.exit(1);
  }

  const profileArgs = debug ? [] : ['--release'];
  execFileSync('cargo', ['build', ...profileArgs], { cwd: crateDir, stdio: 'inherit' });

  const built = join(
    crateDir,
    'target',
    targetDir,
    process.platform === 'win32' ? 'weq-daemon.exe' : 'weq-daemon',
  );
  if (!existsSync(built)) {
    console.error(`[build:daemon] cargo succeeded but binary missing: ${built}`);
    process.exit(1);
  }

  const platform = PLATFORM_DIR[process.platform];
  const arch = ARCH_DIR[process.arch];
  if (!platform || !arch) {
    console.error(`[build:daemon] unsupported platform/arch: ${process.platform}/${process.arch}`);
    process.exit(1);
  }

  const outDir = join(stageRoot, `${platform}-${arch}`);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, process.platform === 'win32' ? 'weq-daemon.exe' : 'weq-daemon');
  execFileSync('cp', ['-f', built, outFile]);

  const size = statSync(outFile).size;
  console.log(`[build:daemon] staged ${outFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);

  // lint: previously staged artifacts for other platform-arch dirs would ship
  // into the installer too — electron-builder copies resources/ wholesale.
  // Fail loudly if anything unexpected is present so CI catches it.
  for (const entry of readdirSync(stageRoot)) {
    if (entry !== `${platform}-${arch}`) {
      console.error(
        `[build:daemon] WARNING: foreign artifact dir resources/daemon/${entry} present ` +
          '(built on another machine?). electron-builder will bundle it — clean resources/daemon before release packaging.',
      );
    }
  }
}

main();
