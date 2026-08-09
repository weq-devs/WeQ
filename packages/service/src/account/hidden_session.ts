/**
 * HiddenSessionService — surfaces `hidden_session_storage_table_v1`
 * (「隐藏聊天」/hidden conversations) as conversation-list-shaped summaries.
 *
 * The storage table itself carries no timestamp or message preview (see
 * `HiddenSession` in `@weq/db`) — the whole point of merging these back into
 * the visible session list is to sort them correctly, so this resolves the
 * REAL last-message time/preview by querying the peer's row in
 * `c2c_msg_table`/`group_msg_table` directly, the same tables the normal
 * chat view reads. A row whose chatType/targetUid don't resolve to a real
 * conversation (observed once in 3 real samples) comes back `resolvable:
 * false` rather than a guessed identity.
 */

import type { AccountSession } from '@weq/account';
import type { HiddenSession } from '@weq/db';
import type { Element } from '@weq/codec';

export interface HiddenSessionSummary {
  storageKey: string;
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  /** False when chatType/targetUid don't resolve to an addressable conversation. */
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
    return Promise.all(rows.map((row) => this.resolve(row)));
  }

  private async resolve(row: HiddenSession): Promise<HiddenSessionSummary> {
    const base = {
      storageKey: row.storageKey,
      chatType: row.chatType,
      targetUid: row.targetUid,
      targetUin: row.targetUin,
    };

    if (row.chatType === 'KCHATTYPEC2C' && UID_PATTERN.test(row.targetUid)) {
      const [latest] = await this.session.c2cMsgs.listLatest({ uid: row.targetUid }, 1);
      return { ...base, resolvable: true, ...summarizeLatest(latest) };
    }
    if (row.chatType === 'KCHATTYPEGROUP' && GROUP_CODE_PATTERN.test(row.targetUid)) {
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
