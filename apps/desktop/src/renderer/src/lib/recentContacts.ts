import { messageElementsPreview } from './conversationPreview';

interface RecentContactSnapshot {
  targetUid: string;
  msgSeq?: string;
  sendTime: string;
}

export interface ObservedContactPreview extends RecentContactSnapshot {
  msgSeq: string;
  senderUid: string;
  senderDisplayName: string;
  senderNick: string;
  senderRemark: string;
  preview: unknown;
}

/** 只保留最新正文的摘要字段，不冻结会话名称、免打扰、置顶等目录资料。 */
export function observeContactPreview(
  previous: ReadonlyMap<string, ObservedContactPreview>,
  contact: RecentContactSnapshot,
  message: {
    msgSeq: string;
    sendTime: string;
    senderUid: string;
    elements: readonly unknown[];
    source?: 'roaming';
  },
): ReadonlyMap<string, ObservedContactPreview> {
  if (!recentContactPreviewIsBehind(contact, message)) return previous;
  const old = previous.get(contact.targetUid);
  if (old && !recentContactPreviewIsBehind(old, message)) return previous;
  const next = new Map(previous);
  next.delete(contact.targetUid);
  next.set(contact.targetUid, {
    targetUid: contact.targetUid,
    msgSeq: message.msgSeq,
    sendTime: message.sendTime,
    senderUid: message.senderUid,
    // 旧摘要的发送者可能是另一个人，交回现有本地资料解析，不继承其名字。
    senderDisplayName: '',
    senderNick: '',
    senderRemark: '',
    preview: messageElementsPreview(message.elements),
  });
  while (next.size > 500) next.delete(next.keys().next().value!);
  return next;
}

export function applyObservedContactPreview<T extends RecentContactSnapshot>(
  contact: T,
  previews: ReadonlyMap<string, ObservedContactPreview>,
): T {
  const preview = previews.get(contact.targetUid);
  return preview && recentContactPreviewIsBehind(contact, preview)
    ? { ...contact, ...preview }
    : contact;
}

/** 正文已落到本地但列表通知缺失时，用真实消息水位发现落后的摘要。 */
export function recentContactPreviewIsBehind(
  contact: RecentContactSnapshot,
  message: { msgSeq: string; sendTime: string; source?: 'roaming' },
): boolean {
  if (message.source === 'roaming') return false;
  const time = number(message.sendTime);
  const previous = number(contact.sendTime);
  return time > previous || (time === previous && number(message.msgSeq) > number(contact.msgSeq));
}

const number = (value: string | undefined) => (value && /^\d+$/.test(value) ? BigInt(value) : 0n);

/** 最新页和分页目录可能短暂重叠；不能让后面的旧副本把新消息时间覆盖回去。 */
export function mergeRecentContactPages<T extends RecentContactSnapshot>(
  pages: readonly (readonly T[])[],
): T[] {
  const rows = new Map<string, T>();
  for (const page of pages)
    for (const row of page) {
      const old = rows.get(row.targetUid);
      if (
        !old ||
        number(row.msgSeq) > number(old.msgSeq) ||
        (number(row.msgSeq) === number(old.msgSeq) && number(row.sendTime) > number(old.sendTime))
      )
        rows.set(row.targetUid, row);
    }
  return [...rows.values()];
}
