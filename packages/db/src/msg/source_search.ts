import { statSync } from 'node:fs';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';
import { databaseRequestSignal } from '../query_schedule';
import type { BuddyMsgFtsHit } from './types';
import { toBigint, toStr } from './util';
import { sourceFtsContract, type SourceTokenizer } from './source_search_contract';
import type { FtsRecordBounds } from './fts_record_candidates';
import { ftsLikePattern } from './fts_content_search';

export type SourceSearchTable = 'buddy_msg_fts' | 'group_msg_fts';
export interface SourceSearchTarget {
  dbPath: string;
  key?: string;
  algo?: DatabaseAlgorithms;
}
export type SourceSearchQuery = (
  target: SourceSearchTarget,
  sql: string,
  params: SqlValue[],
  purpose: 'search' | 'validation',
  signal?: AbortSignal,
) => Promise<SqlRow[]>;
export interface SourceSearchOptions extends SourceSearchTarget {
  nt: NtHelperBinding;
  tableName: SourceSearchTable;
  query?: SourceSearchQuery;
}

const FIELDS =
  'f."40001",f."40010",f."40021",f."40020",f."41701",f."40050",f."41702",f."40003",f."41700"';
const CONTENT_FIELDS = FIELDS.replaceAll('f.', 'c.');
const REQUIRED = [
  '41700',
  '41701',
  '41702',
  '40001',
  '40010',
  '40021',
  '40020',
  '40050',
  '40003',
  '40027',
];
const phrase = (text: string) => `"${text.replaceAll('"', '""')}"`;
const nonAsciiCased = (text: string) =>
  text.codePointAt(0)! > 127 && text.toLowerCase() !== text.toUpperCase();

export interface SourceSearchPartition {
  column: '40021' | '40027' | '40035';
  value: string | bigint;
}

interface LikeCandidates {
  keyword: string;
  limit: number;
  fields: 'body' | 'file' | 'both';
  order: 'rowid' | 'msgId' | 'time';
  partition?: SourceSearchPartition;
  bounds?: FtsRecordBounds;
}

/** 直接读取 QQ 的搜索库；不解密复制、不建库、不增量写入。 */
export class SourceMsgSearchDb {
  private readonly qq: QqDb;
  private readonly table: SourceSearchTable;
  private readonly target: SourceSearchTarget;
  private readonly override?: SourceSearchQuery;
  private syncing: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private closed = false;
  private generation = 0;
  private identity = '';
  private schema = -1;
  private tokenizer: SourceTokenizer | null = null;
  private coverageRetryAt = Number.POSITIVE_INFINITY;
  ready = false;
  lastError: string | null = null;
  indexedReadVerified = false;

  constructor(options: SourceSearchOptions) {
    this.qq = new QqDb(options.nt, options);
    this.table = options.tableName;
    this.target = { dbPath: options.dbPath, key: options.key, algo: options.algo };
    this.override = options.query;
  }

  get accelerated(): boolean {
    return this.ready && this.tokenizer !== null;
  }
  private fileIdentity(): string {
    const info = statSync(this.target.dbPath);
    return `${info.dev}:${info.ino}`;
  }
  private query(
    sql: string,
    params: SqlValue[] = [],
    purpose: 'search' | 'validation' = 'search',
  ): Promise<SqlRow[]> {
    this.abort.signal.throwIfAborted();
    const request = purpose === 'search' ? databaseRequestSignal() : undefined;
    const signal = request ? AbortSignal.any([this.abort.signal, request]) : this.abort.signal;
    signal.throwIfAborted();
    return this.override
      ? this.override(this.target, sql, params, purpose, signal)
      : this.qq.query(sql, params);
  }
  sync(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('搜索来源已关闭'));
    if (!this.syncing)
      this.syncing = this.probe()
        .catch((error: unknown) => {
          this.ready = false;
          this.lastError = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => {
          this.syncing = null;
        });
    return this.syncing;
  }
  private async probe(): Promise<void> {
    const generation = this.generation;
    const identity = this.fileIdentity();
    if (
      this.ready &&
      identity === this.identity &&
      Date.now() < this.coverageRetryAt &&
      Number((await this.query('PRAGMA schema_version', [], 'validation'))[0]?.[0]) === this.schema
    )
      return;

    this.ready = false;
    this.tokenizer = null;
    this.indexedReadVerified = false;
    this.coverageRetryAt = Number.POSITIVE_INFINITY;
    if (this.identity && identity !== this.identity && !this.override) this.qq.close();

    // 版本、列定义和 FTS 声明来自同一个 SQLite 快照，只启动一次读取进程。
    const info = await this.query(
      `SELECT v.schema_version,
         weq_trigram_contains('CAFÉ','café'), weq_trigram_contains('a  b','a b'),
         (SELECT sql FROM sqlite_master WHERE name=?), c.name, c.type, c.pk
       FROM pragma_schema_version v LEFT JOIN pragma_table_info(?) c ON 1 ORDER BY c.cid`,
      [`${this.table}_fts`, this.table],
      'validation',
    );
    const [schema, folded, collapsed, ddl] = info[0] ?? [];
    const version = Number(schema);
    if (Number(folded) !== 1 || Number(collapsed) !== 0) throw new Error('native 搜索能力不可用');
    const names = new Set(info.map((row) => toStr(row[4])));
    if (REQUIRED.some((name) => !names.has(name))) throw new Error('搜索内容表结构不兼容');
    const keys = info.filter((row) => Number(row[6]) > 0);
    if (
      keys.length !== 1 ||
      toStr(keys[0]?.[4]) !== '41700' ||
      toStr(keys[0]?.[5]).toUpperCase() !== 'INTEGER'
    )
      throw new Error('搜索内容表主键不兼容');

    let afterVersion = version;
    const contract = sourceFtsContract(toStr(ddl), this.table);
    let tokenizer = contract?.tokenizer ?? null;
    if (contract?.columns.some((name) => !names.has(name))) tokenizer = null;
    if (tokenizer === 'pinyin0') {
      const signature = await this.query(
        'SELECT weq_qq_pinyin0_query_version(), schema_version FROM pragma_schema_version',
        [],
        'validation',
      );
      afterVersion = Number(signature[0]?.[1]);
      if (toStr(signature[0]?.[0]) !== 'qq-char0-ascii-query-v1') tokenizer = null;
    }
    if (tokenizer && version === afterVersion) {
      let missing: SqlRow[] | undefined;
      try {
        missing = await this.query(
          `SELECT (
             SELECT COUNT(*) FROM ${this.table} c
             LEFT JOIN ${this.table}_fts_docsize d ON d.id=c."41700"
             WHERE d.id IS NULL AND (length(c."41701")>0 OR length(c."41702")>0)
           ), schema_version FROM pragma_schema_version`,
          [],
          'validation',
        );
      } catch {
        // 核验查询不可用时仍要复核 schema，避免接纳已经换表的来源。
      }
      afterVersion = Number(
        missing
          ? missing[0]?.[1]
          : (await this.query('PRAGMA schema_version', [], 'validation'))[0]?.[0],
      );
      if (Number(missing?.[0]?.[0]) !== 0) {
        tokenizer = null;
        this.coverageRetryAt = Date.now() + 5 * 60000;
      }
    }
    if (
      this.closed ||
      generation !== this.generation ||
      identity !== this.fileIdentity() ||
      version !== afterVersion
    )
      throw new Error('搜索来源已变化，请重试');
    this.identity = identity;
    this.schema = version;
    this.tokenizer = tokenizer;
    this.ready = true;
    this.lastError = null;
  }
  dispose(): void {
    this.closed = true;
    this.ready = false;
    this.generation++;
    this.abort.abort(new Error('搜索来源已关闭'));
    this.qq.close();
  }

  private async anchor(keyword: string): Promise<string | null> {
    if (
      this.tokenizer === 'pinyin0' &&
      [...keyword].every(
        (char) => !nonAsciiCased(char) && (!/\s/u.test(char) || /[ \r\n]/.test(char)),
      )
    )
      return phrase(keyword.replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' '));
    if (!this.tokenizer) return null;
    const runs: string[] = [];
    let run = '';
    for (const char of keyword) {
      if (/\s/u.test(char) || (this.tokenizer === 'pinyin0' && nonAsciiCased(char))) {
        if (run) runs.push(run);
        run = '';
      } else run += char;
    }
    if (run) runs.push(run);
    runs.sort((a, b) => [...b].length - [...a].length);
    if (runs[0] && [...runs[0]].length >= (this.tokenizer === 'trigram' ? 3 : 1))
      return phrase(runs[0]);
    if (this.tokenizer === 'pinyin0') {
      const char = [...keyword].find(nonAsciiCased);
      if (char) {
        const rows = await this.query('SELECT weq_trigram_equivalents(?)', [char]);
        const values: unknown = JSON.parse(toStr(rows[0]?.[0]));
        if (
          Array.isArray(values) &&
          values.length &&
          values.every((value): value is string => typeof value === 'string')
        )
          return `(${values.map(phrase).join(' OR ')})`;
      }
    }
    return null;
  }
  private validate(keyword: string, limit: number, offset = 0): string {
    if (this.closed || !this.ready) throw new Error('搜索来源未就绪');
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error('搜索分页参数无效');
    const needle = keyword.trim();
    if (/[\p{Cs}\p{Cc}]/u.test(needle.replace(/[\r\n\t]/g, '')))
      throw new Error('搜索词含无效控制字符');
    return needle;
  }
  private async clause(
    keyword: string,
    filesOnly: boolean,
    partition: bigint | undefined,
    bodyOnly: boolean,
    useIndex: boolean,
  ) {
    const long = [...keyword].length >= 3;
    const columns = filesOnly ? ['41702'] : bodyOnly || !long ? ['41701'] : ['41701', '41702'];
    const anchor = useIndex ? await this.anchor(keyword) : null;
    const alias = anchor ? 'f' : 'c';
    const predicates = columns.map((column) =>
      long
        ? `weq_trigram_contains(${alias}."${column}",?)`
        : `${alias}."${column}" LIKE ? ESCAPE '\\'`,
    );
    const args: SqlValue[] = columns.map(() => (long ? keyword : ftsLikePattern(keyword)));
    let from = `FROM ${this.table} c WHERE (${predicates.join(' OR ')})`;
    if (anchor) {
      const scope = `{${columns.map((column) => `"${column}"`).join(' ')}}`;
      from = `FROM ${this.table}_fts f WHERE ${this.table}_fts MATCH ? AND f."41700" IS NOT NULL AND (${predicates.join(' OR ')})`;
      args.unshift(`${scope}:${anchor}`);
    }
    if (partition !== undefined) {
      from += ` AND ${alias}."40027"=CAST(? AS INTEGER)`;
      args.push(partition);
    }
    return { from, args, alias, indexed: anchor !== null };
  }
  private assertCurrent(rows: SqlRow[], column: number, generation: number): void {
    if (
      this.closed ||
      generation !== this.generation ||
      this.identity !== this.fileIdentity() ||
      Number(rows[0]?.[column]) !== this.schema
    ) {
      this.ready = false;
      throw new Error('搜索来源已变化，请重试');
    }
  }

  /** 以 MATCH 缩小文本比较范围，沿用调用方的 LIKE、过滤条件及候选排序。 */
  async likeCandidates(options: LikeCandidates): Promise<SqlRow[] | undefined> {
    try {
      return await this.queryLikeCandidates(options);
    } catch {
      databaseRequestSignal()?.throwIfAborted();
      this.abort.signal.throwIfAborted();
    }
  }

  private async queryLikeCandidates({
    keyword,
    limit,
    fields,
    order,
    partition,
    bounds,
  }: LikeCandidates) {
    if (
      !this.accelerated ||
      !keyword.trim() ||
      /[\p{Cs}\p{Cc}]/u.test(keyword.replace(/[\r\n\t]/g, ''))
    )
      return;
    const generation = this.generation;
    const anchor = await this.anchor(keyword);
    if (!anchor) return;

    const columns =
      fields === 'body' ? ['41701'] : fields === 'file' ? ['41702'] : ['41701', '41702'];
    const scope = `{${columns.map((column) => `"${column}"`).join(' ')}}`;
    const match = columns.map((column) => `c."${column}" LIKE ? ESCAPE '\\'`).join(' OR ');
    const where: string[] = [];
    const args: SqlValue[] = [];
    if (partition) {
      where.push(`c."${partition.column}"=?`);
      args.push(partition.value);
    }
    if (bounds?.senderUid) {
      where.push('c."40020"=?');
      args.push(bounds.senderUid);
    }
    if (bounds?.start !== undefined) {
      where.push('c."40050">=?');
      args.push(BigInt(bounds.start));
    }
    if (bounds?.end !== undefined) {
      where.push('c."40050"<=?');
      args.push(BigInt(bounds.end));
    }
    const filters = where.length ? `${where.join(' AND ')} AND ` : '';
    const tie = `"${order === 'msgId' ? '40001' : '41700'}" ${order === 'time' ? 'ASC' : 'DESC'}`;
    const table = this.table;
    const virtual = `${table}_fts`;
    // QQ 可能在校验后先写入内容表。补查无 docsize 的行，并在同一个 SQL 快照内去重。
    const rows = await this.query(
      `WITH candidates(id) AS MATERIALIZED (
         SELECT rowid FROM ${virtual} WHERE ${virtual} MATCH ?
         UNION
         SELECT c.rowid FROM ${table} c WHERE ${filters}c.rowid NOT IN (SELECT id FROM ${virtual}_docsize)
       )
       SELECT p.*,v.schema_version FROM pragma_schema_version v LEFT JOIN (
         SELECT ${CONTENT_FIELDS}, c."40027" AS partition
         FROM candidates CROSS JOIN ${table} c ON c.rowid=candidates.id
         WHERE ${filters}(${match}) ORDER BY c."40050" DESC,c.${tie} LIMIT ?
       ) p ON 1 ORDER BY p."40050" DESC,p.${tie}`,
      [
        `${scope}:${anchor}`,
        ...args,
        ...args,
        ...columns.map(() => ftsLikePattern(keyword)),
        BigInt(limit),
      ],
    );
    this.assertCurrent(rows, 10, generation);
    return rows.filter((row) => row[8] !== null).map((row) => [...row.slice(0, 8), row[9]!]);
  }
  private async page(
    keyword: string,
    limit: number,
    offset: number,
    partition?: bigint,
    filesOnly = false,
    bodyOnly = false,
    useIndex = true,
    lookAhead = false,
  ): Promise<{ items: BuddyMsgFtsHit[]; total: number }> {
    const needle = this.validate(keyword, limit, offset);
    if (!needle) return { items: [], total: 0 };
    const generation = this.generation;
    const plan = await this.clause(needle, filesOnly, partition, bodyOnly, useIndex);
    let rows: SqlRow[];
    try {
      rows = await this.query(
        `SELECT p.*,t.total,v.schema_version FROM pragma_schema_version v CROSS JOIN
        (${lookAhead ? 'SELECT NULL AS total' : `SELECT COUNT(*) total ${plan.from}`}) t LEFT JOIN
        (SELECT ${plan.indexed ? FIELDS : CONTENT_FIELDS} ${plan.from}
         ORDER BY ${plan.alias}."40050" DESC,${plan.alias}."41700" DESC LIMIT ? OFFSET ?) p ON 1`,
        [
          ...(lookAhead ? [] : plan.args),
          ...plan.args,
          BigInt(lookAhead ? limit + 1 : limit),
          BigInt(offset),
        ],
      );
    } catch (error) {
      databaseRequestSignal()?.throwIfAborted();
      if (plan.indexed && !this.closed && generation === this.generation)
        return this.page(keyword, limit, offset, partition, filesOnly, bodyOnly, false, lookAhead);
      throw error;
    }
    this.assertCurrent(rows, 10, generation);
    if (plan.indexed && rows.some((row) => row[8] !== null)) this.indexedReadVerified = true;
    const found = rows.filter((row) => row[8] !== null);
    return {
      total: lookAhead ? offset + found.length : Number(rows[0]?.[9] ?? 0),
      items: (lookAhead ? found.slice(0, limit) : found).map((row) => ({
        msgId: toBigint(row[0]),
        chatType: Number(row[1] ?? 0),
        targetUid: toStr(row[2]),
        senderUid: toStr(row[3]),
        content: toStr(row[4]),
        sendTime: toBigint(row[5]),
        fileName: toStr(row[6]) || undefined,
        msgSeq: toBigint(row[7]),
      })),
    };
  }
  searchPartition(
    partition: bigint,
    keyword: string,
    limit = 20,
    offset = 0,
    bodyOnly = false,
    lookAhead = false,
  ) {
    return this.page(keyword, limit, offset, partition, false, bodyOnly, true, lookAhead);
  }
  searchFiles(keyword: string, limit = 20, offset = 0, lookAhead = false) {
    return this.page(keyword, limit, offset, undefined, true, false, true, lookAhead);
  }
  async topPartitions(
    keyword: string,
    limit = 200,
    useIndex = true,
  ): Promise<Array<{ partition: bigint; count: number }>> {
    const needle = this.validate(keyword, limit);
    if (!needle) return [];
    const generation = this.generation,
      plan = await this.clause(needle, false, undefined, false, useIndex);
    let rows: SqlRow[];
    try {
      rows = await this.query(
        `SELECT p.partition,p.hits,v.schema_version FROM pragma_schema_version v LEFT JOIN
        (SELECT ${plan.alias}."40027" partition,COUNT(*) hits ${plan.from}
         GROUP BY ${plan.alias}."40027" ORDER BY COUNT(*) DESC,${plan.alias}."40027" ASC LIMIT ?) p ON 1`,
        [...plan.args, BigInt(limit)],
      );
    } catch (error) {
      databaseRequestSignal()?.throwIfAborted();
      if (plan.indexed && !this.closed && generation === this.generation)
        return this.topPartitions(keyword, limit, false);
      throw error;
    }
    this.assertCurrent(rows, 2, generation);
    if (plan.indexed && rows.some((row) => row[0] !== null)) this.indexedReadVerified = true;
    return rows
      .filter((row) => row[0] !== null)
      .map((row) => ({ partition: toBigint(row[0]), count: Number(row[1]) }));
  }
}
