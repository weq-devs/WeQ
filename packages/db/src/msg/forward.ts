/**
 * Forward / reply cache lookup — the 40900 column.
 *
 * When a message is a merged-forward (msgType 8) or quote-reply (msgType 9),
 * its cached source/quoted message(s) live in the 40900 column as a REPEATED
 * MsgCache (which can itself nest 40900 — see proto/msg/40900.ts). This class
 * fetches one message row by msgId and decodes that column.
 *
 * 私聊、群聊和小Q使用相同的消息 ID 与缓存列，按消息来源定位表。
 */

import { decodeMsgCacheColumn, type MsgCacheRecord } from '@weq/codec';
import type { DatabaseAlgorithms, NtHelperBinding, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const FORWARD_TABLES = {
  c2c: 'c2c_msg_table',
  group: 'group_msg_table',
  aiAssistant: 'ai_assistant_msg_table',
};
export type ForwardCacheKind = keyof typeof FORWARD_TABLES;

export interface ForwardMsgDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class ForwardMsgDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: ForwardMsgDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** Forward/reply cache for a c2c message, by msgId. */
  listC2cForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    return this.listForward('c2c', msgId);
  }

  /** Forward/reply cache for a group message, by msgId. */
  listGroupForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    return this.listForward('group', msgId);
  }

  /** 单页引用缓存批量读取；坏 BLOB 仅影响该条引用。 */
  async listForMessages(
    kind: 'c2c' | 'group',
    msgIds: readonly bigint[],
  ): Promise<Map<bigint, MsgCacheRecord[]>> {
    const table = FORWARD_TABLES[kind];
    const ids = [...new Set(msgIds)];
    const result = new Map<bigint, MsgCacheRecord[]>();
    for (let offset = 0; offset < ids.length; offset += 256) {
      const batch = ids.slice(offset, offset + 256);
      const rows = await this.qq.query(
        `SELECT "40001", "40900" FROM ${table} WHERE "40001" IN (${batch.map(() => '?').join(',')})`,
        batch,
      );
      for (const row of rows) {
        if (!(row[1] instanceof Uint8Array)) continue;
        try {
          result.set(BigInt(String(row[0])), decodeMsgCacheColumn(row[1]));
        } catch {
          /* 仅保留原有引用占位，不让坏缓存拖垮整页。 */
        }
      }
    }
    return result;
  }

  async listForward(kind: ForwardCacheKind, msgId: bigint): Promise<MsgCacheRecord[]> {
    const table = FORWARD_TABLES[kind];
    const rows = await this.qq.query(`SELECT "40900" FROM ${table} WHERE "40001" = ? LIMIT 1`, [
      msgId,
    ]);
    const blob: SqlValue | undefined = rows[0]?.[0];
    if (!(blob instanceof Uint8Array)) return [];
    return decodeMsgCacheColumn(blob);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}
