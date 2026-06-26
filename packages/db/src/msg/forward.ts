/**
 * Forward / reply cache lookup — the 40900 column.
 *
 * When a message is a merged-forward (msgType 8) or quote-reply (msgType 9),
 * its cached source/quoted message(s) live in the 40900 column as a REPEATED
 * MsgCache (which can itself nest 40900 — see proto/msg/40900.ts). This class
 * fetches one message row by msgId and decodes that column.
 *
 * c2c and group share the same column layout (40001 = msgId, 40900 = cache),
 * differing only in table name — hence two thin methods over one query.
 */

import { decodeMsgCacheColumn, type MsgCacheRecord } from '@weq/codec';
import type { DatabaseAlgorithms, NtHelperBinding, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

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
    return this.queryForward('c2c_msg_table', msgId);
  }

  /** Forward/reply cache for a group message, by msgId. */
  listGroupForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    return this.queryForward('group_msg_table', msgId);
  }

  // `table` is an internal constant (never user input) so interpolating it
  // into the SQL is safe; msgId is bound as a parameter.
  private async queryForward(table: string, msgId: bigint): Promise<MsgCacheRecord[]> {
    const rows = await this.qq.query(
      `SELECT "40900" FROM ${table} WHERE "40001" = ? LIMIT 1`,
      [msgId],
    );
    const blob: SqlValue | undefined = rows[0]?.[0];
    if (!(blob instanceof Uint8Array)) return [];
    return decodeMsgCacheColumn(blob);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}
