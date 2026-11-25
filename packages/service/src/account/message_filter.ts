import type { RenderElement } from './msg_view';
import { elementsToText } from './export/element_text';
import { parseArkData } from '../common/arkCards';
import { hasTextLink } from '../common/text_links';

export const MESSAGE_CATEGORIES = [
  'text',
  'image',
  'video',
  'voice',
  'file',
  'link',
  'emoji',
  'system',
  'other',
] as const;
export type MessageCategory = (typeof MESSAGE_CATEGORIES)[number];
export const CONVERSATION_RECORD_TYPES = [
  'media',
  'emoji',
  'voice',
  'file',
  'forward',
  'linkCard',
  'other',
] as const;
export type ConversationRecordType = (typeof CONVERSATION_RECORD_TYPES)[number];

export interface ForwardCardTarget {
  elementIndex: number;
  resId: string;
}

export interface ForwardRecordTarget {
  index: number;
  msgId: string;
  recordIdentity?: string;
}

export interface ForwardExportTarget extends ForwardCardTarget {
  /** Position within the carrier, not a message ID in the current conversation. */
  path?: Array<ForwardCardTarget & { record: ForwardRecordTarget }>;
  records?: ForwardRecordTarget[];
}

export interface MessageFilter {
  /** 精确行身份集合，含漫游来源前缀；空集合不等于全部，不转浮点数。 */
  messageIds?: string[];
  forwardTarget?: ForwardExportTarget;
  sender?: string;
  senders?: string[];
  recordType?: ConversationRecordType;
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
  const senders = filter?.senders ? new Set(filter.senders) : undefined;
  return (message) => matchesMessageFilter(message, snapshot, ids, senders);
}

type ClassifiedElement = RenderElement | { type?: string; data?: Record<string, unknown> };

function categoryOf(element: ClassifiedElement): MessageCategory {
  if (element.type === 'text' || element.type === 'at') return 'text';
  if (element.type === 'pic') return 'image';
  if (element.type === 'video') return 'video';
  if (element.type === 'ptt') return 'voice';
  if (['file', 'onlineFile', 'onlineFolder'].includes(element.type ?? '')) return 'file';
  if (['face', 'mface', 'emojiBounce'].includes(element.type ?? '')) return 'emoji';
  if (element.type?.startsWith('grayTip')) return 'system';
  return 'other';
}

function hasLink(element: ClassifiedElement): boolean {
  if (element.type === 'text') return hasTextLink(String(element.data?.textContent ?? ''));
  if (element.type !== 'ark') return false;
  const news = parseArkData(element.data?.arkData)?.meta?.news;
  if (!news) return false;
  return [news.jumpUrl, news.qqdocurl, news.url].some((value) => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return false;
    return URL.canParse(value);
  });
}

export function messageCategory(elements: readonly RenderElement[]): MessageCategory[] {
  const categories = new Set(elements.map(categoryOf));
  if (elements.some(hasLink)) categories.add('link');
  if (!categories.size) categories.add('other');
  return [...categories];
}

export function conversationRecordTypeOf(element: ClassifiedElement): ConversationRecordType {
  if (
    element.type === 'multiMsg' ||
    (element.type === 'ark' && parseArkData(element.data?.arkData)?.app === 'com.tencent.multimsg')
  )
    return 'forward';
  if (element.type === 'pic' && Number(element.data?.subType) === 1) return 'emoji';
  const category = categoryOf(element);
  if (category === 'image' || category === 'video') return 'media';
  if (category === 'emoji' || category === 'voice' || category === 'file') return category;
  if (element.type === 'ark' || hasLink(element)) return 'linkCard';
  return 'other';
}

export function matchesConversationRecordType(
  elements: readonly ClassifiedElement[],
  type: ConversationRecordType,
): boolean {
  return type === 'other'
    ? elements.every((element) => conversationRecordTypeOf(element) === 'other')
    : elements.some((element) => conversationRecordTypeOf(element) === type);
}

export function matchesMessageFilter(
  message: FilterableMessage,
  filter?: MessageFilter,
  selectedIds?: ReadonlySet<string>,
  selectedSenders?: ReadonlySet<string>,
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
  if (filter.senders?.length) {
    const senders = selectedSenders ?? new Set(filter.senders);
    if (!senders.has(message.senderUid) && !senders.has(String(message.senderUin))) return false;
  }
  if (filter.recordType && !matchesConversationRecordType(message.elements, filter.recordType))
    return false;
  const { category } = filter;
  if (category) {
    const { elements } = message;
    const matches =
      category === 'link'
        ? elements.some(hasLink)
        : elements.length === 0
          ? category === 'other'
          : elements.some((element) => categoryOf(element) === category);
    if (!matches) return false;
  }
  if (
    filter.keyword &&
    !elementsToText(message.elements)
      .toLocaleLowerCase()
      .includes(filter.keyword.toLocaleLowerCase())
  )
    return false;
  return true;
}
