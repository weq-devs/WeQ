/**
 * Insert a brand-new message row by *cloning the conversation's newest row* as a
 * template and overriding the handful of columns we understand.
 *
 * Why clone instead of build from scratch: the message tables have ~38 columns,
 * most of them opaque flags with no safe default. Copying the latest row of the
 * same conversation carries those flags forward verbatim (proven not to corrupt
 * the DB in manual testing), while we override only the fields that must change
 * for a new message:
 *
 *   40001 msgId        → last + small random increment  (unique & monotonic)
 *   40002 msgRandom    → fresh random (part of the c2c UNIQUE(40027,40002,40005))
 *   40003 msgSeq       → MAX(seq) + 1  (see below)
 *   40011 msgType      → caller (2 = plain, 9 = reply)
 *   40020 senderUid    → caller
 *   40033 senderUin    → caller
 *   40050 sendTime     → caller (unix seconds)
 *   40058 dayTimestamp → caller (local midnight of sendTime)
 *   40800 msgBody      → caller (encoded elements)
 *   40801, 40900       → NULL  (display-text / source-message cache; copying
 *                               them verbatim breaks reply/forward rendering)
 *   40062 setEmoji     → NULL  (a new message carries no sticker reactions)
 *
 * The clone requires the conversation to already have at least one message
 * (returns null otherwise) — the intended use is appending to existing chats.
 *
 * `msgSeq` is taken from an explicit `MAX("40003")`, NOT from the template
 * row. The two happen to agree today (the template IS the max-seq row), but
 * they answer different questions — "which row do I copy the opaque columns
 * from" vs "what seq must the next message have" — and only the latter may
 * drift (seq ties, NULL/0 seq-less rows, a template rule change). Keeping them
 * separate means a change to the clone rule can never silently renumber new
 * messages into the middle of the conversation.
 */

import { resolve } from 'node:path';
import type { SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';
import { toBigint } from './util';

/** Domain fields the caller supplies for the new row. */
export interface AppendMsgFields {
  senderUid: string;
  senderUin: bigint;
  /** Column 40011: 2 = plain, 9 = reply. */
  msgType: number;
  /** Column 40050, unix seconds. */
  sendTime: bigint;
  /** Column 40058, local midnight of sendTime (unix seconds). */
  dayTimestamp: bigint;
  /** Column 40800, encoded `repeated ElementWire`. */
  body: Uint8Array;
}

/** What the caller gets back after a successful append. */
export interface AppendMsgResult {
  msgId: bigint;
  msgSeq: bigint;
}

/** Columns forced to NULL on the clone. */
const NULL_COLUMNS = ['40801', '40900', '40062'] as const;
const pendingAppends = new Map<string, { tail: Promise<void>; count: number }>();
const MAX_PENDING_APPENDS = 256;

/**
 * Clone the newest row of the partition (identified by `partWhere`/`partValue`)
 * and insert it with the caller's overrides. Returns the new msgId/msgSeq, or
 * `null` if the conversation has no existing message to clone.
 */
export async function appendClonedRow(
  qq: QqDb,
  table: string,
  partWhere: string,
  partValue: SqlValue,
  fields: AppendMsgFields,
): Promise<AppendMsgResult | null> {
  // 同库不同 QqDb 句柄也协调模板 ID；外部进程的 seq 竞争由下面的单条 SQL 处理。
  const key = resolve(qq.dbPath);
  const previous = pendingAppends.get(key);
  if ((previous?.count ?? 0) >= MAX_PENDING_APPENDS)
    throw new Error('消息追加队列已满，请稍后重试');
  const snapshot = { ...fields, body: new Uint8Array(fields.body) };
  const result = (previous?.tail ?? Promise.resolve()).then(() =>
    appendAtomic(qq, table, partWhere, partValue, snapshot),
  );
  const tail = result.then(
    () => {},
    () => {},
  );
  pendingAppends.set(key, { tail, count: (previous?.count ?? 0) + 1 });
  try {
    return await result;
  } finally {
    const current = pendingAppends.get(key);
    if (current?.tail === tail) pendingAppends.delete(key);
    else if (current) current.count--;
  }
}

async function appendAtomic(
  qq: QqDb,
  table: string,
  partWhere: string,
  partValue: SqlValue,
  fields: AppendMsgFields,
): Promise<AppendMsgResult | null> {
  // Column order = declaration order (matches PRAGMA cid order and SELECT-list order).
  const info = await qq.query(`PRAGMA table_info("${table}")`);
  const cols = info.map((r) => String(r[1]));
  const quoted = cols.map((c) => `"${c}"`).join(',');
  const col = (c: string): number => {
    const i = cols.indexOf(c);
    if (i < 0) throw new Error(`[append] column ${c} missing from ${table}`);
    return i;
  };

  const lastRows = await qq.query(
    `SELECT ${quoted} FROM ${table} WHERE ${partWhere} ORDER BY "40003" DESC LIMIT 1`,
    [partValue],
  );
  if (lastRows.length === 0) return null;

  const lastMsgId = toBigint(lastRows[0]![col('40001')]);
  const newMsgId = lastMsgId + BigInt(1 + Math.floor(Math.random() * 1000));
  const random = BigInt(Math.floor(Math.random() * 0x7fffffff));
  const overrides = new Map<string, SqlValue>([
    ['40001', newMsgId],
    ['40002', random],
    ['40011', BigInt(fields.msgType)],
    ['40020', fields.senderUid],
    ['40033', fields.senderUin],
    ['40050', fields.sendTime],
    ['40058', fields.dayTimestamp],
    ['40800', fields.body],
    ...NULL_COLUMNS.map((c): [string, SqlValue] => [c, null]),
  ]);
  for (const c of [...overrides.keys(), '40003']) col(c);
  const params: SqlValue[] = [];
  const select = cols
    .map((c) => {
      if (c === '40003') {
        params.push(partValue);
        return `(SELECT COALESCE(MAX("40003"), 0) + 1 FROM ${table} WHERE ${partWhere})`;
      }
      if (!overrides.has(c)) return `"${c}"`;
      params.push(overrides.get(c)!);
      return '?';
    })
    .join(',');
  params.push(partValue, partValue);
  // 模板与 MAX 在同一个写语句快照中读取；不跨 native 调用拼 BEGIN/COMMIT。
  const changed = await qq.write(
    `INSERT INTO ${table} (${quoted}) SELECT ${select} FROM ${table} WHERE ${partWhere}
      AND (SELECT COALESCE(MAX("40003"), 0) FROM ${table} WHERE ${partWhere}) < 9223372036854775807
      ORDER BY "40003" DESC LIMIT 1`,
    params,
  );
  if (changed === 0) throw new Error('会话已变化或消息序号达到上限，未追加消息');
  try {
    if (changed !== 1) throw new Error('追加影响行数异常');
    const rows = await qq.query(
      `SELECT "40003" FROM ${table} WHERE "40001" = ? AND "40002" = ? AND ${partWhere}`,
      [newMsgId, random, partValue],
    );
    if (rows.length !== 1) throw new Error('无法唯一定位追加消息');
    return { msgId: newMsgId, msgSeq: toBigint(rows[0]![0]) };
  } catch (error) {
    throw new Error('消息追加已执行，但无法核对结果；请刷新确认，勿自动重试', { cause: error });
  }
}
