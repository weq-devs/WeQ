/**
 * 妙妙工具 → 数据库修复 router。
 *
 * 与 `account` 路由的分工：那边是"当前打开账号"的读取链路，这边是**任意账号**的库
 * 维护 —— 修库的前提恰恰是 QQ（以及 WeQ）都不要持有它，所以不能挂在"必须有活动
 * 会话"的那套入口上，单独一个顶层 router（`client.dbRepair.*`）。
 *
 * 几个刻意的设计：
 *
 *   - **渲染层只传 uin（绝不传路径）**。目录、密钥、算法全部在这里用账号配置 +
 *     platform 解析后交给服务层；`dbName` 只接受纯文件名（服务层会挡 `..` 与分隔符）。
 *     这与 `account.clearSalvageQuarantine` 那条注释同一个道理：一旦接受路径，这里就
 *     变成了一个任意路径写入接口。
 *   - **能力检查放在真要用的时候**（`assertRecoverCapable`）：老平台的 `.node` 缺
 *     `recoverDatabase` 时报"去取产物"，而不是 `undefined is not a function`。
 *   - **进度走订阅**（与 `onAgentLabBuildProgress` 同一套 observable 模式）：一次修复
 *     约 5 秒、六个阶段，没有进度条用户会以为卡死。
 *   - **错误直接 throw**：tRPC 会把 `Error.message` 带回来，渲染层原样展示即可 ——
 *     服务层的每条错误都是照着"用户下一步该做什么"写的。
 */

import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { assertRecoverCapable } from '@weq/db';
import type { DatabaseAlgorithms, RecoverOptions } from '@weq/native';
import {
  ACCOUNT_HEALTH_DATABASES,
  DbRepairError,
  DbRepairService,
  getHost,
  getLogger,
  concludeCheckup,
  resolveAccountDbDir,
  scanDatabaseBadPages,
  type BadPageScanReport,
  type DbRepairAccountInfo,
  type DbRepairCheckup,
  type DbRepairDeps,
  type DbRepairErrorCode,
  type DbRepairPreflight,
  type DbRepairProgress,
  type DbRepairRecord,
  type DbRepairRestorePreview,
  type DbRepairTarget,
} from '@weq/service';
import {
  closeSalvageConnections,
  getAppContext,
  requireBootstrap,
  requirePlatform,
} from '../../context/app_context';
import { procedure, router } from '../trpc';

const logger = getLogger().child({ scope: 'db-repair' });

/** 结束 QQ 之后等锁释放的上限。 */
const KILL_WAIT_MS = 5000;
/** 轮询间隔。 */
const KILL_POLL_MS = 200;

/** 订阅推送的一条进度（带上"是哪一次修复"，面板据此过滤）。 */
export interface DbRepairTaskProgress extends DbRepairProgress {
  uin: string;
  dbName: string;
}

const progressBus = new EventEmitter();

/** 列表里一条记录的精简形状（列表不需要全部字段）。 */
export interface DbRepairRecordSummary {
  id: string;
  at: string;
  dbName: string;
  state: DbRepairRecord['state'];
  badPages: number[];
  durationMs: number;
  beforeBytes: number;
  afterBytes: number | null;
  strictPages: boolean;
  /** 失败/中止原因（`applied` 时没有）。 */
  error?: string;
  reportPath: string | null;
  /** 备份还在不在 —— 决定"回滚"能不能点。 */
  canRestore: boolean;
  purgedAt?: string;
}

/** 体检表里的一行。 */
export interface DbRepairDatabaseRow {
  dbName: string;
  dbPath: string;
  exists: boolean;
  bytes: number | null;
  /** 最近一次修复（没修过则为 null）。 */
  lastRecord: DbRepairRecordSummary | null;
}

/** 账号级的修复状态（面板首屏只发这一个请求）。 */
export interface DbRepairAccountStatus {
  uin: string;
  dataDir: string | null;
  /** 解析不出来时为空串（`error` 里说明原因）。 */
  dbDir: string;
  keyPresent: boolean;
  /** 该账号的 QQ pid（`resolveQqPid`）；离线为 null。 */
  qqPid: number | null;
  /** 当前跑着的 QQ 进程（"结束 QQ 进程"按钮用）。 */
  qqPids: number[];
  /** 是否有修复任务在跑（界面据此禁用按钮）。 */
  busy: boolean;
  databases: DbRepairDatabaseRow[];
  /** 解析账号失败的原因（数据库目录找不到 / 没配置）。 */
  error: string | null;
}

/**
 * 一次修复 / 回滚的结局。
 *
 * **失败也走返回值，而不是 throw**：失败分两类，界面的处置完全不同，而 "账号是否已经
 * 被关掉" 只有这里知道 ——
 *
 *   - 早期失败（预检被 QQ 挡、空间不够、没密钥、已有任务在跑）：还没动任何东西，
 *     源库与账号都是原样，界面只需弹一条 toast 让人改一下再试；
 *   - **替换阶段的失败**（替换前复核发现 QQ 又打开了库、`rename` 被占用挡住、自检
 *     不过）：此前那句话里的 `releaseHandles` **已经执行过了**（见
 *     `db_repair/service.ts` 的 repair 流程），也就是主进程里当前账号已经关了。此时
 *     渲染层还停在主界面上，是一个坏界面（会话列表在、头像没有、点不开消息）—— 必须
 *     把 `closedAccount` 带回去，界面才能把人送回首页重新打开。
 *
 * throw 只在"连服务都没进得去"的意外上（例如 product 代码里的 bug）；分类好的用户可见
 * 失败一律收在 `ok: false` 里，让渲染层永远有话说。
 */
export type DbRepairTaskResult =
  | {
      ok: true;
      record: DbRepairRecord;
      /** 替换前因为句柄被占而关掉了当前打开的账号 —— 完成后用户可重新打开。 */
      closedAccount: boolean;
    }
  | {
      ok: false;
      /** 分类后的原因（服务层同一套 `DbRepairErrorCode`）。 */
      code: DbRepairErrorCode;
      /** 已经是可以直接展示给用户的句子。 */
      error: string;
      /** **失败之前**是否已经关掉了当前打开的账号（见上面的长注释）。 */
      closedAccount: boolean;
    };

// ────────────────────────── 依赖装配 ──────────────────────────

/** 该 pid 是否属于 QQ（不给这个接口当"任意进程结束器"的机会）。 */
function isQqPid(pid: number): boolean {
  try {
    return requirePlatform().native.ntHelper.getQqProcesses().includes(pid);
  } catch {
    return false;
  }
}

/**
 * 同一个 uin 可能有多份账号配置（不同 `dataDir`，例如导入的静态备份）：优先挑**库真的
 * 在的那一份**，其次是 platform 能解析出目录的那一份。
 *
 * 目录解析本身在 `@weq/service` 的 `resolveAccountDbDir` 里（路径规则与"修哪个库"
 * 绑得太紧，必须能离线单测）。
 */
function resolveAccountInfo(uin: string): DbRepairAccountInfo | null {
  const boot = requireBootstrap();
  const platform = requirePlatform();
  const candidates: DbRepairAccountInfo[] = [];
  for (const config of boot.userConfig.listAccountConfigs()) {
    if (config.uin !== uin) continue;
    const dataDir = config.dataDir ?? null;
    const dbDir = resolveAccountDbDir(platform, uin, dataDir);
    if (!dbDir) continue;
    candidates.push({ dataDir, dbDir, dbKey: config.dbKey, algos: config.algos });
  }
  if (candidates.length === 0) return null;
  return candidates.find((info) => existsSync(join(info.dbDir, 'nt_msg.db'))) ?? candidates[0]!;
}

/** 本次任务里是否关掉过当前打开的账号（用于回一句"可以重新打开了"）。 */
let closedAccountDuringRun = false;

const deps: DbRepairDeps = {
  cacheDir: (...segments) => requireBootstrap().userConfig.cacheDir(join(...segments)),

  resolveAccount: (uin) => resolveAccountInfo(uin),

  probeLock: (dbPath) => {
    try {
      const probe = requirePlatform().native.ntHelper.probeDbLock(dbPath);
      return { success: probe.success, holders: probe.holders ?? [] };
    } catch (error) {
      // 探测失败 ≠ 没锁，所以把 success 报成 false，预检会落到 `unknown-lock`。
      logger.warn('probeDbLock failed', {
        event: 'db-repair-probe-lock-failed',
        dbPath,
        ...(error instanceof Error ? { error: error.message } : { error: String(error) }),
      });
      return { success: false, holders: [] };
    }
  },

  qqPid: (uin) => {
    try {
      return requirePlatform().resolveQqPid(uin);
    } catch {
      return null;
    }
  },

  /**
   * 替换前释放句柄。
   *
   * 修的就是当前打开的账号 → 整套关掉（`clearAccount()` 会 `dispose()` 掉每一个
   * `Db`，顺带停掉 watcher / 计划任务 / SSE / MCP / 助手）；宽容链路的只读连接不在
   * `dispose` 范围内，单独清一次。修的是别的账号 → 只关那一个库的连接。
   *
   * 顺序不能反：句柄不关，Windows 下 `rename` 会被占用挡住；Linux 下 `rename` 会
   * 成功但旧 inode 仍被占用，WeQ 会继续读旧内容。
   */
  releaseHandles: (uin, dbPath) => {
    const ctx = getAppContext();
    const platform = ctx.platform;
    if (!platform) return;
    const session = ctx.account;
    const sameAccount =
      session !== null &&
      session.context.uin === uin &&
      dirname(session.msgDbPath) === dirname(dbPath);
    try {
      if (sameAccount) {
        closeSalvageConnections(ctx);
        ctx.clearAccount();
        // `clearAccount` 会把会话里的每个 `Db` 都关掉，但**裸缓存的连接**（例如刚刚做
        // WAL 合并那条带密钥的写连接）不一定在它的范围内 —— 显式再关一次，Windows 上
        // 少一个 rename 被占用挡住的机会。
        platform.native.ntHelper.closeDb(dbPath);
        closedAccountDuringRun = true;
        logger.info('closed the open account before swapping the repaired database', {
          event: 'db-repair-closed-account',
          accountUin: uin,
        });
        return;
      }
      platform.native.ntHelper.closeSalvageDb(dbPath);
      platform.native.ntHelper.closeDb(dbPath);
    } catch (error) {
      // 关不掉也继续：真还被占用的话，替换那一步会失败，而源库不会被破坏。
      logger.warn('failed to release database handles before swapping', {
        event: 'db-repair-release-failed',
        dbPath,
        ...(error instanceof Error ? { error: error.message } : { error: String(error) }),
      });
    }
  },

  recover: (options: RecoverOptions, onProgress) => {
    const platform = requirePlatform();
    assertRecoverCapable(platform.native.ntHelper, '数据库修复');
    return platform.native.ntHelper.recoverDatabase(options, (error, progress) => {
      if (error) {
        // 进度投递失败不影响修复本身，记一条就够（别刷屏）。
        logger.debug('recover progress callback error', {
          event: 'db-repair-progress-error',
          error: error.message,
        });
        return;
      }
      onProgress(progress);
    });
  },

  /**
   * 把源库未合并的 WAL 合并回主文件（**不需要 QQ 参与**，用我们自己的带密钥连接）。
   *
   * 为什么不能拿现成的 `executeSqlWriteWithKey` 跑 `PRAGMA wal_checkpoint(TRUNCATE)`：
   *
   *   - 写接口走 rusqlite 的 `execute`，**拒绝任何会返回行的语句** —— 实测抛的是
   *     `Execute returned results - did you mean to call query?`，而这个 PRAGMA
   *     （FULL / TRUNCATE / PASSIVE 都一样）必然返回 `(busy, log, checkpointed)` 一行；
   *   - 读接口是只读连接，跑它得到 `disk I/O error` / `database table is locked`。
   *
   * 所以这里点名要 native 的 `checkpointWal`：产物里有就用；没有（旧产物）就把错误往
   * 上抛 —— 服务层会退回到"如实警告 + 清理 sidecar"，修复照常进行，不会被挡住。
   */
  checkpointWal: async (dbPath: string, key: string, algo: DatabaseAlgorithms) => {
    const binding = requirePlatform().native.ntHelper;
    if (typeof binding.checkpointWal !== 'function') {
      throw new Error(
        '当前 native 产物没有 checkpointWal，无法把未合并的 WAL 并回主文件（取到新产物后重试即可）',
      );
    }
    return binding.checkpointWal(dbPath, key, algo);
  },

  /** 替换后的额外复核：native 报告已含 integrity_check，这里再用健康检查确认一次。 */
  verify: async (dbPath: string, key: string, algo: DatabaseAlgorithms) => {
    const platform = requirePlatform();
    const health = await platform.native.ntHelper.checkDatabaseHealth(dbPath, key, algo);
    return { healthy: health.healthy, corruptedTables: health.corruptedTables };
  },
};

const service = new DbRepairService(deps);

// ────────────────────────── 展示用的小工具 ──────────────────────────

function summarize(record: DbRepairRecord): DbRepairRecordSummary {
  return {
    id: record.id,
    at: record.at,
    dbName: record.dbName,
    state: record.state,
    badPages: record.badPages,
    durationMs: record.durationMs,
    beforeBytes: record.beforeBytes,
    afterBytes: record.afterBytes,
    strictPages: record.strictPages,
    ...(record.error ? { error: record.error } : {}),
    reportPath: record.reportPath,
    canRestore: record.backupPath !== null && record.purgedAt === undefined,
    ...(record.purgedAt ? { purgedAt: record.purgedAt } : {}),
  };
}

function rowsFor(uin: string, dbDir: string): DbRepairDatabaseRow[] {
  // `listRecords` 最新在前，所以每个库的第一条就是最近一次。
  const latest = new Map<string, DbRepairRecord>();
  for (const record of service.listRecords(uin)) {
    if (!latest.has(record.dbName)) latest.set(record.dbName, record);
  }
  return ACCOUNT_HEALTH_DATABASES.map((dbName) => {
    const dbPath = join(dbDir, dbName);
    let bytes: number | null = null;
    try {
      bytes = existsSync(dbPath) ? statSync(dbPath).size : null;
    } catch {
      bytes = null;
    }
    const record = latest.get(dbName);
    return {
      dbName,
      dbPath,
      exists: bytes !== null,
      bytes,
      lastRecord: record ? summarize(record) : null,
    };
  });
}

/** 服务层的错误已经是给用户看的句子，直接让它往上传。 */
function rethrow(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

/** 把一次任务（修复 / 回滚）的失败收成返回值，并记一条日志。
 *
 * `closedAccount` 由调用方在 catch 里读 `closedAccountDuringRun` —— 那个变量是
 * `releaseHandles` 唯一会改动的东西，所以它精确回答"账号是不是已经被关了"。
 */
function failedResult(error: unknown, closedAccount: boolean, event: string): DbRepairTaskResult {
  const code: DbRepairErrorCode = error instanceof DbRepairError ? error.code : 'recover-failed';
  const message = error instanceof Error ? error.message : String(error);
  logger.warn('db repair task failed', {
    event,
    code,
    error: message,
    closedAccount,
  });
  return { ok: false, code, error: message, closedAccount };
}

/** 结构体检：`PRAGMA integrity_check`（native）。失败只当这一格没跑成。 */
async function runIntegrityCheck(target: DbRepairTarget): Promise<DbRepairCheckup['integrity']> {
  try {
    const health = await requirePlatform().native.ntHelper.checkDatabaseHealth(
      target.dbPath,
      target.key,
      target.algo,
    );
    return { ran: true, healthy: health.healthy, corruptedTables: health.corruptedTables };
  } catch (error) {
    return { ran: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 页级体检：坏页地图（native `scanBadPages` + `dbstat` 映射到对象）。 */
async function runPageMap(target: DbRepairTarget): Promise<DbRepairCheckup['pages']> {
  try {
    const report = await scanDatabaseBadPages(requirePlatform().native.ntHelper, {
      dbPath: target.dbPath,
      dbName: target.dbName,
      key: target.key,
      algo: target.algo,
    });
    return { ran: true, report };
  } catch (error) {
    return { ran: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const accountRef = z.object({ uin: z.string().min(1) });
const targetRef = accountRef.extend({ dbName: z.string().min(1) });
const recordRef = accountRef.extend({ recordId: z.string().min(1) });

// ────────────────────────── 路由 ──────────────────────────

export const dbRepairRouter = router({
  /**
   * 账号级状态 + 库体检表。
   *
   * 账号解析失败**不抛错**（面板只是打不开某一页，不该整个报错），而是把原因放在
   * `error` 里 —— 界面据此显示"先用 WeQ 打开一次该账号"这类指引。
   */
  status: procedure.input(accountRef).query(({ input }): DbRepairAccountStatus => {
    let info: DbRepairAccountInfo | null = null;
    let error: string | null = null;
    try {
      info = service.accountInfo(input.uin);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    let qqPids: number[] = [];
    let qqPid: number | null = null;
    try {
      const platform = requirePlatform();
      qqPids = platform.native.ntHelper.getQqProcesses();
      qqPid = platform.resolveQqPid(input.uin);
    } catch {
      qqPids = [];
      qqPid = null;
    }

    return {
      uin: input.uin,
      dataDir: info?.dataDir ?? null,
      dbDir: info?.dbDir ?? '',
      keyPresent: info ? info.dbKey !== '' : false,
      qqPid,
      qqPids,
      busy: service.isBusy(),
      databases: info ? rowsFor(input.uin, info.dbDir) : [],
      error,
    };
  }),

  /** 开修前的预检：锁 / 空间 / 密钥 / 已有备份。 */
  preflight: procedure.input(targetRef).query(({ input }): DbRepairPreflight => {
    try {
      return service.preflight(input.uin, input.dbName);
    } catch (error) {
      rethrow(error);
    }
  }),

  /**
   * 坏页扫描（从设置页搬过来，现在对**任意账号**可用）。
   *
   * 修复前先看清坏在哪、修完再对照，走的是同一份实现（`@weq/service` 的
   * `bad_pages`），所以两个入口的口径不会漂。
   */
  scanBadPages: procedure
    .input(targetRef)
    .mutation(async ({ input }): Promise<BadPageScanReport> => {
      const platform = requirePlatform();
      try {
        const target = service.resolveTarget(input.uin, input.dbName);
        return await scanDatabaseBadPages(platform.native.ntHelper, {
          dbPath: target.dbPath,
          dbName: input.dbName,
          key: target.key,
          algo: target.algo,
        });
      } catch (error) {
        rethrow(error);
      }
    }),

  /**
   * 体检一个库：结构（`PRAGMA integrity_check`，回答"坏不坏、哪张表"）+ 页级（坏页
   * 地图，回答"坏在哪些页、波及谁"）。
   *
   * 为什么要有这一条：面板上原本只有「开始修复」和一个标着"（可选）"的扫描 —— 等于在
   * 用户既不知道哪个库有问题、也不知道有没有问题的情况下，默认让他做一次**替换**。
   * 体检把"坏不坏、坏在哪"变成点一下就能看到的东西，修复才是一个有依据的选择；同时
   * 手动修某个库的路径仍然在（体检只是建议，不是门槛）。
   *
   * 两格检查各自失败各自报（见 `@weq/service` 的 `DbRepairCheckup`），结论由
   * `concludeCheckup` 一处算 —— 那段纯逻辑在 service 里，有离线单测守着。
   *
   * **只读**，但要整库读一遍（128MB 的 `nt_msg.db` 通常几秒），所以界面是逐个库调用、
   * 逐个库显示结果的 —— 一个慢库不会把其它库的结果一起扣着。
   */
  checkup: procedure.input(targetRef).mutation(async ({ input }): Promise<DbRepairCheckup> => {
    let target: DbRepairTarget;
    try {
      target = service.resolveTarget(input.uin, input.dbName);
    } catch (error) {
      rethrow(error);
    }

    let bytes = 0;
    try {
      bytes = statSync(target.dbPath).size;
    } catch {
      bytes = 0;
    }

    const integrity = await runIntegrityCheck(target);
    const pages = await runPageMap(target);
    const { verdict, summary } = concludeCheckup(integrity, pages);
    return {
      dbName: target.dbName,
      dbPath: target.dbPath,
      bytes,
      integrity,
      pages,
      verdict,
      summary,
    };
  }),

  /**
   * 结束挡住该库的 QQ 进程。
   *
   * 只接受**当前确实在跑的 QQ 主进程 pid**：渲染层传来的 pid 会在这里对照 native 的
   * 进程列表校验一遍，避免这个接口变成"任意进程结束器"。杀完等锁释放（最多
   * {@link KILL_WAIT_MS}），返回是否真的空闲了。
   */
  killQq: procedure
    .input(targetRef.extend({ pid: z.number().int().positive() }))
    .mutation(async ({ input }): Promise<{ released: boolean; waitedMs: number }> => {
      const platform = requirePlatform();
      if (!isQqPid(input.pid)) {
        throw new Error(`pid ${input.pid} 不是当前运行的 QQ 主进程，已拒绝结束它`);
      }

      let dbPath: string;
      try {
        dbPath = service.resolveTarget(input.uin, input.dbName).dbPath;
      } catch (error) {
        rethrow(error);
      }

      const started = Date.now();
      try {
        process.kill(input.pid);
      } catch (error) {
        throw new Error(
          `结束 QQ 进程失败（pid ${input.pid}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      for (;;) {
        const stillLocked = (() => {
          try {
            return (platform.native.ntHelper.probeDbLock(dbPath).holders?.length ?? 0) > 0;
          } catch {
            // 探测不到就当它已经释放：后面替换前还有一次复核。
            return false;
          }
        })();
        if (!stillLocked) {
          const waitedMs = Date.now() - started;
          logger.info('QQ killed and database lock released', {
            event: 'db-repair-kill-released',
            pid: input.pid,
            waitedMs,
          });
          return { released: true, waitedMs };
        }
        if (Date.now() - started >= KILL_WAIT_MS) {
          const waitedMs = Date.now() - started;
          logger.warn('QQ killed but database still locked', {
            event: 'db-repair-kill-timeout',
            pid: input.pid,
            waitedMs,
          });
          return { released: false, waitedMs };
        }
        await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
      }
    }),

  /** 修复记录（最新在前）。 */
  history: procedure.input(accountRef).query(({ input }): DbRepairRecordSummary[] => {
    try {
      return service.listRecords(input.uin).map(summarize);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** 回滚前复核：备份还在吗？修完之后库又被写过吗？ */
  restorePreview: procedure.input(recordRef).query(({ input }): DbRepairRestorePreview => {
    try {
      return service.restorePreview(input.uin, input.recordId);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** 手动备份（不修复，只留一份修复前的快照）。 */
  backup: procedure
    .input(targetRef)
    .mutation(({ input }): { path: string; bytes: number; sha256: string } => {
      try {
        return service.backup(input.uin, input.dbName);
      } catch (error) {
        rethrow(error);
      }
    }),

  /**
   * 跑一次修复。
   *
   * **这是长任务**（约 5 秒，大库更久）：进度通过 `onProgress` 订阅推送，这个
   * mutation 结束时返回结局（`ok: true` 带记录 / `ok: false` 带失败原因，见
   * {@link DbRepairTaskResult}）。默认先备份 —— 没有备份就没有"后悔"。
   */
  start: procedure
    .input(
      targetRef.extend({
        backup: z.boolean().optional(),
        /** 坏页先清零（内容一定经过校验，代价是那些行明确丢失）。 */
        strictPages: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<DbRepairTaskResult> => {
      closedAccountDuringRun = false;
      const platform = requirePlatform();
      try {
        assertRecoverCapable(platform.native.ntHelper, '数据库修复');
        const record = await service.repair(
          {
            uin: input.uin,
            dbName: input.dbName,
            ...(input.backup === undefined ? {} : { backup: input.backup }),
            ...(input.strictPages === undefined ? {} : { strictPages: input.strictPages }),
          },
          (progress) => {
            progressBus.emit('progress', {
              ...progress,
              uin: input.uin,
              dbName: input.dbName,
            } satisfies DbRepairTaskProgress);
          },
        );
        return { ok: true, record, closedAccount: closedAccountDuringRun };
      } catch (error) {
        return failedResult(error, closedAccountDuringRun, 'db-repair-start-failed');
      } finally {
        closedAccountDuringRun = false;
      }
    }),

  /**
   * 回滚到修复前。
   *
   * 修完之后库又被写过（QQ 进了新消息）时，服务层会拒绝并要求显式 `force` ——
   * 否则"后悔"会变成"丢消息"。界面先用 `restorePreview` 说明情况再让用户确认。
   *
   * 结局与 `start` 同一形状（失败走返回值，好把"账号已被关掉"带回去）。
   */
  restore: procedure
    .input(recordRef.extend({ force: z.boolean().optional() }))
    .mutation(({ input }): DbRepairTaskResult => {
      closedAccountDuringRun = false;
      try {
        const record = service.restore(input.uin, input.recordId, {
          ...(input.force === undefined ? {} : { force: input.force }),
        });
        return { ok: true, record, closedAccount: closedAccountDuringRun };
      } catch (error) {
        return failedResult(error, closedAccountDuringRun, 'db-repair-restore-failed');
      } finally {
        closedAccountDuringRun = false;
      }
    }),

  /** 删掉一条记录的备份（释放空间）；记录留着并标 `purgedAt`。 */
  deleteBackup: procedure.input(recordRef).mutation(({ input }): { removed: boolean } => {
    try {
      return service.deleteBackup(input.uin, input.recordId);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** 彻底删掉一条修复记录（连同它的备份）—— 用户主动不要这条历史了。 */
  deleteRecord: procedure.input(recordRef).mutation(({ input }): { removed: boolean } => {
    try {
      return service.deleteRecord(input.uin, input.recordId);
    } catch (error) {
      rethrow(error);
    }
  }),

  /** 打开某条记录的修复报告（在系统文件管理器里定位）。 */
  revealReport: procedure.input(recordRef).mutation(async ({ input }): Promise<{ ok: boolean }> => {
    try {
      const record = service.listRecords(input.uin).find((item) => item.id === input.recordId);
      if (!record?.reportPath) throw new DbRepairError('not-found', '这条记录没有报告文件');
      await getHost().revealInFolder(record.reportPath);
      return { ok: true };
    } catch (error) {
      rethrow(error);
    }
  }),

  /** 打开这份备份所在目录（用户想手动找回旧库时用）。 */
  revealBackup: procedure.input(recordRef).mutation(async ({ input }): Promise<{ ok: boolean }> => {
    try {
      const preview = service.restorePreview(input.uin, input.recordId);
      const backupPath = preview.record.backupPath;
      if (!preview.backupExists || !backupPath) {
        throw new DbRepairError('no-backup', '这条记录的备份已经不在了');
      }
      await getHost().revealInFolder(backupPath);
      return { ok: true };
    } catch (error) {
      rethrow(error);
    }
  }),

  /** 修复进度流（native 的六个阶段 + 备份 / 替换 / 完成三个自有阶段）。 */
  onProgress: procedure.subscription(() => {
    return observable<DbRepairTaskProgress>((emit) => {
      const handler = (progress: DbRepairTaskProgress): void => emit.next(progress);
      progressBus.on('progress', handler);
      return () => {
        progressBus.off('progress', handler);
      };
    });
  }),
});
