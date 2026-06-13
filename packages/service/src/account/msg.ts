/**
 * MsgService — fetch the messages of one conversation, by target.
 *
 * Two methods, one per chat type. Both take the conversation target (peer uid
 * for c2c, group code for group — both come from RecentContact.targetUid) plus
 * offset paging. Returns the structured `*Msg[]`; bigint ids/timestamps are
 * serialized at the IPC/JSON boundary by the caller.
 */

import type { AccountSession } from '@weq/account';
import type { C2cMsg, GroupMsg } from '@weq/db';

export class MsgService {
  constructor(private readonly session: AccountSession) {}

  /** Private-chat messages with one peer (by peer uid), newest first. */
  getC2cMessages(targetUid: string, limit = 50, offset = 0): Promise<C2cMsg[]> {
    return this.session.c2cMsgs.listMessagesWithTarget(targetUid, limit, offset);
  }

  /** Group-chat messages in one group (by group code), newest first. */
  getGroupMessages(targetGroupCode: string, limit = 50, offset = 0): Promise<GroupMsg[]> {
    return this.session.groupMsgs.listMessagesWithTarget(targetGroupCode, limit, offset);
  }
}
