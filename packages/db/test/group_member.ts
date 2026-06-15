/**
 * Integration test for `GroupMemberDb`.
 */

import { loadNative } from '@weq/native';
import { GroupMemberDb } from '../src/group_info/member';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';

// Hardcoded path for the developer demo test.
const GROUP_INFO_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();

  console.log('[test:group-member] Opening:', GROUP_INFO_DB_PATH);
  const db = new GroupMemberDb(native.ntHelper, {
    dbPath: GROUP_INFO_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  // 1. Find a group and list its members
  const anyRows = await (db as any).qq.query('SELECT "60001" FROM group_member3 LIMIT 1', []);
  
  if (anyRows.length === 0) {
    console.log('[test:group-member] No records found in table.');
  } else {
    const groupCode = anyRows[0][0];
    console.log('[test:group-member] Testing with groupCode:', groupCode);
    
    const members = await db.listMembersInGroup(BigInt(groupCode), 5);
    console.log(`[test:group-member] Found ${members.length} members in group.`);
    if (members.length > 0) {
      console.log('[test:group-member] Sample Member:');
      console.log(JSON.stringify(members[0], bigintReplacer, 2));

      // 2. Test listing groups for that specific member
      const userUid = members[0]!.uid;
      console.log('[test:group-member] Listing groups for user UID:', userUid);
      const userGroups = await db.listUserGroups(userUid, 5);
      console.log(`[test:group-member] User is in ${userGroups.length} groups (sampled).`);
      console.log(JSON.stringify(userGroups.map(g => g.groupCode.toString()), null, 2));
    }
  }

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:group-member] failed:', e);
  process.exit(1);
});
