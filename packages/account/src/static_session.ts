/**
 * Static (offline) account session — opens a directory of locally-stored
 * QQ databases. Two flavors:
 *
 *   1. Already-decrypted plain SQLite (no key required)
 *   2. Still-encrypted SQLCipher databases (key + algorithm required)
 *
 * The UIN is NOT derived from the directory name — it is read from
 * `profile_info.db → profile_info_v6`'s first row, column `"1002"`. This
 * works for phone backups or third-party decrypted folders whose directory
 * names carry no reliable UIN.
 *
 * Same lifecycle as the online session: caller must `dispose()` before
 * opening another account to drop the cached native connections.
 */

import { join } from 'node:path';
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
  QqDb,
  UnreadInfoDb,
} from '@weq/db';
import type { DatabaseAlgorithms } from '@weq/native';
import type { Platform } from '@weq/platform';
import type { AccountSession } from './session';

function requireFile(dirPath: string, filename: string): string {
  const p = join(dirPath, filename);
  if (!existsSync(p)) {
    throw new Error(`${filename} not found in selected directory: ${dirPath}`);
  }
  return p;
}

function dbOpts(profileInfoPath: string, dbKey?: string, algo?: DatabaseAlgorithms) {
  return { dbPath: profileInfoPath, ...(dbKey ? { key: dbKey } : {}), ...(algo ? { algo } : {}) };
}

/**
 * Read the self row from `profile_info_v6` (the first row is the account
 * owner). Throws on missing files / SQLCipher-without-key / bad schema so
 * the caller can show a friendly "needs key" prompt.
 */
export interface StaticSelfPreview {
  uin: string;
  nick: string;
  avatarUrl: string;
  uid: string;
}

export async function peekStaticSelfUin(
  platform: Platform,
  dirPath: string,
  dbKey?: string,
  algo?: DatabaseAlgorithms,
): Promise<StaticSelfPreview> {
  const nt = platform.native.ntHelper;
  const profileInfoPath = requireFile(dirPath, 'profile_info.db');
  // Probe via QqDb directly (not ProfileInfoDb) so we don't drag every
  // profile column through the codec pipeline just to read 4 fields.
  const qq = new QqDb(nt, dbOpts(profileInfoPath, dbKey, algo));
  try {
    // 1002 = uin, 20002 = nick, 20004 = avatarUrl, 1000 = uid
    // First row of profile_info_v6 is always the account owner.
    const rows = await qq.query(
      `SELECT "1000","1002","20002","20004" FROM profile_info_v6 LIMIT 1`,
    );
    if (rows.length === 0 || rows[0] === undefined) {
      throw new Error('profile_info_v6 为空，无法识别账号');
    }
    const row = rows[0];
    const uinRaw = row[1];
    const uin = uinRaw === null || uinRaw === undefined ? '' : String(uinRaw);
    if (!uin) throw new Error('profile_info_v6 中未找到有效的 UIN');
    return {
      uin,
      uid: String(row[0] ?? ''),
      nick: String(row[2] ?? ''),
      avatarUrl: String(row[3] ?? ''),
    };
  } finally {
    qq.close();
  }
}

export interface OpenStaticAccountOptions {
  /** Path to the directory containing the QQ .db files. */
  dirPath: string;
  /**
   * SQLCipher key. Omit / leave blank for plain (already-decrypted) SQLite.
   * The native helper auto-probes the matching algorithms when `algo` is
   * omitted, so callers don't need to know the exact cipher params.
   */
  dbKey?: string;
  /**
   * Resolved SQLCipher algorithms. Optional — when omitted AND `dbKey` is
   * provided, the native helper is asked to probe them.
   */
  algo?: DatabaseAlgorithms;
  /**
   * Pre-resolved self preview. Required — the directory name is not used as
   * a UIN fallback. Run {@link peekStaticSelfUin} first to obtain it.
   */
  self: StaticSelfPreview;
}

/**
 * Open a static (offline) account. Caller MUST supply `self` from
 * {@link peekStaticSelfUin} so we don't trust the directory name.
 */
export async function openStaticAccount(
  platform: Platform,
  options: OpenStaticAccountOptions,
): Promise<AccountSession> {
  const { dirPath, dbKey, algo, self } = options;
  const nt = platform.native.ntHelper;
  const uin = self.uin;
  const opts = (dbPath: string) => dbOpts(dbPath, dbKey, algo);

  // ---- core databases ----
  const msgDbPath = requireFile(dirPath, 'nt_msg.db');

  const c2cMsgs = new C2cMsgDb(nt, opts(msgDbPath));
  const groupMsgs = new GroupMsgDb(nt, opts(msgDbPath));
  const recentContacts = new RecentContactDb(nt, opts(msgDbPath));

  // Load the uid ↔ uin ↔ sortNo directory.
  const uidMappingDb = new UidMappingDb(nt, opts(msgDbPath));
  let uidMap: UidMap;
  try {
    uidMap = UidMap.from(await uidMappingDb.listAll());
  } catch (e) {
    console.error('[static-account] failed to load nt_uid_mapping_table — using empty uid map:', e);
    uidMap = UidMap.from([]);
  } finally {
    uidMappingDb.close();
  }

  const forwardMsgs = new ForwardMsgDb(nt, opts(msgDbPath));
  const unreadInfo = new UnreadInfoDb(nt, opts(msgDbPath));

  // ---- full-text-search indexes (may not exist; search will fail gracefully) ----
  const buddyMsgFts = new BuddyMsgFtsDb(nt, opts(join(dirPath, 'buddy_msg_fts.db')));
  const groupMsgFts = new GroupMsgFtsDb(nt, opts(join(dirPath, 'group_msg_fts.db')));

  // ---- group info ----
  const groupInfoDbPath = requireFile(dirPath, 'group_info.db');
  const groupInfoOpts = opts(groupInfoDbPath);
  const groupEssence = new GroupEssenceDb(nt, groupInfoOpts);
  const memberLevelInfo = new GroupMemberLevelInfoDb(nt, groupInfoOpts);
  const groupDetail = new GroupDetailDb(nt, groupInfoOpts);
  const groupBulletins = new GroupBulletinDb(nt, groupInfoOpts);
  const groupMembers = new GroupMemberDb(nt, groupInfoOpts);
  const groupNotifies = new GroupNotifyDb(nt, groupInfoOpts);

  // ---- file assistant (may not exist) ----
  const fileAssistant = new FileAssistantDb(nt, opts(join(dirPath, 'file_assistant.db')));

  // ---- profile ----
  const profileInfoPath = requireFile(dirPath, 'profile_info.db');
  const profileOpts = opts(profileInfoPath);
  const buddies = new BuddyDb(nt, profileOpts);
  const categories = new CategoryDb(nt, profileOpts);
  const buddyReqs = new BuddyRequestDb(nt, profileOpts);
  const profileInfo = new ProfileInfoDb(nt, profileOpts);

  // ---- misc ----
  const misc = new MiscDb(nt, opts(join(dirPath, 'misc.db')));

  let disposed = false;
  return {
    context: {
      uin,
      dbKey: dbKey ?? '',
      algo: algo ?? { pageHmacAlgorithm: '', kdfHmacAlgorithm: '' },
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
