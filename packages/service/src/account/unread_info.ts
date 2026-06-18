import type { AccountSession } from '@weq/account';
import type { UnreadInfoResult } from '@weq/db';

export class UnreadInfoService {
  constructor(private readonly session: AccountSession) {}

  getUnreadInfo(chatType: number, uid: string): Promise<UnreadInfoResult | null> {
    return this.session.unreadInfo.getUnreadInfo(chatType, uid);
  }
}
