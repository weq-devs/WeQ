/**
 * End-to-end check for the 头像路径 tool's FRIEND path:
 *
 *   uin --(profile_info_v6: 1002→1000)--> uid --(md5³)--> hash --> on-disk file
 *
 * We take real friend conversations from recent_contact (chatType 1, which carry
 * both 40030 targetUin and 40021 targetUid), resolve uin→uid the way `probeByQq`
 * does (via profile_info.db), recompute the hash, and confirm both that the
 * resolved uid matches recent_contact's and that the derived avatar file exists.
 *
 * Run:  pnpm --filter @weq/db test:verify-avatar-probe
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const MSG_DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

const PROFILE_DB = join(dirname(MSG_DB), 'profile_info.db');
const NT_DATA_DIR = join(dirname(dirname(MSG_DB)), 'nt_data');

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}
function avatarHash(uid: string): string {
  return md5(md5(md5(uid) + uid) + uid);
}
function onDisk(scope: string, hash: string): string {
  const bucket = hash.slice(0, 2);
  const has = (p: string): boolean => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const big = has(join(NT_DATA_DIR, 'avatar', scope, bucket, `b_${hash}`));
  const small = has(join(NT_DATA_DIR, 'avatar', scope, bucket, `s_${hash}`));
  return `${big ? 'b_' : '--'}${small ? 's_' : '--'}`;
}

async function main(): Promise<void> {
  const native = loadNative();
  const msg = new QqDb(native.ntHelper, { dbPath: MSG_DB, key: KEY, algo: ALGO });
  const profile = new QqDb(native.ntHelper, { dbPath: PROFILE_DB, key: KEY, algo: ALGO });

  // Friend conversations only (chatType 1): both uin + uid present.
  const rows = await msg.query(
    `SELECT "40030","40021" FROM recent_contact_v3_table
       WHERE "40010" = 1 AND "40030" IS NOT NULL AND "40030" <> 0
       ORDER BY "40050" DESC LIMIT 20`,
  );

  let checked = 0;
  let uidOk = 0;
  let fileOk = 0;

  for (const row of rows) {
    const uin = typeof row[0] === 'bigint' ? row[0].toString() : String(row[0] ?? '');
    const rcUid = typeof row[1] === 'string' ? row[1] : String(row[1] ?? '');
    if (!/^\d+$/.test(uin)) continue;

    // The exact lookup probeByQq does for a friend.
    const pr = await profile.query(`SELECT "1000" FROM profile_info_v6 WHERE "1002" = ? LIMIT 1`, [
      BigInt(uin),
    ]);
    const uid = pr.length ? String(pr[0]![0] ?? '') : '';

    checked += 1;
    const matches = uid !== '' && uid === rcUid;
    if (matches) uidOk += 1;

    const hash = uid ? avatarHash(uid) : '';
    const disk = uid ? onDisk('user', hash) : '----';
    if (uid && disk !== '----') fileOk += 1;

    console.log(
      `${matches ? 'OK  ' : uid ? 'DIFF' : 'MISS'}  uin=${uin}\n` +
        `      profile.uid=${uid || '(not found)'}\n` +
        `      rc.uid     =${rcUid}\n` +
        (uid ? `      hash=${hash} onDisk=[${disk}]\n` : ''),
    );
  }

  console.log(
    `\n============ uid match ${uidOk}/${checked}, avatar on disk ${fileOk}/${checked} ============`,
  );
  msg.close();
  profile.close();
}

main().catch((e) => {
  console.error('[verify-avatar-probe] failed:', e);
  process.exit(1);
});
