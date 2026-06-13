/**
 * Resolve and load the two closed-source `.node` addons plus their
 * companion resource files.
 *
 * Repo layout (only win32-x64 is implemented for now; mac/linux throw
 * with a clear "not yet implemented" message):
 *
 *   native/
 *     win32/x64/
 *       nt_helper.node                (renamed from index.win32-x64-msvc.node)
 *       ninebird/
 *         NineBird.node               (renamed from NineBird.win32-x64.node)
 *         NineBirdBoot.node           (renamed from ninebird_addon.node)
 *         NineBirdHook.dll
 *         qqnt.json
 *         qr-dbkey.js
 *         quick-dbkey.js
 *     darwin/, linux/                 (placeholder dirs)
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
  const nineBirdBootPath = join(nineBirdDir, 'NineBirdBoot.node');
  assertExists(nineBirdBootPath, 'ninebird/NineBirdBoot.node');

  const resources = buildResources(nineBirdDir);

  const ntHelper = requireFromHere(ntHelperPath) as NtHelperBinding;
  const initStatus = ntHelper.getInitStatus();

  if (initStatus !== InitStatus.Success) {
    const message = INIT_ERROR_MESSAGES[initStatus] || INIT_ERROR_MESSAGES[InitStatus.UnknownError];
    throw new Error(`nt_helper initialization failed: [${initStatus}] ${message}`);
  }

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
  // regardless of how deep we got bundled.
  const tried: string[] = [];
  for (const start of [here, process.cwd()]) {
    let dir = resolve(start);
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'native');
      tried.push(candidate);
      if (existsSync(candidate) && existsSync(join(candidate, 'win32'))) {
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
  if (platform !== 'win32') {
    throw new Error(
      `Platform '${platform}' is not yet supported. Only win32-x64 is implemented; ` +
        `mac/linux ports are pending.`,
    );
  }
  if (arch !== 'x64') {
    throw new Error(
      `Architecture '${arch}' is not supported on win32. Only x64 is implemented.`,
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
  const resources: NineBirdResources = {
    loaderDir: nineBirdDir,
    hookDllPath: join(nineBirdDir, 'NineBirdHook.dll'),
    qqntJsonPath: join(nineBirdDir, 'qqnt.json'),
    nineBirdAddonPath: join(nineBirdDir, 'NineBird.node'),
    qrDbkeyJsPath: join(nineBirdDir, 'qr-dbkey.js'),
    quickDbkeyJsPath: join(nineBirdDir, 'quick-dbkey.js'),
    accountListJsPath: join(nineBirdDir, 'account-list.js'),
  };
  assertExists(resources.hookDllPath, 'ninebird/NineBirdHook.dll');
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
