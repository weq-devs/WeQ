import { messageElementsPreview, previewNodes, previewNodesToText } from './conversationPreview';
import { classifyChatType } from '@weq/codec';

interface RecentContactSnapshot {
  targetUid: string;
  msgSeq?: string;
  sendTime: string;
  chatType?: string | number;
  source?: 'roaming';
  ntSeqVerified?: boolean;
  preview?: unknown;
}

export interface ContactPreviewMessage {
  msgSeq: string;
  sendTime: string;
  source?: 'roaming';
  ntSeqVerified?: boolean;
}

interface PreviewableMessage extends ContactPreviewMessage {
  msgId?: string;
  senderUid: string;
  elements: readonly unknown[];
  deletedKind?: 'weq' | 'qq';
  recall?: unknown;
}

export interface ObservedContactPreview extends RecentContactSnapshot {
  msgId?: string;
  msgSeq: string;
  senderUid: string;
  senderDisplayName: string;
  senderNick: string;
  senderRemark: string;
  preview: unknown;
  fallback: boolean;
}

const previewVisibility = new WeakMap<object, boolean>();

function hasContactPreview(preview: unknown): boolean {
  if (!preview || typeof preview !== 'object') return false;
  const cached = previewVisibility.get(preview);
  if (cached !== undefined) return cached;
  const visible = Boolean(previewNodesToText(previewNodes(preview)));
  previewVisibility.set(preview, visible);
  return visible;
}

const previewsByMessage = new WeakMap<PreviewableMessage, object | null>();

function previewForMessage(message: PreviewableMessage): object | null {
  if (!message.elements.length) return null;
  const cached = previewsByMessage.get(message);
  if (cached !== undefined) return cached;
  // 防撤回保留的原文不能变成回退摘要；有明确的撤回灰条时仍显示灰条。
  const hiddenOriginal = Boolean(message.deletedKind || message.recall);
  const elements = hiddenOriginal
    ? message.elements.filter(
        (element) => (element as { type?: unknown })?.type === 'grayTipRevoke',
      )
    : message.elements;
  const preview = messageElementsPreview(elements);
  const result = hasContactPreview(preview) ? preview : null;
  previewsByMessage.set(message, result);
  return result;
}

/** 只保留最新正文的摘要字段，不冻结会话名称、免打扰、置顶等目录资料。 */
export function observeContactPreview(
  previous: ReadonlyMap<string, ObservedContactPreview>,
  contact: RecentContactSnapshot,
  message: PreviewableMessage | undefined,
  latestWindow?: readonly PreviewableMessage[],
): ReadonlyMap<string, ObservedContactPreview> {
  const old = previous.get(contact.targetUid);
  const invalidated =
    old?.msgId &&
    (!message || !recentContactPreviewIsBehind(old, message)) &&
    latestWindow?.some(
      (row) =>
        row.msgId === old.msgId &&
        row.source === old.source &&
        (row.deletedKind || row.recall) &&
        (previewKind(old.preview) !== 'grayTipRevoke' || !previewForMessage(row)),
    );
  const fallback = Boolean(message && !recentContactPreviewIsBehind(contact, message));
  const preview =
    message && (!fallback || (latestWindow && !hasContactPreview(contact.preview)))
      ? previewForMessage(message)
      : null;
  if (!message || !preview) {
    if (!invalidated) return previous;
    const next = new Map(previous);
    next.delete(contact.targetUid);
    return next;
  }
  if (
    old &&
    !invalidated &&
    !recentContactPreviewIsBehind(old, message) &&
    !(old.msgId === message.msgId && old.fallback !== fallback)
  )
    return previous;
  const next = new Map(previous);
  next.delete(contact.targetUid);
  next.set(contact.targetUid, {
    targetUid: contact.targetUid,
    chatType: contact.chatType,
    msgId: message.msgId,
    msgSeq: message.msgSeq,
    sendTime: message.sendTime,
    source: message.source,
    ntSeqVerified: message.ntSeqVerified,
    senderUid: message.senderUid,
    // 旧摘要的发送者可能是另一个人，交回现有本地资料解析，不继承其名字。
    senderDisplayName: '',
    senderNick: '',
    senderRemark: '',
    preview,
    fallback,
  });
  while (next.size > 500) next.delete(next.keys().next().value!);
  return next;
}

export function applyObservedContactPreview<T extends RecentContactSnapshot>(
  contact: T,
  previews: ReadonlyMap<string, ObservedContactPreview>,
): T {
  const preview = previews.get(contact.targetUid);
  if (!preview) return contact;
  if (preview.fallback) return withOlderContactPreview(contact, preview, true);
  if (!recentContactPreviewIsBehind(contact, preview)) return contact;
  const {
    source,
    ntSeqVerified: _verified,
    chatType: _chatType,
    msgId: _msgId,
    fallback: _fallback,
    msgSeq,
    ...summary
  } = preview;
  // 漫游只提供展示摘要，不能把服务端序号写进本地阅读／未读水位。
  return { ...contact, ...summary, msgSeq: source === 'roaming' ? contact.msgSeq : msgSeq };
}

type PreviewFields = Pick<
  ObservedContactPreview,
  'preview' | 'senderUid' | 'senderDisplayName' | 'senderNick' | 'senderRemark'
>;

/** 仅借用摘要和发送者，时间、排序、未读水位仍属于最新会话行。 */
function withOlderContactPreview<T extends RecentContactSnapshot & Partial<PreviewFields>>(
  contact: T,
  previous: RecentContactSnapshot & PreviewFields,
  fromTimeline: boolean,
): T {
  if (
    contact === previous ||
    contact.chatType !== previous.chatType ||
    hasContactPreview(contact.preview)
  )
    return contact;
  if (!fromTimeline) {
    if (!hasContactPreview(previous.preview)) return contact;
    if (!recentContactPreviewIsBehind(previous, contact)) return contact;
    // 同序号的空行可能是原消息被删除，不能用旧目录把原文重新显示出来。
    if (contact.msgSeq === previous.msgSeq && !previewKind(previous.preview).startsWith('grayTip'))
      return contact;
  }
  return {
    ...contact,
    preview: previous.preview,
    senderUid: previous.senderUid,
    senderDisplayName: previous.senderDisplayName,
    senderNick: previous.senderNick,
    senderRemark: previous.senderRemark,
  };
}

function previewKind(preview: unknown): string {
  const kind = (preview as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : '';
}

/** 复用上一轮已有的小表摘要，只保留当前目录的行引用。 */
export function reconcileRecentContactPreviews<T extends RecentContactSnapshot & PreviewFields>(
  contacts: readonly T[],
  previous: ReadonlyMap<string, T>,
  observed: ReadonlyMap<string, ObservedContactPreview>,
): { rows: T[]; summaries: ReadonlyMap<string, T> } {
  const summaries = new Map<string, T>();
  const rows = contacts.map((contact) => {
    const cached = previous.get(contact.targetUid);
    const carried = cached ? withOlderContactPreview(contact, cached, false) : contact;
    summaries.set(contact.targetUid, carried !== contact && cached ? cached : contact);
    const current = applyObservedContactPreview(contact, observed);
    return current === contact ? carried : current;
  });
  return { rows, summaries };
}

/** 漫游也参与摘要；未确认映射的私聊序号不能与 NT 序号比较。 */
export function recentContactPreviewIsBehind(
  contact: RecentContactSnapshot,
  message: Pick<RecentContactSnapshot, 'msgSeq' | 'sendTime' | 'source' | 'ntSeqVerified'>,
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
  canPreview?: (message: T) => boolean,
): T | undefined {
  let latest: T | undefined;
  for (const message of messages) {
    if (
      (!latest || recentContactPreviewIsBehind({ ...contact, ...latest }, message)) &&
      (!canPreview || canPreview(message))
    )
      latest = message;
  }
  return latest;
}

export const canPreviewContactMessage = (message: PreviewableMessage): boolean =>
  previewForMessage(message) !== null;

const number = (value: string | undefined) => (value && /^\d+$/.test(value) ? BigInt(value) : 0n);

/** 定向校准也接受同水位灰条变化，但迟到结果不能盖住更晚的摘要。 */
export function patchRecentContactRows<T extends RecentContactSnapshot & ContactPreviewMessage>(
  rows: T[],
  updates: readonly T[],
): T[] {
  const byId = new Map(updates.map((row) => [row.targetUid, row]));
  let changed = false;
  const next = rows.map((row) => {
    const update = byId.get(row.targetUid);
    if (!update || recentContactPreviewIsBehind(update, row)) return row;
    changed = true;
    return update;
  });
  return changed ? next : rows;
}

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
