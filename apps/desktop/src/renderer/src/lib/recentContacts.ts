import { messageElementsPreview } from './conversationPreview';
import { classifyChatType } from '@weq/codec';

interface RecentContactSnapshot {
  targetUid: string;
  msgSeq?: string;
  sendTime: string;
  chatType?: string | number;
  source?: 'roaming';
  ntSeqVerified?: boolean;
}

export interface ContactPreviewMessage {
  msgSeq: string;
  sendTime: string;
  source?: 'roaming';
  ntSeqVerified?: boolean;
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
  message: ContactPreviewMessage & {
    senderUid: string;
    elements: readonly unknown[];
  },
): ReadonlyMap<string, ObservedContactPreview> {
  if (!recentContactPreviewIsBehind(contact, message)) return previous;
  const old = previous.get(contact.targetUid);
  if (old && !recentContactPreviewIsBehind(old, message)) return previous;
  const next = new Map(previous);
  next.delete(contact.targetUid);
  next.set(contact.targetUid, {
    targetUid: contact.targetUid,
    chatType: contact.chatType,
    msgSeq: message.msgSeq,
    sendTime: message.sendTime,
    source: message.source,
    ntSeqVerified: message.ntSeqVerified,
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
  if (!preview || !recentContactPreviewIsBehind(contact, preview)) return contact;
  const { source, ntSeqVerified: _verified, chatType: _chatType, msgSeq, ...summary } = preview;
  // 漫游只提供展示摘要，不能把服务端序号写进本地阅读／未读水位。
  return { ...contact, ...summary, msgSeq: source === 'roaming' ? contact.msgSeq : msgSeq };
}

/** 漫游也参与摘要；未确认映射的私聊序号不能与 NT 序号比较。 */
export function recentContactPreviewIsBehind(
  contact: RecentContactSnapshot,
  message: ContactPreviewMessage,
): boolean {
  const time = number(message.sendTime);
  const previous = number(contact.sendTime);
  if (time !== previous) return time > previous;
  const group = classifyChatType(contact.chatType ?? '') === 'group';
  const comparable = (row: Pick<RecentContactSnapshot, 'source' | 'ntSeqVerified'>) =>
    group || row.source !== 'roaming' || row.ntSeqVerified === true;
  return (
    comparable(contact) && comparable(message) && number(message.msgSeq) > number(contact.msgSeq)
  );
}

/** 混合窗口不按跨来源序号取末项，旧漫游历史也不能盖住已读到的新正文。 */
export function latestContactPreviewMessage<T extends ContactPreviewMessage>(
  contact: RecentContactSnapshot,
  messages: readonly T[],
): T | undefined {
  let latest: T | undefined;
  for (const message of messages)
    if (!latest || recentContactPreviewIsBehind({ ...contact, ...latest }, message))
      latest = message;
  return latest;
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
