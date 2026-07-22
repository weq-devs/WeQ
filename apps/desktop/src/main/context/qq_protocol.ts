/**
 * Resolve which exe the OS associates with QQ's `tencent://` URL scheme, so
 * the win32 platform can anchor every install path (QQ.exe / wrapper.node /
 * version) on it instead of the `Uninstall\QQ` registry key — which is missing
 * or relocated for portable installs, non-standard layouts, and machines whose
 * registry has been cleaned.
 *
 * The handler is QQNT's `timwp.exe`, sitting in the same `resources/app` dir as
 * `wrapper.node`. We prefer `tencent://`, then `mqqapi://` (both point at the
 * same handler in practice; the second is a fallback for installs that only
 * registered one). Anything else — no association, throw — leaves the cached
 * value null and the platform silently falls back to the registry probe.
 *
 * Win32-only: linux QQ doesn't register these schemes, so the caller skips the
 * probe there entirely and the getter stays null.
 */

import { app } from 'electron';
import { getLogger } from '@weq/service';

const SCHEMES = ['tencent://', 'mqqapi://'] as const;

let cachedExe: string | null = null;

/** The resolved protocol-handler exe path, or null until/unless the probe finds one. */
export function getQqProtocolExe(): string | null {
  return cachedExe;
}

/**
 * Probe the OS protocol association once and cache the handler exe path. Safe
 * to call before any path lookup; resolves (never rejects) so a missing
 * association just leaves the cache null. Must run after `app.whenReady()`.
 */
export async function probeQqProtocolHandler(): Promise<void> {
  const logger = getLogger().child({ scope: 'qq-protocol' });
  for (const scheme of SCHEMES) {
    try {
      const info = await app.getApplicationInfoForProtocol(scheme);
      if (info.path) {
        cachedExe = info.path;
        logger.info('resolved QQ protocol handler', {
          event: 'qq-protocol-resolved',
          scheme,
          path: info.path,
          name: info.name,
        });
        return;
      }
    } catch {
      // No app registered for this scheme — try the next one.
    }
  }
  logger.warn('no QQ protocol handler registered; falling back to registry', {
    event: 'qq-protocol-unresolved',
    schemes: SCHEMES,
  });
}
