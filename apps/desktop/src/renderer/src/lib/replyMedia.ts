interface ReplyMessage {
  msgId: string;
  elements: unknown[];
  source?: string;
}
const mediaTypes = new Set(['pic', 'video', 'file', 'mface', 'ptt']);
function replyData(element: unknown): Record<string, unknown> | null {
  if (!element || typeof element !== 'object' || !('type' in element) || element.type !== 'reply')
    return null;
  if (!('data' in element) || !element.data || typeof element.data !== 'object') return null;
  return element.data as Record<string, unknown>;
}
function missingMedia(data: Record<string, unknown>): boolean {
  return (
    !Array.isArray(data.origElements) ||
    !data.origElements.some((element: unknown) =>
      Boolean(
        element &&
          typeof element === 'object' &&
          'type' in element &&
          mediaTypes.has(String(element.type)),
      ),
    )
  );
}
export function needsReplyMedia(message: ReplyMessage): boolean {
  return (
    message.source !== 'roaming' &&
    /^-?\d{1,20}$/.test(message.msgId) &&
    message.elements.some((element) => {
      const data = replyData(element);
      return data !== null && missingMedia(data);
    })
  );
}

/** 只补查询时那一版消息；迟到结果不能盖回已编辑、删除或换页后的新对象。 */
export function applyReplyMedia<T extends ReplyMessage>(
  rows: T[],
  pending: ReadonlyMap<string, T>,
  patches: readonly { msgId: string; elements: readonly unknown[] }[],
): T[] {
  const byId = new Map(patches.map((patch) => [patch.msgId, patch.elements]));
  let changed = false;
  const next = rows.map((row) => {
    const media = byId.get(row.msgId);
    if (pending.get(row.msgId) !== row || !media?.length || !needsReplyMedia(row)) return row;
    changed = true;
    return {
      ...row,
      elements: row.elements.map((element) => {
        const data = replyData(element);
        return data && missingMedia(data)
          ? { ...(element as object), data: { ...data, origElements: media } }
          : element;
      }),
    };
  });
  return changed ? next : rows;
}
