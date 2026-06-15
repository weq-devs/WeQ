/**
 * Integration test for `OnlineStatus` in `misc.db`.
 */

import { loadNative } from '@weq/native';
import { MiscDb } from '../src/profile/misc';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const MISC_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\misc.db`;

async function main() {
  const native = loadNative();
  
  console.log('[test:misc-status] Opening:', MISC_DB_PATH);
  const db = new MiscDb(native.ntHelper, {
    dbPath: MISC_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    // 1. List some UIDs from the table to see what's available
    const rows = await db.query("SELECT \"48901\" FROM online_status_kv_table LIMIT 5;");
    if (!rows || rows.length === 0) {
      console.log('[test:misc-status] No UIDs found in table.');
      return;
    }
    console.log(`[test:misc-status] Found ${rows.length} sample UIDs:`, rows.map(r => r[0]));

    const firstRow = rows[0];
    if (firstRow) {
      const targetUid = firstRow[0] as string;
      console.log(`[test:misc-status] Fetching status for: ${targetUid}`);
      
      const status = await db.getUserOnlineStatus(targetUid);
      if (status) {
        console.log('[test:misc-status] Decoded Status:');
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log('[test:misc-status] No status found for this UID.');
      }
    }

  } catch (err) {
    console.error('[test:misc-status] Failed:', err);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('[test:misc-status] failed:', e);
  process.exit(1);
});
