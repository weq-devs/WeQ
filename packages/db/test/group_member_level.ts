/**
 * Integration test for `GroupMemberLevelInfoDb`.
 */

import { loadNative } from '@weq/native';
import { GroupMemberLevelInfoDb } from '../src/group_info/member_level';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const GROUP_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  
  console.log('[test:group-member-level] Opening:', GROUP_INFO_DB_PATH);
  const db = new GroupMemberLevelInfoDb(native.ntHelper, { dbPath: GROUP_INFO_DB_PATH, key: KEY });

  // Try to find a groupCode to test with.
  const anyRows = await (db as any).qq.query('SELECT "60001" FROM group_member_level_info LIMIT 1', []);
  
  if (anyRows.length === 0) {
    console.log('[test:group-member-level] No records found in table.');
  } else {
    const groupCode = anyRows[0][0];
    console.log('[test:group-member-level] Found groupCode:', groupCode);
    
    const info = await db.getLevelInfo(BigInt(groupCode));
    console.log('[test:group-member-level] Result:');
    console.log(JSON.stringify(info, bigintReplacer, 2));
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:group-member-level] failed:', e);
  process.exit(1);
});
