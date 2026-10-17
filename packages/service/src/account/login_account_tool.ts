/**
 * QQ 登陆账号管理 —— `login.db` 的**写**侧。
 *
 * `bootstrap/login_db.ts` 只读（解密出行），这里负责用户能感知的三件事：
 *
 *   1. **移除快登**：把 `login_table.[1004]`（缓存的 A1 凭据）清成 NULL。
 *      QQ 下次启动时这个号不再出现在快速登录列表里，要重新输密码 / 扫码。
 *   2. **删除账号（真删）**：把 `login_table` 里那一行整行删掉 —— 不是隐藏，
 *      是 QQ 自己都读不到了。账号目录 / 聊天记录**不动**（那是另一个数量级的
 *      操作，不该藏在一个"清理登录列表"的按钮后面）。
 *   3. **随机更换设备 guid**：交给 native（`writeDeviceGuid`），三端各自改写自己
 *      那份设备标识来源。换完 guid，服务端会把本机当成新设备。
 *
 * 为什么整个模块的写操作都要先确认「没有 QQ 在跑」：`login.db` 与 msf 下的设备
 * 标识文件都是 QQ 自己读写并常驻内存的，QQ 在线时改完会被它覆盖回去（Windows 的
 * 硬件回退甚至会立刻重写自己的缓存）。进程检查由上层（`probeOnline` 的实例数
 * 探测）做，这里只声明契约。
 *
 * 写库本身走 native 的 `executeSqlWriteWithKey`：offset VFS 直接改密文，不落
 * 临时明文文件。密钥是固定的 pre-login key，算法对每个库单独 probe 一次。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import { darwinAccountDirName, linuxAccountDirName } from '@weq/platform';
import type { DatabaseAlgorithms, NtHelperBinding, SqlValue } from '@weq/native';
import { LOGIN_DB_KEY } from '../bootstrap/login_db';
import { getLogger, logErrorContext } from '../common/logger';

const logger = getLogger().child({ scope: 'login-account-tool' });

/** `login.db` 的行表；每行 = 一个在这台机器登录过的账号。 */
const LOGIN_TABLE = 'login_table';
/** `[1000]` = uin（INTEGER PRIMARY KEY）。 */
const UIN_COLUMN = '1000';
/** `[1004]` = 缓存的 A1 凭据（BLOB）。 */
const A1_COLUMN = '1004';

/** 列顺序与 {@link LoginAccountEntry} 的字段一一对应。 */
const SELECT_SQL = `SELECT "${UIN_COLUMN}", "1001", "1002", "1007", "${A1_COLUMN}", "1008" FROM ${LOGIN_TABLE}`;

/** 管理面板里的一行（= 一个在 login.db 里出现过的账号）。 */
export interface LoginAccountEntry {
  /** QQ 号（十进制串）。 */
  uin: string;
  /** 长 uid（`u_...`）；linux 的账号目录由它派生。 */
  uid: string;
  /** 账号在 QQ 里设的显示名。 */
  userName: string;
  /** 缓存的头像 URL（CDN，可能已 404）。 */
  avatarUrl: string;
  /** 最后登录时间（unix 秒）；0 = 从没登录成功过。 */
  lastLoginAt: number;
  /** `[1004]` 是否有内容 —— 有就是「快速登录账号」。 */
  hasA1: boolean;
  /** `[1004]` 的字节数（0 = 没有缓存）。 */
  a1Bytes: number;
  /** 账号数据目录；null = 本机只有登录记录、数据目录已经不在了。 */
  dataDir: string | null;
  /** 这个账号出现在哪些 login.db 文件里（linux 有两处）。 */
  dbPaths: string[];
}

/** guid 变更 / A1 删除后，对 WeQ 自己那份配置要做的事。 */
export interface LoginAccountSyncHooks {
  /**
   * 设备 guid 变了。WeQ 把 guid 存进每个账号配置（发包身份用），必须跟着换；
   * 同时按旧 guid 解出来的 A1 payload 缓存也要作废（`[1004]` 是用旧 guid
   * 加密的，新 guid 解不开）。
   */
  onGuidRotated(newGuid: string): void;
  /** 某账号的 A1 被清掉：WeQ 缓存的 A1 payload 同步作废。 */
  onA1Removed(uin: string): void;
  /** 某账号被真删：WeQ 里那份本地账号配置一并清掉。 */
  onAccountRemoved(uin: string): void;
}

export interface LoginAccountToolDeps {
  nt: Pick<
    NtHelperBinding,
    | 'testDatabaseKey'
    | 'executeSqlWithKey'
    | 'executeSqlWriteWithKey'
    | 'closeDb'
    | 'readDeviceGuid'
    | 'writeDeviceGuid'
  >;
  /** 全部 login.db（linux 是主 + 辅两处），顺序即优先级。 */
  loginDbPaths: string[];
  /** QQ 数据根（`readDeviceGuid` / `writeDeviceGuid` 的入参）。 */
  dataRoot: string | null;
  /**
   * 账号数据目录解析（只用来展示"数据还在不在"，可选）。
   *
   * 带上 `uid` 是因为 linux / macOS 的目录名由它派生（`nt_qq_<hash>`），而
   * uid 只存在 `login.db` 里 —— 上层若只按 uin 找（走 WeQ 已保存的账号配置），
   * 一个从没在 WeQ 里打开过的号会被误判成"目录已删"。
   */
  accountDir?: (uin: string, uid: string) => string | null;
  /** WeQ 自身配置的同步钩子；不给就只改 QQ 那边（测试用）。 */
  sync?: LoginAccountSyncHooks;
}

/** 一次写操作的结论。 */
export interface LoginAccountWriteResult {
  /** 真正被改动的 login.db 文件数。 */
  changedFiles: number;
  /** 被改动的行数。 */
  changedRows: number;
}

/**
 * 解析某个账号的数据目录，用于界面上「目录还在不在」这一行。
 *
 * linux / macOS 的目录名是 `nt_qq_<md5(md5(uid)+"nt_kernel")>`，而平台层的
 * `accountDir(uin)` 要经 WeQ 已保存的账号配置把 uin 翻成 uid —— 一个从没在
 * WeQ 里打开过的号会因此被判成"目录已不存在"。`login.db` 的每一行都自带 uid，
 * 所以这里先用它现算目录名；命中就返回，没命中再退回平台解析（账号可能落在
 * 用户另选的 Tencent Files 目录里）。
 *
 * win32 的目录名就是 uin，没有这个问题，直接走平台。
 */
export function resolveLoginAccountDir(
  platform: Platform,
  uin: string,
  uid: string,
): string | null {
  if (uid && (platform.kind === 'linux' || platform.kind === 'darwin')) {
    const dirName =
      platform.kind === 'linux' ? linuxAccountDirName(uid) : darwinAccountDirName(uid);
    // 候选根按 override → 默认顺序，和平台自己的 firstExistingUnderAccount 一致。
    for (const root of platform.tencentFilesRoots()) {
      const candidate = join(root, dirName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return platform.accountDir(uin);
}

/** 字符串化一个 SQL 值（uin / uid / 名字这些文本列）。 */
function toText(value: SqlValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return String(value);
}

function toNumber(value: SqlValue): number {
  if (value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class LoginAccountToolService {
  constructor(private readonly deps: LoginAccountToolDeps) {}

  /** 每个库的密码算法（页面 HMAC / KDF HMAC 组合）逐文件 probe，失败跳过。 */
  private async resolveAlgo(dbPath: string): Promise<DatabaseAlgorithms | null> {
    try {
      const probe = await this.deps.nt.testDatabaseKey(dbPath, LOGIN_DB_KEY);
      if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
        logger.warn('login.db probe did not yield algorithms', {
          event: 'login-account-probe-unsuccessful',
          dbPath,
        });
        return null;
      }
      return {
        pageHmacAlgorithm: probe.pageHmacAlgorithm,
        kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
      };
    } catch (error) {
      logger.warn('login.db probe threw', {
        event: 'login-account-probe-failed',
        dbPath,
        ...logErrorContext(error),
      });
      return null;
    }
  }

  /** 全部历史账号（跨 login.db 按 uin 合并，先出现的路径优先）。 */
  async list(): Promise<LoginAccountEntry[]> {
    const merged = new Map<string, LoginAccountEntry>();
    for (const dbPath of this.deps.loginDbPaths) {
      const algo = await this.resolveAlgo(dbPath);
      if (!algo) continue;
      let rows: SqlValue[][];
      try {
        rows = await this.deps.nt.executeSqlWithKey(dbPath, SELECT_SQL, LOGIN_DB_KEY, algo);
      } catch (error) {
        logger.warn('login.db row query failed', {
          event: 'login-account-query-failed',
          dbPath,
          ...logErrorContext(error),
        });
        continue;
      }
      for (const row of rows) {
        const uin = toText(row[0] ?? null);
        if (!uin) continue;
        const a1 = row[4] ?? null;
        const a1Bytes = a1 === null ? 0 : a1 instanceof Uint8Array ? a1.byteLength : 0;
        const existing = merged.get(uin);
        if (existing) {
          existing.dbPaths.push(dbPath);
          continue;
        }
        const uid = toText(row[1] ?? null);
        merged.set(uin, {
          uin,
          uid,
          avatarUrl: toText(row[2] ?? null),
          userName: toText(row[3] ?? null),
          hasA1: a1Bytes > 0,
          a1Bytes,
          lastLoginAt: toNumber(row[5] ?? null),
          dataDir: this.deps.accountDir?.(uin, uid) ?? null,
          dbPaths: [dbPath],
        });
      }
    }
    // 最近登录的排前面 —— 与 QQ 自己的快速登录列表顺序一致。
    return [...merged.values()].sort((a, b) => b.lastLoginAt - a.lastLoginAt);
  }

  /** 本机设备 guid（离线读，不需要权限）。 */
  readGuid(): string | null {
    const root = this.deps.dataRoot;
    if (!root) return null;
    try {
      return this.deps.nt.readDeviceGuid(root) ?? null;
    } catch (error) {
      logger.warn('read device guid failed', {
        event: 'login-account-read-guid-failed',
        ...logErrorContext(error),
      });
      return null;
    }
  }

  /** 对一个账号在**每个** login.db 上跑同一条写语句。 */
  private async writeAll(sql: string, uin: string): Promise<LoginAccountWriteResult> {
    const result: LoginAccountWriteResult = { changedFiles: 0, changedRows: 0 };
    for (const dbPath of this.deps.loginDbPaths) {
      const algo = await this.resolveAlgo(dbPath);
      if (!algo) continue;
      try {
        const rows = await this.deps.nt.executeSqlWriteWithKey(dbPath, sql, LOGIN_DB_KEY, algo, [
          uin,
        ]);
        if (rows > 0) {
          result.changedFiles++;
          result.changedRows += rows;
        }
      } catch (error) {
        logger.warn('login.db write failed', {
          event: 'login-account-write-failed',
          dbPath,
          ...logErrorContext(error),
        });
      }
    }
    return result;
  }

  /** 移除快登：清掉该账号缓存的 A1（`[1004]`）。 */
  async removeQuickLogin(uin: string): Promise<LoginAccountWriteResult> {
    const result = await this.writeAll(
      `UPDATE ${LOGIN_TABLE} SET "${A1_COLUMN}" = NULL WHERE "${UIN_COLUMN}" = ?`,
      uin,
    );
    if (result.changedRows > 0) {
      this.deps.sync?.onA1Removed(uin);
      logger.info('removed cached a1', {
        event: 'login-account-a1-removed',
        accountUin: uin,
        files: result.changedFiles,
      });
    }
    return result;
  }

  /**
   * 真删账号：把这一行从 login.db 删掉。
   *
   * **只动登录记录**：账号目录（聊天记录 / 媒体）留在原地。这个按钮的语义是
   * "这台机器上别再出现这个号"，不是"把数据铲掉"。
   */
  async deleteAccount(uin: string): Promise<LoginAccountWriteResult> {
    const result = await this.writeAll(`DELETE FROM ${LOGIN_TABLE} WHERE "${UIN_COLUMN}" = ?`, uin);
    if (result.changedRows > 0) {
      this.deps.sync?.onAccountRemoved(uin);
      logger.info('deleted login account row', {
        event: 'login-account-deleted',
        accountUin: uin,
        files: result.changedFiles,
      });
    }
    return result;
  }

  /**
   * 随机换一个设备 guid，并同步 WeQ 自己的配置。
   *
   * 返回新 guid；native 说"这个根下没有可改写的来源"时返回 null。**调用前**
   * 必须已经确认没有 QQ 实例在跑（由上层把关）。
   */
  async rotateGuid(): Promise<string | null> {
    const root = this.deps.dataRoot;
    if (!root) throw new Error('没有解析出 QQ 数据根路径，无法更换设备 guid。');
    const write = this.deps.nt.writeDeviceGuid;
    if (typeof write !== 'function') {
      throw new Error('当前原生产物不支持更换设备 guid，请更新 nt_helper 产物后重试。');
    }
    const next = write.call(this.deps.nt, root);
    if (!next) return null;
    this.deps.sync?.onGuidRotated(next);
    logger.info('rotated device guid', { event: 'login-account-guid-rotated' });
    return next;
  }
}
