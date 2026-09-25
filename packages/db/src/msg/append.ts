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

import type { SqlRow, SqlValue } from '@weq/native';
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

  const values = [...(lastRows[0] as SqlRow)] as SqlValue[];
  const lastMsgId = toBigint(values[col('40001')]);

  // The conversation's current highest seq, via `MAX("40003")` (which walks the
  // `(40027,40003)` index to its rightmost entry). COALESCE keeps an all-seqless
  // partition at 0 → the new message becomes seq 1.
  const maxSeqRows = await qq.query(
    `SELECT COALESCE(MAX("40003"), 0) FROM ${table} WHERE ${partWhere}`,
    [partValue],
  );
  const newSeq = toBigint(maxSeqRows[0]?.[0]) + 1n;

  const newMsgId = lastMsgId + BigInt(1 + Math.floor(Math.random() * 1000));

  values[col('40001')] = newMsgId;
  values[col('40002')] = BigInt(Math.floor(Math.random() * 0x7fffffff));
  values[col('40003')] = newSeq;
  values[col('40011')] = BigInt(fields.msgType);
  values[col('40020')] = fields.senderUid;
  values[col('40033')] = fields.senderUin;
  values[col('40050')] = fields.sendTime;
  values[col('40058')] = fields.dayTimestamp;
  values[col('40800')] = fields.body;
  for (const c of NULL_COLUMNS) values[col(c)] = null;

  const placeholders = cols.map(() => '?').join(',');
  await qq.write(`INSERT INTO ${table} (${quoted}) VALUES (${placeholders})`, values);

  return { msgId: newMsgId, msgSeq: newSeq };
}
