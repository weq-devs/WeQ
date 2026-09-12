/**
 * DeletedSessionService — surfaces `recent_contact_delete_storage`
 * (「删除的会话」/deleted conversations) as conversation-list-shaped summaries.
 *
 * Key difference from hidden sessions: deleted sessions are REMOVED from
 * `recent_contact_v3_table` entirely, so we can't just filter the main list.
 * Instead, we check if the targetUid still exists in recent_contact — if it
 * DOESN'T exist there (and has a valid uid), it's a truly deleted session
 * that should appear in the deleted-session merged panel.
 *
 * We still resolve the REAL last-message time/preview by querying the peer's
 * row in `c2c_msg_table`/`group_msg_table` directly, just like hidden sessions.
 */

import type { AccountSession } from '@weq/account';
import type { DeletedSession } from '@weq/db';
import type { Element } from '@weq/codec';

export interface DeletedSessionSummary {
  sessionKey: string;
  chatType: number;
  targetUid: string;
  /** False when chatType/targetUid don't resolve, or the row IS in recent_contact_v3_table. */
  resolvable: boolean;
  /** Real last-message time (unix seconds), resolved from the msg table. 0 if none found. */
  sendTime: bigint;
  senderUid: string;
  /** Latest message's first element, for a list preview. */
  preview: Element | null;
  /** Deletion timestamp (unix milliseconds). */
  deleteTime: bigint;
}

/** `u_` + base64url-ish body, matching real QQ uids seen across the codebase. */
const UID_PATTERN = /^u_[\w-]{20,}$/;
const GROUP_CODE_PATTERN = /^\d+$/;

export class DeletedSessionService {
  constructor(private readonly session: AccountSession) {}

  async listDeletedSessions(): Promise<DeletedSessionSummary[]> {
    const rows = await this.session.deletedSessions.listDeletedSessions();
    // 一次性精确查询这些 targetUid 是否还在 recent_contact_v3_table 里 ——
    // 如果还在，说明又有新消息了，会话已经"复活"，不应该出现在删除列表里。
    const inRecentSet = await this.session.recentContacts.hasTargetUids(
      rows.map((row) => row.targetUid),
    );
    return Promise.all(rows.map((row) => this.resolve(row, inRecentSet)));
  }

  private async resolve(
    row: DeletedSession,
    inRecentSet: Set<string>,
  ): Promise<DeletedSessionSummary> {
    const base = {
      sessionKey: row.sessionKey,
      chatType: row.chatType,
      targetUid: row.targetUid,
      deleteTime: row.deleteTime,
    };

    // 有效条件：targetUid 必须存在且符合格式，并且这条会话
    // 不在 recent_contact_v3_table 里（删除后没有复活）。
    const inRecent = inRecentSet.has(row.targetUid);
    const isC2c = row.chatType === 1 || row.chatType === 10; // 1=普通c2c, 10=临时会话
    const isGroup = row.chatType === 2;

    if (isC2c && UID_PATTERN.test(row.targetUid) && !inRecent) {
      const [latest] = await this.session.c2cMsgs.listLatest({ uid: row.targetUid }, 1);
      return { ...base, resolvable: true, ...summarizeLatest(latest) };
    }
    if (isGroup && GROUP_CODE_PATTERN.test(row.targetUid) && !inRecent) {
      const [latest] = await this.session.groupMsgs.listLatest(row.targetUid, 1);
      return { ...base, resolvable: true, ...summarizeLatest(latest) };
    }
    return { ...base, resolvable: false, sendTime: 0n, senderUid: '', preview: null };
  }
}

function summarizeLatest(
  latest: { sendTime: bigint; senderUid: string; elements: Element[] } | undefined,
): Pick<DeletedSessionSummary, 'sendTime' | 'senderUid' | 'preview'> {
  if (!latest) return { sendTime: 0n, senderUid: '', preview: null };
  return {
    sendTime: latest.sendTime,
    senderUid: latest.senderUid,
    preview: latest.elements[0] ?? null,
  };
}
