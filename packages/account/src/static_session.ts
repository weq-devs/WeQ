/**
 * Static (offline) account session — opens an already-decrypted local QQ
 * database directory without needing a dbKey or live QQ process.
 *
 * The directory is expected to contain plain SQLite `.db` files (the result
 * of a prior bulk-decrypt). The directory name is treated as the account UIN.
 *
 * Same lifecycle as the online session: caller must `dispose()` before
 * opening another account to drop the cached native connections.
 */

import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  C2cMsgDb,
  GroupMsgDb,
  RecentContactDb,
  UidMappingDb,
  UidMap,
  ForwardMsgDb,
  BuddyMsgFtsDb,
  GroupMsgFtsDb,
  GroupEssenceDb,
  GroupMemberLevelInfoDb,
  GroupDetailDb,
  GroupBulletinDb,
  GroupMemberDb,
  GroupNotifyDb,
  FileAssistantDb,
  BuddyDb,
  CategoryDb,
  BuddyRequestDb,
  ProfileInfoDb,
  MiscDb,
  UnreadInfoDb,
} from '@weq/db';
import type { Platform } from '@weq/platform';
import type { AccountSession } from './session';

function requireFile(dirPath: string, filename: string): string {
  const p = join(dirPath, filename);
  if (!existsSync(p)) {
    throw new Error(`${filename} not found in selected directory: ${dirPath}`);
  }
  return p;
}

export async function openStaticAccount(
  platform: Platform,
  dirPath: string,
): Promise<AccountSession> {
  const nt = platform.native.ntHelper;
  const uin = basename(dirPath);

  if (!uin || uin.length < 5) {
    throw new Error(`Cannot derive a valid UIN from directory name: ${dirPath}`);
  }

  // ---- core databases ----
  const msgDbPath = requireFile(dirPath, 'nt_msg.db');

  const c2cMsgs = new C2cMsgDb(nt, { dbPath: msgDbPath });
  const groupMsgs = new GroupMsgDb(nt, { dbPath: msgDbPath });
  const recentContacts = new RecentContactDb(nt, { dbPath: msgDbPath });

  // Load the uid ↔ uin ↔ sortNo directory.
  const uidMappingDb = new UidMappingDb(nt, { dbPath: msgDbPath });
  let uidMap: UidMap;
  try {
    uidMap = UidMap.from(await uidMappingDb.listAll());
  } catch (e) {
    console.error('[static-account] failed to load nt_uid_mapping_table — using empty uid map:', e);
    uidMap = UidMap.from([]);
  } finally {
    uidMappingDb.close();
  }

  const forwardMsgs = new ForwardMsgDb(nt, { dbPath: msgDbPath });
  const unreadInfo = new UnreadInfoDb(nt, { dbPath: msgDbPath });

  // ---- full-text-search indexes (may not exist; search will fail gracefully) ----
  const buddyMsgFts = new BuddyMsgFtsDb(nt, { dbPath: join(dirPath, 'buddy_msg_fts.db') });
  const groupMsgFts = new GroupMsgFtsDb(nt, { dbPath: join(dirPath, 'group_msg_fts.db') });

  // ---- group info ----
  const groupInfoDbPath = requireFile(dirPath, 'group_info.db');
  const groupEssence = new GroupEssenceDb(nt, { dbPath: groupInfoDbPath });
  const memberLevelInfo = new GroupMemberLevelInfoDb(nt, { dbPath: groupInfoDbPath });
  const groupDetail = new GroupDetailDb(nt, { dbPath: groupInfoDbPath });
  const groupBulletins = new GroupBulletinDb(nt, { dbPath: groupInfoDbPath });
  const groupMembers = new GroupMemberDb(nt, { dbPath: groupInfoDbPath });
  const groupNotifies = new GroupNotifyDb(nt, { dbPath: groupInfoDbPath });

  // ---- file assistant (may not exist) ----
  const fileAssistant = new FileAssistantDb(nt, { dbPath: join(dirPath, 'file_assistant.db') });

  // ---- profile ----
  const profileInfoPath = requireFile(dirPath, 'profile_info.db');
  const buddies = new BuddyDb(nt, { dbPath: profileInfoPath });
  const categories = new CategoryDb(nt, { dbPath: profileInfoPath });
  const buddyReqs = new BuddyRequestDb(nt, { dbPath: profileInfoPath });
  const profileInfo = new ProfileInfoDb(nt, { dbPath: profileInfoPath });

  // ---- misc ----
  const misc = new MiscDb(nt, { dbPath: join(dirPath, 'misc.db') });

  let disposed = false;
  return {
    context: {
      uin,
      dbKey: '',
      algo: { pageHmacAlgorithm: '', kdfHmacAlgorithm: '' },
    },
    msgDbPath,
    lastRowIdMaps: { c2cRowId: 0n, groupRowId: 0n, guildRowId: 0n },
    uidMap,
    c2cMsgs,
    groupMsgs,
    recentContacts,
    forwardMsgs,
    buddyMsgFts,
    groupMsgFts,
    groupEssence,
    memberLevelInfo,
    groupDetail,
    groupBulletins,
    groupMembers,
    groupNotifies,
    fileAssistant,
    buddies,
    categories,
    buddyReqs,
    profileInfo,
    misc,
    unreadInfo,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      c2cMsgs.close();
      groupMsgs.close();
      recentContacts.close();
      forwardMsgs.close();
      buddyMsgFts.close();
      groupMsgFts.close();
      groupEssence.close();
      memberLevelInfo.close();
      groupDetail.close();
      groupBulletins.close();
      groupMembers.close();
      groupNotifies.close();
      fileAssistant.close();
      buddies.close();
      categories.close();
      buddyReqs.close();
      profileInfo.close();
      misc.close();
      unreadInfo.close();
    },
  };
}
