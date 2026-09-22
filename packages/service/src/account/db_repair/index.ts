/**
 * 数据库修复（妙妙工具 → 数据库修复）的服务层。
 *
 * 分层：
 *   - `types.ts`   公共类型（含 native `recoverDatabase` 的结构描述）
 *   - `paths.ts`   缓存目录布局与时间戳
 *   - `files.ts`   一次读算 sha256 / 分块拷贝 / 静默清理 / 可用空间
 *   - `lock.ts`    锁占用归类（QQ vs 其它进程）
 *   - `history.ts` 记录与备份保留策略
 *   - `checkup.ts` 体检结论（结构 + 页级 → 一句结论）
 *   - `report.ts`  人读报告
 *   - `service.ts` 编排：预检 → 备份 → 重建 → 安全替换 → 自检 → 记录/回滚
 *
 * 唯一入口是 {@link DbRepairService}；主进程注入依赖（platform / userConfig /
 * native），所以这一层可以离线单测（见 `packages/service/test/db_repair_*.test.ts`）。
 */

export {
  classifyLock,
  isQqProcessName,
  isSelfProcessName,
} from './lock';
export type { DbRepairLockClassification, DbRepairLockProbe } from './lock';
export { DEFAULT_BACKUP_KEEP, DbRepairHistory } from './history';
export {
  DB_REPAIR_CACHE_DIR,
  dbRepairPaths,
  dbRepairRoot,
  makeStamp,
  productTempPath,
  resolveAccountDbDir,
} from './paths';
export type { DbRepairPaths } from './paths';
export { concludeCheckup } from './checkup';
export type {
  DbRepairCheckup,
  DbRepairCheckupIntegrity,
  DbRepairCheckupPages,
  DbRepairCheckupVerdict,
} from './checkup';
export { renderDbRepairReportMarkdown } from './report';
export type { DbRepairReportOptions } from './report';
export { DbRepairError, DbRepairService } from './service';
export type {
  DbRepairAccountInfo,
  DbRepairBackupResult,
  DbRepairDeps,
  DbRepairErrorCode,
  DbRepairRequest,
} from './service';
export type {
  DbRepairAccountRef,
  DbRepairLockHolder,
  DbRepairPhase,
  DbRepairPreflight,
  DbRepairProgress,
  DbRepairReadiness,
  DbRepairRecord,
  DbRepairRecordState,
  DbRepairRecoverOptions,
  DbRepairRecoverPhaseTiming,
  DbRepairRecoverReport,
  DbRepairRecoverVerification,
  DbRepairRestorePreview,
  DbRepairTarget,
  DbRepairWalCheckpoint,
} from './types';
