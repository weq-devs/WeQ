/**
 * `c2c_msg_table` — private-chat (one-on-one) messages.
 *
 * Column map (subset we actually read; more columns exist):
 *   40001  msgId         (INTEGER)
 *   40020  senderUid     (TEXT)
 *   40021  peerUid       (TEXT)
 *   40030  peerUin       (INTEGER)
 *   40033  senderUin     (INTEGER)
 *   40050  sendTime      (INTEGER, unix seconds)
 *   40800  msgBody       (BLOB — protobuf repeated ElementWire)
 *
 * The 40800 column is decoded by `@weq/codec`. Row-level columns and
 * decoded elements are assembled into `C2cMsg`.
 */

import { ProtoMsg } from '@weq/codec';
import { decodeElement } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import type { NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { C2cMsg, C2cPeer } from './types';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40001","40020","40021","40030","40033","40050","40800"`;
const bodyCodec = new ProtoMsg(MsgBody);

export interface C2cMsgDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. */
  key: string;
}

export class C2cMsgDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: C2cMsgDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key });
  }

  /**
   * Most recent N messages exchanged with one peer, newest first.
   *
   * `peerUin` is the QQ number of the contact (not the encoded uid). We
   * intentionally filter on `40030` (peerUin) — using the uid here would
   * require an extra lookup, and the caller always knows the uin.
   */
  async listRecentWithPeer(peerUin: bigint, limit = 50, offset = 0): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        WHERE "40030" = ?
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [peerUin, BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToC2cMsg);
  }

  /** Most recent N messages across all peers, newest first. Useful for "test dump". */
  async listRecent(limit = 50, offset = 0): Promise<C2cMsg[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM c2c_msg_table
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToC2cMsg);
  }

  /**
   * Distinct peers that appear in c2c_msg_table, ordered by most recent
   * message first. Used by the main view's left pane.
   *
   * The aggregation is cheap on QQ's index over `40030 + 40050` (the
   * primary use of the table). Even for a 1M-row db this returns in
   * sub-second.
   */
  async listPeers(): Promise<C2cPeer[]> {
    const rows = await this.qq.query(
      `SELECT "40030", MAX("40050"), COUNT(*)
         FROM c2c_msg_table
        GROUP BY "40030"
        ORDER BY MAX("40050") DESC`,
    );
    return rows.map(rowToC2cPeer);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

// ---------- row → C2cMsg --------------------------------------------------

function rowToC2cMsg(row: SqlRow): C2cMsg {
  return {
    msgId: toBigint(row[0]),
    senderUid: toStr(row[1]),
    peerUid: toStr(row[2]),
    peerUin: toBigint(row[3]),
    senderUin: toBigint(row[4]),
    sendTime: toBigint(row[5]),
    elements: decodeBody(row[6]),
  };
}

function decodeBody(blob: SqlValue | undefined): C2cMsg['elements'] {
  if (!(blob instanceof Uint8Array)) return [];
  try {
    // Sanitize first: drop fields whose on-wire type conflicts with the schema
    // so one mis-declared tag can't derail the whole message. Conflicting (or
    // genuinely missing) fields just go absent instead of failing the decode.
    const decoded = bodyCodec.decode(sanitizeBytes(blob, MsgBody));
    return (decoded.elements ?? []).map(decodeElement);
  } catch (e) {
    console.error(`[C2cMsgDb] failed to decode msgBody:`, e);
    return [{ kind: 'text', textContent: '[解析消息失败: 格式错误]' }];
  }
}

function rowToC2cPeer(row: SqlRow): C2cPeer {
  return {
    peerUin: toBigint(row[0]),
    lastSendTime: toBigint(row[1]),
    msgCount: Number(toBigint(row[2])),
  };
}

function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
