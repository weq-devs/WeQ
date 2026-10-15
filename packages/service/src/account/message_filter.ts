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
  sender?: string;
  keyword?: string;
  category?: MessageCategory;
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
  message: { senderUid: string; senderUin: string | bigint; elements: RenderElement[] },
  filter?: MessageFilter,
): boolean {
  if (!filter) return true;
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
