/**
 * SQLiteStudio-style database explorer for the current QQ account.
 *
 * Sits on top of `@weq/db`'s `QqDb` (which itself wraps the cached native
 * SQLCipher connections) and exposes the generic operations a DB browser
 * needs: enumerate databases, list schema objects, page through table rows,
 * run arbitrary SQL, and edit individual rows.
 *
 * ── Design notes ──────────────────────────────────────────────────────────
 *  • NO native (.node) change. Result column names for hand-written SELECTs
 *    are recovered with a pure-SQL trick — a `TEMP VIEW` is created on the
 *    (single, cached) read connection and introspected via
 *    `PRAGMA table_info(view)`. If that fails we degrade to positional
 *    `col_1…` names but still return the data.
 *  • Values crossing the IPC boundary are normalised into {@link DbCell}:
 *      – INTEGER (`bigint`) → `{ t:'int', v:<decimal string> }` so the grid
 *        never loses precision.
 *      – BLOB (`Uint8Array`) → `{ t:'blob', hex, bytes }` because superjson
 *        cannot serialise typed arrays.
 *      – TEXT → `string`, REAL → `number`, NULL → `null`.
 *  • Edits are keyed by {@link RowKey}: `rowid` for ordinary tables, primary
 *    key columns for WITHOUT ROWID tables (full-row match as a last resort).
 *  • Only databases inside the account's `nt_db` directory may be opened, and
 *    every table / column identifier is validated against the live schema
 *    before it is interpolated into SQL.
 *
 * ⚠️  Writes hit QQ's live databases. Callers should back up first and prefer
 *     to run with QQ closed (mirrors `QqDb.write`'s warning).
 */

import { QqDb } from '@weq/db';
import type { SqlRow, SqlValue } from '@weq/native';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { DbDecryptService, type AccountDbFile } from './db_decrypt';

// ── Wire types (shared with the renderer through tRPC inference) ────────────

/** One cell value as it crosses the IPC boundary. */
export type DbCell =
  | null
  | string // TEXT
  | number // REAL
  | { t: 'int'; v: string } // INTEGER — bigint rendered as a decimal string
  | { t: 'blob'; hex: string; bytes: number }; // BLOB — hex preview + length

/** A value supplied by the renderer for an edit / insert. */
export type DbInputValue =
  | { t: 'null' }
  | { t: 'int'; v: string } // decimal string → bigint
  | { t: 'real'; v: number }
  | { t: 'text'; v: string }
  | { t: 'blob'; hex: string }; // hex string → bytes

/** How to locate one row for UPDATE / DELETE. */
export type RowKey =
  | { t: 'rowid'; rowid: string }
  | { t: 'pk'; cols: Array<{ name: string; value: DbInputValue }> };

/** A schema object from `sqlite_master` (triggers intentionally excluded). */
export interface DbObject {
  name: string;
  type: 'table' | 'view' | 'index';
  /** For indices: the table they belong to. Null otherwise. */
  tableName: string | null;
  /** The original `CREATE …` statement, if any. */
  sql: string | null;
}

/** One column of a table / view (from `PRAGMA table_info`). */
export interface DbColumn {
  cid: number;
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  /** 0 = not part of the primary key; otherwise its 1-based position. */
  pk: number;
}

/** A page of table rows. */
export interface TableRowsResult {
  columns: DbColumn[];
  rows: DbCell[][];
  /** Aligned 1:1 with `rows` — the key used to UPDATE / DELETE that row. */
  keys: RowKey[];
  /** Opaque cursor to pass back for the next page, or null when exhausted. */
  nextCursor: string | null;
  /** True when the table exposes a usable `rowid` (⇒ editable, fast paging). */
  hasRowid: boolean;
}

/** Result of a hand-written statement. */
export interface QueryResult {
  /** 'rows' for read statements, 'write' for INSERT/UPDATE/DELETE/DDL. */
  kind: 'rows' | 'write';
  columns: string[];
  rows: DbCell[][];
  rowsAffected: number;
  /** True when a SELECT was capped at {@link RUN_SQL_LIMIT}. */
  truncated: boolean;
}

/** Hard row cap for hand-written SELECTs, to keep one IPC payload bounded. */
const RUN_SQL_LIMIT = 1000;
/** Default / max page size for `getRows`. */
const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;

export class DbExplorerService {
  private readonly decrypt: DbDecryptService;
  private readonly handles = new Map<string, QqDb>();
  private allowed: Set<string> | null = null;
  private viewSeq = 0;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {
    this.decrypt = new DbDecryptService(session, platform);
  }

  /** Encrypted `*.db` files under the account's `nt_db` directory. */
  listDatabases(): Promise<AccountDbFile[]> {
    return this.decrypt.listDatabases();
  }

  /** Tables / views / indices (no triggers, no internal `sqlite_*`). */
  async listObjects(dbPath: string): Promise<DbObject[]> {
    const db = await this.open(dbPath);
    const rows = await db.query(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE type IN ('table','view','index') AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    );
    return rows.map((r) => {
      const type = asText(r[0]) as DbObject['type'];
      const name = asText(r[1]) ?? '';
      const tblName = asText(r[2]);
      return {
        name,
        type,
        tableName: type === 'index' ? tblName : null,
        sql: asText(r[3]),
      };
    });
  }

  /** Columns of `table` (works for views too). */
  async getColumns(dbPath: string, table: string): Promise<DbColumn[]> {
    const db = await this.open(dbPath);
    return this.readColumns(db, table);
  }

  /**
   * One page of rows from `table`.
   *
   * With no filter/sort the fast paths are used: `rowid` tables keyset-page
   * (`WHERE rowid > cursor`), WITHOUT ROWID tables LIMIT/OFFSET. As soon as a
   * `search` term or an explicit `orderBy` is supplied, both cases switch to
   * OFFSET paging with an explicit `ORDER BY` (rowid tables still fetch their
   * `rowid` so inline editing keeps working). `search` matches a `%term%` LIKE
   * against every column cast to TEXT (BLOBs won't match, harmlessly).
   */
  async getRows(
    dbPath: string,
    table: string,
    opts: {
      limit?: number;
      cursor?: string | null;
      search?: string | null;
      orderBy?: string | null;
      orderDir?: 'asc' | 'desc';
    } = {},
  ): Promise<TableRowsResult> {
    const db = await this.open(dbPath);
    const columns = await this.readColumns(db, table);
    const cap = clampInt(opts.limit ?? DEFAULT_PAGE, 1, MAX_PAGE);
    const cursor = opts.cursor ?? null;
    const q = quoteId(table);
    const hasRowid = await this.detectRowid(db, table);

    const search = opts.search?.trim() ? opts.search.trim() : null;
    // Only honour an orderBy that names a real column (guards SQL injection).
    const orderBy =
      opts.orderBy && columns.some((c) => c.name === opts.orderBy) ? opts.orderBy : null;
    const orderDir: 'asc' | 'desc' = opts.orderDir === 'desc' ? 'desc' : 'asc';

    // Fast keyset path: rowid table, no search, no explicit sort.
    if (hasRowid && !search && !orderBy) {
      const params: SqlValue[] = [];
      let where = '';
      if (cursor != null) {
        where = 'WHERE rowid > ?';
        params.push(BigInt(cursor));
      }
      params.push(cap);
      const raw = await db.query(
        `SELECT rowid AS __weq_rowid, * FROM ${q} ${where} ORDER BY rowid LIMIT ?`,
        params,
      );
      const rows: DbCell[][] = [];
      const keys: RowKey[] = [];
      let last: bigint | null = null;
      for (const r of raw) {
        last = asBigint(r[0]);
        keys.push({ t: 'rowid', rowid: String(r[0]) });
        rows.push(r.slice(1).map(toCell));
      }
      return {
        columns,
        rows,
        keys,
        hasRowid: true,
        nextCursor: raw.length === cap && last != null ? String(last) : null,
      };
    }

    // Filtered / sorted path (and all WITHOUT ROWID / view paging): OFFSET.
    const offset = cursor != null ? Math.max(0, Number(cursor)) : 0;
    const params: SqlValue[] = [];

    let where = '';
    if (search) {
      const like = `%${escapeLike(search)}%`;
      const ors = columns
        .map((c) => `CAST(${quoteId(c.name)} AS TEXT) LIKE ? ESCAPE '\\'`)
        .join(' OR ');
      where = `WHERE (${ors})`;
      for (let i = 0; i < columns.length; i++) params.push(like);
    }

    // Sort by the chosen column; append rowid as a stable tiebreaker when we can.
    const dir = orderDir === 'desc' ? 'DESC' : 'ASC';
    let orderClause: string;
    if (orderBy) {
      orderClause = `ORDER BY ${quoteId(orderBy)} ${dir}${hasRowid ? ', rowid' : ''}`;
    } else if (hasRowid) {
      orderClause = 'ORDER BY rowid';
    } else {
      orderClause = '';
    }

    const select = hasRowid ? `rowid AS __weq_rowid, *` : '*';
    params.push(cap, offset);
    const raw = await db.query(
      `SELECT ${select} FROM ${q} ${where} ${orderClause} LIMIT ? OFFSET ?`,
      params,
    );

    const pkCols = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const rows: DbCell[][] = [];
    const keys: RowKey[] = [];
    for (const r of raw) {
      if (hasRowid) {
        keys.push({ t: 'rowid', rowid: String(r[0]) });
        rows.push(r.slice(1).map(toCell));
      } else {
        const cells = r.map(toCell);
        rows.push(cells);
        const keyCols = pkCols.length ? pkCols : columns;
        keys.push({
          t: 'pk',
          cols: keyCols.map((c) => ({
            name: c.name,
            value: cellToInput(cells[columns.findIndex((x) => x.name === c.name)] ?? null),
          })),
        });
      }
    }
    return {
      columns,
      rows,
      keys,
      hasRowid,
      nextCursor: raw.length === cap ? String(offset + cap) : null,
    };
  }

  /**
   * Run a hand-written statement. Reads (SELECT / WITH / PRAGMA / EXPLAIN)
   * return rows with best-effort real column names; everything else runs as a
   * write and returns the affected-row count.
   */
  async runSql(dbPath: string, sql: string): Promise<QueryResult> {
    const db = await this.open(dbPath);
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (!trimmed) throw new Error('SQL 为空');

    const isRead = /^(select|with|pragma|explain)\b/i.test(trimmed);
    if (!isRead) {
      const rowsAffected = await db.write(sql);
      return { kind: 'write', columns: [], rows: [], rowsAffected, truncated: false };
    }

    const viewable = /^(select|with)\b/i.test(trimmed);
    if (viewable) {
      const view = `__weq_explorer_q_${this.viewSeq++}`;
      const vq = quoteId(view);
      try {
        await db.query(`DROP VIEW IF EXISTS ${vq}`);
        await db.query(`CREATE TEMP VIEW ${vq} AS ${trimmed}`);
        const info = await db.query(`PRAGMA table_info(${vq})`);
        const columns = info.map((r) => asText(r[1]) ?? '');
        const raw = await db.query(`SELECT * FROM ${vq} LIMIT ?`, [RUN_SQL_LIMIT + 1]);
        await db.query(`DROP VIEW IF EXISTS ${vq}`);
        return packRows(columns, raw);
      } catch {
        // Read connection refused the TEMP VIEW (e.g. opened query-only) —
        // fall back to positional column names below. Best-effort cleanup.
        try {
          await db.query(`DROP VIEW IF EXISTS ${vq}`);
        } catch {
          /* ignore */
        }
        const raw = await db.query(`SELECT * FROM (${trimmed}) LIMIT ?`, [RUN_SQL_LIMIT + 1]);
        return packRows(positionalColumns(raw), raw);
      }
    }

    // PRAGMA / EXPLAIN — run verbatim, positional column names.
    const raw = await db.query(trimmed);
    return packRows(positionalColumns(raw), raw);
  }

  /** Set one cell. Returns the number of rows affected (should be 1). */
  async updateCell(
    dbPath: string,
    table: string,
    rowKey: RowKey,
    column: string,
    value: DbInputValue,
  ): Promise<number> {
    const db = await this.open(dbPath);
    await this.assertColumn(db, table, column);
    const { clause, params } = buildWhere(rowKey);
    return db.write(
      `UPDATE ${quoteId(table)} SET ${quoteId(column)} = ? WHERE ${clause}`,
      [fromInput(value), ...params],
    );
  }

  /** Insert a row. Columns omitted from `values` take their default. */
  async insertRow(
    dbPath: string,
    table: string,
    values: Array<{ name: string; value: DbInputValue }>,
  ): Promise<number> {
    const db = await this.open(dbPath);
    for (const v of values) await this.assertColumn(db, table, v.name);
    const q = quoteId(table);
    if (values.length === 0) return db.write(`INSERT INTO ${q} DEFAULT VALUES`);
    const cols = values.map((v) => quoteId(v.name)).join(', ');
    const placeholders = values.map(() => '?').join(', ');
    return db.write(
      `INSERT INTO ${q} (${cols}) VALUES (${placeholders})`,
      values.map((v) => fromInput(v.value)),
    );
  }

  /** Delete one row identified by `rowKey`. */
  async deleteRow(dbPath: string, table: string, rowKey: RowKey): Promise<number> {
    const db = await this.open(dbPath);
    await this.assertTable(db, table);
    const { clause, params } = buildWhere(rowKey);
    return db.write(`DELETE FROM ${quoteId(table)} WHERE ${clause}`, params);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Open (and cache) a `QqDb` for `dbPath`, after checking it's in-scope. */
  private async open(dbPath: string): Promise<QqDb> {
    const cached = this.handles.get(dbPath);
    if (cached) return cached;
    if (this.allowed == null) {
      const files = await this.listDatabases();
      this.allowed = new Set(files.map((f) => f.path));
    }
    if (!this.allowed.has(dbPath)) {
      throw new Error(`数据库不在当前账号目录下：${dbPath}`);
    }
    const db = new QqDb(this.platform.native.ntHelper, {
      dbPath,
      key: this.session.context.dbKey,
      algo: this.session.context.algo,
    });
    this.handles.set(dbPath, db);
    return db;
  }

  private async readColumns(db: QqDb, table: string): Promise<DbColumn[]> {
    const rows = await db.query(`PRAGMA table_info(${quoteId(table)})`);
    if (rows.length === 0) throw new Error(`表不存在或无列：${table}`);
    return rows.map((r) => ({
      cid: Number(r[0]),
      name: asText(r[1]) ?? '',
      type: asText(r[2]) ?? '',
      notNull: Number(r[3]) !== 0,
      defaultValue: asText(r[4]),
      pk: Number(r[5]),
    }));
  }

  /** True when `SELECT rowid FROM table` is legal (ordinary rowid table). */
  private async detectRowid(db: QqDb, table: string): Promise<boolean> {
    try {
      await db.query(`SELECT rowid FROM ${quoteId(table)} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  }

  private async assertTable(db: QqDb, table: string): Promise<void> {
    await this.readColumns(db, table); // throws if it doesn't exist
  }

  private async assertColumn(db: QqDb, table: string, column: string): Promise<void> {
    const cols = await this.readColumns(db, table);
    if (!cols.some((c) => c.name === column)) {
      throw new Error(`列不存在：${table}.${column}`);
    }
  }
}

// ── value <-> wire helpers ──────────────────────────────────────────────────

function toCell(v: SqlValue): DbCell {
  if (v == null) return null;
  if (typeof v === 'bigint') return { t: 'int', v: v.toString() };
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  // Uint8Array (BLOB)
  return { t: 'blob', hex: toHex(v), bytes: v.length };
}

function fromInput(v: DbInputValue): SqlValue {
  switch (v.t) {
    case 'null':
      return null;
    case 'int':
      return BigInt(v.v);
    case 'real':
      return v.v;
    case 'text':
      return v.v;
    case 'blob':
      return fromHex(v.hex);
  }
}

/** Turn a returned cell back into an input value (for PK-based WHERE match). */
function cellToInput(c: DbCell): DbInputValue {
  if (c == null) return { t: 'null' };
  if (typeof c === 'number') return { t: 'real', v: c };
  if (typeof c === 'string') return { t: 'text', v: c };
  if (c.t === 'int') return { t: 'int', v: c.v };
  return { t: 'blob', hex: c.hex };
}

function buildWhere(rowKey: RowKey): { clause: string; params: SqlValue[] } {
  if (rowKey.t === 'rowid') {
    return { clause: 'rowid = ?', params: [BigInt(rowKey.rowid)] };
  }
  const parts: string[] = [];
  const params: SqlValue[] = [];
  for (const c of rowKey.cols) {
    const val = fromInput(c.value);
    if (val === null) {
      parts.push(`${quoteId(c.name)} IS NULL`);
    } else {
      parts.push(`${quoteId(c.name)} = ?`);
      params.push(val);
    }
  }
  if (parts.length === 0) throw new Error('无法定位该行（缺少主键）');
  return { clause: parts.join(' AND '), params };
}

function packRows(columns: string[], raw: SqlRow[]): QueryResult {
  const truncated = raw.length > RUN_SQL_LIMIT;
  const body = truncated ? raw.slice(0, RUN_SQL_LIMIT) : raw;
  return {
    kind: 'rows',
    columns,
    rows: body.map((r) => r.map(toCell)),
    rowsAffected: 0,
    truncated,
  };
}

function positionalColumns(raw: SqlRow[]): string[] {
  const width = raw.reduce((m, r) => Math.max(m, r.length), 0);
  return Array.from({ length: width }, (_, i) => `col_${i + 1}`);
}

/** Quote an SQL identifier, guarding against embedded double-quotes. */
function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Escape LIKE wildcards so a search term matches literally (with ESCAPE '\'). */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function asText(v: SqlValue | undefined): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint' || typeof v === 'number') return String(v);
  return null; // BLOB — not expected for the schema columns we read
}

function asBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  return BigInt(Number(v ?? 0));
}

function clampInt(n: number, lo: number, hi: number): number {
  const x = Math.floor(Number.isFinite(n) ? n : lo);
  return Math.min(hi, Math.max(lo, x));
}

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX.charAt(b >> 4) + HEX.charAt(b & 0xf);
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('非法的十六进制 BLOB');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
