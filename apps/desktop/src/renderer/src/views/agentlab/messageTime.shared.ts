import * as timeFormat from '@weq/time';

/** 与主聊天一致：间隔 ≥ 5 分钟才插分隔条。 */
const CHAT_TIME_DIVIDER_INTERVAL_MS = 5 * 60 * 1000;

/** 是否需要在 ts 这条消息前插入时间分隔条（prevTs 为空 = 首条，必显）。 */
export function shouldShowChatTime(prevTs: number | undefined, ts: number): boolean {
  if (prevTs === undefined) return true;
  return ts - prevTs >= CHAT_TIME_DIVIDER_INTERVAL_MS;
}

/** 共用聊天分隔格式，来源为助手消息的毫秒时间。 */
export function formatChatTime(ts: number): string {
  return ts > 0 ? timeFormat.formatChatTime(ts) : '';
}
