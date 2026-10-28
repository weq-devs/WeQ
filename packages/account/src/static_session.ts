/**
 * Static (offline) account session — opens a directory of locally-stored
 * QQ databases. Two flavors:
 *
 *   1. Already-decrypted plain SQLite (no key required)
 *   2. Still-encrypted SQLCipher databases (key + algorithm required)
 *
 * The UIN is NOT derived from the directory name — it is read from
 * the detected `profile_info_vN` table in `profile_info.db`, column `"1002"`. This
 * works for phone backups or third-party decrypted folders whose directory
 * names carry no reliable UIN.
 *
 * Same lifecycle as the online session: caller must `dispose()` before
 * opening another account to drop the cached native connections.
 */

import { basename, dirname, join } from 'node:path';
import { existsSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  C2cMsgDb,
  GroupMsgDb,
  RecentContactDb,
  RecentContactTopDb,
  SearchHistoryDb,
  HiddenSessionDb,
  DraftDb,
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
  GroupTodoDb,
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
  GuildDirectNodeDb,
  GuildDirectMsgDb,
  GuildCommonProfileDb,
  wrapBindingForSalvage,
  resolveProfileTableSchema,
} from '@weq/db';
import type { DatabaseAlgorithms, NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';
import type { AccountSession, AccountSalvageOptions } from './session';

function requireFile(dirPath: string, filename: string): string {
  const p = join(dirPath, filename);
  if (!existsSync(p)) {
    throw new Error(`${filename} not found in selected directory: ${dirPath}`);
  }
  return p;
}

function dbOpts(
  dbPath: string,
  key?: string,
  algos?: Record<string, import('@weq/native').DatabaseAlgorithms>,
) {
  const algo = algos ? (algos[basename(dbPath)] ?? algos['nt_msg.db']) : undefined;
  return { dbPath, ...(key ? { key } : {}), ...(algo ? { algo } : {}) };
}

async function resolveAllAlgorithms(
  nt: NtHelperBinding,
  dbPaths: string[],
  dbKey?: string,
  algos?: Record<string, DatabaseAlgorithms>,
  keyFor?: (dbPath: string) => string | undefined,
): Promise<Record<string, DatabaseAlgorithms>> {
  if (!dbKey) return algos ?? {};
  const resolved: Record<string, DatabaseAlgorithms> = { ...algos };
  await Promise.all(
    dbPaths.map(async (dbPath) => {
      if (!existsSync(dbPath)) return;
      const filename = basename(dbPath);
      if (resolved[filename]) return;
      const key = keyFor ? keyFor(dbPath) : dbKey;
      if (!key) return;
      const probe = await nt.testDatabaseKey(dbPath, key);
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

/** 安卓 QQ 频道库文件名：`gpro_v1-6_<uid>.db`（uid 直接写在文件名里）。 */
const GPRO_DB_RE = /^gpro_v[\d-]+_(u_[A-Za-z0-9_-]+)\.db$/;

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
    const m = GPRO_DB_RE.exec(name);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * QQ 频道「常用资料缓存」（t_GPro_CommonUserProfile_v2）的物理文件。
 * PC 端是 `guild1.db`；安卓备份里没有 `guild1.db`，同一张表放在同目录的
 * `gpro_v1-6_<uid>.db` 里。找不到时回退到 `guild1.db` 路径，保持原有的
 * 「文件缺失 → 查询侧惰性报错/容错」语义。
 */
function resolveGuildProfileCacheDb(dirPath: string): string {
  const guild1DbPath = join(dirPath, 'guild1.db');
  if (existsSync(guild1DbPath)) return guild1DbPath;
  try {
    const name = readdirSync(dirPath).find((n) => GPRO_DB_RE.test(n));
    if (name) return join(dirPath, name);
  } catch {
    // 目录不可读时交给后面的惰性报错。
  }
  return guild1DbPath;
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

/** 手机备份的目录布局：账号根下是 `nt_db/`（导出时可能被拍平成一层）。 */
function accountRootOf(dirPath: string): string {
  return basename(dirPath) === 'nt_db' ? dirname(dirPath) : dirPath;
}

/**
 * 安卓 `login.db` 的固定 pre-login 密钥。与 `@weq/service` 的
 * `LOGIN_DB_KEY` 是同一个值，这里单独抄一份只是为了让本包不必依赖 service
 * （account 是更底层的一层）。改动时两处一起改。
 */
const ANDROID_LOGIN_DB_KEY = 'BD156D6710D54D8782F4';

/** `login.db` 可能出现的相对位置：全局目录，或直接平铺在备份里。 */
const LOGIN_DB_SEGMENTS = [
  ['global', 'nt_db', 'login.db'],
  ['nt_qq', 'global', 'nt_db', 'login.db'],
  ['login.db'],
] as const;

/** 从给定根目录找 `login.db`；只做存在性检查，读不了就当没有。 */
function findLoginDbUnder(root: string): string | undefined {
  for (const segments of LOGIN_DB_SEGMENTS) {
    const candidate = join(root, ...segments);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // 目录不可读 / 文件不存在：继续看下一个候选。
    }
  }
  return undefined;
}

/** 一层层往上找 `login.db` 时最多回溯的层数（含账号根自身）。 */
const LOGIN_DB_ROOT_DEPTH = 3;

/** 从 `login.db` 里最多尝试的账号行数：给 KDF 探测留个上限。 */
const LOGIN_DB_MAX_ROWS = 8;

export interface AndroidKeyOptions {
  /** 已知 uin 时只认这个账号在 `login.db` 里的行。 */
  uin?: string;
  /**
   * 额外要尝试的 `login.db` 路径（调用方按平台数据根解析出的本机位置）。
   * 排在本备份目录自带的那份之后。
   */
  loginDbPaths?: string[];
}

/** 读一份 `login.db` 的 uid 列表；解不开 / 不是账号库时返回空表，绝不抛错。 */
async function loginDbUids(nt: NtHelperBinding, dbPath: string, uin?: string): Promise<string[]> {
  try {
    const probe = await nt.testDatabaseKey(dbPath, ANDROID_LOGIN_DB_KEY);
    if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) return [];
    const rows = nt.decryptLoginDb(dbPath, {
      pageHmacAlgorithm: probe.pageHmacAlgorithm,
      kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
    });
    const matched = rows.filter((row) => row.uid && (!uin || row.uin === uin));
    // 最近登录的账号更可能是这份备份的主人。
    matched.sort((a, b) => (b.lastLoginAt ?? 0) - (a.lastLoginAt ?? 0));
    return matched.slice(0, LOGIN_DB_MAX_ROWS).map((row) => row.uid);
  } catch {
    // login.db 解不开 / 不是账号库 / 原生抛错：当作没有这份来源。
    return [];
  }
}

/**
 * 手机备份里没有 `gpro_*.db` 时（用户只拷了数据库、或旧版备份没有频道库），
 * 退而求其次从 `login.db` 找 uid：先看备份目录自带的那份（账号根及其上两层，
 * 覆盖 `<导出>/nt_qq/global/nt_db/login.db` 这类布局），再看调用方给的本机
 * `login.db`。
 *
 * 任何失败（文件缺失、密钥探测失败、原生解密抛错、行里没有 uid）都静默跳过，
 * 绝不向外抛错，也不影响非手机备份的既有路径。
 */
async function findUidsFromLoginDb(
  nt: NtHelperBinding,
  dirPath: string,
  options: AndroidKeyOptions,
): Promise<string[]> {
  const paths: string[] = [];
  let root = accountRootOf(dirPath);
  const seen = new Set<string>();
  for (let depth = 0; depth < LOGIN_DB_ROOT_DEPTH; depth++) {
    if (seen.has(root)) break;
    seen.add(root);
    const found = findLoginDbUnder(root);
    if (found) paths.push(found);
    const parent = dirname(root);
    if (parent === root) break;
    root = parent;
  }
  for (const path of options.loginDbPaths ?? []) if (path) paths.push(path);

  const uids: string[] = [];
  const tried = new Set<string>();
  for (const path of paths) {
    if (tried.has(path)) continue;
    tried.add(path);
    for (const uid of await loginDbUids(nt, path, options.uin))
      if (!uids.includes(uid)) uids.push(uid);
    if (uids.length >= LOGIN_DB_MAX_ROWS) break;
  }
  return uids;
}

/**
 * 尝试为一个安卓备份目录直接算出 dbkey。算得出且能开库就返回它，
 * 任何一步不成立都返回 undefined —— 调用方回退到让用户手输。
 *
 * uid 优先取目录里的 `gpro_*.db` 文件名；没有时按 {@link AndroidKeyOptions}
 * 退到 `login.db` 的行里逐个试。两条路都要过「头部 rand」这一关（PC 库的头
 * 结构不同，读不出 8 字节 rand），所以不会改变非手机备份的行为。
 */
export async function deriveAndroidDbKey(
  nt: NtHelperBinding,
  dirPath: string,
  options: AndroidKeyOptions = {},
): Promise<{ dbKey: string; algos: Record<string, DatabaseAlgorithms> } | undefined> {
  const msgDbPath = join(dirPath, 'nt_msg.db');
  if (!existsSync(msgDbPath)) return undefined;

  // 先读 rand：读不出就说明这不是安卓备份的头，别去碰 login.db。
  const rand = readHeaderRand(msgDbPath);
  if (!rand) return undefined;

  const gproUid = findUidFromDirEntries(dirPath);
  const uids = gproUid ? [gproUid] : await findUidsFromLoginDb(nt, dirPath, options);
  if (!uids.length) return undefined;

  // 目录名自校验：账号目录叫 `nt_qq_<hash>` 时，hash 必须由这条 uid 派生出来，
  // 否则说明它不是「uid 派生目录」的那套规则，别硬算。
  const accountRoot = accountRootOf(dirPath);
  const dirName =
    accountRoot
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? '';
  for (const uid of uids) {
    const inner = md5(uid);
    if (dirName.startsWith('nt_qq_') && dirName.slice(6) !== md5(inner + DIR_SALT)) continue;
    const dbKey = md5(inner + rand);
    try {
      const probe = await nt.testDatabaseKey(msgDbPath, dbKey);
      if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) continue;
      return {
        dbKey,
        algos: {
          'nt_msg.db': {
            pageHmacAlgorithm: probe.pageHmacAlgorithm,
            kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
          },
        },
      };
    } catch {
      // 单个 uid 探测失败不影响其它候选。
    }
  }
  return undefined;
}

/**
 * Read the owner preview from the actual versioned profile table.
 * Throws on missing files / SQLCipher-without-key / bad schema so
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
  expectedUin?: string,
): Promise<StaticSelfPreview> {
  const nt = platform.native.ntHelper;
  const profileInfoPath = requireFile(dirPath, 'profile_info.db');
  const resolvedAlgos = await resolveAllAlgorithms(nt, [profileInfoPath], dbKey, algos);
  // Probe via QqDb directly (not ProfileInfoDb) so we don't drag every
  // profile column through the codec pipeline just to read 3 fields.
  const qq = new QqDb(nt, dbOpts(profileInfoPath, dbKey, resolvedAlgos));
  try {
    const schema = await resolveProfileTableSchema(qq);
    // 1002 = uin, 20002 = nick, 1000 = uid. We intentionally do NOT read the
    // stored avatar (20004) — it's a chat-CDN token that only a live QQ can
    // complete, so it 404s for offline/static accounts. The UI builds a stable
    // avatar URL from the uin instead (see QqAvatar/qqAvatarUrl).
    // 已通过同账号密钥确认身份时精确匹配；无身份提示时保留原有更新时间启发式。
    const rows = await qq.query(
      `SELECT "1000","1002","20002" FROM "${schema.table}" ${expectedUin ? 'WHERE "1002" = ?' : ''} ORDER BY ${schema.columns.has('20003') ? '"20003"' : '"1002"'} DESC LIMIT 1`,
      expectedUin ? [BigInt(expectedUin)] : [],
    );
    if (rows.length === 0 || rows[0] === undefined) {
      throw new Error('资料表中未找到目标账号，无法识别备份');
    }
    const row = rows[0];
    const uinRaw = row[1];
    const uin = uinRaw === null || uinRaw === undefined ? '' : String(uinRaw);
    if (!uin) throw new Error('资料表中未找到有效的 UIN');
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
  /**
   * 可选的损坏宽容（salvage）授权，语义与 `openAccount` 的同名参数完全一致。
   *
   * 静态账号也有**自己**的账号级设置：不传时读取与今天逐字节相同（严格），传了才
   * 可能在用户授权后换访问路径。注意它与在线账号**不是**同一份设置 —— 授权必须按账号
   * 算，否则「A 账号开了宽容」会顺带影响 B 账号。
   */
  salvage?: AccountSalvageOptions;
}

/**
 * Open a static (offline) account. Caller MUST supply `self` from
 * {@link peekStaticSelfUin} so we don't trust the directory name.
 */
export async function openStaticAccount(
  platform: Platform,
  options: OpenStaticAccountOptions,
): Promise<AccountSession> {
  const { dirPath, dbKey, algos, self, salvage } = options;
  // 与在线账号同一个包装（`wrapBindingForSalvage`）：级别 0 时是纯透传，所以不授权就是
  // 今天的行为；授权 ≥ 1 后，静态账号的读查询也走 salvage 通道。
  const nt = salvage
    ? wrapBindingForSalvage(platform.native.ntHelper, salvage)
    : platform.native.ntHelper;
  const uin = self.uin;

  // ---- core databases ----
  const msgDbPath = requireFile(dirPath, 'nt_msg.db');
  const groupInfoDbPath = requireFile(dirPath, 'group_info.db');
  const profileInfoPath = requireFile(dirPath, 'profile_info.db');

  // ---- guild (QQ 频道) physical files ----
  // 会话/消息表（direct_node_list_table / guild_msg_table）两端都在
  // guild_msg.db；资料缓存 t_GPro_CommonUserProfile_v2 在 PC 是 guild1.db，
  // 安卓备份里没有 guild1.db，同一张表放在同目录的 gpro_v1-6_<uid>.db。
  const guildMsgDbPath = join(dirPath, 'guild_msg.db');
  const guildProfileDbPath = resolveGuildProfileCacheDb(dirPath);
  // gpro 库（安卓 QQ 频道）的 SQLCipher 密钥独立于账号主密钥，按文件派生；
  // 其余库沿用账号主密钥；明文目录（无 dbKey）统一不开密钥。
  const guildKeyOf = (dbPath: string): string | undefined =>
    dbKey && basename(dbPath).startsWith('gpro_') ? nt.getGuildDbKey(dbPath, uin) : dbKey;

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
      guildMsgDbPath,
      guildProfileDbPath,
    ],
    dbKey,
    algos,
    guildKeyOf,
  );

  // probeAllAlgorithms throws when the key is wrong for the primary db; for
  // plain-SQLite folders dbKey is absent and we get an empty map — that's fine.
  if (dbKey && !resolvedAlgos['nt_msg.db']) {
    throw new Error('Database key is incorrect or the encryption parameters are unsupported');
  }

  const opts = (dbPath: string) => dbOpts(dbPath, guildKeyOf(dbPath), resolvedAlgos);
  const schemaDb = new QqDb(nt, opts(profileInfoPath));
  const profileSchema = await resolveProfileTableSchema(schemaDb).finally(() => schemaDb.close());

  const c2cMsgs = new C2cMsgDb(nt, opts(msgDbPath));
  // 数据线消息表结构同 c2c，复用 C2cMsgDb 只换表名。
  const datalineMsgs = new C2cMsgDb(nt, { ...opts(msgDbPath), table: 'dataline_msg_table' });
  const groupMsgs = new GroupMsgDb(nt, opts(msgDbPath));
  const recentContacts = new RecentContactDb(nt, opts(msgDbPath));
  const recentContactTops = new RecentContactTopDb(nt, opts(msgDbPath));
  const searchHistory = new SearchHistoryDb(nt, opts(msgDbPath));
  const hiddenSessions = new HiddenSessionDb(nt, opts(msgDbPath));

  const drafts = new DraftDb(nt, opts(msgDbPath));
  const deletedSessions = new DeletedSessionDb(nt, opts(msgDbPath));
  const serviceAssistantContacts = new ServiceAssistantContactDb(nt, opts(msgDbPath));
  // 服务号（118）消息表结构同 c2c，复用 C2cMsgDb 只换表名；分区键是 appId（40035）。
  const serviceAssistantMsgs = new C2cMsgDb(nt, {
    ...opts(msgDbPath),
    table: 'service_assistant_msg_table',
  });

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

  // ---- guild (QQ 频道); files may be absent for non-channel accounts ----
  const guildDirectNodes = new GuildDirectNodeDb(nt, opts(guildMsgDbPath));
  const guildDirectMsgs = new GuildDirectMsgDb(nt, opts(guildMsgDbPath));
  const guildCommonProfiles = new GuildCommonProfileDb(nt, opts(guildProfileDbPath));

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
  const groupTodos = new GroupTodoDb(nt, groupInfoOpts);

  // ---- file assistant (may not exist) ----
  const fileAssistant = new FileAssistantDb(nt, opts(join(dirPath, 'file_assistant.db')));

  // ---- collection / 收藏 (may not exist) ----
  const collection = new CollectionDb(nt, opts(join(dirPath, 'collection.db')));

  // ---- profile ----
  const profileOpts = opts(profileInfoPath);
  const buddies = new BuddyDb(nt, profileOpts);
  const categories = new CategoryDb(nt, profileOpts);
  const buddyReqs = new BuddyRequestDb(nt, profileOpts);
  const profileInfo = new ProfileInfoDb(nt, { ...profileOpts, schema: profileSchema });
  const botProfiles = new BotProfileDb(nt, profileOpts);

  // ---- misc ----
  const misc = new MiscDb(nt, opts(join(dirPath, 'misc.db')));

  // Same rule as the live session: resolve "my uid" from profile_info_v6 by
  // uin rather than trusting the caller-supplied preview, which is picked by a
  // heuristic (`ORDER BY 20003 DESC`) that mis-identifies the owner when the
  // table has ties. The preview stays as the fallback.
  let selfUid = '';
  try {
    selfUid = await profileInfo.getUidByUin(BigInt(uin));
  } catch (e) {
    console.error('[static-account] failed to resolve own uid from profile_info_v6:', e);
  }
  if (!selfUid) selfUid = self.uid ?? '';

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
    selfUid,
    c2cMsgs,
    datalineMsgs,
    groupMsgs,
    recentContacts,
    recentContactTops,
    searchHistory,
    hiddenSessions,
    drafts,
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
    groupTodos,
    fileAssistant,
    collection,
    buddies,
    categories,
    buddyReqs,
    profileInfo,
    botProfiles,
    misc,
    unreadInfo,
    guildDirectNodes,
    guildDirectMsgs,
    guildCommonProfiles,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      c2cMsgs.close();
      datalineMsgs.close();
      groupMsgs.close();
      recentContacts.close();
      recentContactTops.close();
      searchHistory.close();
      hiddenSessions.close();
      drafts.close();
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
      groupTodos.close();
      fileAssistant.close();
      collection.close();
      buddies.close();
      categories.close();
      buddyReqs.close();
      profileInfo.close();
      botProfiles.close();
      misc.close();
      unreadInfo.close();
      guildDirectNodes.close();
      guildDirectMsgs.close();
      guildCommonProfiles.close();
    },
  };
}
