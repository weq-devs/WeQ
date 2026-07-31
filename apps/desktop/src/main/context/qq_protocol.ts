/**
 * Probe which exe the OS associates with QQ's `tencent://` URL scheme.
 *
 * We prefer `tencent://`, then `mqqapi://` (both point at the same handler in
 * practice; the second is a fallback for installs that only registered one).
 * Anything else — no association, throw — leaves the cached value null and the
 * platform silently falls back to the registry probe.
 *
 * Win32-only: linux QQ doesn't register these schemes, so the caller skips the
 * probe there entirely and the cache stays null.
 *
 * Electron-only (needs `app.getApplicationInfoForProtocol`). The cache itself
 * lives in `qq_protocol_cache.ts` so non-Electron hosts can read it.
 */

import { app } from 'electron';
import { getLogger } from '@weq/service';
import { setQqProtocolExe } from './qq_protocol_cache';

const SCHEMES = ['tencent://', 'mqqapi://'] as const;

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
        setQqProtocolExe(info.path);
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
