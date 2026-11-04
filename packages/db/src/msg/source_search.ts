import { statSync } from 'node:fs';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';
import { databaseRequestSignal } from '../query_schedule';
import type { BuddyMsgFtsHit } from './types';
import { toBigint, toStr } from './util';
import { sourceFtsContract, type SourceTokenizer } from './source_search_contract';

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
const like = (text: string) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
const nonAsciiCased = (text: string) =>
  text.codePointAt(0)! > 127 && text.toLowerCase() !== text.toUpperCase();

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
  ready = false;
  lastError: string | null = null;

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
    const version = Number((await this.query('PRAGMA schema_version', [], 'validation'))[0]?.[0]);
    if (this.ready && identity === this.identity && version === this.schema) return;
    this.ready = false;
    this.tokenizer = null;
    if (this.identity && identity !== this.identity && !this.override) this.qq.close();
    const caps = await this.query(
      "SELECT weq_trigram_contains('CAFÉ','café'),weq_trigram_contains('a  b','a b')",
      [],
      'validation',
    );
    if (Number(caps[0]?.[0]) !== 1 || Number(caps[0]?.[1]) !== 0)
      throw new Error('native 搜索能力不可用');
    const info = await this.query(`PRAGMA table_info(${this.table})`, [], 'validation');
    const names = new Set(info.map((row) => toStr(row[1])));
    if (REQUIRED.some((name) => !names.has(name))) throw new Error('搜索内容表结构不兼容');
    const keys = info.filter((row) => Number(row[5]) > 0);
    if (
      keys.length !== 1 ||
      toStr(keys[0]?.[1]) !== '41700' ||
      toStr(keys[0]?.[2]).toUpperCase() !== 'INTEGER'
    )
      throw new Error('搜索内容表主键不兼容');
    const ddl = await this.query(
      'SELECT sql FROM sqlite_master WHERE name=?',
      [`${this.table}_fts`],
      'validation',
    );
    const contract = sourceFtsContract(toStr(ddl[0]?.[0]), this.table);
    let tokenizer = contract?.tokenizer ?? null;
    if (contract?.columns.some((name) => !names.has(name))) tokenizer = null;
    if (tokenizer === 'pinyin0') {
      const signature = await this.query('SELECT weq_qq_pinyin0_query_version()', [], 'validation');
      if (toStr(signature[0]?.[0]) !== 'qq-char0-ascii-query-v1') tokenizer = null;
    }
    if (tokenizer) {
      try {
        const missing = await this.query(
          `SELECT COUNT(*) FROM ${this.table} c
          LEFT JOIN ${this.table}_fts_docsize d ON d.id=c."41700"
          WHERE d.id IS NULL AND (length(c."41701")>0 OR length(c."41702")>0)`,
          [],
          'validation',
        );
        if (Number(missing[0]?.[0]) !== 0) tokenizer = null;
      } catch {
        tokenizer = null;
      }
    }
    const afterVersion = Number(
      (await this.query('PRAGMA schema_version', [], 'validation'))[0]?.[0],
    );
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
    const args: SqlValue[] = columns.map(() => (long ? keyword : like(keyword)));
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
  private async page(
    keyword: string,
    limit: number,
    offset: number,
    partition?: bigint,
    filesOnly = false,
    bodyOnly = false,
    useIndex = true,
  ): Promise<{ items: BuddyMsgFtsHit[]; total: number }> {
    const needle = this.validate(keyword, limit, offset);
    if (!needle) return { items: [], total: 0 };
    const generation = this.generation;
    const plan = await this.clause(needle, filesOnly, partition, bodyOnly, useIndex);
    let rows: SqlRow[];
    try {
      rows = await this.query(
        `SELECT p.*,t.total,v.schema_version FROM pragma_schema_version v CROSS JOIN
        (SELECT COUNT(*) total ${plan.from}) t LEFT JOIN
        (SELECT ${plan.indexed ? FIELDS : CONTENT_FIELDS} ${plan.from}
         ORDER BY ${plan.alias}."40050" DESC,${plan.alias}."41700" DESC LIMIT ? OFFSET ?) p ON 1`,
        [...plan.args, ...plan.args, BigInt(limit), BigInt(offset)],
      );
    } catch (error) {
      if (plan.indexed && !this.closed && generation === this.generation)
        return this.page(keyword, limit, offset, partition, filesOnly, bodyOnly, false);
      throw error;
    }
    this.assertCurrent(rows, 10, generation);
    return {
      total: Number(rows[0]?.[9] ?? 0),
      items: rows
        .filter((row) => row[8] !== null)
        .map((row) => ({
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
  searchPartition(partition: bigint, keyword: string, limit = 20, offset = 0, bodyOnly = false) {
    return this.page(keyword, limit, offset, partition, false, bodyOnly);
  }
  searchFiles(keyword: string, limit = 20, offset = 0) {
    return this.page(keyword, limit, offset, undefined, true);
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
      if (plan.indexed && !this.closed && generation === this.generation)
        return this.topPartitions(keyword, limit, false);
      throw error;
    }
    this.assertCurrent(rows, 2, generation);
    return rows
      .filter((row) => row[0] !== null)
      .map((row) => ({ partition: toBigint(row[0]), count: Number(row[1]) }));
  }
}
