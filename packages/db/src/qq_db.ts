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
  SalvageScanOutcome,
  SqlRow,
  SqlValue,
  DatabaseAlgorithms,
} from '@weq/native';
import {
  iterateSalvageWindows,
  runSalvageScan,
  type SalvageBindingOptions,
  type SalvageScanRequest,
  type SalvageWindowExtras,
  type SalvageWindowPlan,
} from './salvage';

export interface QqDbOptions {
  /** Absolute path to the QQ NT database file (encrypted, with QQ wrapper). */
  dbPath: string;
  /**
   * SQLCipher key (hex passphrase or raw ASCII — both work).
   * Omit (or set to an empty string) for already-decrypted plain SQLite databases.
   */
  key?: string;
  /**
   * Cryptographic algorithms used for this database.
   * Omit for plain (already-decrypted) databases.
   */
  algo?: DatabaseAlgorithms;
}

export class QqDb {
  readonly dbPath: string;
  private readonly key?: string;
  private readonly algo?: DatabaseAlgorithms;
  private readonly nt: NtHelperBinding;
  private readonly encrypted: boolean;

  constructor(nt: NtHelperBinding, opts: QqDbOptions) {
    this.nt = nt;
    this.dbPath = opts.dbPath;
    this.key = opts.key;
    this.algo = opts.algo;
    this.encrypted = !!opts.key && !!opts.algo;
  }

  /**
   * Execute a SELECT against this database. Returns rows as positional
   * `SqlValue` arrays. Use `rowsToObjects` from `./row` if you have a
   * static column list and prefer named access.
   */
  query(sql: string, params?: SqlValue[]): Promise<SqlRow[]> {
    if (this.encrypted) {
      return this.nt.executeSqlWithKey(this.dbPath, sql, this.key!, this.algo!, params ?? null);
    }
    return this.nt.executeSql(this.dbPath, sql, params ?? null);
  }

  /**
   * 损坏宽容的分块扫描（L2/L3）：按 key 区间切块读取，读不出来的块先换访问路径、
   * 再二分，最后把读不出来的区间记成"跳过区间"并如实汇报。
   *
   * 与 `query()` 的差别：`query()` 是一条语句一次性读完（遇到损坏就整体失败），
   * 而 `scan()` 会在**用户授权**的范围内尽量多地把数据读出来。代价是可能缺数据，
   * 所以它：严格级别直接拒绝；`ok === false`（超预算 / 未授权 L2 / 表被隔离）照旧
   * 抛错；每一次跳过都进账本。
   *
   * SQL 契约：末两个 `?` 是 `(lo, hi)`、结果按 key 升序、**第一列是整数 key**
   * （一般是 `rowid`）—— native 侧靠它记录"坏区间的前后邻居"。
   */
  scan(
    sql: string,
    request: SalvageScanRequest,
    salvage: SalvageBindingOptions,
  ): Promise<SalvageScanOutcome> {
    return runSalvageScan(
      this.nt,
      {
        dbPath: this.dbPath,
        ...(this.encrypted ? { key: this.key!, algo: this.algo! } : {}),
      },
      sql,
      request,
      salvage,
    );
  }

  /**
   * 分块容错读取（L2）：沿键轴逐块扫描，**逐块**把原始行交出来。
   *
   * 与 `scan()` 的差别只在于内存：`scan()` 一次调用扫完整个区间、把所有行一次性
   * 返回，适合"一段"数据；本方法把同一个区间切成多块，每块读完就交出去，适合
   * "整场会话"这种量级 —— 导出正是靠它才能不把几万条消息堆在内存里。
   *
   * 扫描语句的契约与 `scan()` 相同（末两个 `?` 是 `(lo, hi)`、按第一列整数键升序），
   * 且只在用户授权级别 ≥ 2 时可用。
   */
  scanWindows(
    sql: string,
    params: SqlValue[] | null,
    plan: SalvageWindowPlan,
    salvage: SalvageBindingOptions,
    extras: SalvageWindowExtras = {},
  ): AsyncGenerator<SqlRow[]> {
    return iterateSalvageWindows({
      nt: this.nt,
      target: {
        dbPath: this.dbPath,
        ...(this.encrypted ? { key: this.key!, algo: this.algo! } : {}),
      },
      sql,
      params,
      plan,
      opts: salvage,
      ...(extras.hints && extras.hints.length > 0 ? { hints: extras.hints } : {}),
      ...(extras.onSkipped ? { onSkipped: extras.onSkipped } : {}),
    });
  }

  /**
   * Execute an INSERT / UPDATE / DELETE. Returns the number of rows affected.
   *
   * ⚠️ Writes go to QQ's live database. Always back up first and prefer to
   *    run with QQ fully closed.
   *
   * The native layer keeps a cached connection per dbPath, and a write
   * connection holds SQLite's RESERVED/EXCLUSIVE lock. If we left it open,
   * QQ itself would be locked out of nt_msg.db ("database is locked" — no
   * chat history, no contacts) until WeQ exits. And if the write throws
   * (e.g. a SQL error), the half-acquired lock would otherwise stay held.
   * So we ALWAYS drop the connection afterwards — releasing the lock back to
   * QQ. Writes here are low-frequency (delete / edit / insert), so the
   * re-open + re-decrypt on the next query is a non-issue.
   */
  async write(sql: string, params?: SqlValue[]): Promise<number> {
    try {
      if (this.encrypted) {
        return await this.nt.executeSqlWriteWithKey(
          this.dbPath,
          sql,
          this.key!,
          this.algo!,
          params ?? null,
        );
      }
      return await this.nt.executeSqlWrite(this.dbPath, sql, params ?? null);
    } finally {
      this.nt.closeDb(this.dbPath);
    }
  }

  /** Drop both the read and write cached native connections for this database. */
  close(): void {
    this.nt.closeDb(this.dbPath);
  }
}
