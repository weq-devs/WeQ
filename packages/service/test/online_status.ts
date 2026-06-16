/**
 * Full Service integration test for `OnlineStatusService`.
 */

import { loadNative } from '@weq/native';
import { MiscDb } from '@weq/db';
import { OnlineStatusService } from '../src/account/online_status';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const MISC_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\misc.db`;

async function main() {
  const native = loadNative();
  
  // Create a mock session that just has the bits the service needs
  const miscDb = new MiscDb(native.ntHelper, {
    dbPath: MISC_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const mockSession = {
    misc: miscDb,
    // (add other fields if Service constructor checks them, but our current impl is thin)
  } as any;

  const service = new OnlineStatusService(mockSession);

  try {
    // We'll use the UID we found in the previous test
    const targetUid = 'u_-5G5s2u1eRSwl5MPLaWV2Q';
    console.log(`[test:status-service] Fetching status for: ${targetUid}`);
    
    const formatted = await service.getOnlineStatus(targetUid);
    if (formatted) {
      console.log('[test:status-service] Formatted Result:');
      console.log(JSON.stringify(formatted, null, 2));
    } else {
      console.log('[test:status-service] No status found.');
    }

  } catch (err) {
    console.error('[test:status-service] Failed:', err);
  } finally {
    miscDb.close();
  }
}

main().catch((e) => {
  console.error('[test:status-service] failed:', e);
  process.exit(1);
});
