export type ContactNoticeKind = 'friend' | 'group';

export type NoticeOperationWire = {
  token: string;
  noticeId?: string;
  sequence?: string;
  inboxCursor?: string;
  uid: string;
  uin: string;
  groupId: string;
  name: string;
  groupName: string;
  message: string;
};

export function groupNoticeSequenceId(sequence: string, filtered: boolean): string {
  return `group-notify-seq:${filtered ? 'filtered' : 'normal'}:${sequence}`;
}

/** 与通知列表使用相同窗口，文件变更不扫描完整历史。 */
export const CONTACT_NOTICE_LIMIT = 2000;
