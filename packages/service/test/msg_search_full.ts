/**
 * Test enhanced message search functionality.
 */

import { loadNative } from '@weq/native';
import { BuddyMsgFtsDb, GroupMsgFtsDb } from '@weq/db';
import { MsgSearchService } from '../src/account/msg_search';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const NT_DB_DIR = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db`;

async function main() {
  const native = loadNative();
  
  const buddyFts = new BuddyMsgFtsDb(native.ntHelper, {
    dbPath: `${NT_DB_DIR}\\buddy_msg_fts.db`,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const groupFts = new GroupMsgFtsDb(native.ntHelper, {
    dbPath: `${NT_DB_DIR}\\group_msg_fts.db`,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const mockSession = {
    buddyMsgFts: buddyFts,
    groupMsgFts: groupFts,
  } as any;

  const service = new MsgSearchService(mockSession);

  try {
    const keyword = '哈哈';
    console.log(`[test:search] Searching for: "${keyword}"`);

    const buddyHits = await service.searchBuddy(keyword, 3);
    console.log(`\nBuddy Hits (${buddyHits.length}):`);
    buddyHits.forEach(h => console.log(` - [${h.sendTime}] ${h.content.slice(0, 30)}`));

    const groupHits = await service.searchGroup(keyword, 3);
    console.log(`\nGroup Hits (${groupHits.length}):`);
    groupHits.forEach(h => console.log(` - [${h.sendTime}] ${h.content.slice(0, 30)}`));

    const fileKeyword = 'zip';
    console.log(`\n[test:search] Searching files for: "${fileKeyword}"`);
    const fileHits = await service.searchFiles(fileKeyword, 3);
    console.log(`File Hits (${fileHits.length}):`);
    fileHits.forEach(h => console.log(` - [${h.sendTime}] File: ${h.fileName}, Content: ${h.content.slice(0, 30)}`));

  } catch (err) {
    console.error('[test:search] Failed:', err);
  } finally {
    buddyFts.close();
    groupFts.close();
  }
}

main().catch(console.error);
