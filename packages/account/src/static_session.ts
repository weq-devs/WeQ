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

import { basename, join } from 'node:path';
import { existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  C2cMsgDb,
  GroupMsgDb,
  RecentContactDb,
  RecentContactTopDb,
  HiddenSessionDb,
  DeletedSessionDb,
  ServiceAssistantContactDb,
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
  GroupExtDb,
  FileAssistantDb,
  CollectionDb,
  BuddyDb,
  CategoryDb,
  BuddyRequestDb,
  ProfileInfoDb,
  BotProfileDb,
  MiscDb,
  QqDb,
  UnreadInfoDb,
} from '@weq/db';
import type { DatabaseAlgorithms, NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';
import type { AccountSession } from './session';

function requireFile(dirPath: string, filename: string): string {
  const p = join(dirPath, filename);
  if (!existsSync(p)) {
    throw new Error(`${filename} not found in selected directory: ${dirPath}`);
  }
  return p;
}

function dbOpts(
  dbPath: string,
  dbKey?: string,
  algos?: Record<string, import('@weq/native').DatabaseAlgorithms>,
) {
  const algo = algos ? (algos[basename(dbPath)] ?? algos['nt_msg.db']) : undefined;
  return { dbPath, ...(dbKey ? { key: dbKey } : {}), ...(algo ? { algo } : {}) };
}

async function resolveAllAlgorithms(
  nt: NtHelperBinding,
  dbPaths: string[],
  dbKey?: string,
  algos?: Record<string, DatabaseAlgorithms>,
): Promise<Record<string, DatabaseAlgorithms>> {
  if (!dbKey) return algos ?? {};
  const resolved: Record<string, DatabaseAlgorithms> = { ...algos };
  await Promise.all(
    dbPaths.map(async (dbPath) => {
      if (!existsSync(dbPath)) return;
      const filename = basename(dbPath);
      if (resolved[filename]) return;
      const probe = await nt.testDatabaseKey(dbPath, dbKey);
      if (probe.success && probe.pageHmacAlgorithm && probe.kdfHmacAlgorithm) {
        resolved[filename] = {
          pageHmacAlgorithm: probe.pageHmacAlgorithm,
          kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
        };
      }
    }),
  );
  return resolved;
}

// ---- Android backup: derive the SQLCipher key from the directory itself ----

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

/**
 * 手机 QQ 的账号目录名是 `nt_qq_<md5(md5(uid) + "nt_kernel")>`，同一个
 * `md5(uid)` 换个盐就是 dbkey。所以只要拿到 uid 就能自己算出密钥。
 */
const DIR_SALT = 'nt_kernel';

/** QQ NT 在真正的 SQLite 页前面塞了 1024 字节自定义头。 */
const CUSTOM_HEADER_LEN = 1024;

/**
 * uid 不用猜 —— 安卓目录里有个 `gpro_v1-6_<uid>.db`，文件名直接带着它。
 * （PC 目录没有这个文件，所以这条路只对手机备份成立。）
 */
function findUidFromDirEntries(dirPath: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dirPath);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const m = /^gpro_v[\d-]+_(u_[A-Za-z0-9_-]+)\.db$/.exec(name);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * 从 nt_msg.db 的自定义头里取 8 字节 rand。安卓的 rand 是一段可打印
 * ASCII，紧跟在 `QQ_NT DB` 魔数后面的那一串；PC 的头结构不同（那里是一
 * 长串 hex），所以这里只认「魔数之后第一段正好 8 字节的可打印串」，
 * 认不出就返回 undefined 让调用方回退。
 */
function readHeaderRand(dbPath: string): string | undefined {
  const buf = Buffer.alloc(CUSTOM_HEADER_LEN);
  let fd: number;
  try {
    fd = openSync(dbPath, 'r');
  } catch {
    return undefined;
  }
  try {
    if (readSync(fd, buf, 0, CUSTOM_HEADER_LEN, 0) < CUSTOM_HEADER_LEN) return undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }

  const magicAt = buf.indexOf('QQ_NT DB', 0, 'ascii');
  if (magicAt < 0) return undefined;

  const ascii = [...buf]
    .map((b) => (b >= 0x21 && b < 0x7f ? String.fromCharCode(b) : '\0'))
    .join('');
  // 魔数之后的可打印串里，挑长度恰为 8 的那一段。安卓是 8 字节 rand；
  // PC 那串是 60+ 位 hex，长度不符会被跳过。
  for (const m of ascii.slice(magicAt + 8).matchAll(/[\x21-\x7e]+/g)) {
    if (m[0].length === 8) return m[0];
  }
  return undefined;
}

/**
 * 尝试为一个安卓备份目录直接算出 dbkey。算得出且能开库就返回它，
 * 任何一步不成立都返回 undefined —— 调用方回退到让用户手输。
 */
export async function deriveAndroidDbKey(
  nt: NtHelperBinding,
  dirPath: string,
): Promise<{ dbKey: string; algos: Record<string, DatabaseAlgorithms> } | undefined> {
  const uid = findUidFromDirEntries(dirPath);
  if (!uid) return undefined;

  const msgDbPath = join(dirPath, 'nt_msg.db');
  if (!existsSync(msgDbPath)) return undefined;

  const rand = readHeaderRand(msgDbPath);
  if (!rand) return undefined;

  const inner = md5(uid);
  // 目录名自校验：对不上说明这不是「uid 派生目录」的那套规则，别硬算。
  const dirName =
    dirPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  if (dirName.startsWith('nt_qq_') && dirName.slice(6) !== md5(inner + DIR_SALT)) {
    return undefined;
  }

  const dbKey = md5(inner + rand);
  const probe = await nt.testDatabaseKey(msgDbPath, dbKey);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) return undefined;

  return {
    dbKey,
    algos: {
      'nt_msg.db': {
        pageHmacAlgorithm: probe.pageHmacAlgorithm,
        kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
      },
    },
  };
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
  algos?: Record<string, DatabaseAlgorithms>,
): Promise<StaticSelfPreview> {
  const nt = platform.native.ntHelper;
  const profileInfoPath = requireFile(dirPath, 'profile_info.db');
  const resolvedAlgos = await resolveAllAlgorithms(nt, [profileInfoPath], dbKey, algos);
  // Probe via QqDb directly (not ProfileInfoDb) so we don't drag every
  // profile column through the codec pipeline just to read 3 fields.
  const qq = new QqDb(nt, dbOpts(profileInfoPath, dbKey, resolvedAlgos));
  try {
    // 1002 = uin, 20002 = nick, 1000 = uid. We intentionally do NOT read the
    // stored avatar (20004) — it's a chat-CDN token that only a live QQ can
    // complete, so it 404s for offline/static accounts. The UI builds a stable
    // avatar URL from the uin instead (see QqAvatar/qqAvatarUrl).
    // 20003 = lastUpdateTime; the account owner's row has the largest value.
    // The first row is NOT guaranteed to be self (other contacts appear before it
    // in some backups), so we ORDER BY 20003 DESC to find the correct self row.
    const rows = await qq.query(
      `SELECT "1000","1002","20002" FROM profile_info_v6 ORDER BY "20003" DESC LIMIT 1`,
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
      // Always empty for static accounts — UI derives the avatar from the uin.
      avatarUrl: '',
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
   * The native helper auto-probes the matching algorithms when `algos` is
   * omitted, so callers don't need to know the exact cipher params.
   */
  dbKey?: string;
  /**
   * Per-database SQLCipher algorithms, keyed by filename. Optional — when
   * omitted AND `dbKey` is provided, each database is probed individually.
   */
  algos?: Record<string, DatabaseAlgorithms>;
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
  const { dirPath, dbKey, algos, self } = options;
  const nt = platform.native.ntHelper;
  const uin = self.uin;

  // ---- core databases ----
  const msgDbPath = requireFile(dirPath, 'nt_msg.db');
  const groupInfoDbPath = requireFile(dirPath, 'group_info.db');
  const profileInfoPath = requireFile(dirPath, 'profile_info.db');

  // Probe each db file not already covered by the supplied algos map.
  const resolvedAlgos = await resolveAllAlgorithms(
    nt,
    [
      msgDbPath,
      groupInfoDbPath,
      profileInfoPath,
      join(dirPath, 'buddy_msg_fts.db'),
      join(dirPath, 'group_msg_fts.db'),
      join(dirPath, 'file_assistant.db'),
      join(dirPath, 'collection.db'),
      join(dirPath, 'misc.db'),
    ],
    dbKey,
    algos,
  );

  // probeAllAlgorithms throws when the key is wrong for the primary db; for
  // plain-SQLite folders dbKey is absent and we get an empty map — that's fine.
  if (dbKey && !resolvedAlgos['nt_msg.db']) {
    throw new Error('Database key is incorrect or the encryption parameters are unsupported');
  }

  const opts = (dbPath: string) => dbOpts(dbPath, dbKey, resolvedAlgos);

  const c2cMsgs = new C2cMsgDb(nt, opts(msgDbPath));
  // 数据线消息表结构同 c2c，复用 C2cMsgDb 只换表名。
  const datalineMsgs = new C2cMsgDb(nt, { ...opts(msgDbPath), table: 'dataline_msg_table' });
  const groupMsgs = new GroupMsgDb(nt, opts(msgDbPath));
  const recentContacts = new RecentContactDb(nt, opts(msgDbPath));
  const recentContactTops = new RecentContactTopDb(nt, opts(msgDbPath));
  const hiddenSessions = new HiddenSessionDb(nt, opts(msgDbPath));
  const deletedSessions = new DeletedSessionDb(nt, opts(msgDbPath));
  const serviceAssistantContacts = new ServiceAssistantContactDb(nt, opts(msgDbPath));
  // 服务号（118）消息表结构同 c2c，复用 C2cMsgDb 只换表名；分区键是 appId（40035）。
  const serviceAssistantMsgs = new C2cMsgDb(nt, { ...opts(msgDbPath), table: 'service_assistant_msg_table' });

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
  const groupInfoOpts = opts(groupInfoDbPath);
  const groupEssence = new GroupEssenceDb(nt, groupInfoOpts);
  const memberLevelInfo = new GroupMemberLevelInfoDb(nt, groupInfoOpts);
  const groupDetail = new GroupDetailDb(nt, groupInfoOpts);
  const groupBulletins = new GroupBulletinDb(nt, groupInfoOpts);
  const groupMembers = new GroupMemberDb(nt, groupInfoOpts);
  const groupNotifies = new GroupNotifyDb(nt, groupInfoOpts);
  const groupExt = new GroupExtDb(nt, groupInfoOpts);

  // ---- file assistant (may not exist) ----
  const fileAssistant = new FileAssistantDb(nt, opts(join(dirPath, 'file_assistant.db')));

  // ---- collection / 收藏 (may not exist) ----
  const collection = new CollectionDb(nt, opts(join(dirPath, 'collection.db')));

  // ---- profile ----
  const profileOpts = opts(profileInfoPath);
  const buddies = new BuddyDb(nt, profileOpts);
  const categories = new CategoryDb(nt, profileOpts);
  const buddyReqs = new BuddyRequestDb(nt, profileOpts);
  const profileInfo = new ProfileInfoDb(nt, profileOpts);
  const botProfiles = new BotProfileDb(nt, profileOpts);

  // ---- misc ----
  const misc = new MiscDb(nt, opts(join(dirPath, 'misc.db')));

  let disposed = false;
  return {
    context: {
      uin,
      dbKey: dbKey ?? '',
      algos: resolvedAlgos,
    },
    msgDbPath,
    lastRowIdMaps: { c2cRowId: 0n, groupRowId: 0n, guildRowId: 0n },
    uidMap,
    c2cMsgs,
    datalineMsgs,
    groupMsgs,
    recentContacts,
    recentContactTops,
    hiddenSessions,
    deletedSessions,
    serviceAssistantContacts,
    serviceAssistantMsgs,
    forwardMsgs,
    buddyMsgFts,
    groupMsgFts,
    groupEssence,
    memberLevelInfo,
    groupDetail,
    groupBulletins,
    groupMembers,
    groupNotifies,
    groupExt,
    fileAssistant,
    collection,
    buddies,
    categories,
    buddyReqs,
    profileInfo,
    botProfiles,
    misc,
    unreadInfo,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      c2cMsgs.close();
      datalineMsgs.close();
      groupMsgs.close();
      recentContacts.close();
      recentContactTops.close();
      hiddenSessions.close();
      deletedSessions.close();
      serviceAssistantContacts.close();
      serviceAssistantMsgs.close();
      forwardMsgs.close();
      buddyMsgFts.close();
      groupMsgFts.close();
      groupEssence.close();
      memberLevelInfo.close();
      groupDetail.close();
      groupBulletins.close();
      groupMembers.close();
      groupNotifies.close();
      groupExt.close();
      fileAssistant.close();
      collection.close();
      buddies.close();
      categories.close();
      buddyReqs.close();
      profileInfo.close();
      botProfiles.close();
      misc.close();
      unreadInfo.close();
    },
  };
}
