/**
 * IPC protocol between the main process and `standardDbWorker`.
 *
 * `child_process.fork(..., { serialization: 'advanced' })` is required: query
 * results contain `bigint` (SQLite INTEGER) and `Uint8Array` (BLOB), which the
 * default JSON serializer would mangle.
 */

/** Methods the standard-SQLite worker is allowed to execute. */
export const STANDARD_DB_METHODS = [
  'executeSql',
  'executeSqlWrite',
  'executeSqlSalvage',
  'executeSqlSalvageScan',
  'closeDb',
  'closeSalvageDb',
  'closeAllDb',
  'listQuarantinedTables',
  'clearQuarantinedTables',
] as const;

export type StandardDbMethod = (typeof STANDARD_DB_METHODS)[number];

export interface StandardDbRequest {
  id: number;
  method: StandardDbMethod;
  args: unknown[];
}

export interface StandardDbError {
  name: string;
  message: string;
  stack?: string;
}

export type StandardDbResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: StandardDbError };

/** Errors cannot cross IPC as class instances; keep the parts callers use. */
export function serializeStandardDbError(error: unknown): StandardDbError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: 'Error', message: String(error) };
}

export function isStandardDbMethod(value: unknown): value is StandardDbMethod {
  return typeof value === 'string' && (STANDARD_DB_METHODS as readonly string[]).includes(value);
}
