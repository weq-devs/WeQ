import type { ConversationCalendarJob } from '@weq/service/conversation-calendar';
import '../styles/search-scope.css';

export type CalendarSnapshot = ReturnType<ConversationCalendarJob['snapshot']>;
export function calendarReadLabel(snapshot?: CalendarSnapshot): string | undefined {
  if (!snapshot) return '正在读取统计进度…';
  if (snapshot.emptyReason) return snapshot.emptyReason;
  if (snapshot.cancelled) return '统计已暂停';
  if (snapshot.enabledKinds && !snapshot.enabledKinds.length) return '未选择统计内容';
  const state = snapshot.readState?.state;
  if (state === 'idle') return '正在为其他数据库读取让路…';
  if (state === 'queued') return '等待可用读取连接，将自动继续…';
  if (state === 'reading') return '正在读取数据库…';
  if (!snapshot.activeScan && snapshot.controls?.day.state === 'paused') return '该日统计已暂停';
  if (!snapshot.activeScan && snapshot.controls?.month.state === 'paused') return '当月统计已暂停';
  if (snapshot.refreshing) return '正在重新获取统计…';
  if (!snapshot.days.every((value) => value.complete)) return '正在统计消息数量…';
  return undefined;
}
