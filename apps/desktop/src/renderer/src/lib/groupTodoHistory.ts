export interface GroupTodoRecord {
  sequence: string;
  sourceId?: string;
  text: string;
  createdAt?: number;
  updatedAt?: number;
  completed?: boolean;
}

export function groupTodoKey(todo: GroupTodoRecord): string {
  return todo.sourceId || todo.sequence;
}

/** 在线列表可能只有当前横幅；保留本地已有摘要，同一消息优先采用在线状态。 */
export function mergeGroupTodoSources(
  local: readonly GroupTodoRecord[],
  online: readonly GroupTodoRecord[],
): GroupTodoRecord[] {
  const rows = new Map(local.map((row) => [row.sequence, row]));
  for (const row of online) rows.set(row.sequence, { ...rows.get(row.sequence), ...row });
  return [...rows.values()];
}

/** 服务器不再返回已完成横幅时仍保留记录；明确更新后的重新待办可以覆盖旧完成态。 */
export function mergeGroupTodoHistory(
  live: readonly GroupTodoRecord[],
  completed: readonly GroupTodoRecord[],
): GroupTodoRecord[] {
  const rows = new Map(live.map((row) => [groupTodoKey(row), row]));
  for (const old of completed) {
    if (!old.completed) continue;
    const current = rows.get(groupTodoKey(old));
    if (!current || (!current.completed && (current.updatedAt ?? 0) <= (old.updatedAt ?? 0)))
      rows.set(groupTodoKey(old), {
        ...old,
        ...current,
        completed: true,
        updatedAt: old.updatedAt,
      });
  }
  return [...rows.values()];
}

export function groupTodoHistoryKey(uin: string, configId: string, groupId: number): string {
  return `weq:completed-group-todos:v1:${JSON.stringify([uin, configId, groupId])}`;
}

function completedRecord(value: unknown): value is GroupTodoRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    row.completed === true &&
    typeof row.sequence === 'string' &&
    !!row.sequence &&
    typeof row.text === 'string' &&
    (row.sourceId === undefined || typeof row.sourceId === 'string') &&
    [row.createdAt, row.updatedAt].every(
      (time) =>
        time === undefined || (typeof time === 'number' && Number.isFinite(time) && time >= 0),
    )
  );
}

export function readGroupTodoHistory(
  key: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): GroupTodoRecord[] {
  if (!key) return [];
  try {
    const rows: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    return Array.isArray(rows) ? rows.filter(completedRecord) : [];
  } catch {
    return [];
  }
}

export function saveGroupTodoHistory(
  key: string,
  rows: readonly GroupTodoRecord[],
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  if (key) storage.setItem(key, JSON.stringify(rows.filter((row) => row.completed)));
}
