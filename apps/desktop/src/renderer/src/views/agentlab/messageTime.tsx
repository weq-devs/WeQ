import { TimeLabel } from '../../components/TimeLabel';
import * as timeFormat from '@weq/time';
/**
 * 克隆体聊天（私聊/群聊）的时间分隔条。
 *
 * 规则与主聊天 im-template/template/messageTime.tsx 完全一致：
 *  - 首条消息必显示；
 *  - 相邻两条消息间隔 ≥ 5 分钟时显示；
 *  - 与普通聊天共用北京自然日分段，正文到秒、完整提示保留毫秒。
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

/** 共用聊天分隔格式，来源为助手消息的毫秒时间。 */
export function formatChatTime(ts: number): string {
  return ts > 0 ? timeFormat.formatChatTime(ts) : '';
}

/** 时间分隔条（无文案时返回 null，保持渲染输出干净）。 */
export function ChatTimeDivider({ ts }: { ts: number }): ReactElement | null {
  const label = formatChatTime(ts);
  if (!label) return null;
  return (
    <TimeLabel className="message-time-divider" value={ts} precision="millisecond">
      {label}
    </TimeLabel>
  );
}
