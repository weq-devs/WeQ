/**
 * HiddenSessionService — surfaces `hidden_session_storage_table_v1`
 * (「隐藏聊天」/hidden conversations) as conversation-list-shaped summaries.
 *
 * The storage table itself carries no timestamp or message preview (see
 * `HiddenSession` in `@weq/db`) — the whole point of merging these back into
 * the visible session list is to sort them correctly, so this resolves the
 * REAL last-message time/preview by querying the peer's row in
 * `c2c_msg_table`/`group_msg_table` directly, the same tables the normal
 * chat view reads.
 *
 * QQ's hiding is a *marker*, not a removal: the row stays in
 * `recent_contact_v3_table` and only gets an extra entry in
 * `hidden_session_storage_table_v1`. A conversation only counts as
 * genuinely "hidden" (and thus `resolvable: true`) when BOTH tables agree —
 * present in the hidden table AND still present in `recent_contact_v3_table`.
 * That existence check goes through `RecentContactDb.hasTargetUids`, an
 * unbounded exact lookup — NOT `getRecentContact`'s capped top-200 list,
 * which would silently drop a long-idle hidden conversation that's fallen
 * off the recent-chats page.
 */

import type { AccountSession } from '@weq/account';
import type { HiddenSession } from '@weq/db';
import type { Element } from '@weq/codec';

export interface HiddenSessionSummary {
  storageKey: string;
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  /** False when chatType/targetUid don't resolve, or the row is no longer in recent_contact_v3_table. */
  resolvable: boolean;
  /** Real last-message time (unix seconds), resolved from the msg table. 0 if none found. */
  sendTime: bigint;
  senderUid: string;
  /** Latest message's first element, for a list preview. Not QQ's `displayText`-carrying PreviewElement, but the same `kind` taxonomy. */
  preview: Element | null;
}

/** `u_` + base64url-ish body, matching real QQ uids seen across the codebase. */
const UID_PATTERN = /^u_[\w-]{20,}$/;
const GROUP_CODE_PATTERN = /^\d+$/;

export class HiddenSessionService {
  constructor(private readonly session: AccountSession) {}

  async listHiddenSessions(): Promise<HiddenSessionSummary[]> {
    const rows = await this.session.hiddenSessions.listHiddenSessions();
    // 一次性精确查询这些 targetUid 是否还在 recent_contact_v3_table 里 ——
    // 不受 getRecentContact 的 LIMIT 200 影响,避免久未活跃的隐藏会话被漏判。
    const inRecentSet = await this.session.recentContacts.hasTargetUids(
      rows.map((row) => row.targetUid),
    );
    return Promise.all(rows.map((row) => this.resolve(row, inRecentSet)));
  }

  private async resolve(
    row: HiddenSession,
    inRecentSet: Set<string>,
  ): Promise<HiddenSessionSummary> {
    const base = {
      storageKey: row.storageKey,
      chatType: row.chatType,
      targetUid: row.targetUid,
      targetUin: row.targetUin,
    };

    // 有效条件：targetUid 必须存在且符合格式（targetUin 可选），并且这条会话
    // 仍然在 recent_contact_v3_table 里 —— 两表都有才算真正「隐藏的会话」。
    const inRecent = inRecentSet.has(row.targetUid);
    if (row.chatType === 'KCHATTYPEC2C' && UID_PATTERN.test(row.targetUid) && inRecent) {
      const [latest] = await this.session.c2cMsgs.listLatest({ uid: row.targetUid }, 1);
      return { ...base, resolvable: true, ...summarizeLatest(latest) };
    }
    if (row.chatType === 'KCHATTYPEGROUP' && GROUP_CODE_PATTERN.test(row.targetUid) && inRecent) {
      const [latest] = await this.session.groupMsgs.listLatest(row.targetUid, 1);
      return { ...base, resolvable: true, ...summarizeLatest(latest) };
    }
    return { ...base, resolvable: false, sendTime: 0n, senderUid: '', preview: null };
  }
}

function summarizeLatest(
  latest: { sendTime: bigint; senderUid: string; elements: Element[] } | undefined,
): Pick<HiddenSessionSummary, 'sendTime' | 'senderUid' | 'preview'> {
  if (!latest) return { sendTime: 0n, senderUid: '', preview: null };
  return {
    sendTime: latest.sendTime,
    senderUid: latest.senderUid,
    preview: latest.elements[0] ?? null,
  };
}
