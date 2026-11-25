/**
 * 数据库重建与提交：消费已完成的常规扫描 → 备份 → 临时重建 → 替换 → 自检 → 记录。
 *
 * 账号级扫描及持续锁归 `maintenance.ts`。生产入口必须持有同一数据源的维护锁，
 * 不再扫描源库或以持续正常变化使扫描失效。备份指纹仍用于记录与恢复。
 * 原生重建在可停止的子进程中执行；提交期间可以撤销本库替换。
 * 产物位于原库卷的本次专用目录，先转接维护锁再原子替换，保留原库直到复核结束。
 * 正常维护仅失效连接缓存，保留账号只读浏览；历史备份恢复保留原账号关闭流程。
 * 结束时只清理本次创建的产物和工作目录，每次修复均保留结果与报告。
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseAlgorithms, DatabaseProgress, SingleBytePageCorrection } from '@weq/native';
import type { BadPageScanReport } from '../bad_pages';
import { writeFileAtomicSync } from '../../common/atomic_write';
import { getHost } from '../../common/host';
import { getLogger } from '../../common/logger';
import {
  backupFileAndHashSync,
  backupFileAndHash,
  fingerprintFile,
  copyFileAndHashSync,
  fileBytes,
  freeBytesAt,
  hashFileSync,
  pendingWalBytes,
  removeDirQuietly,
  removeQuietly,
  removeSqliteSidecars,
  replaceFileSync,
} from './files';
import { DEFAULT_BACKUP_KEEP, DbRepairHistory } from './history';
import { probeDbLayout, type DbLayoutProbe } from './layout_migration';
import type { DatabaseRepairMethod } from './maintenance_types';
import { classifyLock, type DbRepairLockClassification, type DbRepairLockProbe } from './lock';
import {
  dbRepairPaths,
  dbRepairRoot,
  makeStamp,
  productTempPath,
  type DbRepairPaths,
} from './paths';
import { renderDbRepairReportMarkdown } from './report';
import {
  repairSpaceBudget,
  quickRepairSpaceBudget,
  repairDiskSpace,
  repairWorkingBytes,
  type RepairDiskSpace,
  type RepairStorageStatus,
} from './space';
import type {
  DbRepairLockHolder,
  DbRepairPreflight,
  DbRepairProgress,
  DbRepairRecord,
  DbRepairRecoverOptions,
  DbRepairRecoverReport,
  DbRepairRecoverVerification,
  DbRepairRestorePreview,
  DbRepairTarget,
  DbRepairWalCheckpoint,
} from './types';

// ────────────────────────── 错误与依赖 ──────────────────────────

/** 修复失败的原因分类 —— router 据此给用户不同的下一步动作。 */
export type DbRepairErrorCode =
  /** 库文件 / 目录找不到。 */
  | 'not-found'
  /** 账号配置里没有密钥或该库的算法。 */
  | 'no-credentials'
  /** 库被占用（QQ 或其它进程）。 */
  | 'blocked'
  /** 磁盘空间不够。 */
  | 'insufficient-space'
  /** 预计峰值足够，但未确认接受建议余量不足。 */
  | 'space-margin'
  /** 已有修复任务在进行。 */
  | 'busy'
  /** 修复期间源库被改动 —— 可重试（建议先关账号）。 */
  | 'changed-during-repair'
  /** 回滚前发现库在修复后又被写过，需要用户确认。 */
  | 'needs-confirm'
  /** 记录对应的备份已不存在。 */
  | 'no-backup'
  /** native 没报错但产物自检不过。 */
  | 'verify-failed'
  /** native 重建本身失败（写不出产物、errcode 非 0 等），可重试。 */
  | 'recover-failed';

export class DbRepairError extends Error {
  sourceUnchanged = false;
  storage?: RepairStorageStatus;
  constructor(
    readonly code: DbRepairErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DbRepairError';
  }
}

export class DbRepairRollbackError extends DbRepairError {
  constructor(
    message: string,
    readonly retry: (progress?: (tick: DbRepairProgress) => void) => Promise<void>,
  ) {
    super('verify-failed', message);
  }
}

const RESTORE_JOURNALS = ['-wal', '-journal'] as const;
const RESTORE_SIDECARS = [...RESTORE_JOURNALS, '-shm'] as const;

function hasRestoreJournal(dbPath: string): boolean {
  return RESTORE_JOURNALS.some(
    (suffix) => (statSync(`${dbPath}${suffix}`, { throwIfNoEntry: false })?.size ?? 0) > 0,
  );
}

function confirmRestoreChanges(): never {
  throw new DbRepairError(
    'needs-confirm',
    '当前数据库已变化或仍有未合并的日志，恢复会覆盖修复之后的数据。请重新打开恢复确认。',
  );
}

/**
 * 一个账号解析出来的修复上下文。
 *
 * **路径只由这一层解析**（账号配置 + platform），不进 IPC：把 `dataDir` / `dbPath`
 * 交给渲染层再传回来的写法会变成一个"任意路径写入接口"，与
 * `account.clearSalvageQuarantine` 那条注释同一个道理。
 */
export interface DbRepairAccountInfo {
  /** 账号数据目录（用于 `accountConfigId` 分目录）；`null` = 平台默认解析。 */
  dataDir: string | null;
  /** 存放 `.db` 的目录（静态账号就是它自己的目录）。 */
  dbDir: string;
  /** SQLCipher 口令。 */
  dbKey: string;
  /** 逐库的页 HMAC × KDF HMAC 组合。 */
  algos: Record<string, DatabaseAlgorithms>;
}

/** 修复服务的外部依赖（全部由主进程注入，便于离线单测）。 */
export interface DbRepairDeps {
  /** 缓存根（`userConfig.cacheDir` 的绑定）——记录 / 备份 / 报告都放它下面。 */
  cacheDir(...segments: string[]): string;
  /** 仅重定向备份和明文临时件，历史索引与报告保持原位。 */
  scratchDir?(): string | null;
  storageOptimized?(): boolean;
  storageStreaming?(): boolean;
  diskSpace?(path: string): RepairDiskSpace;
  /** 由 uin 解析账号的库目录与密钥；解析不了（没配置）返回 `null`。 */
  resolveAccount(uin: string): DbRepairAccountInfo | null;
  /** native 修复（`recoverDatabase` 的适配）。 */
  recover(
    options: DbRepairRecoverOptions,
    onProgress: (progress: DbRepairProgress) => void,
    signal?: AbortSignal,
    method?: DatabaseRepairMethod,
    streaming?: boolean,
    references?: string[],
  ): Promise<DbRepairRecoverReport>;
  cloneBackup?(source: string, target: string, signal?: AbortSignal): Promise<void>;
  protectProduct?(maintenanceId: string, dbPath: string, product: string): void | Promise<void>;
  /**
   * 把源库未合并的 WAL 合并回主文件（`PRAGMA wal_checkpoint(TRUNCATE)`，带密钥的写连接；
   * 不需要 QQ 参与）。
   *
   * 为什么要有这一条：QQ 崩溃留下的 `-wal` 里的帧，页级读取（解密 / 坏页扫描 / 修复）
   * 是**看不到**的。不先合并就修，用户的最后一批消息会静默消失。合并本身不改内容，
   * 只是把帧写回主文件对应的页，所以备份与修复都能看到它们。
   *
   * 看返回的 `merged`：`false`（或抛错）都算没合并成功，服务层会退回"如实警告 + 清理
   * sidecar"。不注入则跳过这一步（旧产物没有这个方法）。
   */
  checkpointWal?(
    dbPath: string,
    key: string,
    algo: DatabaseAlgorithms,
  ): Promise<DbRepairWalCheckpoint>;
  /** 锁探测（native `probeDbLock`）；不注入则预检一律 `unknown-lock`。 */
  probeLock?(dbPath: string): DbRepairLockProbe | null;
  /** 该账号的 QQ pid（`platform.resolveQqPid`），用于把持有者归到 QQ。 */
  qqPid?(uin: string): number | null;
  /**
   * WeQ 自己的进程 pid（默认 `process.pid`）—— 用于把**我们自己的句柄**从阻断条件里
   * 摘出来。Windows 的 Restart Manager 枚举的是"谁打开着这个文件"，只要界面开着这个
   * 账号，WeQ 就必然出现在持有者列表里；那是替换前会主动释放的句柄，不该拦。
   */
  selfPid?(): number | null;
  /**
   * 失效该库的缓存句柄。keepReadOnly=true 时保留账号和只读浏览；历史恢复可关闭账号。
   * 替换前后调用，避免继续复用被替换文件的旧连接；调用方保证幂等。
   */
  releaseHandles?(uin: string, dbPath: string, keepReadOnly?: boolean): void;
  /** 替换后的额外复核（native `checkDatabaseHealth`）。 */
  verify?(
    dbPath: string,
    key: string,
    algo: DatabaseAlgorithms,
    progress: (tick: DatabaseProgress) => void,
  ): Promise<{
    healthy: boolean;
    corruptedTables: string[];
    complete?: boolean;
    unverifiedTables?: string[];
  } | null>;
  /** 报告里写的 WeQ 版本；不注入则尝试 `getHost().appVersion()`，都拿不到写"未知"。 */
  appVersion?(): string;
  now?(): Date;
  /** 备份保留份数（默认 3）。 */
  keepBackups?: number;
}

/** 一次修复请求。 */
export interface DbRepairRequest {
  /** 账号 uin —— 目录与密钥由服务内部解析，渲染层不传路径。 */
  uin: string;
  dbName: string;
  /** 是否保留可供日后恢复的备份（默认 `true`）。 */
  backup?: boolean;
  /** 仅接受建议余量不足；不能绕过预计峰值不足，也不影响备份与自检。 */
  allowLowSpace?: boolean;
  /** 严格页模式：坏页先清零，内容一定经过校验，代价是那些行明确丢失。 */
  strictPages?: boolean;
  /** 是否从 freelist 捞已删除的记录（默认 `false`；打开会"复活"已删除消息）。 */
  recoverFreelist?: boolean;
  /** 孤立页回收表名；空字符串表示不做孤立页回收。 */
  lostAndFoundName?: string;
  /** 先建索引再灌数据（默认 `false`）：进度更连续但整体更慢。 */
  slowIndexes?: boolean;
  /**
   * 走「布局迁移」而不是通用修复。
   *
   * 迁移的源页布局固定按 `standard` 读、目标写回 `qq`；它与通用修复共用备份 /
   * 替换 / 回滚，只是多带这两个 native 参数，并把记录标成 `layout-migration`。
   */
  layoutMigration?: boolean;
  sourceScan?: BadPageScanReport;
  method?: DatabaseRepairMethod;
  quickBudgetBytes?: number;
  singleByteCorrection?: SingleBytePageCorrection;
  references?: string[];
  /** 当前账号维护锁标识，替换前将锁转接到临时产物。 */
  maintenanceId?: string;
  replacement?: {
    begin(): Promise<void>;
    waitForDecision(): Promise<void>;
    signal: AbortSignal;
    leaseSignal?: AbortSignal;
  };
  signal?: AbortSignal;
}

/** 备份的产出。 */
export interface DbRepairBackupResult {
  path: string;
  bytes: number;
  sha256: string;
}

/** 库里一次修复的"体检"等需要的库文件名列表由调用方给（白名单在 service 层之上）。 */
export class DbRepairService {
  private readonly histories = new Map<string, DbRepairHistory>();
  private readonly retryBackups = new Map<
    string,
    { maintenanceId: string; backup: DbRepairBackupResult }
  >();
  private readonly log = getLogger().child({ scope: 'db-repair' });
  /** 当前正在跑的修复（同一时刻只允许一个：两个任务互相覆盖是灾难）。 */
  private running: { dbPath: string; startedAt: string } | null = null;

  constructor(private readonly deps: DbRepairDeps) {}

  /** 只读检测旧版误修复留下的页布局；不落盘、不碰 native。 */
  probeLayout(uin: string, dbName: string): DbLayoutProbe {
    // 检测只看文件大小与两个原始页，**不要求密钥 / 算法**：用户还没打开过账号、
    // 或密钥暂时不可用时，仍然应该能判断出这是不是旧版误修复的库。
    return probeDbLayout(this.resolveDatabasePath(uin, dbName).dbPath);
  }

  /** 是否有修复在进行（界面用来禁用按钮）。 */
  isBusy(): boolean {
    return this.running !== null;
  }

  /** 该账号的修复根目录与路径碎片（路径来自 `resolveAccount`，不来自渲染层）。 */
  paths(uin: string): DbRepairPaths {
    const info = this.accountInfo(uin);
    const root = dbRepairRoot(this.deps.cacheDir, uin, info.dataDir);
    const scratch = this.deps.scratchDir?.();
    return dbRepairPaths(
      root,
      scratch ? dbRepairRoot((...parts) => join(scratch, ...parts), uin, info.dataDir) : root,
    );
  }

  history(uin: string): DbRepairHistory {
    const paths = this.paths(uin);
    let history = this.histories.get(paths.root);
    if (!history) {
      history = new DbRepairHistory(paths);
      this.histories.set(paths.root, history);
    } else history.reload();
    return history;
  }

  /** 解析账号上下文；解析不了就报一条能照着做的错。 */
  accountInfo(uin: string): DbRepairAccountInfo {
    const info = this.deps.resolveAccount(uin);
    if (!info || info.dbDir === '') {
      throw new DbRepairError(
        'not-found',
        `找不到账号 ${uin} 的数据库目录——先用 WeQ 打开一次该账号，让它记录下数据目录`,
      );
    }
    return info;
  }

  /**
   * 解析一个目标：目录、文件、密钥、算法。
   *
   * `dbName` 来自渲染层，所以这里必须挡住路径穿越（只接受纯文件名）。
   */
  resolveTarget(uin: string, dbName: string): DbRepairTarget {
    const { info, dbDir, dbPath } = this.resolveDatabasePath(uin, dbName);
    if (info.dbKey === '') {
      throw new DbRepairError(
        'no-credentials',
        `账号 ${uin} 没有可用的数据库密钥，无法修复（先用 WeQ 打开一次该账号）`,
      );
    }
    // 逐库算法缺失时回退 nt_msg.db 那份（与 `algoFor` 同一个口径）。
    const algo = info.algos[dbName] ?? info.algos['nt_msg.db'];
    if (!algo) {
      throw new DbRepairError('no-credentials', `账号配置里没有 ${dbName} 的加密算法信息`);
    }
    return { uin, dataDir: info.dataDir, dbName, dbDir, dbPath, key: info.dbKey, algo };
  }

  /**
   * 只解析库路径，不要求密钥。
   *
   * 布局检测只需要读文件；把路径解析从 {@link resolveTarget} 拆出来后，检测不会因为
   * 账号还没登录 / 没解出密钥而失效。`dbName` 来自渲染层，所以这里同样要挡住路径穿越。
   */
  resolveDatabasePath(
    uin: string,
    dbName: string,
  ): { info: DbRepairAccountInfo; dbDir: string; dbPath: string } {
    if (!isPlainDatabaseName(dbName)) {
      throw new DbRepairError('not-found', `非法的数据库文件名：${dbName}`);
    }
    const info = this.accountInfo(uin);
    const dbDir = info.dbDir;
    const dbPath = join(dbDir, dbName);
    // 必须是**普通文件**：只查 existsSync 的话 `..` 这类名字会指向目录，
    // 而后面所有步骤都假定 dbPath 是一个可以整体替换的库文件。
    if (!isRegularFile(dbPath)) {
      throw new DbRepairError('not-found', `数据库不存在或不是文件：${dbPath}`);
    }
    return { info, dbDir, dbPath };
  }

  /**
   * 预检：能不能开修。只读、不落盘。
   *
   * `unknown-lock` 不阻断（探测失败 ≠ 没锁）：真正的把关在替换前那道复核。
   * `self-hold`（只有 WeQ 自己拿着句柄）同样不阻断 —— 见 {@link classifyLock}。
   */
  preflight(
    uin: string,
    dbName: string,
    backup = true,
    maintenanceId?: string,
    quickBudgetBytes?: number,
  ): DbRepairPreflight {
    const target = this.resolveTarget(uin, dbName);
    const lock = this.classifyLock(target.dbPath, uin);
    const dbBytes = fileBytes(target.dbPath) ?? 0;
    const paths = this.paths(uin);
    const walBytes = pendingWalBytes(target.dbPath);
    const storageOptimized = this.deps.storageOptimized?.() === true;
    const storageStreaming = this.deps.storageStreaming?.() === true;
    const makeBackup = backup && !this.reusableBackup(target, maintenanceId);
    if (!quickBudgetBytes || makeBackup) this.assertScratchAvailable();
    if (quickBudgetBytes && makeBackup) {
      const probe = this.deps.diskSpace ?? repairDiskSpace;
      const sourceVolume = probe(target.dbDir).volume;
      if (
        !sourceVolume ||
        sourceVolume !== probe(dirname(paths.workDir)).volume ||
        !this.deps.cloneBackup
      )
        throw new DbRepairError(
          'blocked',
          '快速修复的备份需要能克隆的同卷工作区。请将工作区改到原库所在卷，或取消快速修复的备份。',
        );
    }
    const space = quickBudgetBytes
      ? quickRepairSpaceBudget(target.dbDir, quickBudgetBytes, this.deps.diskSpace)
      : repairSpaceBudget({
          sourceDir: target.dbDir,
          cacheDir: dirname(paths.workDir),
          dbBytes,
          walBytes,
          backup: makeBackup,
          optimized: storageOptimized,
          streaming: storageStreaming,
          probe: this.deps.diskSpace,
        });
    return {
      ...target,
      readiness: lock.readiness,
      holders: lock.holders,
      qqHolders: lock.qqHolders,
      selfHolders: lock.selfHolders,
      otherHolders: lock.otherHolders,
      dbBytes,
      space,
      cachePath: dirname(paths.workDir),
      storageOptimized,
      storageStreaming,
      freeBytes: freeBytesAt(target.dbDir),
      requiredBytes: space.reduce((sum, item) => sum + item.requiredBytes, 0),
      recommendedBytes: space.reduce((sum, item) => sum + item.recommendedBytes, 0),
      keyPresent: target.key !== '',
      backupsKept: this.countBackups(uin),
      pendingWalBytes: pendingWalBytes(target.dbPath),
    };
  }

  /** 结束持续维护后不再复用旧备份，文件及其历史记录继续保留。 */
  endMaintenance(maintenanceId: string): void {
    for (const [path, saved] of this.retryBackups)
      if (saved.maintenanceId === maintenanceId) this.retryBackups.delete(path);
  }

  private reusableBackup(
    target: DbRepairTarget,
    maintenanceId?: string,
  ): DbRepairBackupResult | null {
    const saved = this.retryBackups.get(target.dbPath);
    if (!maintenanceId || saved?.maintenanceId !== maintenanceId) return null;
    if (fileBytes(saved.backup.path) !== saved.backup.bytes) {
      this.retryBackups.delete(target.dbPath);
      return null;
    }
    return saved.backup;
  }

  /** 手动备份（界面上独立的"立即备份"按钮）。 */
  backup(uin: string, dbName: string, stamp?: string): DbRepairBackupResult {
    if (this.running) throw new DbRepairError('busy', '已有修复或回滚在进行，请等待完成');
    this.assertScratchAvailable();
    const target = this.resolveTarget(uin, dbName);
    return this.writeBackup(target, this.paths(uin), stamp ?? this.operationStamp());
  }

  /**
   * 跑一次完整修复。
   *
   * 任何非 `applied` 的结局都会往历史里写一条记录（含失败原因），界面因此能回答
   * "上次修过什么、结果如何"。**源库只在最后那一次原子替换里被改动。**
   */
  async repair(
    request: DbRepairRequest,
    onProgress: (progress: DbRepairProgress) => void,
  ): Promise<DbRepairRecord> {
    let committing = false;
    try {
      return await this.repairDatabase(request, onProgress, () => {
        committing = true;
      });
    } catch (error) {
      const classified = classifyFailure(error);
      const failure =
        error instanceof DbRepairError
          ? error
          : new DbRepairError(classified.code, classified.message);
      // 只有持续锁内、尚未进入提交且未发现源库变化，才允许继续消费同一份扫描结果。
      failure.sourceUnchanged =
        !!request.maintenanceId && !committing && failure.code !== 'changed-during-repair';
      if (!failure.sourceUnchanged || request.signal?.aborted) {
        const path = request.sourceScan?.dbPath;
        if (path && this.retryBackups.get(path)?.maintenanceId === request.maintenanceId)
          this.retryBackups.delete(path);
      }
      throw failure;
    }
  }

  private async repairDatabase(
    request: DbRepairRequest,
    onProgress: (progress: DbRepairProgress) => void,
    onCommit: () => void,
  ): Promise<DbRepairRecord> {
    if (this.running) {
      throw new DbRepairError(
        'busy',
        `已有修复任务在进行中（${this.running.dbPath}），请等它结束再试`,
      );
    }

    const { uin } = request;
    const target = this.resolveTarget(uin, request.dbName);
    if (!request.sourceScan || request.sourceScan.dbPath !== target.dbPath) {
      throw new DbRepairError(
        'recover-failed',
        '请先在当前维护中完成此数据库的常规扫描，修复不能独立执行。',
      );
    }
    request.signal?.throwIfAborted();
    const quick = request.method === 'quick';
    if (
      quick &&
      (!request.maintenanceId || !request.quickBudgetBytes || request.quickBudgetBytes <= 0)
    )
      throw new DbRepairError('recover-failed', '请先取得本轮快速修复方案。');
    const layoutMigration =
      request.layoutMigration === true || request.sourceScan.sourceLayout === 'standard';
    const retryBackup =
      request.backup === false ? null : this.reusableBackup(target, request.maintenanceId);
    const preflight = this.preflight(
      uin,
      request.dbName,
      request.backup !== false,
      request.maintenanceId,
      quick ? request.quickBudgetBytes : undefined,
    );
    const initialStorage: RepairStorageStatus = {
      cachePath: preflight.cachePath,
      phase: 'backup',
      space: preflight.space,
    };
    const spaceError = (
      code: 'insufficient-space' | 'space-margin',
      message: string,
      storage: RepairStorageStatus,
    ) => {
      const error = new DbRepairError(code, message);
      error.storage = { ...storage, warning: code };
      return error;
    };
    onProgress({
      phase: 'backup',
      percent: 0,
      message: '检查备份与修复工作区空间',
      storage: initialStorage,
    });
    const shortage = preflight.space.find(
      (item) => item.freeBytes !== null && item.freeBytes < item.requiredBytes,
    );
    if (shortage) {
      throw spaceError(
        'insufficient-space',
        `磁盘空间不足（${shortage.paths.join('、')}）：预计新增峰值约 ${formatMb(shortage.requiredBytes)}，当前可用 ${formatMb(shortage.freeBytes!)}`,
        initialStorage,
      );
    }
    const margin = preflight.space.find(
      (item) => item.freeBytes !== null && item.freeBytes < item.recommendedBytes,
    );
    if (margin && request.allowLowSpace !== true) {
      throw spaceError(
        'space-margin',
        `磁盘建议余量不足（${margin.paths.join('、')}）：预计新增峰值约 ${formatMb(margin.requiredBytes)}，建议预留 ${formatMb(margin.recommendedBytes)}，当前可用 ${formatMb(margin.freeBytes!)}。可在修复确认中明确接受风险后继续。`,
        initialStorage,
      );
    }
    if (preflight.readiness === 'blocked-by-qq') {
      throw new DbRepairError(
        'blocked',
        `QQ 正在使用该数据库（${describeHolders(preflight.qqHolders)}），请先结束 QQ 进程`,
      );
    }
    if (preflight.readiness === 'blocked-by-other') {
      throw new DbRepairError(
        'blocked',
        `该数据库被其它进程占用（${describeHolders(preflight.otherHolders)}）—— 请先关掉它们再试`,
      );
    }

    const paths = this.paths(uin);
    const history = this.history(uin);
    const stamp = this.operationStamp();
    const productDirectory = productTempPath(target.dbDir, target.dbName, stamp);
    const product = join(productDirectory, target.dbName);
    const startedAt = this.now().toISOString();
    const startMs = Date.now();
    const guardedEmit = progressGuard(onProgress);
    let committing = false;
    const spaceAbort = new AbortController();
    const recoverSignal = AbortSignal.any([
      spaceAbort.signal,
      ...(request.signal ? [request.signal] : []),
    ]);
    let latest: DbRepairProgress = { phase: 'backup', percent: 0, message: '准备重建' };
    let lastSpaceCheck = 0;
    let storage = initialStorage;
    let rebuildPercent: number | undefined;
    let hasNativeRebuildProgress = false;
    const { pageCount, pageSize, headerOffset } = request.sourceScan;
    const sourcePageBytes = pageCount * pageSize;
    const updateRebuildPercent = (rebuiltBytes: number) => {
      if (sourcePageBytes > 0)
        rebuildPercent = Math.min(
          99,
          Math.max(rebuildPercent ?? 0, (rebuiltBytes / sourcePageBytes) * 100),
        );
    };
    const checkSpace = () => {
      lastSpaceCheck = Date.now();
      if (quick) return;
      const working = repairWorkingBytes(join(paths.workDir, stamp));
      const productWorking = repairWorkingBytes(productDirectory);
      const productBytes = productWorking.allocated;
      if (latest.phase === 'Repair' && !hasNativeRebuildProgress) {
        const rebuiltBytes = preflight.storageStreaming
          ? productWorking.streamingProduct - headerOffset
          : working.rebuilt;
        if (rebuiltBytes > 0) updateRebuildPercent(rebuiltBytes);
      }
      // 文件释放与 IPC 进度可能先后到达，不把刚被删除的输入再次计入未来写入。
      let budgetPhase = latest.phase.toLowerCase();
      if (
        !preflight.storageStreaming &&
        preflight.storageOptimized &&
        budgetPhase === 'repair' &&
        working.rebuilt > 0 &&
        !working.sourcePresent
      )
        budgetPhase = 'encrypt';
      if (
        !preflight.storageStreaming &&
        preflight.storageOptimized &&
        budgetPhase === 'encrypt' &&
        working.rebuilt === 0 &&
        productBytes > 0
      )
        budgetPhase = 'restore';
      storage = {
        cachePath: preflight.cachePath,
        phase: latest.phase,
        space: repairSpaceBudget({
          sourceDir: target.dbDir,
          cacheDir: preflight.cachePath,
          dbBytes: preflight.dbBytes,
          walBytes: preflight.pendingWalBytes,
          backup: request.backup !== false,
          optimized: preflight.storageOptimized,
          streaming: preflight.storageStreaming,
          probe: this.deps.diskSpace,
          current: {
            phase: budgetPhase,
            cacheBytes: working.allocated,
            rebuiltBytes: working.rebuilt,
            productBytes,
            backupRemainingBytes:
              latest.phase.toLowerCase() === 'backup' &&
              request.backup !== false &&
              !retryBackup &&
              !backup
                ? Math.max(
                    0,
                    preflight.dbBytes - (fileBytes(paths.backupFile(stamp, target.dbName)) ?? 0),
                  )
                : 0,
          },
        }),
      };
      const low = storage.space.find(
        (volume) => volume.freeBytes !== null && volume.freeBytes < volume.requiredBytes,
      );
      if (low && !committing)
        spaceAbort.abort(
          spaceError(
            'insufficient-space',
            `剩余磁盘空间不足（${low.paths.join('、')}）：后续新增峰值约 ${formatMb(low.requiredBytes)}，当前可用 ${formatMb(low.freeBytes!)}。已保留维护锁和扫描结果，请清理磁盘或更改备份与修复工作区位置后重试。`,
            storage,
          ),
        );
    };
    const publishProgress = () => {
      const progress = { ...latest, storage };
      if (latest.phase === 'Repair' && rebuildPercent !== undefined) {
        const detail = latest.detail ?? { step: latest.phase, message: latest.message };
        progress.detail = { ...detail, rebuildPercent };
      }
      guardedEmit(progress);
    };
    const emit = (progress: DbRepairProgress, interrupt = true) => {
      if (!committing && interrupt) request.signal?.throwIfAborted();
      if (progress.phase === 'Repair' && progress.rebuiltBytes !== undefined) {
        hasNativeRebuildProgress = true;
        updateRebuildPercent(progress.rebuiltBytes);
      }
      const phaseChanged = latest.phase !== progress.phase;
      // 阶段摘要和字段计数交替到达。保留计数，让空间采样也能更新同一行进度条。
      latest =
        !phaseChanged && !progress.detail && latest.detail?.step === 'recover-data'
          ? { ...progress, detail: latest.detail }
          : progress;
      if (!committing && (phaseChanged || Date.now() - lastSpaceCheck >= 1000)) checkSpace();
      publishProgress();
      if (!committing && interrupt) spaceAbort.signal.throwIfAborted();
    };
    let spaceTimer: ReturnType<typeof setInterval> | undefined;
    // 未合并的 WAL：页级读取看不到它的帧，所以这部分改动不在修复范围内。先量下来，
    // 记进记录与报告里（不能悄悄丢掉用户的最后一批消息）。
    const pendingWal = pendingWalBytes(target.dbPath);
    if (pendingWal > 0) {
      this.log.warn('source database has an unmerged WAL', {
        event: 'db-repair-pending-wal',
        accountUin: target.uin,
        dbPath: target.dbPath,
        pendingWalBytes: pendingWal,
      });
    }

    this.running = { dbPath: target.dbPath, startedAt };
    this.log.info('db repair starting', {
      event: 'db-repair-start',
      accountUin: target.uin,
      dbPath: target.dbPath,
      strictPages: request.strictPages ?? false,
      backup: request.backup !== false,
      allowLowSpace: request.allowLowSpace === true,
      layoutMigration,
    });

    let backup: DbRepairBackupResult | null = null;
    let before = { bytes: 0, sha256: '' };
    let recovered: DbRepairRecoverReport | null = null;
    /** 替换成功后的产物指纹（成功路径与"自检不过"路径都要记）。 */
    let after: { bytes: number; sha256: string } | null = null;
    /** 自检结论（含注入的复核）；`null` = 还没走到自检。 */
    let verification: DbRepairRecoverVerification | null = null;
    /** 未合并的 WAL 是否在修复前合并回主文件了（catch 里也要用，所以声明在外层）。 */
    let walMerged = false;
    let preserveOriginal = false;
    try {
      mkdirSync(productDirectory, { mode: 0o700 });
      if (!quick && preflight.storageStreaming)
        mkdirSync(join(paths.workDir, stamp), { recursive: true, mode: 0o700 });

      // 先合并 WAL（如果有）：必须在**备份之前**做，备份里才含最后那批改动。
      if (quick && pendingWal > 0)
        throw new DbRepairError(
          'changed-during-repair',
          '发现新的预写日志，请核对原库状态后重新扫描。',
        );
      if (pendingWal > 0) emit({ phase: 'wal', percent: 0, message: '合并预写日志' });
      walMerged = request.maintenanceId ? true : await this.mergePendingWal(target, pendingWal);

      emit({ phase: 'backup', percent: 0, message: '准备修复备份' });
      if (request.backup === false) {
        before = await fingerprintFile(target.dbPath, (completed, total) =>
          emit({
            phase: 'backup',
            percent: 0,
            message: '计算源库指纹',
            detail: {
              step: 'source-fingerprint',
              message: '计算源库指纹',
              completed,
              total,
              unit: 'bytes',
            },
          }),
        );
      } else if (retryBackup) {
        try {
          const fingerprint = await fingerprintFile(retryBackup.path, (completed, total) =>
            emit({
              phase: 'backup',
              percent: 0,
              message: '校验并复用本次维护的已有备份',
              detail: {
                step: 'backup',
                message: '校验并复用本次维护的已有备份',
                completed,
                total,
                unit: 'bytes',
              },
            }),
          );
          if (fingerprint.sha256 !== retryBackup.sha256 || fingerprint.bytes !== retryBackup.bytes)
            throw new DbRepairError('no-backup', '已有备份校验未通过，请重试以重新备份。');
        } catch (error) {
          if (!spaceAbort.signal.aborted) this.retryBackups.delete(target.dbPath);
          throw error;
        }
        backup = retryBackup;
        before = { bytes: backup.bytes, sha256: backup.sha256 };
      } else {
        const destination = paths.backupFile(stamp, target.dbName);
        const onBackupProgress = (completed: number, total: number) =>
          emit({
            phase: 'backup',
            percent: 0,
            message: '备份并校验数据库',
            detail: {
              step: 'backup',
              message: '备份并校验数据库',
              completed,
              total,
              unit: 'bytes',
            },
          });
        let fingerprint: Awaited<ReturnType<typeof fingerprintFile>>;
        if (quick) {
          mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
          try {
            await this.deps.cloneBackup!(target.dbPath, destination, recoverSignal);
            fingerprint = await fingerprintFile(destination, onBackupProgress);
          } catch (error) {
            removeDirQuietly(dirname(destination));
            throw error;
          }
        } else fingerprint = await backupFileAndHash(target.dbPath, destination, onBackupProgress);
        backup = this.writeBackup(target, paths, stamp, fingerprint);
        before = { bytes: backup.bytes, sha256: backup.sha256 };
        if (request.maintenanceId)
          this.retryBackups.set(target.dbPath, { maintenanceId: request.maintenanceId, backup });
      }
      emit({
        phase: 'backup',
        percent: 1,
        message: backup
          ? `${retryBackup ? '已复用备份' : '已备份'} ${formatMb(backup.bytes)}`
          : '已跳过备份（按请求）',
      });

      // 原生工作在子进程中；即使某个步骤不再发进度，也继续观测文件增长与可用空间。
      spaceTimer = setInterval(() => {
        checkSpace();
        publishProgress();
      }, 1000);
      try {
        recovered = await this.deps.recover(
          {
            dbPath: target.dbPath,
            outPath: product,
            workDir: join(paths.workDir, stamp),
            key: target.key,
            algo: target.algo,
            strictPages: request.strictPages,
            recoverFreelist: request.recoverFreelist,
            lostAndFoundName: request.lostAndFoundName,
            slowIndexes: request.slowIndexes,
            sourceScan: request.sourceScan,
            ...(quick && request.singleByteCorrection
              ? { singleByteCorrection: request.singleByteCorrection }
              : {}),
            ...(layoutMigration
              ? { sourceLayout: 'standard' as const, targetLayout: 'qq' as const }
              : {}),
          },
          (progress) => emit(progress, false),
          recoverSignal,
          request.method,
          !quick && preflight.storageStreaming,
          request.references,
        );
        spaceAbort.signal.throwIfAborted();
      } finally {
        clearInterval(spaceTimer);
        spaceTimer = undefined;
      }
      request.signal?.throwIfAborted();

      // 已知不合格的产物不进入替换，也不为此触发原库还原。
      if (
        !recovered.verification.healthy ||
        recovered.verification.badPages.length > 0 ||
        (quick && recovered.verification.complete !== true)
      ) {
        verification = recovered.verification;
        throw new DbRepairError(
          'verify-failed',
          '修复产物自检未通过，已在替换前中止，原数据库保持不变（详情见修复报告）',
        );
      }

      // 旧产物会静默忽略未知参数：迁移请求传下去后，它仍按 QQ 布局读 standard 源，
      // 产出一个看似成功、实际错位的库。native 新版本会把实际使用的布局回显在报告
      // 里；没回显（或不是 standard → qq）就在替换之前中止，源库一个字节不动。
      if (
        layoutMigration &&
        (recovered.sourceLayout !== 'standard' || recovered.targetLayout !== 'qq')
      ) {
        throw new DbRepairError(
          'recover-failed',
          '当前 native 产物不支持页布局迁移（没有回显 sourceLayout=standard / targetLayout=qq）。请先更新对应平台的 nt_helper 产物，再重试；本次没有替换源库。',
        );
      }

      // ── 保险：修复期间源库被写过就中止（源库一个字节没动） ──
      const current =
        request.maintenanceId && !quick
          ? before
          : await fingerprintFile(target.dbPath, (completed, total) =>
              emit({
                phase: 'source-check',
                percent: 100,
                message: '替换前核对源库指纹',
                detail: {
                  step: 'source-check',
                  message: '替换前核对源库指纹',
                  completed,
                  total,
                  unit: 'bytes',
                },
              }),
            );
      if (current.sha256 !== before.sha256) {
        throw new DbRepairError(
          'changed-during-repair',
          '检测到修复期间数据库发生变化，已中止且未替换数据库。请关闭可能写入该库的程序或账号，核对状态后再试。',
        );
      }

      request.signal?.throwIfAborted();
      await request.replacement?.begin();
      this.deps.releaseHandles?.(uin, target.dbPath, !!request.maintenanceId);
      emit({ phase: 'swapping', percent: 100, message: '正在替换数据库…' });
      const lockAgain = this.classifyLock(target.dbPath, uin);
      if (lockAgain.readiness === 'blocked-by-qq') {
        throw new DbRepairError(
          'blocked',
          `替换前复核发现 QQ 又打开了该数据库（${describeHolders(lockAgain.qqHolders)}），已中止`,
        );
      }
      if (lockAgain.readiness === 'blocked-by-other') {
        throw new DbRepairError(
          'blocked',
          `替换前发现数据库被其它进程占用（${describeHolders(lockAgain.otherHolders)}），已中止且未替换数据库。请关闭相关程序后再试。`,
        );
      }

      // sidecar 属于被换掉的那份库：留着它，新库连 `PRAGMA journal_mode` 都读不了
      // （实测见 `files.ts` 的 `removeSqliteSidecars`）。
      if (request.maintenanceId)
        await this.deps.protectProduct?.(request.maintenanceId, target.dbPath, product);
      request.signal?.throwIfAborted();
      // 同卷硬链接保留原文件及其维护锁，文件系统不支持时复制并转接锁。
      const original = join(productDirectory, 'original', target.dbName);
      let copiedOriginal = false;
      if (request.maintenanceId) {
        mkdirSync(dirname(original), { mode: 0o700 });
        try {
          linkSync(target.dbPath, original);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EPERM', 'EINVAL'].includes(code ?? ''))
            throw error;
          const retained = await backupFileAndHash(target.dbPath, original, (completed, total) =>
            emit({
              phase: 'source-check',
              percent: 100,
              message: '保留可撤销的原库',
              detail: {
                step: 'retain-original',
                message: '保留可撤销的原库',
                completed,
                total,
                unit: 'bytes',
              },
            }),
          );
          if (retained.sha256 !== before.sha256 || retained.bytes !== before.bytes)
            throw new DbRepairError('changed-during-repair', '保留原库时发现数据库内容发生变化。');
          copiedOriginal = true;
        }
      }
      request.signal?.throwIfAborted();
      // 普通停止保留提交结果，明确撤销本次替换时才还原。
      committing = true;
      this.retryBackups.delete(target.dbPath);
      onCommit();
      const removedSidecars = request.maintenanceId
        ? removeSqliteSidecars(target.dbPath, ['-wal', '-journal'])
        : removeSqliteSidecars(target.dbPath);
      if (removedSidecars.length > 0) {
        this.log.info('removed stale sqlite sidecars before swapping', {
          event: 'db-repair-removed-sidecars',
          dbPath: target.dbPath,
          removed: removedSidecars,
        });
      }

      let restoredOriginal = false;
      let protectedOriginal = !copiedOriginal;
      const restoreOriginal = async (onProgress = emit) => {
        try {
          request.replacement?.leaseSignal?.throwIfAborted();
          if (!restoredOriginal) {
            this.deps.releaseHandles?.(uin, target.dbPath, true);
            if (!protectedOriginal) {
              await this.deps.protectProduct?.(request.maintenanceId!, target.dbPath, original);
              protectedOriginal = true;
            }
            request.replacement?.leaseSignal?.throwIfAborted();
            removeSqliteSidecars(target.dbPath, ['-wal', '-journal']);
            this.replaceIntoPlace(original, target.dbPath, uin, null);
            restoredOriginal = true;
            this.deps.releaseHandles?.(uin, target.dbPath, true);
          }
          const progress = (completed: number, total: number, status?: 'completed') =>
            onProgress({
              phase: 'final-check',
              percent: 100,
              message: '校验已恢复的原库',
              detail: {
                step: 'rollback-fingerprint',
                message: '校验已恢复的原库',
                completed,
                total,
                unit: 'bytes',
                status,
              },
            });
          const restored = await fingerprintFile(target.dbPath, progress);
          if (restored.sha256 !== before.sha256 || restored.bytes !== before.bytes)
            throw new Error('恢复后的原库指纹与修复前不一致。');
          progress(restored.bytes, restored.bytes, 'completed');
        } catch (error) {
          preserveOriginal = true;
          const path = restoredOriginal ? target.dbPath : original;
          throw new DbRepairRollbackError(
            `无法恢复并校验原库。原库文件保留在 ${path}。请从「维护中」重试。 ${error instanceof Error ? error.message : String(error)}`,
            async (progress) => {
              await restoreOriginal(progress);
              removeDirQuietly(productDirectory);
            },
          );
        }
      };

      this.replaceIntoPlace(product, target.dbPath, target.uin, lockAgain);
      try {
        if (request.maintenanceId) this.deps.releaseHandles?.(uin, target.dbPath, true);
        after = await fingerprintFile(target.dbPath, (completed, total) => {
          request.replacement?.signal.throwIfAborted();
          emit({
            phase: 'final-check',
            percent: 100,
            message: '校验替换后数据库指纹',
            detail: {
              step: 'final-fingerprint',
              message: '校验替换后数据库指纹',
              completed,
              total,
              unit: 'bytes',
            },
          });
        });
        request.replacement?.signal.throwIfAborted();
        emit({ phase: 'final-check', percent: 100, message: '复核替换后的数据库结构' });
        verification = await this.verifyProduct(target, recovered, (detail) => {
          if (request.replacement?.signal.aborted || detail.step === 'integrity') return;
          emit({ phase: 'final-check', percent: 100, message: detail.message, detail });
        });
        await request.replacement?.waitForDecision();
        request.replacement?.signal.throwIfAborted();
      } catch (error) {
        if (request.maintenanceId) await restoreOriginal();
        await request.replacement?.waitForDecision();
        throw error;
      }
      if (!verification.healthy || verification.badPages.length > 0) {
        const restored = !!request.maintenanceId || !!backup;
        if (request.maintenanceId) {
          await restoreOriginal();
        } else if (backup) {
          // 自检可能已经打开过产物（留下它那一代的 sidecar），还原前同样得清掉。
          removeSqliteSidecars(target.dbPath);
          this.installFromBackup(backup.path, target, stamp, target.uin);
        }
        await request.replacement?.waitForDecision();
        request.replacement?.signal.throwIfAborted();
        this.log.error('db repair product failed verification', {
          event: 'db-repair-verify-failed',
          accountUin: target.uin,
          dbPath: target.dbPath,
          restored,
        });
        throw new DbRepairError(
          'verify-failed',
          restored
            ? '修复产物自检未通过，已自动还原为修复前的数据库（详情见修复报告）'
            : '修复产物自检未通过，且本次没有备份可还原（详情见修复报告）',
        );
      }

      emit({ phase: 'report', percent: 100, message: '保存修复报告' });
      const record = this.record(history, paths, {
        stamp,
        target,
        state: 'applied',
        backup,
        before,
        after,
        recovered: { ...recovered, verification },
        pendingWalBytes: pendingWal,
        walMerged,
        layoutMigration,
        method: request.method,
        durationMs: Date.now() - startMs,
        startedAt,
      });
      const purged = history.pruneBackups(this.deps.keepBackups ?? DEFAULT_BACKUP_KEEP);
      this.log.info('db repair applied', {
        event: 'db-repair-applied',
        accountUin: target.uin,
        dbPath: target.dbPath,
        recordId: record.id,
        durationMs: record.durationMs,
        badPages: record.badPages.length,
        purgedBackups: purged.length,
      });
      emit({ phase: 'done', percent: 100, message: '修复完成' });
      return record;
    } catch (error) {
      removeQuietly(product);
      const cause = spaceAbort.signal.aborted ? spaceAbort.signal.reason : error;
      const classified = classifyFailure(cause);
      // 写满磁盘时报告也可能写不出，不能让次生错误遮盖可恢复的执行结果。
      try {
        const record = this.record(history, paths, {
          stamp,
          target,
          state: classified.state,
          error: classified.message,
          backup,
          before,
          after,
          recovered: recovered && verification ? { ...recovered, verification } : recovered,
          pendingWalBytes: pendingWal,
          walMerged,
          layoutMigration,
          method: request.method,
          durationMs: Date.now() - startMs,
          startedAt,
        });
        this.log.warn('db repair did not apply', {
          event: 'db-repair-failed',
          accountUin: target.uin,
          dbPath: target.dbPath,
          recordId: record.id,
          code: classified.code,
          error: classified.message,
        });
        history.pruneBackups(this.deps.keepBackups ?? DEFAULT_BACKUP_KEEP);
      } catch (reportError) {
        this.log.warn('could not save failed repair report', { error: String(reportError) });
      }
      if (cause instanceof DbRepairError) throw cause;
      const failure = new DbRepairError(classified.code, classified.message);
      if (
        /ENOSPC|SQLITE_FULL|database or disk is full|no space left|not enough space|os error 112|磁盘.*不足/i.test(
          classified.message,
        )
      ) {
        const shortage = new DbRepairError('insufficient-space', classified.message);
        shortage.storage = { ...storage, warning: 'insufficient-space' };
        throw shortage;
      }
      throw failure;
    } finally {
      clearInterval(spaceTimer);
      removeDirQuietly(join(paths.workDir, stamp));
      if (!preserveOriginal) removeDirQuietly(productDirectory);
      this.running = null;
    }
  }

  /** 一个账号的全部修复记录（最新在前）。 */
  listRecords(uin: string): DbRepairRecord[] {
    return this.history(uin).list();
  }

  /** 回滚前复核：备份还在吗？修完之后库又被写过吗？ */
  restorePreview(uin: string, recordId: string): DbRepairRestorePreview {
    const history = this.history(uin);
    const record = history.find(recordId);
    if (!record) throw new DbRepairError('not-found', `找不到修复记录：${recordId}`);
    const backupExists = history.backupExists(record);
    const currentSha = existsSync(record.dbPath) ? hashFileSync(record.dbPath).sha256 : null;
    return {
      record,
      backupExists,
      currentSha,
      matchesAfter:
        record.afterSha !== null &&
        currentSha === record.afterSha &&
        !hasRestoreJournal(record.dbPath),
    };
  }

  /**
   * 回滚到修复前。
   *
   * 主库与修复产物不一致，或仍有可能包含新数据的日志时，必须显式确认覆盖。
   */
  async restore(
    uin: string,
    recordId: string,
    options: { force?: boolean; progress?: (dbName: string, tick: DatabaseProgress) => void } = {},
  ): Promise<DbRepairRecord> {
    if (this.running) {
      throw new DbRepairError('busy', '已有修复任务在进行中，请等它结束再回滚');
    }
    const history = this.history(uin);
    const record = history.find(recordId);
    if (!record) throw new DbRepairError('not-found', `找不到修复记录：${recordId}`);
    if (!record.backupPath || !history.backupExists(record)) {
      throw new DbRepairError(
        'no-backup',
        record.backupPath ? '该记录的备份已被保留策略清理，无法回滚' : '该记录没有备份，无法回滚',
      );
    }
    if (!options.force && hasRestoreJournal(record.dbPath)) confirmRestoreChanges();
    this.checkRestoreLock(record.dbPath, uin);
    const stamp = this.operationStamp();
    const stagingDir = join(
      dirname(record.dbPath),
      `.${basename(record.dbPath)}.weq-restore-${stamp}`,
    );
    this.running = { dbPath: record.dbPath, startedAt: this.now().toISOString() };
    try {
      mkdirSync(stagingDir, { mode: 0o700 });
      const staged = join(stagingDir, 'verified-backup.db');
      try {
        options.progress?.(record.dbName, {
          step: 'restore-backup',
          message: '读取并校验备份',
        });
        const fingerprint = await backupFileAndHash(record.backupPath, staged, (completed, total) =>
          options.progress?.(record.dbName, {
            step: 'restore-backup',
            message: '读取并校验备份',
            completed,
            total,
            unit: 'bytes',
          }),
        );
        if (fingerprint.bytes !== record.beforeBytes || fingerprint.sha256 !== record.beforeSha) {
          throw new DbRepairError(
            'verify-failed',
            '备份大小或校验值与修复记录不符，未替换当前数据库。',
          );
        }
        this.deps.releaseHandles?.(uin, record.dbPath);
        if (!options.force) {
          const currentSha = existsSync(record.dbPath) ? hashFileSync(record.dbPath).sha256 : null;
          if (!record.afterSha || currentSha !== record.afterSha) confirmRestoreChanges();
        }
        const lock = this.checkRestoreLock(record.dbPath, uin);
        // 原子换入已经核对的文件；旧代日志只在替换成功后丢弃。
        options.progress?.(record.dbName, { step: 'restore-install', message: '正在恢复数据库' });
        this.replaceRestoredDatabase(record.dbPath, stagingDir, staged, uin, lock, !!options.force);
      } finally {
        removeQuietly(staged);
        try {
          rmdirSync(stagingDir);
        } catch {
          // 不能递归清理：失败后未归位的日志是恢复材料。
        }
      }
      const next = history.update(recordId, {
        state: 'rolled-back',
        restoredAt: this.now().toISOString(),
      });
      this.log.info('db repair rolled back', {
        event: 'db-repair-rolled-back',
        accountUin: record.uin,
        dbPath: record.dbPath,
        recordId,
      });
      return next ?? record;
    } finally {
      this.running = null;
    }
  }

  private checkRestoreLock(dbPath: string, uin: string): DbRepairLockClassification {
    const lock = this.classifyLock(dbPath, uin);
    if (lock.readiness === 'blocked-by-qq') {
      throw new DbRepairError(
        'blocked',
        `QQ 正在使用该数据库（${describeHolders(lock.qqHolders)}），请先结束 QQ 进程`,
      );
    }
    if (lock.readiness === 'blocked-by-other') {
      throw new DbRepairError(
        'blocked',
        `该数据库被其它进程占用（${describeHolders(lock.otherHolders)}）—— 请先关闭后再试`,
      );
    }
    return lock;
  }

  private replaceRestoredDatabase(
    dbPath: string,
    stagingDir: string,
    staged: string,
    uin: string,
    lock: DbRepairLockClassification,
    force: boolean,
  ): void {
    const detached: Array<{ path: string; saved: string }> = [];
    try {
      for (const suffix of RESTORE_SIDECARS) {
        const path = `${dbPath}${suffix}`;
        if (!lstatSync(path, { throwIfNoEntry: false })) continue;
        const saved = join(stagingDir, basename(path));
        renameSync(path, saved);
        detached.push({ path, saved });
      }
      if (!force && hasRestoreJournal(join(stagingDir, basename(dbPath)))) confirmRestoreChanges();
      if (
        RESTORE_SIDECARS.some((suffix) =>
          lstatSync(`${dbPath}${suffix}`, { throwIfNoEntry: false }),
        )
      ) {
        throw new DbRepairError(
          'blocked',
          '替换前发现数据库日志被重新打开，未替换主文件。请退出写库程序后重试。',
        );
      }
      this.replaceIntoPlace(staged, dbPath, uin, lock);
    } catch (error) {
      const remaining = detached.reverse().filter(({ path, saved }) => {
        try {
          if (lstatSync(path, { throwIfNoEntry: false })) return true;
          renameSync(saved, path);
          return false;
        } catch {
          return true;
        }
      });
      if (remaining.length) {
        throw new DbRepairError(
          'recover-failed',
          `未替换主文件，但部分数据库日志无法放回，原日志保留在 ${stagingDir}。请先不要打开或写入该库，关闭写库程序后检查这些日志。`,
        );
      }
      throw error;
    }
    for (const { saved } of detached) removeQuietly(saved);
  }

  /** 删掉一条记录的备份（释放空间）；记录保留并标记 `purgedAt`。 */
  deleteBackup(uin: string, recordId: string): { removed: boolean } {
    if (this.running) throw new DbRepairError('busy', '已有修复或回滚在进行，请等待完成');
    const history = this.history(uin);
    const record = history.find(recordId);
    if (!record) throw new DbRepairError('not-found', `找不到修复记录：${recordId}`);
    if (!record.backupPath || record.purgedAt !== undefined) return { removed: false };
    return history.deleteBackup(recordId, this.now().toISOString());
  }

  /**
   * 彻底删掉一条修复记录（连同它的备份）。
   *
   * 这是用户主动的"我不要这条历史了"，与 `deleteBackup`（只释放备份、记录留着）不同：
   * 记录一并消失，之后不能再回滚到这一条。正在跑的修复**不**受影响 —— 新记录还没落盘。
   */
  deleteRecord(uin: string, recordId: string): { removed: boolean } {
    if (this.running) throw new DbRepairError('busy', '已有修复或回滚在进行，请等待完成');
    const history = this.history(uin);
    const record = history.find(recordId);
    if (!record) throw new DbRepairError('not-found', `找不到修复记录：${recordId}`);
    const removed = history.remove(recordId);
    this.log.info('db repair record deleted', {
      event: 'db-repair-record-deleted',
      accountUin: uin,
      recordId,
      dbName: record.dbName,
      removed,
    });
    return { removed };
  }

  // ────────────────────────── 内部 ──────────────────────────

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private qqPid(uin: string): number | null {
    try {
      return this.deps.qqPid?.(uin) ?? null;
    } catch {
      return null;
    }
  }

  /** WeQ 自己的 pid；注入的取不到就退回当前进程（服务与探测同进程）。 */
  private selfPid(): number | null {
    try {
      return this.deps.selfPid?.() ?? process.pid;
    } catch {
      return process.pid;
    }
  }

  /**
   * 探测 + 归类。三个调用点（预检 / 替换前 / 回滚）共用一条口径 —— 分开写就容易出现
   * "预检认得出自己、替换前认不出"这种一半修好的状态。
   */
  private classifyLock(dbPath: string, uin: string): DbRepairLockClassification {
    const probe = this.deps.probeLock?.(dbPath) ?? null;
    return classifyLock(probe, this.qqPid(uin), this.selfPid());
  }

  private countBackups(uin: string): number {
    return new Set(
      this.history(uin)
        .list()
        .filter((record) => record.backupPath !== null && record.purgedAt === undefined)
        .map((record) => record.backupPath),
    ).size;
  }

  /** 把源库拷进缓存（含 sha256 + meta）。 */
  private writeBackup(
    target: DbRepairTarget,
    paths: DbRepairPaths,
    stamp: string,
    prepared?: { bytes: number; sha256: string },
  ): DbRepairBackupResult {
    const dest = paths.backupFile(stamp, target.dbName);
    const fingerprint = prepared ?? backupFileAndHashSync(target.dbPath, dest);
    try {
      writeFileAtomicSync(
        paths.backupMetaFile(stamp),
        `${JSON.stringify(
          {
            at: this.now().toISOString(),
            uin: target.uin,
            dataDir: target.dataDir,
            dbName: target.dbName,
            source: target.dbPath,
            bytes: fingerprint.bytes,
            sha256: fingerprint.sha256,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      // dest 由本次排他创建，元数据失败时不留下无法追踪的大文件。
      removeQuietly(dest);
      throw error;
    }
    return { path: dest, bytes: fingerprint.bytes, sha256: fingerprint.sha256 };
  }

  private assertScratchAvailable(): void {
    const scratch = this.deps.scratchDir?.();
    if (scratch && !isDirectory(scratch)) {
      throw new DbRepairError(
        'not-found',
        '自定义备份与修复工作区位置不可用，请重新选择；不会创建替代目录',
      );
    }
  }

  private operationStamp(): string {
    return `${makeStamp(this.now())}-${randomUUID()}`;
  }

  /** 把备份装回原位（先写同目录临时文件再 `rename`，失败不会毁掉当前文件）。 */
  private installFromBackup(
    backupPath: string,
    target: { dbDir: string; dbName: string },
    stamp: string,
    uin: string,
  ): void {
    const staged = productTempPath(target.dbDir, target.dbName, `${stamp}-restore`);
    copyFileAndHashSync(backupPath, staged);
    // 回滚与修复走同一条替换路径：Windows 上都可能被别的进程抢先把库打开。
    this.replaceIntoPlace(staged, join(target.dbDir, target.dbName), uin, null);
  }

  /**
   * 原子替换：把 `from`（同目录临时文件）放到 `to`（真正的库位置）上。
   *
   * 正常情况下这就是一句 `rename`。但在 Windows 上还有一条真实存在的失败路径：Restart
   * Manager 那次探测（{@link classifyLock}）与这次 `rename` 之间存在时间窗口，某个进程
   * （最典型的是用户刚点开的 QQ）可能刚好把库打开 —— 此时 `rename` 会抛 `EPERM` /
   * `EBUSY` / `EACCES`。裸的 Node 错误对用户毫无意义，所以这里把它翻译成"谁占着"。
   *
   * 只是**尽力而为的补充措辞**：重新探测一次是为了给用户一个 pid/进程名，探测不出就
   * 退回通用说法。源库此时一个字节都没动（产物还在临时路径上），所以怎么报都不会更糟。
   */
  private replaceIntoPlace(
    from: string,
    to: string,
    uin: string,
    /** 替换前那次归类（拿不到就再探一次时退回它）。`null` = 调用方没有现成的。 */
    lock: DbRepairLockClassification | null,
  ): void {
    try {
      replaceFileSync(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
      // 只有"被占用"这一类错误才值得重探；ENOSPC / EXDEV 之类与锁无关。
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        const holders = this.describeBlockers(this.classifyLock(to, uin), lock);
        this.log.warn('database replacement was blocked by an open handle', {
          event: 'db-repair-swap-blocked',
          dbPath: to,
          code,
          holders: holders.map((holder) => `${holder.name || '未知进程'}:${holder.pid}`),
        });
        throw new DbRepairError(
          'blocked',
          `写入数据库文件时被占用挡住（${describeHolders(holders)}），未替换主文件。关掉占着它的程序（QQ / 其它工具）后重试即可`,
        );
      }
      throw error;
    }
  }

  /** 报错时优先用"刚刚重探"的结果，它为空再退回替换前那次。 */
  private describeBlockers(
    fresh: DbRepairLockClassification,
    previous: DbRepairLockClassification | null,
  ): DbRepairLockHolder[] {
    return fresh.holders.length > 0 ? fresh.holders : (previous?.holders ?? []);
  }

  /**
   * 产物自检：先用 native 报告里的结论，再叠加调用方注入的复核（`checkDatabaseHealth`）。
   * 复核拿不到就只用报告 —— 回到 native 已经做过一遍 integrity_check 的事实。
   */
  private async verifyProduct(
    target: DbRepairTarget,
    recovered: DbRepairRecoverReport,
    progress: (tick: DatabaseProgress) => void,
  ): Promise<DbRepairRecoverVerification> {
    const verification: DbRepairRecoverVerification = { ...recovered.verification };
    let checking = true;
    const extra = await this.deps
      .verify?.(target.dbPath, target.key, target.algo, (tick) => {
        if (checking) progress(tick);
      })
      .finally(() => {
        checking = false;
      });
    if (!extra) return verification;
    const unverifiedTables = [
      ...new Set([...(verification.unverifiedTables ?? []), ...(extra.unverifiedTables ?? [])]),
    ];
    const coverageKnown =
      verification.complete !== undefined ||
      extra.complete !== undefined ||
      unverifiedTables.length > 0;
    return {
      ...verification,
      healthy: verification.healthy && extra.healthy,
      ...(coverageKnown
        ? {
            complete:
              verification.complete !== false &&
              extra.complete !== false &&
              unverifiedTables.length === 0,
            unverifiedTables,
          }
        : {}),
      corruptedTables: [...new Set([...verification.corruptedTables, ...extra.corruptedTables])],
    };
  }

  /** 落一条记录 + 写报告。 */
  private record(
    history: DbRepairHistory,
    paths: DbRepairPaths,
    input: {
      stamp: string;
      target: DbRepairTarget;
      state: DbRepairRecord['state'];
      error?: string;
      backup: DbRepairBackupResult | null;
      before: { bytes: number; sha256: string };
      after: { bytes: number; sha256: string } | null;
      recovered: DbRepairRecoverReport | null;
      durationMs: number;
      startedAt: string;
      pendingWalBytes: number;
      walMerged: boolean;
      layoutMigration: boolean;
      method?: DatabaseRepairMethod;
    },
  ): DbRepairRecord {
    const { target, recovered } = input;
    const record: DbRepairRecord = {
      id: `${input.stamp}-${target.dbName}`,
      at: input.startedAt,
      uin: target.uin,
      dataDir: target.dataDir,
      dbName: target.dbName,
      dbPath: target.dbPath,
      state: input.state,
      ...(input.error ? { error: input.error } : {}),
      backupPath: input.backup?.path ?? null,
      backupBytes: input.backup?.bytes ?? null,
      beforeSha: input.before.sha256,
      beforeBytes: input.before.bytes,
      afterSha: input.after?.sha256 ?? null,
      afterBytes: input.after?.bytes ?? null,
      badPages: recovered?.badPages ?? [],
      zeroPages: recovered?.zeroPages ?? [],
      pageSize: recovered?.pageSize ?? null,
      headerOffset: recovered?.headerOffset ?? null,
      kind: input.layoutMigration ? 'layout-migration' : 'repair',
      method: input.method,
      strictPages: recovered?.strictPages ?? false,
      sourcePages: recovered?.sourcePages ?? null,
      outputPages: recovered?.outputPages ?? null,
      scannedCells: recovered?.scannedCells ?? null,
      phases: recovered?.phases ?? [],
      verification: recovered?.verification ?? null,
      ...(recovered?.sourceLayout ? { sourceLayout: recovered.sourceLayout } : {}),
      ...(recovered?.targetLayout ? { targetLayout: recovered.targetLayout } : {}),
      pendingWalBytes: input.pendingWalBytes,
      walMerged: input.walMerged,
      durationMs: input.durationMs,
      reportPath: null,
    };

    const reportPath = paths.reportFile(input.stamp);
    try {
      writeFileAtomicSync(
        reportPath,
        renderDbRepairReportMarkdown(record, { appVersion: this.appVersion() }),
      );
      record.reportPath = reportPath;
    } catch (e) {
      this.log.warn('failed to write db repair report', {
        event: 'db-repair-report-write-failed',
        recordId: record.id,
        ...(e instanceof Error ? { error: e.message } : { error: String(e) }),
      });
    }

    return history.add(record);
  }

  /**
   * 把未合并的 WAL 合并回主文件。
   *
   * 成功判据是 native 报的 `merged`（它读 SQLite 的 `checkpointed >= log`），**不是
   * `-wal` 归零**：还有别的连接时 TRUNCATE 可能把所有帧都写回了却截不掉文件 —— 对我们
   * 来说"内容已经回到主文件"就够了。方法本身幂等（帧里存的是整页镜像），只做了一半也
   * 不会错。
   */
  private async mergePendingWal(target: DbRepairTarget, pendingWal: number): Promise<boolean> {
    if (pendingWal <= 0 || !this.deps.checkpointWal) return false;

    let result: DbRepairWalCheckpoint;
    try {
      result = await this.deps.checkpointWal(target.dbPath, target.key, target.algo);
    } catch (error) {
      this.log.warn('failed to merge the pending WAL before repairing', {
        event: 'db-repair-wal-merge-failed',
        accountUin: target.uin,
        dbPath: target.dbPath,
        pendingWalBytes: pendingWal,
        ...(error instanceof Error ? { error: error.message } : { error: String(error) }),
      });
      return false;
    }

    // 判据用 native 报的 `merged`（它读的是 SQLite 的 `checkpointed >= log`），不是文件大小：
    // 还有别的连接时 TRUNCATE 可能写回了全部帧却截不掉文件 —— "内容已经回到主文件"就够了。
    if (result?.merged !== true) {
      this.log.warn('checkpoint did not merge every pending WAL frame', {
        event: 'db-repair-wal-merge-incomplete',
        accountUin: target.uin,
        dbPath: target.dbPath,
        pendingWalBytes: pendingWal,
        busy: result?.busy ?? null,
        log: result?.log ?? null,
        checkpointed: result?.checkpointed ?? null,
        remainingBytes: pendingWalBytes(target.dbPath),
      });
      return false;
    }

    this.log.info('merged the pending WAL into the main file before repairing', {
      event: 'db-repair-wal-merged',
      accountUin: target.uin,
      dbPath: target.dbPath,
      mergedBytes: pendingWal,
      log: result.log,
      checkpointed: result.checkpointed,
    });
    return true;
  }

  private appVersion(): string | undefined {
    if (this.deps.appVersion) {
      try {
        return this.deps.appVersion();
      } catch {
        return undefined;
      }
    }
    try {
      return getHost().appVersion();
    } catch {
      return undefined;
    }
  }
}

// ────────────────────────── 纯函数小工具 ──────────────────────────

/**
 * 库文件名是否合法：**只能是纯文件名**（渲染层传来的值，必须挡住路径穿越）。
 *
 * 逐一挡掉：空串、`.`/`..`（`basename('..') === '..'`，只比 basename 挡不住它）、
 * 含分隔符、含 NUL、含 `:`（Windows 的盘符/数据流写法）。
 */
function isPlainDatabaseName(dbName: string): boolean {
  if (dbName === '' || dbName === '.' || dbName === '..') return false;
  if (dbName !== basename(dbName)) return false;
  return !/[/\\:\0]/.test(dbName);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 保留旧回调的单调 percent 契约；界面使用 detail 的步骤进度。 */
function progressGuard(
  onProgress: (progress: DbRepairProgress) => void,
): (progress: DbRepairProgress) => void {
  let last = -1;
  return (progress) => {
    const percent = Math.max(last, Math.max(0, Math.min(100, Math.round(progress.percent))));
    last = percent;
    onProgress({ ...progress, percent });
  };
}

/** 把失败归类成"中止"（源库没动）还是"尝试失败"。 */
function classifyFailure(error: unknown): {
  code: DbRepairErrorCode;
  state: DbRepairRecord['state'];
  message: string;
} {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'recover-failed',
      state: 'aborted',
      message:
        error.message === '已撤销本次数据库替换。'
          ? error.message
          : '修复已停止，尚未提交的临时重建已取消。',
    };
  }
  if (error instanceof DbRepairError) {
    const aborted: DbRepairErrorCode[] = ['changed-during-repair', 'blocked'];
    return {
      code: error.code,
      state: aborted.includes(error.code) ? 'aborted' : 'apply-failed',
      message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'recover-failed', state: 'apply-failed', message };
}

function describeHolders(holders: readonly DbRepairLockHolder[]): string {
  if (holders.length === 0) return '未知进程';
  return holders.map((holder) => `${holder.name || '未知进程'} (pid ${holder.pid})`).join('、');
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
