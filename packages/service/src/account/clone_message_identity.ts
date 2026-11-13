import { createHash } from 'node:crypto';

interface CloneHistoryMessage {
  id?: string;
  text: string;
  ts: number;
  sourceMessageId?: string;
  sourceSessionId?: string | null;
  sourceReplyToId?: string;
  replyToId?: string;
  role?: string;
  senderId?: string;
  senderKind?: string;
  groupId?: string;
  actions?: unknown;
  mentions?: unknown;
}

export function hasCloneMessageIdCollision(rows: readonly CloneHistoryMessage[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) return true;
    seen.add(row.id);
  }
  return false;
}

/** 原始来源与正文共同识别迁移记录，不把同 ID 的不同内容当成重复副本。 */
export function cloneHistoryOriginKey(message: CloneHistoryMessage): string {
  return JSON.stringify([
    message.sourceSessionId ?? null,
    message.sourceMessageId ?? message.id ?? null,
    message.ts,
    message.text,
    message.role,
    message.senderId,
    message.senderKind,
    message.groupId,
    message.actions,
    message.mentions,
    message.sourceReplyToId ?? message.replyToId,
  ]);
}

/** 仅重编号发生冲突的消息，原 ID 另存；同一批来源重开后得到相同身份。 */
export function uniqueCloneMessageIds<T extends CloneHistoryMessage>(
  owner: string,
  rows: T[],
): T[] {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.id) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  const reserved = new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
  const occurrences = new Map<string, number>();
  const assigned = rows.map((row) => {
    if (row.id && counts.get(row.id) === 1) return row;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([owner, cloneHistoryOriginKey(row)]))
      .digest('hex');
    let occurrence = occurrences.get(fingerprint) ?? 0;
    let id: string;
    do {
      id = `merged-clone:${fingerprint}:${occurrence++}`;
    } while (reserved.has(id));
    occurrences.set(fingerprint, occurrence);
    reserved.add(id);
    return { ...row, id, ...(row.id ? { sourceMessageId: row.sourceMessageId ?? row.id } : {}) };
  });
  const sourceIds = new Map<string, string[]>();
  for (const row of assigned) {
    if (!row.id) continue;
    const key = JSON.stringify([row.sourceSessionId ?? null, row.sourceMessageId ?? row.id]);
    const matches = sourceIds.get(key) ?? [];
    matches.push(row.id);
    sourceIds.set(key, matches);
  }
  return assigned.map((row) => {
    const original = row.sourceReplyToId ?? row.replyToId;
    if (!original) return row;
    const target = sourceIds.get(JSON.stringify([row.sourceSessionId ?? null, original]));
    return target?.length === 1 && target[0] !== row.replyToId
      ? { ...row, replyToId: target[0], sourceReplyToId: original }
      : row;
  });
}
