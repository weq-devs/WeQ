/**
 * RoamMsgCacheDb — 按账号缓存「缺失消息」（漫游消息回填）的本地 SQLite。
 *
 * 布局：weq 缓存目录下新开 `roam-msg/` 文件夹，每个账号一个数据库文件
 * `<cacheBase>/roam-msg/<uin>.db`。只存已经从 QQ 服务端拉到的渲染视图
 * （{ type, data } 元素），前端再次遇到同一个缺口时先查这里，命中就直接
 * 渲染，不用重新联网（甚至 QQ 不在线也能看）。
 *
 * 表结构：单表 `gap_msg`，主键 (kind, conv, msg_seq) 即「会话 + seq」复合索引
 * （一个 seq 最多一条），读取按主键区间扫描即可拿到一段 seq 窗口。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { GapFetchedMessage } from './gap_history';

const TABLE = 'gap_msg';

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
  const [, , msgId, msgSeq, senderUid, senderUin, sendTime, elements, decoration] = row;
  const message: GapFetchedMessage = {
    kind: String(row[0] ?? '') as GapFetchedMessage['kind'],
    conv: String(row[1] ?? ''),
    msgId: String(msgId ?? ''),
    msgSeq: String(msgSeq ?? ''),
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

export class RoamMsgCacheDb {
  readonly dbPath: string;
  private readonly nt: Pick<NtHelperBinding, 'executeSql' | 'executeSqlWrite' | 'closeDb'>;
  private schemaReady = false;

  constructor(
    nt: Pick<NtHelperBinding, 'executeSql' | 'executeSqlWrite' | 'closeDb'>,
    dbPath: string,
  ) {
    this.nt = nt;
    this.dbPath = dbPath;
  }

  /** 读一段 [startSeq, endSeq] 的缓存消息，按 seq 升序。 */
  async query(
    kind: 'c2c' | 'group',
    conv: string,
    startSeq: number,
    endSeq: number,
  ): Promise<GapFetchedMessage[]> {
    if (startSeq > endSeq) return [];
    await this.ensureSchema();
    const rows = await this.nt.executeSql(
      this.dbPath,
      `SELECT kind, conv, msg_id, msg_seq, sender_uid, sender_uin, send_time, elements, decoration
         FROM ${TABLE}
        WHERE kind = ? AND conv = ? AND msg_seq BETWEEN ? AND ?
        ORDER BY msg_seq ASC`,
      [kind, conv, BigInt(startSeq), BigInt(endSeq)],
    );
    return rows.map(rowToMessage);
  }

  /** 按 msgId 找一条已缓存的缺失消息（媒体补全 / 文件下载回查用）。 */
  async findByMsgId(msgId: string): Promise<GapFetchedMessage | null> {
    if (!msgId) return null;
    await this.ensureSchema();
    const rows = await this.nt.executeSql(
      this.dbPath,
      `SELECT kind, conv, msg_id, msg_seq, sender_uid, sender_uin, send_time, elements, decoration
         FROM ${TABLE}
        WHERE msg_id = ? LIMIT 1`,
      [msgId],
    );
    return rows.length > 0 ? rowToMessage(rows[0]!) : null;
  }

  /** 把拉取到的消息全部写入缓存（幂等：同一 seq 覆盖为最新）。 */
  async store(messages: GapFetchedMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.ensureSchema();
    const fetchedAt = BigInt(Date.now());
    for (const message of messages) {
      const params: SqlValue[] = [
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
      ];
      await this.nt.executeSqlWrite(
        this.dbPath,
        `INSERT OR REPLACE INTO ${TABLE}
           (kind, conv, msg_seq, msg_id, sender_uid, sender_uin, send_time, elements, decoration, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
      );
    }
    // 写完释放写连接，避免长期持有 RESERVED 锁（与 QqDb.write 同一约定）。
    try {
      this.nt.closeDb(this.dbPath);
    } catch {
      /* ignore */
    }
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
        PRIMARY KEY (kind, conv, msg_seq)
      )`,
      null,
    );
    this.schemaReady = true;
  }
}
