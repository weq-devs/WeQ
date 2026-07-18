/**
 * Script to fetch full profile info for a specific UIN using hardcoded key.
 */

import { loadNative } from '@weq/native';
import { ProfileInfoDb } from '@weq/db';
import { testEnv, qqDbPath } from '@weq/testkit';

const UIN = testEnv.uin;
const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as any;

const DB_PATH = qqDbPath('profile_info.db');

async function main() {
  const native = loadNative();
  
  const profileDb = new ProfileInfoDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: ALGO,
  });

  try {
    console.log(`[test:full-profile] Fetching info for UIN: ${UIN}`);
    
    // Use the service method to get the parsed object
    const profile = await profileDb.getProfileByUin(BigInt(UIN));
    
    if (profile) {
        console.log('[test:full-profile] Result:');
        console.log(JSON.stringify(profile, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    } else {
        console.log('[test:full-profile] Profile not found.');
    }

  } catch (err) {
    console.error('[test:full-profile] Failed:', err);
  } finally {
    // profileDb doesn't have a close() in its interface, but the internal QqDb does.
    // However, ProfileInfoDb doesn't expose it directly in the version I saw.
    // I'll check if I can close it via any other means or just let the process exit.
    (profileDb as any).qq?.close?.();
  }
}

main().catch((e) => {
  console.error('[test:full-profile] failed:', e);
  process.exit(1);
});
