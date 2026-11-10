import { calendarTargetKey, type CalendarTarget } from '@weq/service/conversation-calendar';

/** 统计范围是身份集合；会话活动排序和展示资料变化不应丢弃扫描进度。 */
export function calendarTargetSetKey(targets: readonly CalendarTarget[]): string {
  return JSON.stringify([...new Set(targets.map(calendarTargetKey))].sort());
}

interface CloneActivity {
  id: string;
  updatedAt: number;
  lastMessageTime?: number;
  preview?: string;
}

/** 使用数据内容而非查询刷新时间，避免相同目录的重新拉取使日历失效。 */
export function calendarCloneRevision(
  personas: readonly CloneActivity[],
  groups: readonly CloneActivity[],
): string {
  const project = (rows: readonly CloneActivity[]) =>
    rows
      .map((row) => ({
        id: row.id,
        updatedAt: row.updatedAt,
        lastMessageTime: row.lastMessageTime ?? 0,
        preview: row.preview ?? '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify([project(personas), project(groups)]);
}
