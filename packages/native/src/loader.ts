/**
 * Resolve and load the `nt_helper.node` addon.
 *
 * Repo layout (win32 + linux + darwin implemented):
 *
 *   native/
 *     win32/x64/  ·  linux/x64/  ·  linux/arm64/  ·  darwin/x64/  ·  darwin/arm64/
 *       nt_helper.node                (renamed from index.<platform>-<arch>-*.node)
 *
 * Resolution order:
 *   1. WEQ_NATIVE_DIR env var          (full override; expects same layout)
 *   2. <install root>/native           (production, packaged Electron — sibling of resources/)
 *   3. <repo>/native                   (dev — found by walking up from this file)
 *
 * `loadNative()` is idempotent: first call resolves + requires + verifies the
 * addon, subsequent calls return the cached bundle.
 */

import { createRequire } from 'node:module';
import { existsSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NativeBundle, NtHelperBinding } from './types';
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

/**
 * Verbose diagnostics toggle (`WEQ_NATIVE_DEBUG=1`).
 *
 * The per-file asset checks and the dev path-resolution walk are only useful
 * when something is missing — on a healthy install they repeated ~65 lines on
 * every startup. Off by default; turn on when diagnosing a broken checkout or
 * an unexpected native root.
 */
function verboseLogging(): boolean {
  const raw = process.env.WEQ_NATIVE_DEBUG;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

/** Write diagnostic log to file (single-line JSON: no multi-line bloat) */
function logToFile(message: string, data?: unknown): void {
  try {
    const timestamp = new Date().toISOString();
    const logPath = initLoaderLog();
    let logLine = `[${timestamp}] ${message}`;
    if (data !== undefined) {
      logLine += ` ${typeof data === 'object' ? JSON.stringify(data) : String(data)}`;
    }
    logLine += '\n';
    appendFileSync(logPath, logLine, 'utf-8');
  } catch {
    // Silent failure - don't break loading if logging fails
  }
}

/** Verbose-only diagnostic line (no-op unless {@link verboseLogging}). */
function logVerbose(message: string, data?: unknown): void {
  if (verboseLogging()) logToFile(message, data);
}

export interface LoadNativeOptions {
  /** Override the entire `native/` root. Useful for tests / non-Electron hosts. */
  nativeRoot?: string;
}

export function loadNative(opts: LoadNativeOptions = {}): NativeBundle {
  if (cached) return cached;

  const startedAt = Date.now();
  logToFile('[loadNative] Starting native module loading...');
  logVerbose('[loadNative] Process info:', {
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    env_WEQ_NATIVE_DIR: process.env.WEQ_NATIVE_DIR,
  });

  const nativeRoot = opts.nativeRoot ?? resolveNativeRoot();
  logToFile('[loadNative] Resolved native root:', nativeRoot);

  const platformRoot = resolvePlatformRoot(nativeRoot);
  logVerbose('[loadNative] Platform root:', platformRoot);

  const ntHelperPath = join(platformRoot, 'nt_helper.node');
  logVerbose('[loadNative] nt_helper path:', ntHelperPath);
  assertExists(ntHelperPath, 'nt_helper.node');
  logVerbose('[loadNative] nt_helper.node exists, attempting to require...');

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

  cached = { ntHelper };
  logToFile('[loadNative] Native module loaded and cached successfully', {
    nativeRoot,
    elapsedMs: Date.now() - startedAt,
  });
  return cached;
}

/** Drop the cached bundle. Mostly for tests. */
export function resetNativeCache(): void {
  cached = undefined;
}

/**
 * Absolute path to the `nt_helper.node` that {@link loadNative} would resolve,
 * without loading it. The desktop app needs this to hand an elevated (sudo)
 * child the exact addon to require. Resolution mirrors `loadNative`
 * (WEQ_NATIVE_DIR → packaged → dev walk-up).
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
    // 失败会在 UI 里弹窗，但日志里也必须留下分类结论 —— 以前只有底层 throw
    // 的原始 message，没有 expired/damaged 的判定。
    logToFile('[loadNativeSafe] load failed', { kind, status, message });
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
  logVerbose('[resolveNativeRoot] Starting native root resolution...');

  const override = process.env.WEQ_NATIVE_DIR;
  if (override) {
    logVerbose('[resolveNativeRoot] Found WEQ_NATIVE_DIR override:', override);
    if (!existsSync(override)) {
      logToFile('[resolveNativeRoot] WEQ_NATIVE_DIR path does not exist:', override);
      throw new Error(`WEQ_NATIVE_DIR points at non-existent directory: ${override}`);
    }
    logVerbose('[resolveNativeRoot] Using WEQ_NATIVE_DIR:', override);
    return override;
  }

  // Production: Electron sets process.resourcesPath when packaged. The bundle
  // is copied to the install root (sibling of resources/), not into resources/.
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  logVerbose('[resolveNativeRoot] Electron resourcesPath:', electronResources || '<not set>');

  if (electronResources) {
    const candidates = [
      join(dirname(electronResources), 'native'),
      join(electronResources, 'native'),
    ];
    logVerbose('[resolveNativeRoot] Checking Electron packaged paths:', candidates);
    for (const packaged of candidates) {
      if (existsSync(packaged)) {
        logVerbose('[resolveNativeRoot] Found packaged native at:', packaged);
        return packaged;
      }
    }
    logVerbose('[resolveNativeRoot] No packaged paths exist');
  }

  // Dev: bundlers (electron-vite) rewrite `import.meta.url` so it points
  // at the output dir (e.g. apps/desktop/out/main/), not at this source
  // file. Walk upward looking for a sibling `native/` so we work
  // regardless of how deep we got bundled. Confirm it's the right dir by
  // checking for the current platform's subdir (not a hardcoded win32).
  logVerbose('[resolveNativeRoot] Trying dev mode path resolution...');
  const tried: string[] = [];
  for (const start of [here, process.cwd()]) {
    logVerbose('[resolveNativeRoot] Walking up from:', start);
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'native');
      tried.push(candidate);
      const platformCheck = join(candidate, process.platform);
      if (existsSync(candidate) && existsSync(platformCheck)) {
        logVerbose('[resolveNativeRoot] Found dev native at:', candidate);
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
      `\nSet WEQ_NATIVE_DIR to override.\n` +
      // nt_helper.node 与装扮资源不入库，dev 克隆里本来就没有 —— 这是最常见的原因。
      `If this is a fresh clone: run \`pnpm native:fetch\` (see native/README.md).`,
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
        `Run \`pnpm native:fetch\` (see native/README.md), or place the renamed\n` +
        `.node files there manually.`,
    );
  }
  return platformRoot;
}

function assertExists(path: string, label: string): void {
  logVerbose(`[assertExists] Checking ${label} at: ${path}`);
  if (!existsSync(path)) {
    logToFile(`[assertExists] MISSING: ${label} not found at ${path}`);
    throw new Error(
      `Required native asset missing: ${label}\n  expected at: ${path}\n  hint: Run \`pnpm native:fetch\` in a dev clone (see native/README.md).`,
    );
  }
  try {
    const stats = statSync(path);
    logVerbose(`[assertExists] Found ${label}`, {
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
  // 把两份日志（loader / nt_helper）关联起来：出问题时一眼能看出 addon 写到哪。
  logToFile('[loadNative] nt_helper log path:', logPath);
}

/**
 * Absolute directory the native addon writes its diagnostics into
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

  const platformRoot = defaultLogRoot();
  const cwdLogDir = join(process.cwd(), 'logs');

  // Existing roots win, so dev / web trees keep their own `logs/` (the repo
  // and dist ship one). The platform root is chosen once its data dir
  // exists; the cwd-derived root only when the logs dir itself exists — its
  // parent is cwd, which always exists, so checking the parent would let
  // `/logs` win on a fresh GUI launch (cwd `/`) and fail for a normal user.
  if (platformRoot && existsSync(dirname(platformRoot))) {
    return platformRoot;
  }
  if (existsSync(cwdLogDir)) {
    return cwdLogDir;
  }

  // Fresh install: no root exists yet (the app data dir is created on first
  // run). Use the per-OS user data root, created on demand by `mkdirSync` /
  // nt_helper's `create_dir_all` — NOT the cwd-derived one, which would be
  // unwritable (e.g. `/logs`) and make setLogPath fail, misreporting the
  // whole native bundle as damaged/tampered.
  return platformRoot ?? cwdLogDir;
}

/**
 * Per-OS default addon log root, following the same per-user data dir
 * convention as the candidates above (mirrors `platform.appDataRoot()`).
 * The directory itself is created on demand (`mkdirSync` /
 * nt_helper's `create_dir_all`), so it does not need to exist yet.
 */
function defaultLogRoot(): string | null {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || process.env.LOCALAPPDATA;
    return appData ? join(appData, 'WeQ', 'logs') : null;
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'WeQ', 'logs');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'WeQ', 'logs');
}
