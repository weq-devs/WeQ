/**
 * MsgService — fetch the messages of one conversation, by target.
 *
 * Two methods, one per chat type. Both take the conversation target (peer uid
 * for c2c, group code for group — both come from RecentContact.targetUid) plus
 * offset paging. Returns the structured `*Msg[]`; bigint ids/timestamps are
 * serialized at the IPC/JSON boundary by the caller.
 */

import type { AccountSession, LastMsgIdMaps } from '@weq/account';
import type { C2cMsg, GroupMsg } from '@weq/db';

export class MsgService {
  constructor(private readonly session: AccountSession) {}

  /** Private-chat messages with one peer (by peer uid), newest first. */
  async getC2cMessages(targetUid: string, limit = 50, offset = 0): Promise<C2cMsg[]> {
    const msgs = await this.session.c2cMsgs.listMessagesWithTarget(targetUid, limit, offset);
    // These rows are newest-first; the user is now looking at the latest, so
    // advance the watch baseline (monotonically) — the file-watcher hook
    // won't re-push what's already on screen. Only the freshest page
    // (offset 0) can carry the global newest, so skip the bump when paging.
    if (offset === 0) bumpMaxMsgId(this.session.lastMsgIdMaps, 'c2cMsgId', msgs);
    return msgs;
  }

  /** Group-chat messages in one group (by group code), newest first. */
  async getGroupMessages(targetGroupCode: string, limit = 50, offset = 0): Promise<GroupMsg[]> {
    const msgs = await this.session.groupMsgs.listMessagesWithTarget(targetGroupCode, limit, offset);
    if (offset === 0) bumpMaxMsgId(this.session.lastMsgIdMaps, 'groupMsgId', msgs);
    return msgs;
  }
}

/**
 * Advance `maps[key]` to the largest msgId in `msgs` (never backwards).
 * Shared by the "latest"-reading services so the nt_msg.db watch hook treats
 * already-seen messages as old. Safe on empty / out-of-order input.
 */
export function bumpMaxMsgId(
  maps: LastMsgIdMaps,
  key: keyof LastMsgIdMaps,
  msgs: readonly { msgId: bigint }[],
): void {
  for (const m of msgs) {
    if (m.msgId > maps[key]) maps[key] = m.msgId;
  }
}
