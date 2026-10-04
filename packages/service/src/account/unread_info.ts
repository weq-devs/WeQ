import type { AccountSession } from '@weq/account';
import type { UnreadHighlightInput, UnreadInfoResult } from '@weq/db';

export class UnreadInfoService {
  constructor(private readonly session: AccountSession) {}

  getUnreadInfo(chatType: number, uid: string): Promise<UnreadInfoResult | null> {
    return this.session.unreadInfo.getUnreadInfo(chatType, uid);
  }

  /**
   * Mark a conversation read (raises the last-read seq, drops highlight groups).
   * `latestSeq` is optional — the DB layer falls back to the conversation's
   * recent-contact watermark when omitted.
   */
  markRead(chatType: number, uid: string, latestSeq?: string): Promise<boolean> {
    return this.session.unreadInfo.markRead(chatType, uid, latestSeq);
  }

  /**
   * Append one notify-highlight hit (e.g. 群提醒词 `2006`) to a conversation so
   * both WeQ and QQ show the badge. Idempotent per `(kind, msgSeq)`.
   */
  addHighlight(chatType: number, uid: string, highlight: UnreadHighlightInput): Promise<boolean> {
    return this.session.unreadInfo.addHighlight(chatType, uid, highlight);
  }
}
