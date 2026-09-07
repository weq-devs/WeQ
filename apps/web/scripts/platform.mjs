/**
 * Platform/arch identity for the per-platform Web packages.
 *
 * Web packaging is no longer a single "universal" archive: every platform/arch
 * gets its own tarball, built on its own runner, carrying only that platform's
 * native addons, daemon binary and resvg binding. The tag below (`win32-x64`,
 * `linux-arm64`, …) is the same one `packages/daemon/scripts/build.mjs` stages
 * binaries under (`resources/daemon/<tag>/`) and that `native/` mirrors as
 * `native/<platform>/<arch>/`.
 */

export const LABELS = {
  'win32-x64': 'Windows x64',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux arm64',
  'darwin-x64': 'macOS Intel (x64)',
  'darwin-arm64': 'macOS Apple Silicon (arm64)',
};

/** The `@resvg/resvg-js` optional binding npm installs per platform. */
export const RESVG_BINDINGS = {
  'win32-x64': '@resvg/resvg-js-win32-x64-msvc',
  'linux-x64': '@resvg/resvg-js-linux-x64-gnu',
  'linux-arm64': '@resvg/resvg-js-linux-arm64-gnu',
  'darwin-x64': '@resvg/resvg-js-darwin-x64',
  'darwin-arm64': '@resvg/resvg-js-darwin-arm64',
};

/** Resolve the packaging target from the host running the script. */
export function currentTarget() {
  const tag = `${process.platform}-${process.arch}`;
  if (!(tag in LABELS)) {
    throw new Error(`unsupported platform/arch: ${process.platform}/${process.arch}`);
  }
  return tag;
}

/** `win32-x64` → `win32/x64` (the `native/` layout under a target root). */
export function nativeRel(target) {
  return target.replace('-', '/');
}

/** The daemon binary file name for a target (`weq-daemon.exe` on win32). */
export function daemonExe(target) {
  return target.startsWith('win32') ? 'weq-daemon.exe' : 'weq-daemon';
}
