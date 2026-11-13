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
  databaseReadBudget,
  databaseRequestSignal,
  scheduleDatabase,
  waitForDatabaseQuiet,
} from './query_schedule';
import { queryDiagnosticSource } from './query_diagnostics';
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

export const DATABASE_SCAN_PAGE_SIZE = 256;

export class QqDb {
  readonly dbPath: string;
  private readonly key?: string;
  private readonly algo?: DatabaseAlgorithms;
  private readonly nt: NtHelperBinding;
  private readonly encrypted: boolean;
  private readonly columns = new Map<string, Promise<ReadonlySet<string>>>();

  async hasLeadingIndex(table: string, column: string): Promise<boolean> {
    return this.hasIndexPrefix(table, [column]);
  }

  async hasIndexPrefix(table: string, columns: readonly string[]): Promise<boolean> {
    if (!columns.length) return false;
    return (
      (
        await this.query(
          `SELECT 1 FROM pragma_index_list(?) i WHERE i.partial=0 AND NOT EXISTS (
         SELECT 1 FROM json_each(?) wanted LEFT JOIN pragma_index_info(i.name) c
           ON c.seqno=CAST(wanted.key AS INTEGER)
         WHERE c.name IS NULL OR c.name!=wanted.value
       ) LIMIT 1`,
          [table, JSON.stringify(columns)],
        )
      ).length > 0
    );
  }

  /** LIMIT 必须是最后一个参数；超预算只缩小未完成页，不丢弃或跳过数据。 */
  async queryPage(sql: string, params: SqlValue[], pageSize = 64) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('分页大小必须是正整数');
    let limit = Math.min(pageSize, 1024);
    let waits = 0;
    const read = this.nt.executeSqlBudgeted;
    for (;;) {
      databaseRequestSignal()?.throwIfAborted();
      const values = [...params, BigInt(limit)];
      try {
        const rows = read
          ? await scheduleDatabase(
              this.dbPath,
              () =>
                read.call(
                  this.nt,
                  this.dbPath,
                  sql,
                  values,
                  15,
                  this.encrypted ? this.key : null,
                  this.encrypted ? this.algo : null,
                ),
              this.nt,
              queryDiagnosticSource(sql),
            )
          : await this.query(sql, values);
        return { rows, limit };
      } catch (error) {
        if (
          read &&
          error instanceof Error &&
          error.message.includes('database_query_wait_timeout') &&
          waits < 2
        ) {
          waits++;
          await new Promise<void>((done) => setTimeout(done, 20));
          continue;
        }
        if (
          limit <= 1 ||
          !(error instanceof Error) ||
          !error.message.includes('database_query_execution_timeout')
        )
          throw error;
        limit = Math.max(1, Math.floor(limit / 2));
        await new Promise<void>((done) => setImmediate(done));
      }
    }
  }

  /** 固定本轮 rowid 上界，按真实键续读，支持稀疏、负数及 64 位键。 */
  async *rowidPages(
    table: string,
    columns: readonly string[],
    pageSize = DATABASE_SCAN_PAGE_SIZE,
    filter?: { column: string; value: SqlValue },
  ) {
    if (![table, ...columns].every((name) => /^[\w]+$/.test(name)))
      throw new Error('分页表或字段名无效');
    if (filter && !columns.includes(filter.column)) throw new Error('分页筛选列不在投影中');
    const end = (await this.query(`SELECT MAX(rowid) FROM "${table}"`))[0]?.[0];
    if (end === null || end === undefined) return;
    let cursor: SqlValue | undefined;
    let limit = pageSize;
    for (;;) {
      databaseRequestSignal()?.throwIfAborted();
      const projection = columns.map((name) => `"${name}"`).join(',');
      const select = `SELECT rowid AS rowid,${projection} FROM "${table}"
         WHERE rowid<=?${cursor === undefined ? '' : ' AND rowid>?'} ORDER BY rowid LIMIT ?`;
      const bounds = cursor === undefined ? [end] : [end, cursor];
      const page = await this.queryPage(
        filter
          ? `WITH target(value) AS (VALUES(?)), page AS MATERIALIZED (${select})
             SELECT rowid,${projection},0 FROM page WHERE "${filter.column}"=(SELECT value FROM target)
             UNION ALL SELECT MAX(rowid),${columns.map(() => 'NULL').join(',')},1 FROM page`
          : select,
        filter ? [filter.value, ...bounds] : bounds,
        limit,
      );
      limit = page.limit;
      const tail = page.rows.at(-1)?.[0];
      if (tail === null || tail === undefined) return;
      const rows = filter ? page.rows.slice(0, -1).map((row) => row.slice(0, -1)) : page.rows;
      if (rows.length) yield rows;
      cursor = tail;
      if (
        (!filter && page.rows.length < limit) ||
        BigInt(cursor as bigint) >= BigInt(end as bigint)
      )
        return;
    }
  }

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
  async query(sql: string, params?: SqlValue[]): Promise<SqlRow[]> {
    const budget = databaseReadBudget();
    if (budget !== undefined) {
      const read = this.nt.executeSqlBudgeted;
      if (!read) throw new Error('日历需要支持短预算读取的原生组件');
      const signal = databaseRequestSignal();
      const waitingSince = performance.now();
      // 短预算读取最多在队列外让路 1 秒，之后交给后台公平调度，避免周期查询使其饿死。
      const current = () => !signal?.aborted && performance.now() - waitingSince < 1000;
      await waitForDatabaseQuiet(this.dbPath, current, 500, budget.onWait);
      if (signal?.aborted) throw new DOMException('日历统计已取消', 'AbortError');
      await new Promise<void>((done) => setTimeout(done, 20));
      budget.onState?.('queued');
      return scheduleDatabase(
        this.dbPath,
        async () => {
          const began = performance.now();
          budget.onState?.('reading');
          try {
            return await read.call(
              this.nt,
              this.dbPath,
              sql,
              params ?? null,
              budget.milliseconds,
              this.encrypted ? this.key : null,
              this.encrypted ? this.algo : null,
            );
          } finally {
            budget.onRead?.(performance.now() - began);
          }
        },
        this.nt,
        queryDiagnosticSource(sql),
      ).finally(() => budget.onState?.(undefined));
    }
    return scheduleDatabase(
      this.dbPath,
      () =>
        this.encrypted
          ? this.nt.executeSqlWithKey(this.dbPath, sql, this.key!, this.algo!, params ?? null)
          : this.nt.executeSql(this.dbPath, sql, params ?? null),
      this.nt,
      queryDiagnosticSource(sql),
    );
  }

  /** 可选功能表按实际 schema 判断，不把查询错误或损坏吞成“没有数据”。 */
  async hasTable(table: string): Promise<boolean> {
    const rows = await this.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      [table],
    );
    return rows.length > 0;
  }

  tableColumns(table: string): Promise<ReadonlySet<string>> {
    let pending = this.columns.get(table);
    if (!pending) {
      pending = this.query('SELECT name FROM pragma_table_info(?)', [table])
        .then((rows) => new Set(rows.map((row) => String(row[0]))))
        .catch((error: unknown) => {
          this.columns.delete(table);
          throw error;
        });
      this.columns.set(table, pending);
    }
    return pending;
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
    return scheduleDatabase(
      this.dbPath,
      async () => {
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
      },
      this.nt,
      queryDiagnosticSource(sql),
    );
  }

  /** Drop both the read and write cached native connections for this database. */
  close(): void {
    this.columns.clear();
    this.nt.closeDb(this.dbPath);
  }
}
