import { EventEmitter } from 'node:events';
import type { WebNotice } from './web/notices';
export const messageNoticeClicks = new EventEmitter();
const pending = new Map<string, WebNotice>();
const key = (uin: string, configId: string) => JSON.stringify([uin, configId]);
export function pushMessageNoticeClick(notice: WebNotice) {
  pending.set(key(notice.uin, notice.configId), notice);
  while (pending.size > 32) pending.delete(pending.keys().next().value!);
  messageNoticeClicks.emit('click', notice);
}
export function consumeMessageNoticeClick(uin: string, configId: string) {
  const id = key(uin, configId),
    notice = pending.get(id) ?? null;
  pending.delete(id);
  return notice;
}
