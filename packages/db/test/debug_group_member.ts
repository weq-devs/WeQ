/**
 * Debug group_member3 columns.
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: GROUP_INFO_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    const table = await db.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='group_member3';"
    );
    console.log('[test:debug-member] Table Schema:');
    console.log(table[0][0]);

    // Also sample a few rows to see what kind of data is in columns like 20004 if it exists
    const sample = await db.query("SELECT * FROM group_member3 LIMIT 1;");
    console.log('\n[test:debug-member] Sample row data count:', sample[0].length);

  } finally {
    db.close();
  }
}

main().catch(console.error);
