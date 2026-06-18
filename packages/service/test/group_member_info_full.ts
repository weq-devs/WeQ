/**
 * Test fetching group member levels, custom titles, and group level names.
 */

import { loadNative } from '@weq/native';
import { GroupMemberDb, GroupMemberLevelInfoDb } from '@weq/db';
import { GroupInfoService } from '../src/account/group_info';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = 1090396070n;

const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\group_info.db`;

async function main() {
  const native = loadNative();
  
  const groupMembersDb = new GroupMemberDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const memberLevelDb = new GroupMemberLevelInfoDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const mockSession = {
    groupMembers: groupMembersDb,
    memberLevelInfo: memberLevelDb,
  } as any;

  const service = new GroupInfoService(mockSession);

  try {
    console.log(`\n[test:group-info] --- Info for group: ${GROUP_CODE} ---\n`);
    
    // 1. Get Group Level Names
    console.log('1. Group Level Configurations:');
    const levelInfo = await service.getMemberLevelInfo(GROUP_CODE);
    if (levelInfo && levelInfo.levelConfigs.length > 0) {
      levelInfo.levelConfigs.forEach(cfg => {
        console.log(`   Level ${cfg.level}: ${cfg.levelName}`);
      });
    } else {
      console.log('   (No level configurations found)');
    }

    // 2. Get All Members with their levels and titles
    console.log('\n2. Member List (Levels & Custom Titles):');
    const members = await service.listMembersInGroup(GROUP_CODE, 1000, 0);
    console.log(`   Fetched ${members.length} members.\n`);
    
    // Header
    console.log('   ' + 'Nick'.padEnd(20) + ' | ' + 'Level'.padEnd(8) + ' | ' + 'Custom Title');
    console.log('   ' + '-'.repeat(50));

    members.forEach((m) => {
        const levelName = levelInfo?.levelConfigs.find(c => c.level === m.memberLevel)?.levelName || `LV${m.memberLevel}`;
        const nick = (m.card || m.nick).slice(0, 20);
        console.log(`   ${nick.padEnd(20)} | ${levelName.padEnd(8)} | ${m.customTitle || '-'}`);
    });

  } catch (err) {
    console.error('[test:group-info] Failed:', err);
  } finally {
    groupMembersDb.close();
    memberLevelDb.close();
  }
}

main().catch((e) => {
  console.error('[test:group-info] failed:', e);
  process.exit(1);
});
