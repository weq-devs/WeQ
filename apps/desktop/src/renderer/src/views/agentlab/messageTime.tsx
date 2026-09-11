/**
 * 克隆体聊天（私聊/群聊）的时间分隔条。
 *
 * 规则与主聊天 im-template/template/messageTime.tsx 完全一致：
 *  - 首条消息必显示；
 *  - 相邻两条消息间隔 ≥ 5 分钟时显示；
 *  - 文案：今天 → HH:mm；昨天 → 昨天 HH:mm；一周内 → 周X HH:mm；更早 → YYYY/MM/DD HH:mm。
 * 复用主聊天的 .message-time-divider 样式（气泡区同为 grid 布局，align-self:center 居中）。
 */
import type { ReactElement } from 'react';

/** 与主聊天一致：间隔 ≥ 5 分钟才插分隔条。 */
const CHAT_TIME_DIVIDER_INTERVAL_MS = 5 * 60 * 1000;

/** 是否需要在 ts 这条消息前插入时间分隔条（prevTs 为空 = 首条，必显）。 */
export function shouldShowChatTime(prevTs: number | undefined, ts: number): boolean {
  if (prevTs === undefined) return true;
  return ts - prevTs >= CHAT_TIME_DIVIDER_INTERVAL_MS;
}

/** 时间文案：今天 HH:mm / 昨天 HH:mm / 周X HH:mm / YYYY/MM/DD HH:mm。 */
export function formatChatTime(ts: number): string {
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.floor((startOfDay(now).getTime() - startOfDay(date).getTime()) / 86400000);
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  }).format(date);

  if (dayDiff <= 0) return time;
  if (dayDiff === 1) return `昨天 ${time}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date);
    return `${weekday} ${time}`;
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}/${month}/${day} ${time}`;
}

/** 时间分隔条（无文案时返回 null，保持渲染输出干净）。 */
export function ChatTimeDivider({ ts }: { ts: number }): ReactElement | null {
  const label = formatChatTime(ts);
  if (!label) return null;
  return <time className="message-time-divider">{label}</time>;
}
