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
