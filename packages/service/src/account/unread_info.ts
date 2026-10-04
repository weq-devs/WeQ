import type { AccountSession } from '@weq/account';
import type { UnreadInfoResult } from '@weq/db';

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
}
