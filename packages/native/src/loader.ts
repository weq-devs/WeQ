/**
 * Resolve and load the two closed-source `.node` addons plus their
 * companion resource files.
 *
 * Repo layout (win32 + linux implemented; darwin throws with a clear
 * "not yet implemented" message):
 *
 *   native/
 *     win32/x64/  ·  linux/x64/  ·  linux/arm64/
 *       nt_helper.node                (renamed from index.<platform>-<arch>-*.node)
 *       ninebird/
 *         NineBird.node               (hooker; loader JS requires it by this exact name)
 *         ninebird_addon.node         (launchQQ entry)
 *         NineBirdHook.dll            (win32 injection medium)
 *         ninebird_launcher.so        (linux injection medium; LD_PRELOAD)
 *         qqnt.json
 *         qr-dbkey.js
 *         quick-dbkey.js
 *         account-list.js
 *     darwin/                         (placeholder dirs)
 *
 * Resolution order:
 *   1. WEQ_NATIVE_DIR env var  (full override; expects same layout)
 *   2. <resourcesPath>/native  (production, packaged Electron)
 *   3. <repo>/native           (dev — found by walking up from this file)
 *
 * `loadNative()` is idempotent: first call resolves + requires + verifies
 * every file, subsequent calls return the cached bundle.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  NativeBundle,
  NineBirdBootBinding,
  NineBirdResources,
  NtHelperBinding,
} from './types';
import { InitStatus } from './types';

export const INIT_ERROR_MESSAGES: Record<InitStatus, string> = {
  [InitStatus.Success]: 'Initialization successful',
  [InitStatus.Expired]: 'Build expired (> 30 days old)',
  [InitStatus.Damaged]: 'Binary file damaged',
  [InitStatus.Tampered]: 'Binary file tampered',
  [InitStatus.UnknownError]: 'Unknown initialization error',
};

const here = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

let cached: NativeBundle | undefined;

export interface LoadNativeOptions {
  /** Override the entire `native/` root. Useful for tests / non-Electron hosts. */
  nativeRoot?: string;
}

export function loadNative(opts: LoadNativeOptions = {}): NativeBundle {
  if (cached) return cached;
  const nativeRoot = opts.nativeRoot ?? resolveNativeRoot();
  const platformRoot = resolvePlatformRoot(nativeRoot);

  const ntHelperPath = join(platformRoot, 'nt_helper.node');
  assertExists(ntHelperPath, 'nt_helper.node');

  const nineBirdDir = join(platformRoot, 'ninebird');
  const nineBirdBootPath = join(nineBirdDir, 'ninebird_addon.node');
  assertExists(nineBirdBootPath, 'ninebird/ninebird_addon.node');

  const resources = buildResources(nineBirdDir);

  const ntHelper = requireFromHere(ntHelperPath) as NtHelperBinding;
  const initStatus = ntHelper.getInitStatus();

  if (initStatus !== InitStatus.Success) {
    const message = INIT_ERROR_MESSAGES[initStatus] || INIT_ERROR_MESSAGES[InitStatus.UnknownError];
    throw new Error(`nt_helper initialization failed: [${initStatus}] ${message}`);
  }

  configureNtHelperLogging(ntHelper);

  cached = {
    ntHelper,
    nineBirdBoot: requireFromHere(nineBirdBootPath) as NineBirdBootBinding,
    resources,
  };
  return cached;
}

/** Drop the cached bundle. Mostly for tests. */
export function resetNativeCache(): void {
  cached = undefined;
}

/**
 * Non-throwing variant of {@link loadNative}. Used by the desktop app so a
 * bad/expired/tampered native bundle surfaces as a UI dialog instead of
 * crashing `app.whenReady`. On failure it best-effort classifies the cause:
 *
 *   - `expired`  — build older than its self-destruct window (InitStatus.Expired)
 *   - `damaged`  — corrupt / tampered binary, missing assets, unsupported
 *                  platform, or any other load failure (collapsed per spec:
 *                  "其它的安装损坏和恶意篡改都显示安装损坏即可")
 */
export type NativeLoadResult =
  | { ok: true; bundle: NativeBundle }
  | { ok: false; status: InitStatus | null; kind: 'expired' | 'damaged'; message: string };

export function loadNativeSafe(opts: LoadNativeOptions = {}): NativeLoadResult {
  try {
    return { ok: true, bundle: loadNative(opts) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = parseInitStatus(message);
    const kind = status === InitStatus.Expired ? 'expired' : 'damaged';
    return { ok: false, status, kind, message };
  }
}

/** Recover the InitStatus code from a `loadNative` error message, if present. */
function parseInitStatus(message: string): InitStatus | null {
  const match = message.match(/\[(-?\d+)\]/);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? (code as InitStatus) : null;
}

// ---------- internals -----------------------------------------------------

function resolveNativeRoot(): string {
  const override = process.env.WEQ_NATIVE_DIR;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`WEQ_NATIVE_DIR points at non-existent directory: ${override}`);
    }
    return override;
  }

  // Production: Electron sets process.resourcesPath when packaged.
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (electronResources) {
    const packaged = join(electronResources, 'native');
    if (existsSync(packaged)) return packaged;
  }

  // Dev: bundlers (electron-vite) rewrite `import.meta.url` so it points
  // at the output dir (e.g. apps/desktop/out/main/), not at this source
  // file. Walk upward looking for a sibling `native/` so we work
  // regardless of how deep we got bundled. Confirm it's the right dir by
  // checking for the current platform's subdir (not a hardcoded win32).
  const tried: string[] = [];
  for (const start of [here, process.cwd()]) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'native');
      tried.push(candidate);
      if (existsSync(candidate) && existsSync(join(candidate, process.platform))) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  throw new Error(
    `Could not locate native/ directory. Tried:\n` +
      `  - WEQ_NATIVE_DIR env var (unset)\n` +
      `  - ${electronResources ? join(electronResources, 'native') : '<not running under Electron>'}\n` +
      tried.map((t) => `  - ${t}`).join('\n') +
      `\nSet WEQ_NATIVE_DIR to override.`,
  );
}

function resolvePlatformRoot(nativeRoot: string): string {
  const { platform, arch } = process;
  if (platform !== 'win32' && platform !== 'linux') {
    throw new Error(
      `Platform '${platform}' is not yet supported. win32 and linux are implemented; ` +
        `darwin port is pending.`,
    );
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error(
      `Architecture '${arch}' is not supported on win32. Only x64 is implemented.`,
    );
  }
  if (platform === 'linux' && arch !== 'x64' && arch !== 'arm64') {
    throw new Error(
      `Architecture '${arch}' is not supported on linux. Only x64 and arm64 are implemented.`,
    );
  }
  const platformRoot = join(nativeRoot, platform, arch);
  if (!existsSync(platformRoot)) {
    throw new Error(
      `Expected platform directory not found: ${platformRoot}\n` +
        `Place the renamed .node files there (see packages/native/README.md).`,
    );
  }
  return platformRoot;
}

function buildResources(nineBirdDir: string): NineBirdResources {
  // The injection medium is the one file whose name differs per OS: a
  // `LD_PRELOAD` shared object on linux, an injected DLL on win32. Both are
  // passed to launchQQ via the same `hookDllPath` field.
  const injectionMedium =
    process.platform === 'linux' ? 'ninebird_launcher.so' : 'NineBirdHook.dll';
  const resources: NineBirdResources = {
    loaderDir: nineBirdDir,
    hookDllPath: join(nineBirdDir, injectionMedium),
    qqntJsonPath: join(nineBirdDir, 'qqnt.json'),
    nineBirdAddonPath: join(nineBirdDir, 'NineBird.node'),
    qrDbkeyJsPath: join(nineBirdDir, 'qr-dbkey.js'),
    quickDbkeyJsPath: join(nineBirdDir, 'quick-dbkey.js'),
    accountListJsPath: join(nineBirdDir, 'account-list.js'),
  };
  assertExists(resources.hookDllPath, `ninebird/${injectionMedium}`);
  assertExists(resources.qqntJsonPath, 'ninebird/qqnt.json');
  assertExists(resources.nineBirdAddonPath, 'ninebird/NineBird.node');
  assertExists(resources.qrDbkeyJsPath, 'ninebird/qr-dbkey.js');
  assertExists(resources.quickDbkeyJsPath, 'ninebird/quick-dbkey.js');
  assertExists(resources.accountListJsPath, 'ninebird/account-list.js');
  return resources;
}

function assertExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `Required native asset missing: ${label}\n  expected at: ${path}`,
    );
  }
}

function configureNtHelperLogging(ntHelper: NtHelperBinding): void {
  const logRoot = resolveNativeLogRoot();
  const logPath = join(logRoot, 'nt_helper.log');
  ntHelper.setLogPath(logPath);
}

function resolveNativeLogRoot(): string {
  const candidates = new Set<string>();

  const electronAppData = process.env.APPDATA;
  if (electronAppData) {
    candidates.add(join(electronAppData, 'WeQ', 'logs'));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.add(join(localAppData, 'WeQ', 'logs'));
  }

  // Linux/macOS: XDG-style per-user config dir.
  if (process.platform !== 'win32') {
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    candidates.add(join(xdg, 'WeQ', 'logs'));
  }

  const cwdLogDir = join(process.cwd(), 'logs');
  candidates.add(cwdLogDir);

  for (const candidate of candidates) {
    const parent = dirname(candidate);
    if (existsSync(parent) || existsSync(candidate)) {
      return candidate;
    }
  }

  return cwdLogDir;
}
