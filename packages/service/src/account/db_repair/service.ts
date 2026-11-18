/**
 * 数据库重建与提交：消费已完成的常规扫描 → 备份 → 临时重建 → 替换 → 自检 → 记录。
 *
 * 账号级扫描及持续锁归 `maintenance.ts`。生产入口必须持有同一数据源的维护锁，
 * 不再扫描源库或以持续正常变化使扫描失效。备份指纹仍用于记录与恢复。
 * 原生重建在可停止的子进程中执行；提交前检查取消，提交开始后完成本库替换与复核。
 * 产物位于原库卷的本次专用目录，先转接维护锁再原子替换；失败尝试从备份还原。
 * 正常维护仅失效连接缓存，保留账号只读浏览；历史备份恢复保留原账号关闭流程。
 * 结束时只清理本次创建的产物和工作目录，每次修复均保留结果与报告。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseAlgorithms } from '@weq/native';
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
  diskSpace?(path: string): RepairDiskSpace;
  /** 由 uin 解析账号的库目录与密钥；解析不了（没配置）返回 `null`。 */
  resolveAccount(uin: string): DbRepairAccountInfo | null;
  /** native 修复（`recoverDatabase` 的适配）。 */
  recover(
    options: DbRepairRecoverOptions,
    onProgress: (progress: DbRepairProgress) => void,
    signal?: AbortSignal,
  ): Promise<DbRepairRecoverReport>;
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
  /** 是否先备份（默认 `true`）：没有备份就没有"后悔"。 */
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
  /** 当前账号维护锁标识，替换前将锁转接到临时产物。 */
  maintenanceId?: string;
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
  private resolveDatabasePath(
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
  preflight(uin: string, dbName: string, backup = true, maintenanceId?: string): DbRepairPreflight {
    this.assertScratchAvailable();
    const target = this.resolveTarget(uin, dbName);
    const lock = this.classifyLock(target.dbPath, uin);
    const dbBytes = fileBytes(target.dbPath) ?? 0;
    const paths = this.paths(uin);
    const walBytes = pendingWalBytes(target.dbPath);
    const storageOptimized = this.deps.storageOptimized?.() === true;
    const space = repairSpaceBudget({
      sourceDir: target.dbDir,
      cacheDir: dirname(paths.workDir),
      dbBytes,
      walBytes,
      backup: backup && !this.reusableBackup(target, maintenanceId),
      optimized: storageOptimized,
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
    const layoutMigration =
      request.layoutMigration === true || request.sourceScan.sourceLayout === 'standard';
    const retryBackup =
      request.backup === false ? null : this.reusableBackup(target, request.maintenanceId);
    const preflight = this.preflight(
      uin,
      request.dbName,
      request.backup !== false,
      request.maintenanceId,
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
    const checkSpace = () => {
      lastSpaceCheck = Date.now();
      const working = repairWorkingBytes(join(paths.workDir, stamp));
      const productBytes = repairWorkingBytes(productDirectory).allocated;
      // 文件释放与 IPC 进度可能先后到达，不把刚被删除的输入再次计入未来写入。
      let budgetPhase = latest.phase.toLowerCase();
      if (
        preflight.storageOptimized &&
        budgetPhase === 'repair' &&
        working.rebuilt > 0 &&
        !working.sourcePresent
      )
        budgetPhase = 'encrypt';
      if (
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
    const emit = (progress: DbRepairProgress, interrupt = true) => {
      if (!committing && interrupt) request.signal?.throwIfAborted();
      const phaseChanged = latest.phase !== progress.phase;
      latest = progress;
      if (!committing && (phaseChanged || Date.now() - lastSpaceCheck >= 1000)) checkSpace();
      guardedEmit({ ...progress, storage });
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
    try {
      mkdirSync(productDirectory, { mode: 0o700 });

      // 先合并 WAL（如果有）：必须在**备份之前**做，备份里才含最后那批改动。
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
        const fingerprint = await backupFileAndHash(
          target.dbPath,
          paths.backupFile(stamp, target.dbName),
          (completed, total) =>
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
            }),
        );
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
        guardedEmit({ ...latest, storage });
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
            ...(layoutMigration
              ? { sourceLayout: 'standard' as const, targetLayout: 'qq' as const }
              : {}),
          },
          (progress) => emit(progress, false),
          recoverSignal,
        );
        spaceAbort.signal.throwIfAborted();
      } finally {
        clearInterval(spaceTimer);
        spaceTimer = undefined;
      }
      request.signal?.throwIfAborted();

      // 已知不合格的产物不进入替换，也不为此触发原库还原。
      if (!recovered.verification.healthy || recovered.verification.badPages.length > 0) {
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
      const current = request.maintenanceId
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

      // ── 替换前：释放句柄 + 复核锁 ──
      request.signal?.throwIfAborted();
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
      // 提交开始后完成替换与验证；停止不回退已经提交成功的数据库。
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

      this.replaceIntoPlace(product, target.dbPath, target.uin, lockAgain);
      if (request.maintenanceId) this.deps.releaseHandles?.(uin, target.dbPath, true);
      after = await fingerprintFile(target.dbPath, (completed, total) =>
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
        }),
      );

      // ── 自检：产物不可用就自动还原（备份就是为了这一刻） ──
      emit({ phase: 'final-check', percent: 100, message: '复核替换后的数据库结构' });
      verification = await this.verifyProduct(target, recovered);
      if (!verification.healthy || verification.badPages.length > 0) {
        // 记录交给 catch 统一落盘（同 stamp → 同 id，不会写出两条），这里只负责
        // "把用户的库放回去"这件事，并且把原因说清。
        let restored = false;
        if (backup) {
          // 自检可能已经打开过产物（留下它那一代的 sidecar），还原前同样得清掉。
          removeSqliteSidecars(
            target.dbPath,
            request.maintenanceId ? ['-wal', '-journal'] : undefined,
          );
          if (request.maintenanceId) {
            const staged = join(productDirectory, `${target.dbName}.restore`);
            copyFileAndHashSync(backup.path, staged);
            this.deps.releaseHandles?.(uin, target.dbPath, true);
            await this.deps.protectProduct?.(request.maintenanceId, target.dbPath, staged);
            this.replaceIntoPlace(staged, target.dbPath, uin, null);
            this.deps.releaseHandles?.(uin, target.dbPath, true);
          } else this.installFromBackup(backup.path, target, stamp, target.uin);
          restored = true;
        }
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
        /ENOSPC|SQLITE_FULL|database or disk is full|no space left|磁盘.*不足/i.test(
          classified.message,
        )
      ) {
        failure.storage = { ...storage, warning: 'insufficient-space' };
      }
      throw failure;
    } finally {
      clearInterval(spaceTimer);
      removeDirQuietly(join(paths.workDir, stamp));
      removeDirQuietly(productDirectory);
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
      matchesAfter: record.afterSha !== null && currentSha === record.afterSha,
    };
  }

  /**
   * 回滚到修复前。
   *
   * `matchesAfter === false`（修完之后 QQ 又写过新消息）时**必须**显式 `force` ——
   * 否则"后悔"会变成"丢消息"。
   */
  restore(uin: string, recordId: string, options: { force?: boolean } = {}): DbRepairRecord {
    if (this.running) {
      throw new DbRepairError('busy', '已有修复任务在进行中，请等它结束再回滚');
    }
    const history = this.history(uin);
    const preview = this.restorePreview(uin, recordId);
    const record = preview.record;
    if (!record.backupPath || !preview.backupExists) {
      throw new DbRepairError(
        'no-backup',
        record.backupPath ? '该记录的备份已被保留策略清理，无法回滚' : '该记录没有备份，无法回滚',
      );
    }
    if (!preview.matchesAfter && !options.force) {
      throw new DbRepairError(
        'needs-confirm',
        '这个数据库在修复之后又被改动过（可能有新消息）—— 回滚会丢掉这些改动，请确认后重试。',
      );
    }

    const lock = this.classifyLock(record.dbPath, uin);
    if (lock.readiness === 'blocked-by-qq') {
      throw new DbRepairError(
        'blocked',
        `QQ 正在使用该数据库（${describeHolders(lock.qqHolders)}），请先结束 QQ 进程`,
      );
    }
    if (lock.readiness === 'blocked-by-other') {
      throw new DbRepairError(
        'blocked',
        `该数据库被其它进程占用（${describeHolders(lock.otherHolders)}）—— 请先关掉它们再试`,
      );
    }

    const stamp = this.operationStamp();
    this.running = { dbPath: record.dbPath, startedAt: this.now().toISOString() };
    try {
      this.deps.releaseHandles?.(uin, record.dbPath);
      // 回滚同理：现在旁边的 sidecar 属于**修复产物**，不能留给被还原的旧库。
      removeSqliteSidecars(record.dbPath);
      this.installFromBackup(
        record.backupPath,
        { dbDir: dirname(record.dbPath), dbName: record.dbName },
        stamp,
        uin,
      );
      const restored = hashFileSync(record.dbPath);
      if (restored.sha256 !== record.beforeSha) {
        throw new DbRepairError(
          'verify-failed',
          '回滚后的文件 sha256 与备份不一致，可能没有写入成功，请重试（原库仍在，未被破坏）',
        );
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
    // 先删记录再删目录：即使删目录失败，界面上这条也已经不在了（不会留半截）。
    const removed = history.remove(recordId);
    if (record.backupPath && !history.list().some((item) => item.backupPath === record.backupPath))
      removeDirQuietly(dirname(record.backupPath));
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
          `写入数据库文件时被占用挡住（${describeHolders(holders)}）—— 临时文件还在，源库没有被动过。关掉占着它的程序（QQ / 其它工具）后重试即可`,
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
  ): Promise<DbRepairRecoverVerification> {
    const verification: DbRepairRecoverVerification = { ...recovered.verification };
    const extra = await this.deps.verify?.(target.dbPath, target.key, target.algo);
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

/** 保留旧回调的单调 percent 契约；界面只使用 detail 的真实步骤计数。 */
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
      message: '修复已停止，尚未提交的临时重建已取消。',
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
