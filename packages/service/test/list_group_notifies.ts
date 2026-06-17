/**
 * Script to list group notifications for a specific UIN.
 */

import { loadNative } from '@weq/native';
import { GroupNotifyDb } from '@weq/db';
import fs from 'node:fs';

// Update these with your real values
const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<'; // This should be the same as profile_info.db's key
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as any;

// Adjust path as needed
const DB_PATH = `C:\\Users\\17078\\Documents\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;
// Fallback path example
const DB_PATH_ALT = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  
  let dbPath = DB_PATH;
  if (!fs.existsSync(dbPath)) {
      dbPath = DB_PATH_ALT;
  }
  
  if (!fs.existsSync(dbPath)) {
      console.error(`[test:group-notify] Could not find group_info.db at ${DB_PATH} or ${DB_PATH_ALT}`);
      return;
  }

  const notifyDb = new GroupNotifyDb(native.ntHelper, {
    dbPath: dbPath,
    key: KEY,
    algo: ALGO,
  });

  try {
    console.log(`[test:group-notify] Fetching notifications for UIN: ${UIN} from ${dbPath}`);
    
    console.log('\n--- Normal Notifications ---');
    const normal = await notifyDb.listNormal(10);
    console.log(JSON.stringify(normal, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

    console.log('\n--- Doubt Notifications ---');
    const doubt = await notifyDb.listDoubt(10);
    console.log(JSON.stringify(doubt, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  } catch (err) {
    console.error('[test:group-notify] Failed:', err);
  } finally {
    notifyDb.close();
  }
}

main().catch((e) => {
  console.error('[test:group-notify] failed:', e);
  process.exit(1);
});
