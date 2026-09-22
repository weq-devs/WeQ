/**
 * 数据库修复（妙妙工具 → 数据库修复）的公共类型。
 *
 * 这一层只描述"要修哪个库、修完是什么样、怎么后悔"，不掺任何 IO —— 具体落盘在
 * `paths.ts` / `files.ts` / `history.ts`，编排在 `service.ts`，报告在 `report.ts`。
 *
 * 与 native 的关系：`recoverDatabase` 的入参/产出**结构一致**地在这里重述一遍。
 * 为什么不用 `@weq/native` 的类型：native 的 `.node` 是**按平台各自下载**的，老产物
 * 没有这个方法；service 层如果直接依赖那些类型，就会把"产物能力"变成"编译期依赖"。
 * 这里用结构类型，调用方（router）负责把 native 的实现适配进来，缺方法时在那里报
 * "重新取产物"，与 salvage 链路同一套做法。
 */

import type { DatabaseAlgorithms } from '@weq/native';

/** 一个账号 + 它的数据目录 —— 与 `accountConfigId(uin, dataDir)` 是同一套主键。 */
export interface DbRepairAccountRef {
  uin: string;
  /** 账号数据目录；`null` = 走平台默认解析（静态账号会带自己的目录）。 */
  dataDir: string | null;
}

/** 解析完成、可以开修的一个目标。 */
export interface DbRepairTarget extends DbRepairAccountRef {
  /** 库文件名，例如 `nt_msg.db`。 */
  dbName: string;
  /** 库所在目录（绝对路径）。 */
  dbDir: string;
  /** 库文件绝对路径。 */
  dbPath: string;
  /** SQLCipher 口令（来自账号配置）。 */
  key: string;
  /** 该库的页 HMAC × KDF HMAC 组合。 */
  algo: DatabaseAlgorithms;
}

/**
 * 进度阶段。
 *
 * 前六个是 native 报上来的（`RecoverPhase` 的字符串枚举）；后三个是 TS 侧在 native
 * 前后补的步骤。**别在这里做百分比换算** —— native 给的就是整体百分比，TS 只负责
 * 在它前后插两条消息，不重排进度轴（否则"阶段内估算"和"真实进度"会打架）。
 */
export type DbRepairPhase =
  | 'backup'
  | 'Scan'
  | 'Decrypt'
  | 'Repair'
  | 'Encrypt'
  | 'Restore'
  | 'Verify'
  | 'swapping'
  | 'done';

/** 一次进度回调。`percent` 单调不回退。 */
export interface DbRepairProgress {
  phase: DbRepairPhase | string;
  percent: number;
  message: string;
}

/** native `checkpointWal` 的产出（结构类型，理由同文件头）。 */
export interface DbRepairWalCheckpoint {
  /** 1 = 被别的连接挡住了，帧没能全部写回。 */
  busy: number;
  /** `-wal` 里的帧数（-1 = 不在 WAL 模式）。 */
  log: number;
  /** 写回主文件的帧数（-1 = WAL 已被重置）。 */
  checkpointed: number;
  /** checkpoint 之后 `-wal` 的字节数。 */
  walBytes: number;
  /** **结论**：帧是否已完整回到主文件。这个才是能不能继续的判断依据。 */
  merged: boolean;
}

/** native `recoverDatabase` 的入参。 */
export interface DbRepairRecoverOptions {
  /** 加密的源库（只读）。 */
  dbPath: string;
  /** 修复产物落盘位置。**必须与源库同盘**（替换走 rename）。 */
  outPath: string;
  /** 明文中间件目录（native 用完自删）。 */
  workDir: string;
  key: string;
  algo: DatabaseAlgorithms;
  strictPages?: boolean;
  recoverFreelist?: boolean;
  lostAndFoundName?: string;
  slowIndexes?: boolean;
}

/** native `recoverDatabase` 的产物自检。 */
export interface DbRepairRecoverVerification {
  healthy: boolean;
  corruptedTables: string[];
  /** 产物里仍然页 HMAC 失败的页（正常为空）。 */
  badPages: number[];
  tables: number;
  indexes: number;
  ms: number;
}

/** native `recoverDatabase` 的阶段耗时。 */
export interface DbRepairRecoverPhaseTiming {
  phase: string;
  ms: number;
}

/** native `recoverDatabase` 的报告（只列我们落盘/展示要用的字段）。 */
export interface DbRepairRecoverReport {
  durationMs: number;
  sourceBytes: number;
  outputBytes: number;
  headerOffset: number;
  pageSize: number;
  sourcePages: number;
  outputPages: number;
  /** 源库物理坏页（内容未经 HMAC 校验的那几页）。 */
  badPages: number[];
  zeroPages: number[];
  strictPages: boolean;
  /** 扫过的 cell 数量（不是行数）。 */
  scannedCells: number;
  phases: DbRepairRecoverPhaseTiming[];
  verification: DbRepairRecoverVerification;
}

/** 锁持有者（`probeDbLock` 的产出）。 */
export interface DbRepairLockHolder {
  pid: number;
  name: string;
}

/** 预检结论：能不能开修。 */
export type DbRepairReadiness =
  /** 没有进程持有该库，可以直接修。 */
  | 'ready'
  /** QQ 持有（`qqHolders` 里给 pid，界面可提供"结束 QQ 进程"）。 */
  | 'blocked-by-qq'
  /** 既不是 QQ、也不是 WeQ 的第三方进程持有 —— 我们关不掉它，只能让用户自己处理。 */
  | 'blocked-by-other'
  /**
   * **只有 WeQ 自己**持有（`selfHolders` 里给 pid）。
   *
   * 不算阻断：那是我们自己的句柄，替换前 `releaseHandles()` 会关掉。之所以要单独成
   * 一档而不是并入 `ready`，是因为界面上它值得单独说一句（Windows 的 Restart Manager
   * 必定会列出 WeQ 自己），而文案与 `ready` 不同。
   */
  | 'self-hold'
  /** 锁探测本身失败（权限 / 平台不支持）：不阻断，但替换前会再查一次。 */
  | 'unknown-lock';

/** 开修前的检查结果（只读，不落盘）。 */
export interface DbRepairPreflight extends DbRepairTarget {
  readiness: DbRepairReadiness;
  /** 全部持有者（探测失败时为空数组）。 */
  holders: DbRepairLockHolder[];
  /** 其中被判为 QQ 的（界面"结束 QQ 进程"用）。 */
  qqHolders: DbRepairLockHolder[];
  /** 其中被判为 WeQ 自己的（不阻断；界面据此说"这是我们自己开的，替换时会关"）。 */
  selfHolders: DbRepairLockHolder[];
  /** 其中被判为第三方进程的（真阻断）。 */
  otherHolders: DbRepairLockHolder[];
  /** 源库字节数。 */
  dbBytes: number;
  /** 源库所在分区的可用空间；探测不到为 `null`（不阻断）。 */
  freeBytes: number | null;
  /** 本次修复需要的空间估算：明文中间件 + 产物 + 备份 ≈ 3× 源库。 */
  requiredBytes: number;
  /** 账号配置里有 key。 */
  keyPresent: boolean;
  /** 已有备份份数（超过保留上限会淘汰最旧那份）。 */
  backupsKept: number;
  /**
   * 未合并的 `-wal` 字节数（0 = 没有）。
   *
   * 非零说明**主文件缺了最后一批改动** —— 修复走的是页级读取，只看得见主文件，
   * 所以这部分不在修复范围内。界面应当先提醒用户（正常关一次 QQ 就会合并），
   * 而不是修完才发现少了消息。
   */
  pendingWalBytes: number;
}

/** 一次修复记录（历史里的一条）。 */
export type DbRepairRecordState =
  /** 已替换成功。 */
  | 'applied'
  /** 中止：源库没被动过（期间被写入、替换前仍被锁、或调用方取消）。 */
  | 'aborted'
  /** 尝试失败（native 报错，或产物自检不过）。 */
  | 'apply-failed'
  /** 已回滚到修复前。 */
  | 'rolled-back';

export interface DbRepairRecord extends DbRepairAccountRef {
  /** `${stamp}-${dbName}`，历史里的主键。 */
  id: string;
  at: string;
  dbName: string;
  dbPath: string;
  state: DbRepairRecordState;
  /** 失败/中止原因（`applied` 时为空）。 */
  error?: string;
  /** 备份文件绝对路径；没做备份时为 `null`。 */
  backupPath: string | null;
  backupBytes: number | null;
  /** 修复前的源库 sha256（同时是"期间是否被写入"的比对基准）。 */
  beforeSha: string;
  beforeBytes: number;
  /** 替换后的产物 sha256；中止/失败时为 `null`。 */
  afterSha: string | null;
  afterBytes: number | null;
  badPages: number[];
  zeroPages: number[];
  pageSize: number | null;
  headerOffset: number | null;
  strictPages: boolean;
  sourcePages: number | null;
  outputPages: number | null;
  scannedCells: number | null;
  phases: DbRepairRecoverPhaseTiming[];
  verification: DbRepairRecoverVerification | null;
  /**
   * 开始修复时源库未合并的 `-wal` 字节数（0 = 没有）。
   *
   * 非零 = 那批改动**没有被修复进去**（页级读取看不到 WAL 帧）。这个数字必须留在
   * 记录与报告里：否则用户只会看到"修完少了几条消息"，而我们什么也没说。
   */
  pendingWalBytes: number;
  /**
   * 那批未合并的 WAL 是否已经在修复前**合并回主文件**了。
   *
   * `true` = 最后一批改动已包含在本次修复与备份里（`pendingWalBytes` 只是"当时有多少"）；
   * `false` 且 `pendingWalBytes > 0` = 合并没做成，那批改动**没修进去**，必须告诉用户。
   */
  walMerged: boolean;
  durationMs: number;
  /** 回滚时间（`rolled-back` 时才有）。 */
  restoredAt?: string;
  /** 备份被保留策略清理的时间（记录留着，但不能再回滚）。 */
  purgedAt?: string;
  /** 人读报告路径。 */
  reportPath: string | null;
}

/** 回滚前的复核（界面据此决定要不要二次确认）。 */
export interface DbRepairRestorePreview {
  record: DbRepairRecord;
  /** 备份文件是否还在。 */
  backupExists: boolean;
  /** 当前库的 sha256。 */
  currentSha: string | null;
  /** 当前库是否仍是"修复后那一份"（`afterSha` 一致）。`false` = 之后又被写过。 */
  matchesAfter: boolean;
}
