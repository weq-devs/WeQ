import type { RenderElement } from './msg_view';
import { elementsToText } from './export/element_text';

export type MessageCategory =
  | 'text'
  | 'image'
  | 'video'
  | 'voice'
  | 'file'
  | 'emoji'
  | 'system'
  | 'other';
export interface MessageFilter {
  /** 精确行身份集合，含漫游来源前缀；空集合不等于全部，不转浮点数。 */
  messageIds?: string[];
  sender?: string;
  keyword?: string;
  category?: MessageCategory;
}

interface FilterableMessage {
  msgId?: string | bigint;
  msgSeq?: string | bigint;
  source?: 'roaming';
  sourceFormat?: 'native' | 'protocol';
  senderUid: string;
  senderUin: string | bigint;
  elements: RenderElement[];
}

export function messageSelectionKey(
  message: Pick<FilterableMessage, 'msgId' | 'msgSeq' | 'source' | 'sourceFormat'>,
): string | null {
  if (message.msgId == null) return null;
  if (message.source !== 'roaming') return String(message.msgId);
  if (message.msgSeq == null) return null;
  return `roaming:${message.sourceFormat ? `${message.sourceFormat}:` : ''}${message.msgSeq}:${message.msgId}`;
}

export function compileMessageFilter(
  filter?: MessageFilter,
): (message: FilterableMessage) => boolean {
  const snapshot = filter ? { ...filter } : undefined;
  const ids = filter?.messageIds ? new Set(filter.messageIds) : undefined;
  return (message) => matchesMessageFilter(message, snapshot, ids);
}

export function messageCategory(elements: readonly RenderElement[]): MessageCategory[] {
  const categories = new Set<MessageCategory>();
  for (const el of elements) {
    if (el.type === 'text' || el.type === 'at') categories.add('text');
    else if (el.type === 'pic') categories.add('image');
    else if (el.type === 'video') categories.add('video');
    else if (el.type === 'ptt') categories.add('voice');
    else if (['file', 'onlineFile', 'onlineFolder'].includes(el.type)) categories.add('file');
    else if (['face', 'mface', 'emojiBounce'].includes(el.type)) categories.add('emoji');
    else if (el.type.startsWith('grayTip')) categories.add('system');
    else categories.add('other');
  }
  if (!categories.size) categories.add('other');
  return [...categories];
}

export function matchesMessageFilter(
  message: FilterableMessage,
  filter?: MessageFilter,
  selectedIds?: ReadonlySet<string>,
): boolean {
  if (!filter) return true;
  if (filter.messageIds !== undefined) {
    const key = messageSelectionKey(message);
    if (key === null || !(selectedIds ?? new Set(filter.messageIds)).has(key)) return false;
  }
  if (
    filter.sender &&
    filter.sender !== message.senderUid &&
    filter.sender !== String(message.senderUin)
  )
    return false;
  if (filter.category && !messageCategory(message.elements).includes(filter.category)) return false;
  if (
    filter.keyword &&
    !elementsToText(message.elements)
      .toLocaleLowerCase()
      .includes(filter.keyword.toLocaleLowerCase())
  )
    return false;
  return true;
}
