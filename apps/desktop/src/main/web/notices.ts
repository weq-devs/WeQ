import { EventEmitter } from 'node:events';

interface WebNoticeBinding {
  uin: string;
  configId: string;
}

interface WebNoticeContent {
  kind: 'recall' | 'keyword' | 'mail' | 'message';
  title: string;
  body: string;
  banner?: { title: string; body: string };
  noticeIdentity?: string;
  target?: { kind: 'c2c' | 'group'; conv: string; seq: string; msgId?: string };
  mail?: { folderId: number; id: string };
}

export type WebNotice = WebNoticeBinding & WebNoticeContent;
export type WebNoticePayload = WebNoticeContent | { kind: 'mail-read'; mailIds: string[] };
export type WebNoticeEvent = WebNoticeBinding & WebNoticePayload;

export const webNotices = new EventEmitter();
webNotices.setMaxListeners(0);
