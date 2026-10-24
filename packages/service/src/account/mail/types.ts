export interface MailAddress {
  email: string;
  name: string;
}

export interface MailFolder {
  id: number;
  name: string;
  unread: number;
  total: number;
  locked: boolean;
}

export interface MailSummary {
  id: string;
  folderId: number;
  messageId: string;
  subject: string;
  snippet: string;
  sender: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  time: number;
  size: number;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  draft: boolean;
}

/** 下载凭据留在服务内，只向界面返回附件标识。 */
export interface MailAttachment {
  id: string;
  name: string;
  size: number;
  big: boolean;
  available: boolean;
}

export interface MailDetail extends MailSummary {
  html: string;
  replyTo: MailAddress | null;
  attachments: MailAttachment[];
  thread?: MailSummary[];
}

export interface MailPage {
  items: MailSummary[];
  page: number;
  total: number;
  unread: number;
  hasMore: boolean;
}

export interface MailListInput {
  folderId: number;
  page: number;
  pageSize?: number;
  unreadOnly?: boolean;
  keyword?: string;
}

export interface MailExportFilter {
  /** Unix 秒，起点包含，终点不包含。 */
  startTime?: number;
  endTime?: number;
  sender?: string;
  subject?: string;
}

export interface MailComposeInput {
  subject: string;
  content: string;
  plainText: boolean;
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  attachments: string[];
  replyId?: string;
  forwardId?: string;
  draftId?: string;
}

export type MailConnectionState = 'disconnected' | 'connecting' | 'ready' | 'error';

export interface MailStatus {
  state: MailConnectionState;
  unread: number;
  notifications: boolean;
  lastSync: number | null;
  error: string | null;
}

export interface MailNotice {
  id: string;
  subject: string;
  sender: string;
  folderId: number;
}

export interface MailEvent {
  type: 'status' | 'changed' | 'new-mail' | 'open';
  status?: MailStatus;
  notice?: MailNotice;
}

export type MailAction = 'read' | 'unread' | 'star' | 'unstar' | 'trash';

export type MailFailureKind = 'auth' | 'offline' | 'network' | 'business' | 'unknown-send';

/** 不携带请求地址、票据、原始响应或收件人，允许安全跨 IPC 返回。 */
export class MailFailure extends Error {
  constructor(
    readonly kind: MailFailureKind,
    message: string,
    readonly businessCode?: string,
  ) {
    super(message);
    this.name = 'MailFailure';
  }
}
