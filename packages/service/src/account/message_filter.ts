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

function categoryOf(element: RenderElement): MessageCategory {
  if (element.type === 'text' || element.type === 'at') return 'text';
  if (element.type === 'pic') return 'image';
  if (element.type === 'video') return 'video';
  if (element.type === 'ptt') return 'voice';
  if (['file', 'onlineFile', 'onlineFolder'].includes(element.type)) return 'file';
  if (['face', 'mface', 'emojiBounce'].includes(element.type)) return 'emoji';
  if (element.type.startsWith('grayTip')) return 'system';
  return 'other';
}

function hasLink(element: RenderElement): boolean {
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
