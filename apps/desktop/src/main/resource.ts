/**
 * Shared static-resource resolver.
 *
 * The repo-root `resources/` tree (brand assets, …) is shipped two different
 * ways depending on build mode, so every consumer must probe a list of
 * candidate roots rather than hard-code one. (QQ emoji are no longer bundled —
 * they stream from the account's QQ NT dir; see resource_protocol.ts.)
 *
 *   Dev:      walk up from this bundled file to the repo root and look for `resources/`.
 *   Packaged: electron-builder copies the tree to
 *             `process.resourcesPath/resources/` (see electron-builder.yml).
 *
 * Used by the window-icon loader and the `weq-asset://` protocol handler.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** 打包产物里 `resources/` 树的标志性子目录 —— 目录名太泛，光看根会被误判。 */
const RESOURCE_MARKER = join('brand', 'logo.png');

/**
 * 从 `start` 逐级往上找带 {@link RESOURCE_MARKER} 的 `resources/`。
 *
 * 不能写死 `../../../../resources`：electron-vite 会把共享模块拆到
 * `out/main/chunks/`（v6 起 chunk 一律带 hash 放进 `chunks/` 子目录），层级比
 * `out/main/` 深一层，写死的相对路径就会指到 `apps/resources` 上 —— 于是所有
 * `resolveResource()` 都静默返回 null（`weq-media://dress` 的名片广告占位图因此裂成 404）。
 * 逐级上溯对「被打进主入口」和「被拆成任何深度的 chunk」都成立。
 */
export function walkUpForResources(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'resources');
    if (existsSync(join(candidate, RESOURCE_MARKER))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** First existing `resources/` root among the candidates, or null. */
export function resolveResourceRoot(): string | null {
  // `resourcesPath` is injected by Electron and absent under plain Node (the
  // web app), where the bundle ships its own sibling `resources/`. Same probe
  // shape as `@weq/native`'s loader.
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  // 别写成 `join(resourcesPath ?? '', 'resources')` —— 纯 Node 下那是相对路径，
  // 会跟着 cwd 漂移（踩过：测试里 cwd 恰好是仓库根，掩盖了探测失败）。
  const candidates = [
    ...(electronResources ? [join(electronResources, 'resources')] : []), // packaged (Electron)
    join(moduleDir, 'resources'), // packaged (web: dist/resources)
  ];
  for (const path of candidates) {
    if (path && existsSync(join(path, RESOURCE_MARKER))) return path;
  }
  // dev：从当前 bundle 所在目录上溯，不管它落在 out/main 还是 out/main/chunks。
  return walkUpForResources(moduleDir) ?? walkUpForResources(process.cwd());
}

/** Absolute path to a resource under the resolved root, or null if missing. */
export function resolveResource(...segments: string[]): string | null {
  const root = resolveResourceRoot();
  if (!root) return null;
  const full = join(root, ...segments);
  return existsSync(full) ? full : null;
}

/** Match native's offline index to desktop's actual packaged resource layout. */
export function configureNativeDressResources(): void {
  if (process.env.NT_HELPER_DRESS_DIR || process.env.WEQ_NATIVE_DIR) return;
  const directory = resolveResource('dress');
  if (directory) process.env.NT_HELPER_DRESS_DIR = directory;
}
