/**
 * Integration test for listing group members.
 */

import { loadNative } from '@weq/native';
import { GroupMemberDb } from '@weq/db';
import { GroupInfoService } from '../src/account/group_info';
import { join } from 'node:path';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = 1090396070n;

// Base path for group_info.db
const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  
  const groupMembersDb = new GroupMemberDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const mockSession = {
    groupMembers: groupMembersDb,
  } as any;

  const service = new GroupInfoService(mockSession);

  try {
    console.log(`[test:group-members] Fetching members for group: ${GROUP_CODE}`);
    
    const members = await service.listMembersInGroup(GROUP_CODE, 10);
    console.log(`[test:group-members] Found ${members.length} members (showing top 10):`);
    
    members.forEach((m, i) => {
        console.log(`${i+1}. ${m.nick} (UIN: ${m.uin}, UID: ${m.uid})`);
    });

  } catch (err) {
    console.error('[test:group-members] Failed:', err);
  } finally {
    groupMembersDb.close();
  }
}

main().catch((e) => {
  console.error('[test:group-members] failed:', e);
  process.exit(1);
});
