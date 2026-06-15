/**
 * Integration test for `ProfileInfoDb`.
 */

import { loadNative } from '@weq/native';
import { ProfileInfoDb } from '../src/profile/profile_info';

const UIN_TARGET = 3096435766n;
const KEY = '^;<kXZ;RI[@]yTD<';
const UIN_ME = '1707889225';

// Hardcoded path for the developer demo test.
const PROFILE_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN_ME}\\nt_qq\\nt_db\\profile_info.db`;

async function main() {
  const native = loadNative();

  console.log('[test:profile-v6] Opening:', PROFILE_INFO_DB_PATH);
  const db = new ProfileInfoDb(native.ntHelper, {
    dbPath: PROFILE_INFO_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log('[test:profile-v6] Querying target UIN:', UIN_TARGET);  const profile = await db.getProfileByUin(UIN_TARGET);
  
  if (profile) {
    console.log('[test:profile-v6] Result found:');
    console.log(JSON.stringify(profile, bigintReplacer, 2));
  } else {
    console.log('[test:profile-v6] User not found in cache.');
    
    // Fallback: list some profiles to see what's there
    const list = await db.listProfiles(3);
    console.log('[test:profile-v6] Listing some cached profiles instead:');
    console.log(JSON.stringify(list, bigintReplacer, 2));
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:profile-v6] failed:', e);
  process.exit(1);
});
