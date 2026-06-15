/**
 * Integration test for `BuddyRequestDb`.
 */

import { loadNative } from '@weq/native';
import { BuddyRequestDb } from '../src/profile/buddy_req';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const PROFILE_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\profile_info.db`;

async function main() {
  const native = loadNative();

  console.log('[test:buddy-req] Opening:', PROFILE_INFO_DB_PATH);
  const db = new BuddyRequestDb(native.ntHelper, {
    dbPath: PROFILE_INFO_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const list = await db.listRequests(10);  console.log(`[test:buddy-req] Found ${list.length} requests.`);
  if (list.length > 0) {
    console.log('[test:buddy-req] Sample Result:');
    console.log(JSON.stringify(list[0], bigintReplacer, 2));
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:buddy-req] failed:', e);
  process.exit(1);
});
