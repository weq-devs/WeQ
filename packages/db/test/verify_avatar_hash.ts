/**
 * Verify the avatar-path hash formula against real `recent_contact_v3_table`
 * rows.
 *
 * Claim: the local avatar file at `nt_data/avatar/<scope>/<bucket>/[b_|s_]<hash>`
 * has
 *
 *     hash   = md5( md5( md5(uid) + uid ) + uid )         // hex-string concat
 *     bucket = hash.slice(0, 2)
 *
 * where `uid` is the account uid (`u_xxx` for users; the numeric uin for groups,
 * since group uin == uid). We read the (uid, avatarPath) pair straight out of
 * recent_contact — 40021 = targetUid, 41110 = targetAvatar — recompute the hash,
 * and check it against the hash embedded in the stored path.
 *
 * Run:  pnpm --filter @weq/db test:verify-avatar-hash
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const TABLE = 'recent_contact_v3_table';

/** md5 hex digest of a UTF-8 string. */
function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

/** hash = md5(md5(md5(uid)+uid)+uid) — nested, hex-string concatenation. */
function avatarHash(uid: string): string {
  return md5(md5(md5(uid) + uid) + uid);
}

/** Pull the `[b_|s_]<hash>` leaf out of a stored avatar path, if present. */
function hashFromPath(path: string): string | null {
  const leaf = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const m = /^(?:[bs]_)?([0-9a-f]{16,64})$/i.exec(leaf);
  return m ? m[1]!.toLowerCase() : null;
}

/** …/nt_qq/nt_db/nt_msg.db → …/nt_qq/nt_data (the avatar tree's root). */
const NT_DATA_DIR = join(dirname(dirname(DB_PATH)), 'nt_data');

/** True when a file exists on disk (mirrors AvatarResourceService.resolveFile). */
function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Rebuild the on-disk path the way `resolveByUid` would — from ntData + scope +
 * bucket + `b_`/`s_` prefix — and report which variants exist. This validates
 * the service's path construction, not just the hash arithmetic.
 */
function probeLocal(scope: 'user' | 'group', hash: string): string {
  const bucket = hash.slice(0, 2).toLowerCase();
  const big = fileExists(join(NT_DATA_DIR, 'avatar', scope, bucket, `b_${hash}`));
  const small = fileExists(join(NT_DATA_DIR, 'avatar', scope, bucket, `s_${hash}`));
  return `${big ? 'b_' : '--'}${small ? 's_' : '--'}`;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[verify-avatar-hash] opening ${DB_PATH}\n`);

  // 40010 chatType, 40021 targetUid, 41110 targetAvatar (path).
  const rows = await db.query(
    `SELECT "40010","40021","41110" FROM "${TABLE}"
       WHERE "41110" IS NOT NULL AND "41110" <> ''
       ORDER BY "40050" DESC LIMIT 40`,
  );

  let checked = 0;
  let matched = 0;

  for (const row of rows) {
    const chatType = String(row[0]);
    const uid = typeof row[1] === 'string' ? row[1] : String(row[1] ?? '');
    const path = typeof row[2] === 'string' ? row[2] : String(row[2] ?? '');
    if (!uid) continue;

    const stored = hashFromPath(path);
    if (!stored) {
      // Not a local nt_data/avatar path (e.g. a CDN url) — nothing to check.
      console.log(`SKIP  chatType=${chatType} uid=${uid}\n      path=${path}`);
      continue;
    }

    const computed = avatarHash(uid);
    const ok = computed === stored;
    checked += 1;
    if (ok) matched += 1;

    // chatType 2 = group (scope 'group'); everything else is a user avatar.
    const scope = chatType === '2' ? 'group' : 'user';
    const onDisk = probeLocal(scope, computed);

    console.log(
      `${ok ? 'OK  ' : 'FAIL'}  chatType=${chatType} scope=${scope} uid=${uid}\n` +
        `      stored  =${stored}\n` +
        `      computed=${computed}  onDisk=[${onDisk}]\n` +
        `      path    =${path}`,
    );
  }

  console.log(`\n================ ${matched}/${checked} hash matched ================`);
  db.close();
}

main().catch((e) => {
  console.error('[verify-avatar-hash] failed:', e);
  process.exit(1);
});
