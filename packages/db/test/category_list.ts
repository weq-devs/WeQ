/**
 * Integration test for `CategoryDb`.
 */

import { loadNative } from '@weq/native';
import { CategoryDb } from '../src/profile/category';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const PROFILE_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\profile_info.db`;

async function main() {
  const native = loadNative();

  console.log('[test:category-list] Opening:', PROFILE_INFO_DB_PATH);
  const db = new CategoryDb(native.ntHelper, {
    dbPath: PROFILE_INFO_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const list = await db.listCategories();  console.log(`[test:category-list] Found ${list.length} categories.`);
  if (list.length > 0) {
    console.log('[test:category-list] Result:');
    console.log(JSON.stringify(list, null, 2));
  }

  db.close();
}

main().catch((e) => {
  console.error('[test:category-list] failed:', e);
  process.exit(1);
});
