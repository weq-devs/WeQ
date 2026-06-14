/**
 * Integration test for `GroupEssenceDb`.
 */

import { loadNative } from '@weq/native';
import { GroupEssenceDb } from '../src/group_info/essence';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const GROUP_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  
  console.log('[test:group-essence] Opening:', GROUP_INFO_DB_PATH);
  const db = new GroupEssenceDb(native.ntHelper, { dbPath: GROUP_INFO_DB_PATH, key: KEY });

  // Try to find a groupCode to test with.
  const anyRows = await (db as any).qq.query('SELECT "60001" FROM group_essence LIMIT 1', []);
  
  if (anyRows.length === 0) {
    console.log('[test:group-essence] No essence messages found in table.');
  } else {
    const groupCode = anyRows[0][0];
    console.log('[test:group-essence] Found groupCode:', groupCode);
    
    const list = await db.listEssence(BigInt(groupCode));
    console.log(`[test:group-essence] Found ${list.length} messages:`);
    console.log(JSON.stringify(list, bigintReplacer, 2));
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:group-essence] failed:', e);
  process.exit(1);
});
