/**
 * ForwardMsgService — fetch the merged-forward / quote-reply cache (40900) for
 * one message, by msgId. Group and c2c are separate methods because they hit
 * different tables (group_msg_table / c2c_msg_table).
 *
 * Returns the raw repeated `MsgCacheRecord[]` from tag 40900 — each record a
 * full cached message snapshot, possibly nesting its own 40900 list (deep
 * forwards). Callers serialize at the IPC/JSON boundary (bigint + bytes).
 */

import type { AccountSession } from '@weq/account';
import type { MsgCacheRecord } from '@weq/codec';

export class ForwardMsgService {
  constructor(private readonly session: AccountSession) {}

  /** Forward/reply cache for a c2c message. */
  getC2cForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    return this.session.forwardMsgs.listC2cForward(msgId);
  }

  /** Forward/reply cache for a group message. */
  getGroupForward(msgId: bigint): Promise<MsgCacheRecord[]> {
    return this.session.forwardMsgs.listGroupForward(msgId);
  }
}
