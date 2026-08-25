/**
 * Resolve and load the two closed-source `.node` addons plus their
 * companion resource files.
 *
 * Repo layout (win32 + linux + darwin implemented):
 *
 *   native/
 *     win32/x64/  ·  linux/x64/  ·  linux/arm64/  ·  darwin/x64/  ·  darwin/arm64/
 *       nt_helper.node                (renamed from index.<platform>-<arch>-*.node)
 *       ninebird/                     (win32 + linux only — mac has no
 *                                      injection, so no hooker bundle)
 *         NineBird.node               (hooker; loader JS requires it by this exact name)
 *         ninebird_addon.node         (launchQQ entry)
 *         NineBirdHook.dll            (win32 injection medium)
 *         ninebird_launcher.so        (linux injection medium; LD_PRELOAD)
 *         qqnt.json
 *
 *   resources/ninebird-runtime/       (platform-independent; built ONCE by
 *     qr-dbkey.js                     `pnpm build:ninebird` from packages/ninebird.
 *     quick-dbkey.js                  The loaders run inside QQ, which receives
 *     account-list.js                 their absolute path via NINEBIRD_LOAD_PATH,
 *     package.json                    so they need not live in native/. package.json
 *                                     is a {"type":"commonjs"} marker for QQ.)
 *
 * Resolution order:
 *   1. WEQ_NATIVE_DIR env var          (full override; expects same layout)
 *   2. WEQ_NINEBIRD_RUNTIME_DIR env var (override for the JS runtime dir)
 *   3. <install root>/native           (production, packaged Electron — sibling of resources/)
 *   4. <repo>/native                   (dev — found by walking up from this file)
 *
 * The loader JS bundle lives in `<repo>/resources/ninebird-runtime` in dev and
 * `<install>/resources/resources/ninebird-runtime` packaged — electron-builder
 * copies the whole repo resources/ tree into the app's resources/ dir (see
 * resolveNineBirdRuntimeDir).
 *
 * `loadNative()` is idempotent: first call resolves + requires + verifies
 * every file, subsequent calls return the cached bundle.
 */

import { createRequire } from 'node:module';
import { existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  LaunchQqResult,
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
let logFilePath: string | undefined;

/** Initialize log file path for loader diagnostics */
function initLoaderLog(): string {
  if (logFilePath) return logFilePath;

  const logRoot = resolveNativeLogRoot();
  try {
    mkdirSync(logRoot, { recursive: true });
  } catch {
    // ignore
  }

  const today = new Date().toISOString().slice(0, 10);
  logFilePath = join(logRoot, `native_loader_${today}.log`);
  return logFilePath;
}

/** Write diagnostic log to file */
function logToFile(message: string, data?: unknown): void {
  try {
    const timestamp = new Date().toISOString();
    const logPath = initLoaderLog();
    let logLine = `[${timestamp}] ${message}`;
    if (data !== undefined) {
      logLine += ` ${typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data)}`;
    }
    logLine += '\n';
    appendFileSync(logPath, logLine, 'utf-8');
  } catch {
    // Silent failure - don't break loading if logging fails
  }
}

export interface LoadNativeOptions {
  /** Override the entire `native/` root. Useful for tests / non-Electron hosts. */
  nativeRoot?: string;
}

export function loadNative(opts: LoadNativeOptions = {}): NativeBundle {
  if (cached) return cached;

  logToFile('[loadNative] Starting native module loading...');
  logToFile('[loadNative] Process info:', {
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    env_WEQ_NATIVE_DIR: process.env.WEQ_NATIVE_DIR,
  });

  const nativeRoot = opts.nativeRoot ?? resolveNativeRoot();
  logToFile('[loadNative] Resolved native root:', nativeRoot);

  const platformRoot = resolvePlatformRoot(nativeRoot);
  logToFile('[loadNative] Platform root:', platformRoot);

  const ntHelperPath = join(platformRoot, 'nt_helper.node');
  logToFile('[loadNative] nt_helper path:', ntHelperPath);
  assertExists(ntHelperPath, 'nt_helper.node');
  logToFile('[loadNative] nt_helper.node exists, attempting to require...');

  const nineBirdDir = join(platformRoot, 'ninebird');
  const resources = buildResources(nineBirdDir, nativeRoot);

  let ntHelper: NtHelperBinding;
  try {
    ntHelper = requireFromHere(ntHelperPath) as NtHelperBinding;
    logToFile('[loadNative] nt_helper.node loaded successfully');
  } catch (err) {
    logToFile('[loadNative] Failed to require nt_helper.node:', err);
    throw new Error(
      `Failed to load nt_helper.node from ${ntHelperPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const initStatus = ntHelper.getInitStatus();
  logToFile('[loadNative] Init status:', {
    status: initStatus,
    message: INIT_ERROR_MESSAGES[initStatus],
  });

  if (initStatus !== InitStatus.Success) {
    const message = INIT_ERROR_MESSAGES[initStatus] || INIT_ERROR_MESSAGES[InitStatus.UnknownError];
    throw new Error(`nt_helper initialization failed: [${initStatus}] ${message}`);
  }

  configureNtHelperLogging(ntHelper);

  // macOS has no injection (SIP) and therefore no hooker bundle — stub the
  // launch bootstrap with a clear error so the login/key flows degrade
  // gracefully instead of crashing on a missing addon. The db-decrypt worker
  // still resolves nt_helper.node from `resources.loaderDir` (see
  // packages/service/src/account/db_decrypt.ts), which is why loaderDir is
  // kept pointing at the platform root's ninebird path even though nothing is
  // shipped there on darwin.
  let nineBirdBoot: NineBirdBootBinding;
  if (process.platform === 'darwin') {
    nineBirdBoot = {
      async launchQQ(): Promise<LaunchQqResult> {
        return {
          success: false,
          pid: 0,
          error: 'macOS 暂不支持注入 QQ（SIP 限制），无法启动登录/密钥提取流程。',
        };
      },
    };
  } else {
    const nineBirdBootPath = join(nineBirdDir, 'ninebird_addon.node');
    assertExists(nineBirdBootPath, 'ninebird/ninebird_addon.node');
    nineBirdBoot = requireFromHere(nineBirdBootPath) as NineBirdBootBinding;
  }

  cached = {
    ntHelper,
    nineBirdBoot,
    resources,
  };
  logToFile('[loadNative] Native modules loaded and cached successfully');
  return cached;
}

/** Drop the cached bundle. Mostly for tests. */
export function resetNativeCache(): void {
  cached = undefined;
}

/**
 * Absolute path to the `nt_helper.node` that {@link loadNative} would resolve,
 * without loading it. The desktop app needs this to hand an elevated
 * (pkexec) child the exact addon to require for linux injection. Resolution
 * mirrors `loadNative` (WEQ_NATIVE_DIR → packaged → dev walk-up).
 */
export function resolveNtHelperPath(opts: LoadNativeOptions = {}): string {
  const nativeRoot = opts.nativeRoot ?? resolveNativeRoot();
  const platformRoot = resolvePlatformRoot(nativeRoot);
  const ntHelperPath = join(platformRoot, 'nt_helper.node');
  assertExists(ntHelperPath, 'nt_helper.node');
  return ntHelperPath;
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
  logToFile('[resolveNativeRoot] Starting native root resolution...');

  const override = process.env.WEQ_NATIVE_DIR;
  if (override) {
    logToFile('[resolveNativeRoot] Found WEQ_NATIVE_DIR override:', override);
    if (!existsSync(override)) {
      logToFile('[resolveNativeRoot] WEQ_NATIVE_DIR path does not exist');
      throw new Error(`WEQ_NATIVE_DIR points at non-existent directory: ${override}`);
    }
    logToFile('[resolveNativeRoot] Using WEQ_NATIVE_DIR:', override);
    return override;
  }

  // Production: Electron sets process.resourcesPath when packaged. The bundle
  // is copied to the install root (sibling of resources/), not into resources/.
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  logToFile('[resolveNativeRoot] Electron resourcesPath:', electronResources || '<not set>');

  if (electronResources) {
    const candidates = [
      join(dirname(electronResources), 'native'),
      join(electronResources, 'native'),
    ];
    logToFile('[resolveNativeRoot] Checking Electron packaged paths:', candidates);
    for (const packaged of candidates) {
      if (existsSync(packaged)) {
        logToFile('[resolveNativeRoot] Found packaged native at:', packaged);
        return packaged;
      }
    }
    logToFile('[resolveNativeRoot] No packaged paths exist');
  }

  // Dev: bundlers (electron-vite) rewrite `import.meta.url` so it points
  // at the output dir (e.g. apps/desktop/out/main/), not at this source
  // file. Walk upward looking for a sibling `native/` so we work
  // regardless of how deep we got bundled. Confirm it's the right dir by
  // checking for the current platform's subdir (not a hardcoded win32).
  logToFile('[resolveNativeRoot] Trying dev mode path resolution...');
  const tried: string[] = [];
  for (const start of [here, process.cwd()]) {
    logToFile('[resolveNativeRoot] Walking up from:', start);
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'native');
      tried.push(candidate);
      const platformCheck = join(candidate, process.platform);
      if (existsSync(candidate) && existsSync(platformCheck)) {
        logToFile('[resolveNativeRoot] Found dev native at:', candidate);
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  logToFile('[resolveNativeRoot] Could not locate native/ directory');
  logToFile('[resolveNativeRoot] Tried paths:', tried);
  throw new Error(
    `Could not locate native/ directory. Tried:\n` +
      `  - WEQ_NATIVE_DIR env var (unset)\n` +
      `  - ${electronResources ? join(dirname(electronResources), 'native') : '<not running under Electron>'}\n` +
      tried.map((t) => `  - ${t}`).join('\n') +
      `\nSet WEQ_NATIVE_DIR to override.`,
  );
}

function resolvePlatformRoot(nativeRoot: string): string {
  const { platform, arch } = process;
  if (platform !== 'win32' && platform !== 'linux' && platform !== 'darwin') {
    throw new Error(
      `Platform '${platform}' is not supported. win32, linux and darwin are implemented.`,
    );
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error(`Architecture '${arch}' is not supported on win32. Only x64 is implemented.`);
  }
  if ((platform === 'linux' || platform === 'darwin') && arch !== 'x64' && arch !== 'arm64') {
    throw new Error(
      `Architecture '${arch}' is not supported on ${platform}. Only x64 and arm64 are implemented.`,
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

/**
 * Directory of the platform-independent NineBird loader bundles. These are
 * built once by `pnpm build:ninebird` from `packages/ninebird` into
 * `resources/ninebird-runtime/`; they run inside QQ and never need to sit
 * next to the native binaries.
 *
 * Probes candidate roots rather than hard-coding one, so the same package
 * works in every layout:
 *   - `process.resourcesPath/resources/ninebird-runtime` — packaged desktop
 *     (electron-builder copies the repo resources/ tree into resources/, so
 *     the runtime lands at `<install>/resources/resources/ninebird-runtime`);
 *   - `<nativeRoot>/../resources/ninebird-runtime` — dev (`<repo>/native` →
 *     `<repo>/resources`) and web dist (`dist/native` → `dist/resources`).
 * `WEQ_NINEBIRD_RUNTIME_DIR` always wins. The first existing candidate is
 * returned; when none exists the dev-style candidate is kept so the
 * assertExists diagnostics point at the most likely location.
 */
function resolveNineBirdRuntimeDir(nativeRoot: string): string {
  const override = process.env.WEQ_NINEBIRD_RUNTIME_DIR;
  if (override) return override;

  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const devCandidate = join(nativeRoot, '..', 'resources', 'ninebird-runtime');
  const candidates = electronResources
    ? [join(electronResources, 'resources', 'ninebird-runtime'), devCandidate]
    : [devCandidate];
  return candidates.find((candidate) => existsSync(candidate)) ?? devCandidate;
}

function buildResources(nineBirdDir: string, nativeRoot: string): NineBirdResources {
  // The injection medium is the one file whose name differs per OS: a
  // `LD_PRELOAD` shared object on linux, an injected DLL on win32. Both are
  // passed to launchQQ via the same `hookDllPath` field. macOS ships no
  // injection medium (SIP) and no hooker bundle — the paths below are kept as
  // placeholders so the resource shape stays uniform, but nothing is asserted
  // (the stub `nineBirdBoot` fails before any of them is read).
  const isMac = process.platform === 'darwin';
  const injectionMedium = isMac
    ? ''
    : process.platform === 'linux'
      ? 'ninebird_launcher.so'
      : 'NineBirdHook.dll';
  const runtimeDir = resolveNineBirdRuntimeDir(nativeRoot);
  const resources: NineBirdResources = {
    // Must keep pointing at the native ninebird/ dir: the loader scripts find
    // `NineBird.node` there via NINEBIRD_LOADER_DIR, and @weq/service derives
    // the nt_helper.node path from `dirname(loaderDir)`.
    loaderDir: nineBirdDir,
    hookDllPath: join(nineBirdDir, injectionMedium),
    qqntJsonPath: join(nineBirdDir, 'qqnt.json'),
    nineBirdAddonPath: join(nineBirdDir, 'NineBird.node'),
    qrDbkeyJsPath: join(runtimeDir, 'qr-dbkey.js'),
    quickDbkeyJsPath: join(runtimeDir, 'quick-dbkey.js'),
    accountListJsPath: join(runtimeDir, 'account-list.js'),
  };
  if (!isMac) {
    assertExists(resources.hookDllPath, `ninebird/${injectionMedium}`);
    assertExists(resources.qqntJsonPath, 'ninebird/qqnt.json');
    assertExists(resources.nineBirdAddonPath, 'ninebird/NineBird.node');
    assertExists(resources.qrDbkeyJsPath, 'ninebird-runtime/qr-dbkey.js — run pnpm build:ninebird');
    assertExists(
      resources.quickDbkeyJsPath,
      'ninebird-runtime/quick-dbkey.js — run pnpm build:ninebird',
    );
    assertExists(
      resources.accountListJsPath,
      'ninebird-runtime/account-list.js — run pnpm build:ninebird',
    );
  }
  return resources;
}

function assertExists(path: string, label: string): void {
  logToFile(`[assertExists] Checking ${label} at: ${path}`);
  if (!existsSync(path)) {
    logToFile(`[assertExists] MISSING: ${label} not found at ${path}`);
    throw new Error(`Required native asset missing: ${label}\n  expected at: ${path}`);
  }
  try {
    const stats = statSync(path);
    logToFile(`[assertExists] Found ${label}`, {
      size: stats.size,
      mode: stats.mode.toString(8),
    });
  } catch (err) {
    logToFile(`[assertExists] Could not stat ${label}:`, err);
  }
}

function configureNtHelperLogging(ntHelper: NtHelperBinding): void {
  const logRoot = resolveNativeLogRoot();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logPath = join(logRoot, `nt_helper_${today}.log`);
  ntHelper.setLogPath(logPath);
}

/**
 * Absolute directory the native addons write their diagnostics into
 * (`nt_helper_<date>.log` / `native_loader_<date>.log`).
 */
export function getNativeLogRoot(): string {
  return resolveNativeLogRoot();
}

function resolveNativeLogRoot(): string {
  // Explicit override wins. Hosts that already own a data directory (the web
  // server's WEQ_DATA_DIR) set this so the addon logs land beside the app's
  // own logs instead of wherever the process happens to be cwd'd — which,
  // absent this, can be the release bundle itself.
  const override = process.env.WEQ_LOG_DIR;
  if (override) return override;

  const candidates = new Set<string>();

  const electronAppData = process.env.APPDATA;
  if (electronAppData) {
    candidates.add(join(electronAppData, 'WeQ', 'logs'));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.add(join(localAppData, 'WeQ', 'logs'));
  }

  // macOS: Library/Application Support (system convention; matches
  // platform.appDataRoot()). Linux: XDG-style per-user config dir.
  if (process.platform !== 'win32') {
    if (process.platform === 'darwin') {
      candidates.add(join(homedir(), 'Library', 'Application Support', 'WeQ', 'logs'));
    } else {
      const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
      candidates.add(join(xdg, 'WeQ', 'logs'));
    }
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
