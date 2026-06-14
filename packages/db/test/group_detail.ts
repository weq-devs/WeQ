/**
 * Integration test for `GroupDetailDb`.
 */

import { loadNative } from '@weq/native';
import { GroupDetailDb } from '../src/group_info/detail';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const GROUP_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  
  console.log('[test:group-detail] Opening:', GROUP_INFO_DB_PATH);
  const db = new GroupDetailDb(native.ntHelper, { dbPath: GROUP_INFO_DB_PATH, key: KEY });

  const all = await db.listAll(5);
  console.log(`[test:group-detail] Found ${all.length} groups.`);

  if (all.length > 0) {
    console.log('[test:group-detail] Sample Result (First Group):');
    console.log(JSON.stringify(all[0], bigintReplacer, 2));
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:group-detail] failed:', e);
  process.exit(1);
});
