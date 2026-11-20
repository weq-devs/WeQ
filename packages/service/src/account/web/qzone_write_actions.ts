import {
  forwardQzoneMsg as forward,
  replyQzoneFeedComment as reply,
  type QzoneFeedReplyTarget as QzoneReplyTarget,
  type WebCredential,
} from '@weqbot/protocol';
import { webRequestText } from './http';

export type { QzoneFeedReplyTarget as QzoneReplyTarget } from '@weqbot/protocol';

// 沿用宿主的 Chromium／代理传输，协议和回执由 WeqBot 共用。
export function replyQzoneMsg(
  cred: WebCredential,
  hostUin: string,
  tid: string,
  target: QzoneReplyTarget,
  content: string,
  imageUrl?: string,
) {
  return reply(cred, hostUin, tid, target, content, imageUrl, webRequestText);
}

export function forwardQzoneMsg(cred: WebCredential, hostUin: string, tid: string, reason: string) {
  return forward(cred, hostUin, tid, reason, undefined, webRequestText);
}
