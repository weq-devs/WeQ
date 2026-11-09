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
