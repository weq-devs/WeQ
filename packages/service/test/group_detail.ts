/**
 * Test fetching basic group detail.
 */

import { loadNative } from '@weq/native';
import { GroupDetailDb } from '@weq/db';
import { GroupInfoService } from '../src/account/group_info';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = 1090396070n;

const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  
  const groupDetailDb = new GroupDetailDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const mockSession = {
    groupDetail: groupDetailDb,
  } as any;

  const service = new GroupInfoService(mockSession);

  try {
    console.log(`[test:group-detail] Fetching info for group: ${GROUP_CODE}`);
    
    const detail = await service.getGroupDetail(GROUP_CODE);
    if (detail) {
        console.log('[test:group-detail] Result:');
        console.log(JSON.stringify(detail, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    } else {
        console.log('[test:group-detail] Group not found.');
    }

  } catch (err) {
    console.error('[test:group-detail] Failed:', err);
  } finally {
    groupDetailDb.close();
  }
}

main().catch((e) => {
  console.error('[test:group-detail] failed:', e);
  process.exit(1);
});
