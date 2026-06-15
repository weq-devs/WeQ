/**
 * Shared static-resource resolver.
 *
 * The repo-root `resources/` tree (brand assets, QQ emoji, …) is shipped two
 * different ways depending on build mode, so every consumer must probe a list
 * of candidate roots rather than hard-code one:
 *
 *   Dev:      walk up from this bundled file (out/main → repo root) to `resources/`.
 *   Packaged: electron-builder copies the tree to
 *             `process.resourcesPath/resources/` (see electron-builder.yml).
 *
 * Used by the window-icon loader and the `weq-asset://` protocol handler.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** First existing `resources/` root among the candidates, or null. */
export function resolveResourceRoot(): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'resources'), // packaged
    join(moduleDir, '../../../../resources'), // dev (out/main → repo root)
    join(process.cwd(), 'resources'),
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** Absolute path to a resource under the resolved root, or null if missing. */
export function resolveResource(...segments: string[]): string | null {
  const root = resolveResourceRoot();
  if (!root) return null;
  const full = join(root, ...segments);
  return existsSync(full) ? full : null;
}
