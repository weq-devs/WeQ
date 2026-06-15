/**
 * Test fetching user profile with gender.
 */

import { loadNative } from '@weq/native';
import { ProfileInfoDb } from '@weq/db';
import { ProfileService } from '../src/account/profile';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const PROFILE_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\profile_info.db`;

async function main() {
  const native = loadNative();
  
  const profileDb = new ProfileInfoDb(native.ntHelper, {
    dbPath: PROFILE_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const mockSession = {
    profileInfo: profileDb,
  } as any;

  const service = new ProfileService(mockSession);

  try {
    // We'll use the UID of "klare" we found earlier
    const targetUid = 'u_-5G5s2u1eRSwl5MPLaWV2Q';
    console.log(`[test:profile] Fetching profile for: ${targetUid}`);
    
    const profile = await service.getProfile(targetUid);
    if (profile) {
        console.log('[test:profile] Result:');
        const display = {
            ...profile,
            uin: profile.uin.toString(),
            genderName: profile.gender === 1 ? '男' : (profile.gender === 2 ? '女' : '未知')
        };
        console.log(JSON.stringify(display, null, 2));
    } else {
        console.log('[test:profile] Profile not found.');
    }

  } catch (err) {
    console.error('[test:profile] Failed:', err);
  } finally {
    profileDb.close();
  }
}

main().catch((e) => {
  console.error('[test:profile] failed:', e);
  process.exit(1);
});
