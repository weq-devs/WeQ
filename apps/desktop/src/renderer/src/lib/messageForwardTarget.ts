import type { Message } from '../im-template/template/types';
import { forwardResIdOf } from '../components/mergeForward/model';
import { isArkMultiMsg } from '../components/ForwardWindow';

export interface ForwardExportTarget {
  elementIndex: number;
  resId: string;
}

/** 媒体命中不能被同一消息里的聊天记录卡片抢占。多卡消息只导出命中的卡片。 */
export function messageForwardTarget(
  message: Message,
  target?: EventTarget | null,
): ForwardExportTarget | undefined {
  const node = target instanceof Element ? target : null;
  if (node?.closest('[data-message-media-key]')) return undefined;
  const card = node?.closest('[data-forward-res-id]');
  const elements = message.qqElements ?? [];
  const cards = elements.flatMap((element, elementIndex) =>
    element.type === 'multiMsg' || (element.type === 'ark' && isArkMultiMsg(element.data?.arkData))
      ? [{ elementIndex, resId: forwardResIdOf(element.data ?? {}) }]
      : [],
  );
  if (card) return cards.find((item) => item.resId === card.getAttribute('data-forward-res-id'));
  if (
    cards.length === 1 &&
    !elements.some((element) =>
      ['pic', 'video', 'ptt', 'file', 'mface'].includes(element.type ?? ''),
    )
  )
    return cards[0];
  return undefined;
}
