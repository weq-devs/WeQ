/**
 * Integration test for `BuddyDb`.
 */

import { loadNative } from '@weq/native';
import { BuddyDb } from '../src';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const PROFILE_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\profile_info.db`;

async function main() {
  const native = loadNative();
  
  console.log('[test:buddy-list] Opening:', PROFILE_INFO_DB_PATH);
  const db = new BuddyDb(native.ntHelper, {
    dbPath: PROFILE_INFO_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const list = await db.listBuddies(10);
  console.log(list);
  console.log(`[test:buddy-list] Found ${list.length} buddies.`);
  if (list.length > 0) {
    console.log('[test:buddy-list] Sample Result:');
    console.log(JSON.stringify(list[0], bigintReplacer, 2));
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:buddy-list] failed:', e);
  process.exit(1);
});
