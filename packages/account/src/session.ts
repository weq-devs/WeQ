/**
 * `AccountContext` is intentionally *thin* — just the credentials and
 * resolved paths for one QQ account. It does NOT hold open db handles.
 *
 * The lifecycle object is `AccountSession`: handed a context, it opens
 * every db this account needs and exposes them as plain fields. Switch
 * accounts by `oldSession.dispose()` + `openAccount(ctx)` — there's no
 * shared mutable state between sessions.
 */

import { dirname, join } from 'node:path';
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
  BuddyDb,
  CategoryDb,
  BuddyRequestDb,
  ProfileInfoDb,
  MiscDb,
} from '@weq/db';
import type { Platform } from '@weq/platform';
import type { DatabaseAlgorithms } from '@weq/native';

export interface AccountContext {
  /** Account QQ number. */
  uin: string;
  /** SQLCipher key for this account's databases (hex passphrase). */
  dbKey: string;
  /** Cryptographic algorithms used for this account's databases. */
  algo: DatabaseAlgorithms;
}

/**
 * Highest SQLite rowid this session has already surfaced as a "new message",
 * per chat type. The file-watcher hook uses these as its "everything at or
 * below this rowid is old" baselines for the new-message notification signal.
 *
 * rowid (not msgId) because msgId is not monotonic in group chats — a gray-tip
 * row can carry a larger msgId than later real messages, so a msgId baseline
 * would silently swallow them. rowid increments on every insert, so it never
 * does.
 *
 * Mutable on purpose — the object identity is stable, only the fields move.
 * `0n` means "not yet initialized": the hook aligns to the current max rowid
 * on first observation instead of replaying the whole table.
 */
export interface LastRowIdMaps {
  /** Largest c2c (private-chat) rowid already surfaced. */
  c2cRowId: bigint;
  /** Largest group rowid already surfaced. */
  groupRowId: bigint;
  /** Largest guild rowid already surfaced. Reserved — not wired yet. */
  guildRowId: bigint;
}

/**
 * One live account. Holds opened Db instances. Caller must `dispose()`
 * before opening another account (or on app shutdown) to drop the cached
 * native connections.
 */
export interface AccountSession {
  readonly context: AccountContext;
  /** Absolute path to this account's `nt_msg.db` (what the file watcher mounts). */
  readonly msgDbPath: string;
  /**
   * Per-chat-type "newest rowid already surfaced" baselines, owned by the
   * file-watcher hook for the new-message notification signal. See
   * {@link LastRowIdMaps}.
   */
  readonly lastRowIdMaps: LastRowIdMaps;
  /**
   * Resident uid ↔ uin ↔ sortNo directory (nt_uid_mapping_table), loaded once
   * at session open. Used to translate a peer uid to its c2c partition number
   * (column 40027) so private-chat queries hit the composite index.
   */
  readonly uidMap: UidMap;
  /** Private-chat messages. */
  readonly c2cMsgs: C2cMsgDb;
  /** Group-chat messages. */
  readonly groupMsgs: GroupMsgDb;
  /** Recent-conversation list. */
  readonly recentContacts: RecentContactDb;
  /** Merged-forward / quote-reply cache (40900 column). */
  readonly forwardMsgs: ForwardMsgDb;
  /** Full-text-search index over message text (buddy_msg_fts.db). */
  readonly buddyMsgFts: BuddyMsgFtsDb;
  /** Full-text-search index over group message text (group_msg_fts.db). */
  readonly groupMsgFts: GroupMsgFtsDb;
  /** Group essential messages (group_info.db). */
  readonly groupEssence: GroupEssenceDb;
  /** Group member level information (group_info.db). */
  readonly memberLevelInfo: GroupMemberLevelInfoDb;
  /** Group detailed information (group_info.db). */
  readonly groupDetail: GroupDetailDb;
  /** Group announcements (group_info.db). */
  readonly groupBulletins: GroupBulletinDb;
  /** Group membership records (group_info.db). */
  readonly groupMembers: GroupMemberDb;
  /** Group notifications (group_info.db). */
  readonly groupNotifies: GroupNotifyDb;
  /** Buddy list (profile_info.db). */
  readonly buddies: BuddyDb;
  /** Buddy categories (profile_info.db). */
  readonly categories: CategoryDb;
  /** Buddy request notifications (profile_info.db). */
  readonly buddyReqs: BuddyRequestDb;
  /** Detailed user profiles (profile_info.db). */
  readonly profileInfo: ProfileInfoDb;
  /** Misc metadata (misc.db). */
  readonly misc: MiscDb;
  /** Close every db this session opened. Idempotent. */
  dispose(): void;
}

export async function openAccount(
  platform: Platform,
  ctx: AccountContext,
): Promise<AccountSession> {
  const msgDbPath = platform.ntMsgDbPath(ctx.uin);
  if (!msgDbPath) {
    throw new Error(`nt_msg.db not found for uin=${ctx.uin}`);
  }

  const c2cMsgs = new C2cMsgDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const groupMsgs = new GroupMsgDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const recentContacts = new RecentContactDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  // Load the uid ↔ uin ↔ sortNo directory once and keep it resident; the c2c
  // query path needs uid → sortNo (column 40027) translation on every call.
  // A failure here (e.g. table absent on an older QQ build) must NOT block
  // login — degrade to an empty map and let callers fall back.
  const uidMappingDb = new UidMappingDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });
  let uidMap: UidMap;
  try {
    uidMap = UidMap.from(await uidMappingDb.listAll());
  } catch (e) {
    console.error('[account] failed to load nt_uid_mapping_table — using empty uid map:', e);
    uidMap = UidMap.from([]);
  } finally {
    uidMappingDb.close();
  }

  const forwardMsgs = new ForwardMsgDb(platform.native.ntHelper, {
    dbPath: msgDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  // buddy_msg_fts.db sits next to nt_msg.db in the same nt_db folder. Trust
  // the platform lookup, but fall back to deriving it from msgDbPath so an
  // account whose index file isn't on disk yet still opens (search just errors
  // on first use rather than blocking the whole session).
  const ftsDbPath =
    platform.buddyMsgFtsDbPath(ctx.uin) ?? join(dirname(msgDbPath), 'buddy_msg_fts.db');

  const buddyMsgFts = new BuddyMsgFtsDb(platform.native.ntHelper, {
    dbPath: ftsDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const groupFtsDbPath =
    platform.groupMsgFtsDbPath(ctx.uin) ?? join(dirname(msgDbPath), 'group_msg_fts.db');

  const groupMsgFts = new GroupMsgFtsDb(platform.native.ntHelper, {
    dbPath: groupFtsDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const groupInfoDbPath =
    platform.groupInfoDbPath(ctx.uin) ?? join(dirname(msgDbPath), 'group_info.db');

  const groupEssence = new GroupEssenceDb(platform.native.ntHelper, {
    dbPath: groupInfoDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const memberLevelInfo = new GroupMemberLevelInfoDb(platform.native.ntHelper, {
    dbPath: groupInfoDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const groupDetail = new GroupDetailDb(platform.native.ntHelper, {
    dbPath: groupInfoDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const groupBulletins = new GroupBulletinDb(platform.native.ntHelper, {
    dbPath: groupInfoDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const groupMembers = new GroupMemberDb(platform.native.ntHelper, {
    dbPath: groupInfoDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const groupNotifies = new GroupNotifyDb(platform.native.ntHelper, {
    dbPath: groupInfoDbPath,
    key: ctx.dbKey,
    algo: ctx.algo,
  });

  const profileInfoPath = platform.profileInfoDbPath(ctx.uin);
  if (!profileInfoPath) throw new Error(`profile_info.db not found for uin ${ctx.uin}`);
  const buddies = new BuddyDb(platform.native.ntHelper, { dbPath: profileInfoPath, key: ctx.dbKey, algo: ctx.algo });
  const categories = new CategoryDb(platform.native.ntHelper, { dbPath: profileInfoPath, key: ctx.dbKey, algo: ctx.algo });
  const buddyReqs = new BuddyRequestDb(platform.native.ntHelper, { dbPath: profileInfoPath, key: ctx.dbKey, algo: ctx.algo });
  const profileInfo = new ProfileInfoDb(platform.native.ntHelper, { dbPath: profileInfoPath, key: ctx.dbKey, algo: ctx.algo });

  const miscDbPath = platform.miscDbPath(ctx.uin) ?? join(dirname(msgDbPath), 'misc.db');
  const misc = new MiscDb(platform.native.ntHelper, { dbPath: miscDbPath, key: ctx.dbKey, algo: ctx.algo });

  let disposed = false;
  return {
    context: ctx,
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
    buddies,
    categories,
    buddyReqs,
    profileInfo,
    misc,
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
      buddies.close();
      categories.close();
      buddyReqs.close();
      profileInfo.close();
      misc.close();
      // Future db instances close here too.
    },
  };
}
