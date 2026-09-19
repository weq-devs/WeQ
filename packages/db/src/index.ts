/**
 * `@weq/db` — typed access to QQ NT databases.
 *
 * Package layout:
 *
 *   src/
 *     qq_db.ts        ← low-level handle: dbPath + key + native binding
 *     row.ts          ← row helpers (rowsToObjects)
 *     msg/            ← message-table business code (c2c / group / forward)
 *     <future>/       ← profile, file-watcher, ...
 *
 * Each business folder owns its types + Db classes and exposes them
 * through its own `index.ts`. This top-level barrel re-exports the
 * common surface so callers can `import { C2cMsgDb } from '@weq/db'`
 * without knowing the internal layout.
 *
 * The codec layer is invoked inside each Db class — consumers above the
 * db boundary see decoded `*Msg` shapes, not protobuf bytes.
 */

// --- low-level / shared ---
export { QqDb } from './qq_db';
export type { QqDbOptions } from './qq_db';
export { rowsToObjects } from './row';
export type { SalvageScanOutcome, SalvageSkippedRange } from '@weq/native';
export { isLikelyCorruptionError, wrapBindingForCorruption } from './errors';
export type { CorruptionSuspectInfo } from './errors';

// --- 损坏宽容（salvage）---
export {
  SALVAGE_BINDING_METHODS,
  SALVAGE_HEALTH_METHODS,
  SALVAGE_QUERY_METHODS,
  SALVAGE_SCAN_METHODS,
  SalvageLedger,
  assertSalvageCapable,
  clampSalvageLevel,
  describeSkipped,
  fingerprintSql,
  isSalvageEnabled,
  iterateSalvageWindows,
  missingSalvageMethods,
  runSalvageScan,
  spanOfRanges,
  subtractCoveredRanges,
  windowPlanFrom,
  wrapBindingForSalvage,
} from './salvage';
export type {
  SalvageBindingOptions,
  SalvageLedgerEntry,
  SalvageLevel,
  SalvageQueryError,
  SalvageScanRequest,
  SalvageScanTarget,
  SalvageStreamOptions,
  SalvageWindowExtras,
  SalvageWindowOptions,
  SalvageWindowPlan,
} from './salvage';

// --- msg business ---
export * from './msg';

// --- contact business ---
export * from './contact';

// --- group_info business ---
export * from './group_info';

// --- profile business ---
export * from './profile';

// --- file_assistant business ---
export * from './file_assistant';

// --- emoji business ---
export * from './emoji';

// --- collection business ---
export * from './collection';

// --- guild (QQ 频道) business ---
export * from './guild';
