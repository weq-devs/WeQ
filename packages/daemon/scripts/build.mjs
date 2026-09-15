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
 * Requirements: cargo on PATH. Missing toolchain is a hard failure (exit 1): the
 * release pipeline that calls this must not quietly ship an installer without a
 * daemon binary.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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

/**
 * cargo 是否可用。直接问 cargo 自己，而不是自己扫 PATH：Windows 的 PATH 用
 * ';' 分隔、条目带盘符（C:\Users\...\.cargo\bin），按 [;:] 切会在盘符处切开，
 * 于是装好的工具链也被当成没装（windows runner 上就是这样炸的）。
 */
function hasCargo() {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (!hasCargo()) {
    console.error(
      '[build:daemon] cargo not found — install Rust (https://rustup.rs) to build ' +
        'the daemon binary the installer bundles.',
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
  copyFileSync(built, outFile);

  const size = statSync(outFile).size;
  console.log(`[build:daemon] staged ${outFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);

  // Windows 还多一个「隐藏拉起器」：GUI 子系统的小程序，计划任务的动作指向它。
  // 直接注册守护进程本体的话，Windows 会给这个控制台程序分配一个 conhost 窗口，
  // 常驻进程就成了开机挂在桌面上的黑框（见 src/bin/weq-daemon-launch.rs）。
  // 其它平台不需要 —— 那里没有「控制台窗口」这个概念。
  if (process.platform === 'win32') {
    const launcherBuilt = join(crateDir, 'target', targetDir, 'weq-daemon-launch.exe');
    if (!existsSync(launcherBuilt)) {
      console.error(`[build:daemon] cargo succeeded but launcher missing: ${launcherBuilt}`);
      process.exit(1);
    }
    const launcherOut = join(outDir, 'weq-daemon-launch.exe');
    copyFileSync(launcherBuilt, launcherOut);
    console.log(
      `[build:daemon] staged ${launcherOut} (${(statSync(launcherOut).size / 1024).toFixed(0)} KB)`,
    );
  }

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
