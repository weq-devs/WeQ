/**
 * Thin handle around one open QQ NT SQLCipher database.
 *
 * The native layer (`@weq/native`) already caches a Connection per
 * `(dbPath, mode)` and skips the open/decrypt dance on subsequent calls.
 * `QqDb` is the matching JS-side convenience: it remembers `dbPath` + `key`
 * so callers don't pass them on every query.
 *
 * Construction does NOT open the database — the first `query()` / `write()`
 * call triggers the open inside native. `close()` drops the cached native
 * connection (e.g. on account switch / app shutdown).
 */

import type {
  NtHelperBinding,
  SqlRow,
  SqlValue,
  DatabaseAlgorithms,
} from '@weq/native';

export interface QqDbOptions {
  /** Absolute path to the QQ NT database file (encrypted, with QQ wrapper). */
  dbPath: string;
  /** SQLCipher key (hex passphrase or raw ASCII — both work). */
  key: string;
  /** Cryptographic algorithms used for this database. */
  algo: DatabaseAlgorithms;
}

export class QqDb {
  readonly dbPath: string;
  private readonly key: string;
  private readonly algo: DatabaseAlgorithms;
  private readonly nt: NtHelperBinding;

  constructor(nt: NtHelperBinding, opts: QqDbOptions) {
    this.nt = nt;
    this.dbPath = opts.dbPath;
    this.key = opts.key;
    this.algo = opts.algo;
  }

  /**
   * Execute a SELECT against this database. Returns rows as positional
   * `SqlValue` arrays. Use `rowsToObjects` from `./row` if you have a
   * static column list and prefer named access.
   */
  query(sql: string, params?: SqlValue[]): Promise<SqlRow[]> {
    return this.nt.executeSqlWithKey(this.dbPath, sql, this.key, this.algo, params ?? null);
  }

  /**
   * Execute an INSERT / UPDATE / DELETE. Returns the number of rows affected.
   *
   * ⚠️ Writes go to QQ's live database. Always back up first and prefer to
   *    run with QQ fully closed.
   */
  write(sql: string, params?: SqlValue[]): Promise<number> {
    return this.nt.executeSqlWriteWithKey(this.dbPath, sql, this.key, this.algo, params ?? null);
  }

  /** Drop both the read and write cached native connections for this database. */
  close(): void {
    this.nt.closeDb(this.dbPath);
  }
}
