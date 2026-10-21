/**
 * RoamMsgCacheDb — 按账号缓存「缺失消息」（漫游消息回填）的本地 SQLite。
 *
 * 布局：weq 缓存目录下新开 `roam-msg/` 文件夹，每个账号一个数据库文件
 * `<cacheBase>/roam-msg/<uin>.db`。正常消息保存渲染视图，增强来源另保留原始数据；
 * 前端再次遇到同一个缺口时先查这里，命中就直接渲染，不用重新联网。
 *
 * `gap_msg` 保留旧单 seq 主键；native/protocol 表保留同 seq 不同身份。
 * 不完整协议观察独立存表，不进入消息读取和恢复覆盖。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import type { NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { compareMessageOrder } from '@weq/codec';
import type { GapFetchedMessage } from './gap_history';
import { nativeHistoryElements } from './native_history_projection';
import type { ProtocolHistoryObservation } from './sso_history_window';

const TABLE = 'gap_msg';
const NATIVE_TABLE = 'native_gap_msg';
const PROTOCOL_TABLE = 'protocol_gap_msg';
const OBSERVATION_TABLE = 'protocol_gap_observation';

/** SQLite 存不了 bigint 字段值，渲染元素里又有 elementId/origMsgId 等 bigint，JSON 序列化时包一层。 */
function serializeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    typeof v === 'bigint' ? { __bigint: v.toString() } : v,
  );
}

function parseJson<T>(text: string): T {
  return JSON.parse(text, (_key, v) => {
    if (
      v !== null &&
      typeof v === 'object' &&
      typeof (v as { __bigint?: unknown }).__bigint === 'string'
    ) {
      return BigInt((v as { __bigint: string }).__bigint);
    }
    return v;
  }) as T;
}

/** 字符串安全转 bigint（空串 / 非数字回退 0，避免单条脏数据打挂整批写入）。 */
function toBigIntSafe(value: string | undefined, fallback = 0n): bigint {
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function rowToMessage(row: SqlRow): GapFetchedMessage {
  // The SELECT below returns kind, conv first; they are read via row[0]/row[1],
  // so the destructure must skip those two columns.
  const [, , msgId, msgSeq, senderUid, senderUin, sendTime, elements, decoration, ntSeqVerified] =
    row;
  const message: GapFetchedMessage = {
    kind: String(row[0] ?? '') as GapFetchedMessage['kind'],
    conv: String(row[1] ?? ''),
    msgId: String(msgId ?? ''),
    msgSeq: String(msgSeq ?? ''),
    ...(String(row[0]) === 'c2c'
      ? { msgRandom: String(msgId ?? ''), ntSeqVerified: Number(ntSeqVerified) === 1 }
      : {}),
    senderUid: String(senderUid ?? ''),
    senderUin: String(senderUin ?? ''),
    sendTime: String(sendTime ?? ''),
    elements: parseJson<GapFetchedMessage['elements']>(String(elements ?? '[]')),
  };
  if (decoration !== null && decoration !== undefined) {
    message.decoration = parseJson<NonNullable<GapFetchedMessage['decoration']>>(
      String(decoration),
    );
  }
  return message;
}

function nativeRow(row: SqlRow): GapFetchedMessage {
  const message = JSON.parse(String(row[0])) as GapFetchedMessage;
  return {
    ...message,
    sourceFormat: 'native',
    elements: nativeHistoryElements(message.nativeRaw?.elements),
  };
}

function combineCache(
  legacy: GapFetchedMessage[],
  native: GapFetchedMessage[],
  protocol: GapFetchedMessage[] = [],
): GapFetchedMessage[] {
  const key = (row: GapFetchedMessage) =>
    `${row.msgSeq}:${row.msgRandom || row.msgId}:${row.senderUid}:${row.sendTime}`;
  const nativeExact = new Set(
    native.filter((row) => row.msgRandom && row.msgRandom !== '0').map(key),
  );
  const nativeIds = new Set(native.map((row) => `${row.msgSeq}:${row.msgId}`));
  const enriched = [
    ...protocol.filter(
      (row) => !nativeIds.has(`${row.msgSeq}:${row.msgId}`) && !nativeExact.has(key(row)),
    ),
    ...native,
  ];
  const remoteKeys = new Set([...legacy, ...enriched].filter((row) => !row.localSent).map(key));
  const exact = new Set(
    enriched.filter((row) => !row.localSent && row.msgRandom && row.msgRandom !== '0').map(key),
  );
  return [
    ...legacy.filter((row) => !exact.has(key(row))),
    ...enriched.filter((row) => !row.localSent || !remoteKeys.has(key(row))),
  ];
}

export class RoamMsgCacheDb {
  readonly dbPath: string;
  private readonly nt: Pick<NtHelperBinding, 'executeSql' | 'executeSqlWrite' | 'closeDb'>;
  private schemaReady = false;
  private schemaPending: Promise<void> | undefined;
  /**
   * 写串行化：导出「消息补全」会 5-10 路并发拉窗，每个窗口都 store 一批并
   * `closeDb` 释放写连接——并发写同一库文件会让 closeDb 与在途写竞争。这里把
   * store 排成一条 promise 链，写永远逐个进行。
   */
  private storeQueue: Promise<void> = Promise.resolve();

  constructor(
    nt: Pick<NtHelperBinding, 'executeSql' | 'executeSqlWrite' | 'closeDb'>,
    dbPath: string,
  ) {
    this.nt = nt;
    this.dbPath = dbPath;
  }

  /** 每个会话最近一次已确认发送，用于 QQ 尚未同步时的会话摘要。 */
  async latestSent(): Promise<GapFetchedMessage[]> {
    await this.ensureSchema();
    const eligible =
      "json_extract(payload,'$.localSent')=1 AND (kind='group' OR nt_seq_verified=1)";
    const rows = await this.nt.executeSql(
      this.dbPath,
      `SELECT payload FROM ${PROTOCOL_TABLE} WHERE ${eligible}
       AND (kind,conv,msg_seq) IN (
         SELECT kind,conv,MAX(msg_seq) FROM ${PROTOCOL_TABLE} WHERE ${eligible} GROUP BY kind,conv
       )`,
      null,
    );
    return rows.map((row) => parseJson<GapFetchedMessage>(String(row[0])));
  }

  /** 读一段缓存，输出始终按 seq 升序；descending 决定限额前选最新还是最旧的行。 */
  async query(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
    verifiedOnly = false,
    limit = 2000,
    descending = true,
  ): Promise<GapFetchedMessage[]> {
    if (startSeq > endSeq) return [];
    await this.ensureSchema();
    const rows = await this.nt.executeSql(
      this.dbPath,
      `SELECT kind, conv, msg_id, msg_seq, sender_uid, sender_uin, send_time, elements, decoration, nt_seq_verified
         FROM ${TABLE}
        WHERE kind = ? AND conv = ? AND msg_seq BETWEEN ? AND ?
          ${verifiedOnly ? 'AND nt_seq_verified = 1' : ''}
        ORDER BY msg_seq ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
      [kind, conv, BigInt(startSeq), BigInt(endSeq), Math.max(1, Math.min(2000, limit))],
    );
    const native = await this.nt.executeSql(
      this.dbPath,
      `SELECT payload FROM ${NATIVE_TABLE} WHERE kind = ? AND conv = ? AND accepted = 1 AND msg_seq BETWEEN ? AND ?
       ORDER BY msg_seq ${descending ? 'DESC' : 'ASC'}, msg_id LIMIT ?`,
      [kind, conv, BigInt(startSeq), BigInt(endSeq), Math.max(1, Math.min(2000, limit))],
    );
    const protocol = await this.nt.executeSql(
      this.dbPath,
      `SELECT payload FROM ${PROTOCOL_TABLE} WHERE kind=? AND conv=? AND msg_seq BETWEEN ? AND ?
       ${verifiedOnly ? 'AND nt_seq_verified=1' : ''} ORDER BY msg_seq ${descending ? 'DESC' : 'ASC'},msg_id LIMIT ?`,
      [kind, conv, BigInt(startSeq), BigInt(endSeq), Math.max(1, Math.min(2000, limit))],
    );
    const messages = combineCache(
      rows.map(rowToMessage),
      native.map(nativeRow),
      protocol.map((row) => parseJson<GapFetchedMessage>(String(row[0]))),
    )
      .sort((a, b) => {
        const order = compareMessageOrder(a, b);
        return descending ? -order : order;
      })
      .slice(0, Math.max(1, Math.min(2000, limit)));
    return descending ? messages.reverse() : messages;
  }

  /** Export-only full scan with bounded DB pages, including every same-seq native ID. */
  async allForExport(kind: 'c2c' | 'group', conv: string): Promise<GapFetchedMessage[]> {
    await this.ensureSchema();
    const legacy: GapFetchedMessage[] = [],
      native: GapFetchedMessage[] = [];
    let seq = 0n;
    for (;;) {
      const rows = await this.nt.executeSql(
        this.dbPath,
        `SELECT kind,conv,msg_id,msg_seq,sender_uid,sender_uin,send_time,elements,decoration,nt_seq_verified
         FROM ${TABLE} WHERE kind = ? AND conv = ? AND msg_seq > ? ${kind === 'c2c' ? 'AND nt_seq_verified = 1' : ''}
         ORDER BY msg_seq LIMIT 1000`,
        [kind, conv, seq],
      );
      if (!rows.length) break;
      const page = rows.map(rowToMessage);
      legacy.push(...page);
      seq = BigInt(page.at(-1)!.msgSeq);
    }
    seq = 0n;
    let id = '';
    for (;;) {
      const rows = await this.nt.executeSql(
        this.dbPath,
        `SELECT payload FROM ${NATIVE_TABLE} WHERE kind = ? AND conv = ? AND accepted = 1
         AND (msg_seq > ? OR (msg_seq = ? AND msg_id > ?)) ORDER BY msg_seq,msg_id LIMIT 250`,
        [kind, conv, seq, seq, id],
      );
      if (!rows.length) break;
      const page = rows.map(nativeRow);
      for (const row of page) {
        const { nativeRaw: _raw, ...view } = row;
        native.push(view);
      }
      seq = BigInt(page.at(-1)!.msgSeq);
      id = page.at(-1)!.msgId;
    }
    const protocol: GapFetchedMessage[] = [];
    seq = 0n;
    id = '';
    for (;;) {
      const rows = await this.nt.executeSql(
        this.dbPath,
        `SELECT payload FROM ${PROTOCOL_TABLE} WHERE kind=? AND conv=?
         ${kind === 'c2c' ? 'AND nt_seq_verified=1' : ''}
         AND (msg_seq>? OR (msg_seq=? AND msg_id>?)) ORDER BY msg_seq,msg_id LIMIT 250`,
        [kind, conv, seq, seq, id],
      );
      if (!rows.length) break;
      const page = rows.map((row) => parseJson<GapFetchedMessage>(String(row[0])));
      for (const { protocolRaw: _raw, ...view } of page) protocol.push(view);
      seq = BigInt(page.at(-1)!.msgSeq);
      id = page.at(-1)!.msgId;
    }
    return combineCache(legacy, native, protocol);
  }

  /** 按 msgId 找一条已缓存的缺失消息（媒体补全 / 文件下载回查用）。 */
  async findByMsgId(msgId: string): Promise<GapFetchedMessage | null> {
    if (!msgId) return null;
    await this.ensureSchema();
    const protocol = await this.nt.executeSql(
      this.dbPath,
      `SELECT payload FROM ${PROTOCOL_TABLE} WHERE msg_id=? LIMIT 1`,
      [msgId],
    );
    if (protocol[0]) return parseJson<GapFetchedMessage>(String(protocol[0][0]));
    const native = await this.nt.executeSql(
      this.dbPath,
      `SELECT payload FROM ${NATIVE_TABLE} WHERE msg_id = ? AND accepted = 1 LIMIT 1`,
      [msgId],
    );
    if (native[0]) return nativeRow(native[0]);
    const rows = await this.nt.executeSql(
      this.dbPath,
      `SELECT kind, conv, msg_id, msg_seq, sender_uid, sender_uin, send_time, elements, decoration, nt_seq_verified
         FROM ${TABLE}
        WHERE msg_id = ? LIMIT 1`,
      [msgId],
    );
    return rows.length > 0 ? rowToMessage(rows[0]!) : null;
  }

  async resolveReplySeq(
    conv: string,
    clientSeq: string,
    senderUin?: string,
    sendTime?: string,
  ): Promise<string | null> {
    await this.ensureSchema();
    const rows = await this.nt.executeSql(
      this.dbPath,
      `SELECT DISTINCT msg_seq FROM ${PROTOCOL_TABLE} WHERE kind='c2c' AND conv=?
       AND json_extract(payload,'$.clientSeq')=?
       AND (? IS NULL OR json_extract(payload,'$.senderUin')=?)
       AND (? IS NULL OR json_extract(payload,'$.sendTime')=?) LIMIT 2`,
      [conv, clientSeq, senderUin ?? null, senderUin ?? null, sendTime ?? null, sendTime ?? null],
    );
    return rows.length === 1 ? String(rows[0]?.[0]) : null;
  }

  /** 把拉取到的消息全部写入缓存（幂等：同一 seq 覆盖为最新）。 */
  async store(messages: GapFetchedMessage[]): Promise<void> {
    const protocol = messages.filter((message) => message.sourceFormat === 'protocol');
    if (protocol.length) await this.storeProtocol(protocol);
    const native = messages.filter((message) => message.sourceFormat === 'native');
    if (native.length) await this.storeNative(native, true);
    messages = messages.filter((message) => !message.sourceFormat);
    if (messages.length === 0) return;
    await this.ensureSchema();
    const run = async (): Promise<void> => {
      // 一批合成单条多行 INSERT：一次 native 调用 + 一个事务写完，避免每条
      // 消息一次 executeSqlWrite 往返（导出补全并发时尤其明显）。
      const fetchedAt = BigInt(Date.now());
      const rowSql: string[] = [];
      const params: SqlValue[] = [];
      for (const message of messages) {
        rowSql.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        params.push(
          message.kind,
          message.conv,
          toBigIntSafe(message.msgSeq),
          message.msgId,
          message.senderUid,
          message.senderUin,
          toBigIntSafe(message.sendTime),
          serializeJson(message.elements),
          message.decoration ? serializeJson(message.decoration) : null,
          fetchedAt,
          message.ntSeqVerified ? 1 : 0,
        );
      }
      await this.nt.executeSqlWrite(
        this.dbPath,
        `INSERT OR REPLACE INTO ${TABLE}
           (kind, conv, msg_seq, msg_id, sender_uid, sender_uin, send_time, elements, decoration, fetched_at, nt_seq_verified)
         VALUES ${rowSql.join(', ')}`,
        params,
      );
      // 写完释放写连接，避免长期持有 RESERVED 锁（与 QqDb.write 同一约定）。
      try {
        this.nt.closeDb(this.dbPath);
      } catch {
        /* ignore */
      }
    };
    const next = this.storeQueue.then(run, run);
    this.storeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  async storeNative(messages: GapFetchedMessage[], accepted: boolean): Promise<void> {
    if (!messages.length) return;
    await this.ensureSchema();
    const run = async () => {
      try {
        for (let i = 0; i < messages.length; i += 80) {
          const batch = messages.slice(i, i + 80);
          const params: SqlValue[] = [];
          for (const message of batch) {
            if (!message.nativeRaw || message.sourceFormat !== 'native')
              throw Error('原生缓存缺少原始消息。');
            const { elements: _elements, ...payload } = message;
            params.push(
              message.kind,
              message.conv,
              BigInt(message.msgSeq),
              message.msgId,
              accepted ? 1 : 0,
              JSON.stringify(payload),
            );
          }
          await this.nt.executeSqlWrite(
            this.dbPath,
            `INSERT OR REPLACE INTO ${NATIVE_TABLE} (kind,conv,msg_seq,msg_id,accepted,payload) VALUES ${batch.map(() => '(?,?,?,?,?,?)').join(',')}`,
            params,
          );
        }
      } finally {
        this.nt.closeDb(this.dbPath);
      }
    };
    const next = this.storeQueue.then(run, run);
    this.storeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  private async storeProtocol(messages: GapFetchedMessage[]): Promise<void> {
    await this.ensureSchema();
    const run = async () => {
      try {
        for (let i = 0; i < messages.length; i += 500) {
          const batch = messages.slice(i, i + 500);
          const params: SqlValue[] = [];
          for (const message of batch)
            params.push(
              message.kind,
              message.conv,
              BigInt(message.msgSeq),
              message.msgId,
              message.ntSeqVerified ? 1 : 0,
              serializeJson(message),
            );
          await this.nt.executeSqlWrite(
            this.dbPath,
            `INSERT OR REPLACE INTO ${PROTOCOL_TABLE}(kind,conv,msg_seq,msg_id,nt_seq_verified,payload)
             VALUES ${batch.map(() => '(?,?,?,?,?,?)').join(',')}`,
            params,
          );
        }
      } finally {
        this.nt.closeDb(this.dbPath);
      }
    };
    const next = this.storeQueue.then(run, run);
    this.storeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  async storeProtocolObservations(rows: ProtocolHistoryObservation[]): Promise<void> {
    if (!rows.length) return;
    await this.ensureSchema();
    const run = async () => {
      try {
        const params: SqlValue[] = [];
        for (const row of rows)
          params.push(
            row.kind,
            row.conv,
            BigInt(row.msgSeq),
            createHash('sha256').update(Buffer.from(row.protocolRaw, 'base64')).digest('hex'),
            row.reason,
            row.protocolRaw,
          );
        await this.nt.executeSqlWrite(
          this.dbPath,
          `INSERT OR IGNORE INTO ${OBSERVATION_TABLE}(kind,conv,msg_seq,raw_hash,reason,protocol_raw)
           VALUES ${rows.map(() => '(?,?,?,?,?,?)').join(',')}`,
          params,
        );
      } finally {
        this.nt.closeDb(this.dbPath);
      }
    };
    const next = this.storeQueue.then(run, run);
    this.storeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }

  /** 关闭缓存的 native 连接（账号切换 / 退出时调用）。 */
  close(): void {
    try {
      this.nt.closeDb(this.dbPath);
    } catch {
      /* ignore */
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    this.schemaPending ??= this.createSchema().catch((error: unknown) => {
      this.schemaPending = undefined;
      throw error;
    });
    await this.schemaPending;
  }

  private async createSchema(): Promise<void> {
    if (!existsSync(this.dbPath)) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      // SQLite 空文件即空库；先落一个空文件再建表。
      writeFileSync(this.dbPath, '');
    }
    await this.nt.executeSqlWrite(
      this.dbPath,
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        kind TEXT NOT NULL,
        conv TEXT NOT NULL,
        msg_seq INTEGER NOT NULL,
        msg_id TEXT NOT NULL,
        sender_uid TEXT NOT NULL,
        sender_uin TEXT NOT NULL,
        send_time INTEGER NOT NULL,
        elements TEXT NOT NULL,
        decoration TEXT,
        fetched_at INTEGER NOT NULL,
        nt_seq_verified INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, conv, msg_seq)
      )`,
      null,
    );
    await this.nt.executeSqlWrite(
      this.dbPath,
      `CREATE TABLE IF NOT EXISTS ${NATIVE_TABLE} (kind TEXT NOT NULL, conv TEXT NOT NULL, msg_seq INTEGER NOT NULL,
       msg_id TEXT NOT NULL, accepted INTEGER NOT NULL, payload TEXT NOT NULL,
       PRIMARY KEY(kind,conv,msg_seq,msg_id,accepted))`,
      null,
    );
    await this.nt.executeSqlWrite(
      this.dbPath,
      `CREATE INDEX IF NOT EXISTS native_gap_seq ON ${NATIVE_TABLE}(kind,conv,accepted,msg_seq)`,
      null,
    );
    await this.nt.executeSqlWrite(
      this.dbPath,
      `CREATE TABLE IF NOT EXISTS ${PROTOCOL_TABLE}(kind TEXT NOT NULL,conv TEXT NOT NULL,
       msg_seq INTEGER NOT NULL,msg_id TEXT NOT NULL,nt_seq_verified INTEGER NOT NULL,payload TEXT NOT NULL,
       PRIMARY KEY(kind,conv,msg_seq,msg_id))`,
      null,
    );
    await this.nt.executeSqlWrite(
      this.dbPath,
      `CREATE TABLE IF NOT EXISTS ${OBSERVATION_TABLE}(kind TEXT NOT NULL,conv TEXT NOT NULL,
       msg_seq INTEGER NOT NULL,raw_hash TEXT NOT NULL,reason TEXT NOT NULL,protocol_raw TEXT NOT NULL,
       PRIMARY KEY(kind,conv,msg_seq,raw_hash))`,
      null,
    );
    await this.nt.executeSqlWrite(
      this.dbPath,
      `CREATE INDEX IF NOT EXISTS protocol_sent_preview ON ${PROTOCOL_TABLE}(kind,conv,msg_seq)
       WHERE json_extract(payload,'$.localSent')=1 AND (kind='group' OR nt_seq_verified=1)`,
      null,
    );
    const columns = await this.nt.executeSql(
      this.dbPath,
      `SELECT name FROM pragma_table_info('${TABLE}') WHERE name = 'nt_seq_verified'`,
      null,
    );
    if (columns.length === 0) {
      try {
        await this.nt.executeSqlWrite(
          this.dbPath,
          `ALTER TABLE ${TABLE} ADD COLUMN nt_seq_verified INTEGER NOT NULL DEFAULT 0`,
          null,
        );
      } catch (error) {
        // Another process may have completed the same additive migration.
        const present = await this.nt.executeSql(
          this.dbPath,
          `SELECT name FROM pragma_table_info('${TABLE}') WHERE name = 'nt_seq_verified'`,
          null,
        );
        if (present.length === 0) throw error;
      }
    }
    this.schemaReady = true;
  }
}
