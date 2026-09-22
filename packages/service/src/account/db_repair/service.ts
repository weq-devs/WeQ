/**
 * 数据库修复的编排：预检 → 备份 → native 重建 → 安全替换 → 自检 → 记录。
 *
 * # 为什么是这个顺序（每一步都有非做不可的理由）
 *
 * 1. **预检先看锁**：`probeDbLock` 是权威事实（谁持有这个文件），进程名只是给界面
 *    措辞用的。QQ 还开着就直接拒绝 —— 解密是手工页解密，边写边读必然撕裂。
 * 2. **备份在解密之前**：备份时算出的 sha256 同时是后面那道"修复期间是否被写入"的基准。
 * 3. **产物先写同目录临时文件**：替换走 `rename`，只有同分区才原子（跨盘会 `EXDEV`）。
 *    产物本身已经是加密库，临时落在 QQ 目录里不涉及明文泄露。
 * 4. **替换前重算源库 sha256**：WeQ 自己也有写库路径（助手 ARK 同步、搜索索引、
 *    db 编辑器）。只要期间被写过就**中止** —— 源库一个字节没动，用户关掉账号重试即可。
 *    这是"允许开着账号修"这个选择必须配的保险，否则解密可能读到撕裂页。
 * 5. **替换前先释放句柄**：Windows 下占用会让 `rename` 直接失败；Linux 更阴 ——
 *    `rename` 会成功，但旧 inode 仍被占用，WeQ 会继续读旧内容。所以句柄必须先关。
 * 6. **自检不过就自动还原**：产物不可用而我们还留着备份，就没有任何理由把坏产物留在
 *    用户的库位置上。
 *
 * # 不做的事
 *
 * * **不改源库**（除了最后那一次原子替换）：任何一步失败，源库都是原样。
 * * **不自动降级宽容**：那是设置页里用户显式选的东西，与修复无关。
 * * **不承诺零丢失**：只给对账口径（见 `report.ts`）。
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseAlgorithms } from '@weq/native';
import { writeFileAtomicSync } from '../../common/atomic_write';
import { getHost } from '../../common/host';
import { getLogger } from '../../common/logger';
import {
  copyFileAndHashSync,
  fileBytes,
  freeBytesAt,
  hashFileSync,
  pendingWalBytes,
  removeDirQuietly,
  removeQuietly,
  removeSqliteSidecars,
  replaceFileSync,
  sweepStaleProducts,
} from './files';
import { DEFAULT_BACKUP_KEEP, DbRepairHistory } from './history';
import { classifyLock, type DbRepairLockClassification, type DbRepairLockProbe } from './lock';
import {
  dbRepairPaths,
  dbRepairRoot,
  makeStamp,
  productTempPath,
  type DbRepairPaths,
} from './paths';
import { renderDbRepairReportMarkdown } from './report';
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
  /** 由 uin 解析账号的库目录与密钥；解析不了（没配置）返回 `null`。 */
  resolveAccount(uin: string): DbRepairAccountInfo | null;
  /** native 修复（`recoverDatabase` 的适配）。 */
  recover(
    options: DbRepairRecoverOptions,
    onProgress: (progress: DbRepairProgress) => void,
  ): Promise<DbRepairRecoverReport>;
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
   * 释放该库的所有句柄：修的就是当前打开的账号时关掉它（`bootstrap.closeAccount`
   * → 逐个 `Db.close()`），否则至少关掉该库的连接，并清掉宽容链路的只读连接。
   * **替换前必须调用**（调用方保证幂等）。
   */
  releaseHandles?(uin: string, dbPath: string): void;
  /** 替换后的额外复核（native `checkDatabaseHealth`）。 */
  verify?(
    dbPath: string,
    key: string,
    algo: DatabaseAlgorithms,
  ): Promise<{ healthy: boolean; corruptedTables: string[] } | null>;
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
  /** 严格页模式：坏页先清零，内容一定经过校验，代价是那些行明确丢失。 */
  strictPages?: boolean;
  /** 是否从 freelist 捞已删除的记录（默认 `false`；打开会"复活"已删除消息）。 */
  recoverFreelist?: boolean;
  /** 孤立页回收表名；空字符串表示不做孤立页回收。 */
  lostAndFoundName?: string;
  /** 先建索引再灌数据（默认 `false`）：进度更连续但整体更慢。 */
  slowIndexes?: boolean;
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
  private readonly log = getLogger().child({ scope: 'db-repair' });
  /** 当前正在跑的修复（同一时刻只允许一个：两个任务互相覆盖是灾难）。 */
  private running: { dbPath: string; startedAt: string } | null = null;

  constructor(private readonly deps: DbRepairDeps) {}

  /** 是否有修复在进行（界面用来禁用按钮）。 */
  isBusy(): boolean {
    return this.running !== null;
  }

  /** 该账号的修复根目录与路径碎片（路径来自 `resolveAccount`，不来自渲染层）。 */
  paths(uin: string): DbRepairPaths {
    const info = this.accountInfo(uin);
    return dbRepairPaths(dbRepairRoot(this.deps.cacheDir, uin, info.dataDir));
  }

  history(uin: string): DbRepairHistory {
    const paths = this.paths(uin);
    let history = this.histories.get(paths.root);
    if (!history) {
      history = new DbRepairHistory(paths);
      this.histories.set(paths.root, history);
    }
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
    if (!isPlainDatabaseName(dbName)) {
      throw new DbRepairError('not-found', `非法的数据库文件名：${dbName}`);
    }
    const info = this.accountInfo(uin);
    if (info.dbKey === '') {
      throw new DbRepairError(
        'no-credentials',
        `账号 ${uin} 没有可用的数据库密钥，无法修复（先用 WeQ 打开一次该账号）`,
      );
    }
    const dbDir = info.dbDir;
    const dbPath = join(dbDir, dbName);
    // 必须是**普通文件**：只查 existsSync 的话 `..` 这类名字会指向目录，
    // 而后面所有步骤都假定 dbPath 是一个可以整体替换的库文件。
    if (!isRegularFile(dbPath)) {
      throw new DbRepairError('not-found', `数据库不存在或不是文件：${dbPath}`);
    }
    // 逐库算法缺失时回退 nt_msg.db 那份（与 `algoFor` 同一个口径）。
    const algo = info.algos[dbName] ?? info.algos['nt_msg.db'];
    if (!algo) {
      throw new DbRepairError('no-credentials', `账号配置里没有 ${dbName} 的加密算法信息`);
    }
    return { uin, dataDir: info.dataDir, dbName, dbDir, dbPath, key: info.dbKey, algo };
  }

  /**
   * 预检：能不能开修。只读、不落盘。
   *
   * `unknown-lock` 不阻断（探测失败 ≠ 没锁）：真正的把关在替换前那道复核。
   * `self-hold`（只有 WeQ 自己拿着句柄）同样不阻断 —— 见 {@link classifyLock}。
   */
  preflight(uin: string, dbName: string): DbRepairPreflight {
    const target = this.resolveTarget(uin, dbName);
    const lock = this.classifyLock(target.dbPath, uin);
    const dbBytes = fileBytes(target.dbPath) ?? 0;
    return {
      ...target,
      readiness: lock.readiness,
      holders: lock.holders,
      qqHolders: lock.qqHolders,
      selfHolders: lock.selfHolders,
      otherHolders: lock.otherHolders,
      dbBytes,
      freeBytes: freeBytesAt(target.dbDir),
      // 明文中间件 + 产物 + 备份，各约一个库大小。
      requiredBytes: dbBytes * 3,
      keyPresent: target.key !== '',
      backupsKept: this.countBackups(uin),
      pendingWalBytes: pendingWalBytes(target.dbPath),
    };
  }

  /** 手动备份（界面上独立的"立即备份"按钮）。 */
  backup(uin: string, dbName: string, stamp?: string): DbRepairBackupResult {
    const target = this.resolveTarget(uin, dbName);
    return this.writeBackup(target, this.paths(uin), stamp ?? makeStamp(this.now()));
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
    if (this.running) {
      throw new DbRepairError(
        'busy',
        `已有修复任务在进行中（${this.running.dbPath}），请等它结束再试`,
      );
    }

    const { uin } = request;
    const target = this.resolveTarget(uin, request.dbName);
    const preflight = this.preflight(uin, request.dbName);
    if (preflight.freeBytes !== null && preflight.freeBytes < preflight.requiredBytes) {
      throw new DbRepairError(
        'insufficient-space',
        `磁盘空间不足：需要约 ${formatMb(preflight.requiredBytes)}，当前可用 ${formatMb(preflight.freeBytes)}`,
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
    const stamp = makeStamp(this.now());
    const product = productTempPath(target.dbDir, target.dbName, stamp);
    const startedAt = this.now().toISOString();
    const startMs = Date.now();
    const emit = progressGuard(onProgress);
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
      // 上次中途被杀掉留下的临时产物先清掉，别把它们算进"是不是我写的"。
      sweepStaleProducts(target.dbDir, target.dbName);

      // 先合并 WAL（如果有）：必须在**备份之前**做，备份里才含最后那批改动。
      walMerged = await this.mergePendingWal(target, pendingWal);

      emit({ phase: 'backup', percent: 0, message: '备份到 WeQ 缓存…' });
      if (request.backup === false) {
        before = hashFileSync(target.dbPath);
      } else {
        backup = this.writeBackup(target, paths, stamp);
        before = { bytes: backup.bytes, sha256: backup.sha256 };
      }
      emit({
        phase: 'backup',
        percent: 1,
        message: backup ? `已备份 ${formatMb(backup.bytes)}` : '已跳过备份（按请求）',
      });

      recovered = await this.deps.recover(
        {
          dbPath: target.dbPath,
          outPath: product,
          workDir: paths.workDir,
          key: target.key,
          algo: target.algo,
          strictPages: request.strictPages,
          recoverFreelist: request.recoverFreelist,
          lostAndFoundName: request.lostAndFoundName,
          slowIndexes: request.slowIndexes,
        },
        (progress) => emit(progress),
      );

      // ── 保险：修复期间源库被写过就中止（源库一个字节没动） ──
      const current = hashFileSync(target.dbPath);
      if (current.sha256 !== before.sha256) {
        throw new DbRepairError(
          'changed-during-repair',
          '修复期间该数据库被改动（很可能来自 WeQ 自己的写入），已中止且未改动源库。请关闭该账号后重试。',
        );
      }

      // ── 替换前：释放句柄 + 复核锁 ──
      this.deps.releaseHandles?.(uin, target.dbPath);
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
          `替换前复核发现该数据库被其它进程占用（${describeHolders(lockAgain.otherHolders)}）—— 这些进程 WeQ 关不掉，请先关掉它们再试（已中止，源库未改动）`,
        );
      }

      // sidecar 属于被换掉的那份库：留着它，新库连 `PRAGMA journal_mode` 都读不了
      // （实测见 `files.ts` 的 `removeSqliteSidecars`）。
      const removedSidecars = removeSqliteSidecars(target.dbPath);
      if (removedSidecars.length > 0) {
        this.log.info('removed stale sqlite sidecars before swapping', {
          event: 'db-repair-removed-sidecars',
          dbPath: target.dbPath,
          removed: removedSidecars,
        });
      }

      this.replaceIntoPlace(product, target.dbPath, target.uin, lockAgain);
      after = hashFileSync(target.dbPath);

      // ── 自检：产物不可用就自动还原（备份就是为了这一刻） ──
      verification = await this.verifyProduct(target, recovered);
      if (!verification.healthy || verification.badPages.length > 0) {
        // 记录交给 catch 统一落盘（同 stamp → 同 id，不会写出两条），这里只负责
        // "把用户的库放回去"这件事，并且把原因说清。
        let restored = false;
        if (backup) {
          // 自检可能已经打开过产物（留下它那一代的 sidecar），还原前同样得清掉。
          removeSqliteSidecars(target.dbPath);
          this.installFromBackup(backup.path, target, stamp, target.uin);
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

      emit({ phase: 'done', percent: 100, message: '修复完成' });
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
      return record;
    } catch (error) {
      removeQuietly(product);
      const classified = classifyFailure(error);
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
      if (error instanceof DbRepairError) throw error;
      throw new DbRepairError(classified.code, classified.message);
    } finally {
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

    const stamp = makeStamp(this.now());
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
    const history = this.history(uin);
    const record = history.find(recordId);
    if (!record) throw new DbRepairError('not-found', `找不到修复记录：${recordId}`);
    if (!record.backupPath || record.purgedAt !== undefined) return { removed: false };
    const path = record.backupPath;
    removeDirQuietly(dirname(path));
    history.update(recordId, { purgedAt: this.now().toISOString() });
    return { removed: !existsSync(path) };
  }

  /**
   * 彻底删掉一条修复记录（连同它的备份）。
   *
   * 这是用户主动的"我不要这条历史了"，与 `deleteBackup`（只释放备份、记录留着）不同：
   * 记录一并消失，之后不能再回滚到这一条。正在跑的修复**不**受影响 —— 新记录还没落盘。
   */
  deleteRecord(uin: string, recordId: string): { removed: boolean } {
    const history = this.history(uin);
    const record = history.find(recordId);
    if (!record) throw new DbRepairError('not-found', `找不到修复记录：${recordId}`);
    // 先删记录再删目录：即使删目录失败，界面上这条也已经不在了（不会留半截）。
    const removed = history.remove(recordId);
    if (record.backupPath) removeDirQuietly(dirname(record.backupPath));
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
    return this.history(uin)
      .list()
      .filter((record) => record.backupPath !== null && record.purgedAt === undefined).length;
  }

  /** 把源库拷进缓存（含 sha256 + meta）。 */
  private writeBackup(
    target: DbRepairTarget,
    paths: DbRepairPaths,
    stamp: string,
  ): DbRepairBackupResult {
    const dest = paths.backupFile(stamp, target.dbName);
    const fingerprint = copyFileAndHashSync(target.dbPath, dest);
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
    return { path: dest, bytes: fingerprint.bytes, sha256: fingerprint.sha256 };
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
    return {
      ...verification,
      healthy: verification.healthy && extra.healthy,
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
      strictPages: recovered?.strictPages ?? false,
      sourcePages: recovered?.sourcePages ?? null,
      outputPages: recovered?.outputPages ?? null,
      scannedCells: recovered?.scannedCells ?? null,
      phases: recovered?.phases ?? [],
      verification: recovered?.verification ?? null,
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

/** 进度保险：百分比单调不回退（native 的估算与 TS 插入的步骤之间不该出现倒扣）。 */
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
