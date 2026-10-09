/**
 * Shared `login.db` helpers — the account list and the pure-protocol login
 * flow both need "which accounts does this machine have, and what a1/guid/uid
 * does each carry".
 *
 * `login.db` is encrypted with a fixed pre-login key; the page/KDF HMAC
 * algorithms are probed per file (they differ across QQ builds). Everything
 * here is read-only: no writes, no network, no QQ process.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import type { Platform } from '@weq/platform';
import { darwinFindLoginDbs, linuxFindLoginDbs } from '@weq/platform';
import type { LoginAccount } from '@weq/native';
import { getLogger, logErrorContext } from '../common/logger';

/** `login.db` 的固定 pre-login key（页 HMAC / KDF 参数由 probe 给出）。 */
export const LOGIN_DB_KEY = 'BD156D6710D54D8782F4';

const logger = getLogger().child({ scope: 'login-db' });

/**
 * All login.db paths to decrypt, in merge-priority order. win32 has a single
 * `nt_qq/global/nt_db/login.db`; linux has two (`global/nt_db` primary +
 * `nt_qq/global/nt_db` supplementary), so we consult the linux-specific
 * two-location finder there and dedupe against the platform's own pick.
 */
export function loginDbPaths(platform: Platform): string[] {
  if (platform.kind === 'linux' || platform.kind === 'darwin') {
    const finder = platform.kind === 'darwin' ? darwinFindLoginDbs : linuxFindLoginDbs;
    const override = platform.tencentFilesRoots()[0] ?? null;
    const both = finder(undefined, override);
    if (both.length > 0) return [...new Set(both)];
  }
  const single = platform.loginDbPath();
  return single ? [single] : [];
}

/**
 * Decrypt every `login.db` and merge the rows by uin (earlier paths win on a
 * clash). Returns `[]` when none of the files can be decrypted — there is
 * deliberately **no fallback**; a failed decrypt is a hard "no accounts" for
 * the caller to surface.
 */
export async function readLoginAccounts(platform: Platform): Promise<LoginAccount[]> {
  const dbPaths = loginDbPaths(platform);
  if (dbPaths.length === 0) {
    logger.warn('login.db not found; skipping decrypt', {
      event: 'login-db-not-found',
      rootsTried: platform.tencentFilesRoots(),
    });
    return [];
  }

  const merged = new Map<string, LoginAccount>();
  for (const dbPath of dbPaths) {
    try {
      const probe = await platform.native.ntHelper.testDatabaseKey(dbPath, LOGIN_DB_KEY);
      if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
        logger.warn('login.db probe did not yield algorithms', {
          event: 'login-db-probe-unsuccessful',
          dbPath,
          probeSuccess: probe.success,
        });
        continue;
      }
      const rows = platform.native.ntHelper.decryptLoginDb(dbPath, {
        pageHmacAlgorithm: probe.pageHmacAlgorithm,
        kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
      });
      for (const row of rows) {
        if (row.uin && !merged.has(row.uin)) merged.set(row.uin, row);
      }
    } catch (error) {
      logger.warn('login.db decrypt threw', {
        event: 'login-db-decrypt-failed',
        dbPath,
        ...logErrorContext(error),
      });
    }
  }
  return [...merged.values()];
}

/**
 * `nt_msg.db` 头 `0x2f..0xaf` 那 128 字节 key_meta（dbSalt，128 位 hex）。
 * 读不到 / 格式非法时返回 `null`（此时登录仍可进行，只是拿不到 dbkey）。
 */
export function readKeyMeta(dbPath: string): string | null {
  const start = 0x2f;
  const end = 0xaf;
  const buf = Buffer.alloc(end);
  let fd: number;
  try {
    fd = openSync(dbPath, 'r');
  } catch {
    return null;
  }
  try {
    readSync(fd, buf, 0, end, 0);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  const salt = buf.toString('latin1', start, end);
  return /^[0-9a-fA-F]{128}$/.test(salt) ? salt : null;
}
