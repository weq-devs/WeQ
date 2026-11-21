import type { DressConversationEntry, DressConversationSlot } from '@weq/service';
import { isVideoBackground } from './resourceUrl';

export function conversationDressLabel(
  entry: DressConversationEntry,
  slot: DressConversationSlot,
): string {
  const value = entry[slot];
  if (!value) return '跟随全局';
  if (value === 'off') return '不使用';
  if ('itemId' in value) return value.name || `通话背景 ${value.itemId}`;
  if ('widgetId' in value) return `挂件 ${value.widgetId}`;
  if (value.source === 'qq') return 'QQ 同款';
  return isVideoBackground(value.file) ? '自定义视频' : '自定义图片';
}
