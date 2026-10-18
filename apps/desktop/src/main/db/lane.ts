/**
 * Which SQLite process handles a binding method.
 *
 * SQLite's pager pending byte is a **process-global** in the amalgamation, so a
 * process cannot safely mix QQ-layout SQLCipher databases (1024-byte wrapper,
 * pending page 262144) with stock SQLite files (pending page 262145).  The
 * native side enforces one layout per process; this table is the matching JS
 * side decision:
 *
 *   - `main`     → the Electron main process addon, initialized as `qq`
 *   - `standard` → the forked standard-SQLite worker, initialized as `standard`
 *   - `both`     → bookkeeping that has to reach whichever lane owns a handle
 *
 * The split is by method name, not by inspecting the file: every `*WithKey`
 * method is SQLCipher/QQ layout, every plain method is stock SQLite.
 * Both decrypt modes (`fast` / `safe`) keep QQ page numbering even though the
 * output is plaintext, so their outputs are marked with `markQqLayout` and
 * later unkeyed calls for those paths stay on the main lane.
 */
export type DbLane = 'main' | 'standard' | 'both';

const ROUTED: Readonly<Record<string, Exclude<DbLane, 'main'>>> = {
  // --- stock SQLite query / write paths ---
  executeSql: 'standard',
  executeSqlWrite: 'standard',
  // --- stock SQLite salvage paths ---
  executeSqlSalvage: 'standard',
  executeSqlSalvageScan: 'standard',
  // --- cached-handle bookkeeping (must hit both processes) ---
  closeDb: 'both',
  closeSalvageDb: 'both',
  closeAllDb: 'both',
  clearQuarantinedTables: 'both',
};

/** Lane for `method`; anything not listed stays in the QQ/SQLCipher lane. */
export function dbLaneFor(method: string): DbLane {
  return ROUTED[method] ?? 'main';
}
