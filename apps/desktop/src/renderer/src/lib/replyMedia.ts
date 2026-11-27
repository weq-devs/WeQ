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
export function needsReplyMedia(message: ReplyMessage, includeName = false): boolean {
  return (
    message.source !== 'roaming' &&
    /^-?\d{1,20}$/.test(message.msgId) &&
    message.elements.some((element) => {
      const data = replyData(element);
      return (
        data !== null &&
        (missingMedia(data) || (includeName && !data.origSenderNick && !data.origCachedSenderName))
      );
    })
  );
}

type QuoteSender = { name: string; uid: string; seq: string; msgId: string };

function quotedName(
  data: Record<string, unknown>,
  sender: QuoteSender | undefined,
  single: boolean,
) {
  if (!sender || data.origSenderNick) return undefined;
  const uid = String(data.origSenderUid || '');
  const seq = String(data.origMsgSeq ?? '').replace(/^0$/, '');
  const id = String(data.origMsgId ?? '').replace(/^0$/, '');
  if (sender.uid && uid && sender.uid !== uid) return undefined;
  if (sender.msgId && id) return sender.msgId === id ? sender.name : undefined;
  if (sender.seq && seq) return sender.seq === seq ? sender.name : undefined;
  return single ? sender.name : undefined;
}

/** 只补查询时那一版消息；迟到结果不能盖回已编辑、删除或换页后的新对象。 */
export function applyReplyMedia<T extends ReplyMessage>(
  rows: T[],
  pending: ReadonlyMap<string, T>,
  patches: readonly { msgId: string; elements: readonly unknown[]; quotedSender?: QuoteSender }[],
): T[] {
  const byId = new Map(patches.map((patch) => [patch.msgId, patch]));
  let changed = false;
  const next = rows.map((row) => {
    const patch = byId.get(row.msgId);
    if (pending.get(row.msgId) !== row || !patch || row.source === 'roaming') return row;
    let changedRow = false;
    const single = !patch.quotedSender || row.elements.filter(replyData).length === 1;
    const elements = row.elements.map((element) => {
      const data = replyData(element);
      if (!data) return element;
      const media = patch.elements.length && missingMedia(data) ? patch.elements : undefined;
      const name = quotedName(data, patch.quotedSender, single);
      if (!media && !name) return element;
      changedRow = true;
      return {
        ...(element as object),
        data: {
          ...data,
          ...(media ? { origElements: media } : {}),
          ...(name ? { origCachedSenderName: name } : {}),
        },
      };
    });
    if (!changedRow) return row;
    changed = true;
    return { ...row, elements };
  });
  return changed ? next : rows;
}
